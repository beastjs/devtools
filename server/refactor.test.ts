import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileBeastResult, componentNameFromPath } from 'beast-tsrx'
import { createOctaneCompiler } from 'octane/compiler/bundler'
import type { AnalyzerSettings, RefactorSuggestion, RefactorTarget } from '../shared/types.ts'
import { analyzeDocument } from './analyze.ts'
import { BeastProject } from './project.ts'
import { planRefactor, RefactorError, type RefactorPlan } from './refactor.ts'

const APP = readFileSync(new URL('../test/fixtures/App.btsx', import.meta.url), 'utf8')
const SETTINGS: AnalyzerSettings = { depthLimit: 5, minLines: 8, fileLines: 30 }
const octane = createOctaneCompiler({ root: process.cwd(), environment: 'client', hmr: false, dev: true })

function suggestionsFor(source: string, name: string, settings: Partial<AnalyzerSettings> = {}) {
  const absolutePath = `/project/src/${name}.btsx`
  const { ast } = compileBeastResult(source, { filename: absolutePath, componentName: name })
  const analysis = analyzeDocument(ast, source, name, { ...SETTINGS, ...settings })
  return { absolutePath, ast, suggestions: analysis.suggestions }
}

function plan(
  source: string,
  host: string,
  pick: (suggestion: RefactorSuggestion) => boolean,
  target: RefactorTarget,
  options: { settings?: Partial<AnalyzerSettings>; exists?: (path: string) => boolean } = {},
): RefactorPlan {
  const { absolutePath, ast, suggestions } = suggestionsFor(source, host, options.settings)
  const suggestion = suggestions.find(pick)
  if (suggestion === undefined) throw new Error(`No matching suggestion among ${suggestions.map((s) => s.name)}`)
  return planRefactor({ absolutePath, source, document: ast, suggestion, target, exists: options.exists ?? (() => false) })
}

function expectCompiles(path: string, source: string): void {
  const { code } = compileBeastResult(source, { filename: path, componentName: componentNameFromPath(path) })
  expect(octane.transform(code, path.replace(/\.btsx$/, '.tsrx'), { environment: 'client', dev: true })).not.toBeNull()
}

describe('hoisting into the same file', () => {
  test('inserts a local component above props and replaces the section with a call', () => {
    const result = plan(APP, 'App', (s) => s.name === 'AppHeader', 'inline')
    expect(result.changes).toHaveLength(1)
    const after = result.changes[0]!.after
    expect(after.indexOf('component AppHeader')).toBeLessThan(after.indexOf('props { docsUrl }: Props'))
    expect(after).toContain('    AppHeader(activeId={activeId} setActiveId={setActiveId} setCopiedSide={setCopiedSide})')
    expect(after.split('\n').filter((line) => line.includes("aria-controls=\"workflow-panel\""))).toHaveLength(1)
    expectCompiles('/project/src/App.btsx', after)
  })

  test('replaces every copy of an identical block', () => {
    const block = ['    .card', '      h2 Title', '      p Body', '      footer', '        small Fine print']
    const source = ['section', '  .left', ...block, '  .right', ...block, ''].join('\n')
    const result = plan(source, 'Cards', (s) => s.kind === 'duplicate' && s.autoApply.blocked === null, 'inline', { settings: { minLines: 4 } })
    const after = result.changes[0]!.after
    expect(after.match(/^ {4}Card$/gm)).toHaveLength(2)
    expect(after.startsWith('component Card\n  .card\n')).toBe(true)
    expectCompiles('/project/src/Cards.btsx', after)
  })

  test('turns values that differ between copies into props, one call per copy', () => {
    const result = plan(APP, 'App', (s) => s.kind === 'duplicate', 'inline')
    const after = result.changes[0]!.after
    expect(after).toContain("onClick={() => copyNote('left', active.left.note)}")
    expect(after).toContain("onClick={() => copyNote('right', active.right.note)}")
    expect(after).toContain('      code(className={codeClassName}) #{note}')
    expect(after.match(/^ {8}CopyNote\(/gm)).toHaveLength(2)
    expectCompiles('/project/src/App.btsx', after)
  })

  test('refuses copies whose markup differs beyond values', () => {
    const source = [
      'section',
      '  .left',
      '    article.card',
      '      h2 One',
      '      p Body',
      '      footer Fine',
      '  .right',
      '    article.panel',
      '      h2 Two',
      '      p Body',
      '      footer Fine',
      '',
    ].join('\n')
    const { suggestions } = suggestionsFor(source, 'Cards', { minLines: 4 })
    const copies = suggestions.find((s) => s.kind === 'duplicate')
    expect(copies?.autoApply.blocked).toContain('tags, selectors')
  })

  test('refuses components with scoped styles', () => {
    const source = [
      'section',
      '  .a',
      '    .b',
      '      .c',
      '        p One',
      '        p Two',
      '        p Three',
      '  style',
      '    .c { color: red; }',
      '',
    ].join('\n')
    expect(() => plan(source, 'Styled', (s) => s.kind === 'extract', 'inline', { settings: { depthLimit: 2, minLines: 3 } })).toThrow(
      /scoped style/,
    )
  })
})

describe('moving to a new file', () => {
  const settings = { fileLines: 18 }

  test('creates a sibling file that imports the types and values it uses', () => {
    const result = plan(APP, 'App', (s) => s.name === 'AppHeader', 'file', { settings })
    const [source, created] = result.changes as [RefactorPlan['changes'][0], RefactorPlan['changes'][0]]
    expect(created.absolutePath).toBe('/project/src/AppHeader.btsx')
    expect(created.before).toBeNull()
    expect(created.after.split('\n').slice(0, 4)).toEqual([
      "import { panels } from './App.btsx'",
      "import type { PanelId, PanelSide } from './App.btsx'",
      'module',
      '  export interface AppHeaderProps {',
    ])
    expect(created.after).toContain('\nprops { activeId, setActiveId, setCopiedSide }: AppHeaderProps\n')
    expect(source.after).toContain("import AppHeader from './AppHeader.btsx'")
    expect(source.after).toContain("  export type PanelId = 'language' | 'integration' | 'skills'")
    expect(source.after).toContain('  export const panels: Panel[] = [')
    expect(source.after).not.toContain('export type LeftPanel')
    expectCompiles(source.absolutePath, source.after)
    expectCompiles(created.absolutePath, created.after)
  })

  test('copies the imports the section needs and keeps module directives', () => {
    const source = [
      'module "use strong";',
      "import Badge from './Badge.btsx'",
      "import { useState } from 'octane'",
      'props { groups }: { groups: { id: string; items: string[] }[] }',
      '.list',
      '  each group in groups',
      '    .group(key={group.id})',
      '      Badge(tone="green") OK',
      '      ul',
      '        each item in group.items',
      '          li #{item}',
      '',
    ].join('\n')
    const result = plan(source, 'Status', (s) => s.name === 'Group', 'file', { settings: { depthLimit: 3, minLines: 4 } })
    const [edited, created] = result.changes
    expect(created!.after.split('\n').slice(0, 8)).toEqual([
      'module',
      '  "use strong";',
      "import Badge from './Badge.btsx'",
      'module',
      '  export interface GroupProps {',
      '    group: any',
      '  }',
      'props { group }: GroupProps',
    ])
    expect(edited!.after).toContain('    Group(key={group.id} group={group})')
    expect(edited!.after.split('\n')[3]).toBe("import Group from './Group.btsx'")
    expectCompiles('/project/src/Status.btsx', edited!.after)
    expectCompiles('/project/src/Group.btsx', created!.after)
  })

  test('picks a free file name', () => {
    const taken = new Set(['/project/src/AppHeader.btsx'])
    const result = plan(APP, 'App', (s) => s.name === 'AppHeader', 'file', { settings, exists: (path) => taken.has(path) })
    expect(result.component).toBe('AppHeader2')
    expect(result.changes[1]!.absolutePath).toBe('/project/src/AppHeader2.btsx')
    expect(result.changes[0]!.after).toContain('AppHeader2(activeId={activeId}')
  })

  test('keeps sections that use a file-local component in the file', () => {
    const source = [
      'component Badge',
      '  span.badge ok',
      'section',
      '  .a',
      '    .b',
      '      .c',
      '        Badge',
      '        p Two',
      '        p Three',
      '',
    ].join('\n')
    const [suggestion] = suggestionsFor(source, 'Local', { depthLimit: 2, minLines: 3 }).suggestions
    expect(suggestion?.autoApply.fileBlocked).toContain('Badge')
    expect(() => plan(source, 'Local', (s) => s.kind === 'extract', 'file', { settings: { depthLimit: 2, minLines: 3 } })).toThrow(
      /Badge/,
    )
  })

  test('defaults large sections to their own file', () => {
    const { suggestions } = suggestionsFor(APP, 'App', { fileLines: 20 })
    expect(suggestions.find((s) => s.name === 'AppHeader')?.autoApply.target).toBe('file')
    expect(suggestions.find((s) => s.name === 'RightArticle')?.autoApply.target).toBe('inline')
  })
})

describe('applying through the project', () => {
  let root: string | null = null
  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true })
    root = null
  })

  function project() {
    root = mkdtempSync(join(tmpdir(), 'beast-devtools-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/App.btsx'), APP)
    return new BeastProject({ root, include: ['src'], exclude: [] })
  }

  test('previews, writes, and undoes a move to a new file', () => {
    const beast = project()
    const settings = { ...SETTINGS, fileLines: 18 }
    const report = beast.file('src/App.btsx', settings)!
    const suggestion = report.analysis!.suggestions.find((s) => s.name === 'AppHeader')!
    const request = { path: 'src/App.btsx', hash: report.hash, settings, suggestionId: suggestion.id, target: 'file' as const }

    const preview = beast.apply({ ...request, dryRun: true })
    expect(preview.undoId).toBeNull()
    expect(preview.files.map((f) => [f.path, f.action])).toEqual([
      ['src/App.btsx', 'edit'],
      ['src/AppHeader.btsx', 'create'],
    ])
    expect(existsSync(join(root!, 'src/AppHeader.btsx'))).toBe(false)

    const applied = beast.apply({ ...request, dryRun: false })
    expect(existsSync(join(root!, 'src/AppHeader.btsx'))).toBe(true)
    expect(readFileSync(join(root!, 'src/App.btsx'), 'utf8')).toContain('AppHeader(activeId={activeId}')
    expect(() => beast.apply({ ...request, dryRun: true })).toThrow(/changed since it was analyzed/)

    beast.undo(applied.undoId!)
    expect(readFileSync(join(root!, 'src/App.btsx'), 'utf8')).toBe(APP)
    expect(existsSync(join(root!, 'src/AppHeader.btsx'))).toBe(false)
  })

  test('validates a chosen name before planning', () => {
    const beast = project()
    const report = beast.file('src/App.btsx', SETTINGS)!
    const suggestion = report.analysis!.suggestions.find((s) => s.name === 'RightArticle')!
    const request = { path: 'src/App.btsx', hash: report.hash, settings: SETTINGS, suggestionId: suggestion.id, target: 'inline' as const, dryRun: true }
    expect(() => beast.apply({ ...request, name: 'right article' })).toThrow(/PascalCase/)
    expect(() => beast.apply({ ...request, name: 'Panel' })).toThrow(/already used/)
    const renamed = beast.apply({ ...request, name: 'OutputCard' })
    expect(renamed.component).toBe('OutputCard')
  })

  test('refuses to undo over later edits', () => {
    const beast = project()
    const report = beast.file('src/App.btsx', SETTINGS)!
    const suggestion = report.analysis!.suggestions.find((s) => s.name === 'RightArticle')!
    const applied = beast.apply({
      path: 'src/App.btsx',
      hash: report.hash,
      settings: SETTINGS,
      suggestionId: suggestion.id,
      target: 'inline',
      dryRun: false,
    })
    writeFileSync(join(root!, 'src/App.btsx'), `${readFileSync(join(root!, 'src/App.btsx'), 'utf8')}\n// edited`)
    expect(() => beast.undo(applied.undoId!)).toThrow(/edited after the refactor/)
  })
})
