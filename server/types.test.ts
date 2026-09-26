import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileBeastResult, componentNameFromPath } from 'beast-tsrx'
import { createOctaneCompiler } from 'octane/compiler/bundler'
import type { AnalyzerSettings, RefactorTarget } from '../shared/types.ts'
import { analyzeDocument } from './analyze.ts'
import { planRefactor } from './refactor.ts'
import { TypeResolver } from './types.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SETTINGS: AnalyzerSettings = { depthLimit: 5, minLines: 8, fileLines: 30 }
const octane = createOctaneCompiler({ root: ROOT, environment: 'client', hmr: false, dev: true })
const resolver = new TypeResolver(ROOT, () => null)

// Fixtures live inside the package so `octane` resolves for the type checker.
const scratch = mkdtempSync(join(ROOT, 'test', '.types-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function analyzeFile(path: string, settings: Partial<AnalyzerSettings> = {}) {
  const source = readFileSync(path, 'utf8')
  const componentName = componentNameFromPath(path)
  const { ast } = compileBeastResult(source, { filename: path, componentName })
  const analysis = analyzeDocument(ast, source, componentName, { ...SETTINGS, ...settings }, {
    sourcePath: path,
    resolveTypes: (file) => resolver.resolve(file),
  })
  const plan = (name: string, target: RefactorTarget) =>
    planRefactor({
      absolutePath: path,
      source,
      document: ast,
      suggestion: analysis.suggestions.find((s) => s.name === name)!,
      target,
      exists: () => false,
    })
  return { analysis, plan }
}

function expectCompiles(path: string, source: string): void {
  const { code } = compileBeastResult(source, { filename: path, componentName: componentNameFromPath(path) })
  expect(octane.transform(code, path.replace(/\.btsx$/, '.tsrx'), { environment: 'client', dev: true })).not.toBeNull()
}

describe('derived prop types', () => {
  const app = join(ROOT, 'test/fixtures/App.btsx')

  test('reads each prop type from TypeScript at the section', () => {
    const { analysis } = analyzeFile(app)
    const types = (name: string) => Object.fromEntries(analysis.suggestions.find((s) => s.name === name)!.props.map((p) => [p.name, p.type]))
    expect(types('LeftArticle')).toEqual({
      active: 'Panel',
      copyNote: '(side: PanelSide, note: string) => Promise<void>',
      copiedSide: 'PanelSide | null',
    })
    // Octane's `StateSetter` is not exported, so it is written out structurally.
    expect(types('AppHeader')).toEqual({
      activeId: 'PanelId',
      setActiveId: '(next: PanelId | ((prev: PanelId) => PanelId)) => void',
      setCopiedSide: '(next: PanelSide | ((prev: PanelSide | null) => PanelSide | null) | null) => void',
    })
    expect(analysis.suggestions.every((s) => s.typesDerived)).toBe(true)
  })

  test('a moved section imports the module types its props name', () => {
    const { plan } = analyzeFile(app)
    const [source, created] = plan('LeftArticle', 'file').changes
    expect(created!.after).toContain("import type { Panel, PanelSide } from './App.btsx'")
    expect(created!.after).toContain('  export interface LeftArticleProps {\n    active: Panel\n')
    expect(source!.after).toContain('  export interface Panel {')
    expectCompiles(source!.absolutePath, source!.after)
    expectCompiles(created!.absolutePath, created!.after)
  })

  test('uses exported types from other modules and imports them', () => {
    writeFileSync(join(scratch, 'user.ts'), [
      'export interface User { name: string; roles: string[] }',
      'export function loadUser(): User { return { name: "Ada", roles: [] } }',
    ].join('\n'))
    const profile = join(scratch, 'Profile.btsx')
    writeFileSync(profile, [
      "import { loadUser } from './user.ts'",
      "setup const user = loadUser();",
      'section',
      '  .a',
      '    .b',
      '      article',
      '        h2 #{user.name}',
      '        ul',
      '          each role in user.roles key role',
      '            li #{role}',
      '',
    ].join('\n'))
    const { analysis, plan } = analyzeFile(profile, { depthLimit: 3, minLines: 4 })
    const [suggestion] = analysis.suggestions
    expect(suggestion?.props).toEqual([{ name: 'user', type: 'User' }])
    expect(suggestion?.typeImports).toEqual([{ name: 'User', from: './user.ts' }])

    const hoisted = plan(suggestion!.name, 'inline').changes[0]!.after
    expect(hoisted.split('\n')[1]).toBe("import type { User } from './user.ts'")
    expect(hoisted).toContain('  interface AProps {\n    user: User\n  }')
    expectCompiles(profile, hoisted)
  })

  test('narrows through loops and conditions', () => {
    const list = join(scratch, 'List.btsx')
    writeFileSync(list, [
      "module type Item = { id: string; label: string | null; tags: string[] }",
      'props { items }: { items: Item[] }',
      'ul',
      '  each item, index in items key item.id',
      '    if item.label !== null',
      '      li',
      '        .row',
      '          span #{index}',
      '          strong #{item.label}',
      '          each tag in item.tags key tag',
      '            em #{tag}',
      '',
    ].join('\n'))
    const { analysis } = analyzeFile(list, { depthLimit: 3, minLines: 4 })
    const props = Object.fromEntries(analysis.suggestions[0]!.props.map((p) => [p.name, p.type]))
    expect(props).toEqual({ index: 'number', item: 'Item' })
  })
})

describe('mapping repeated siblings', () => {
  const nav = () => {
    const path = join(scratch, 'Nav.btsx')
    writeFileSync(path, [
      "import { useState } from 'octane'",
      "setup const [active, setActive] = useState('home');",
      '',
      'nav',
      '  ul.links',
      '    li',
      '      a(href="/" title="Start") Home',
      '    li',
      '      a(href="/docs" title="Read") Docs',
      '    li',
      '      a(href="/blog" title="News") Blog',
      '  .tabs',
      "    button(type=\"button\" className={active === 'home' ? 'on' : ''} onClick={() => setActive('home')}) Home",
      "    button(type=\"button\" className={active === 'docs' ? 'on' : ''} onClick={() => setActive('docs')}) Docs",
      "    button(type=\"button\" className={active === 'blog' ? 'on' : ''} onClick={() => setActive('blog')}) Blog",
      '',
    ].join('\n'))
    return path
  }

  test('constant values become a module array keyed by a unique field', () => {
    const path = nav()
    const { analysis, plan } = analyzeFile(path)
    const map = analysis.suggestions.find((s) => s.kind === 'map' && s.mapping?.placement === 'module')!
    expect(map.name).toBe('items')
    expect(map.mapping?.key).toBe('item.href')
    const after = plan('items', 'inline').changes[0]!.after
    expect(after).toContain("  const items = [\n    { href: \"/\", title: \"Start\", text: 'Home' },")
    expect(after).toContain('    each item in items key item.href\n      li\n        a(href={item.href} title={item.title}) #{item.text}')
    expectCompiles(path, after)
  })

  test('values that read component state stay inline in the each header', () => {
    const path = nav()
    const { analysis, plan } = analyzeFile(path)
    const map = analysis.suggestions.find((s) => s.kind === 'map' && s.mapping?.placement === 'inline')!
    expect(map.autoApply.fileBlocked).not.toBeNull()
    const after = plan(map.name, 'inline').changes[0]!.after
    expect(after).toContain("      ~ { className: active === 'home' ? 'on' : '', onClick: () => setActive('home'), text: 'Home' },")
    expect(after).toContain('      ~ ] key button.text\n      button(type="button" className={button.className} onClick={button.onClick}) #{button.text}')
    expectCompiles(path, after)
  })

  test('differing props of copies are typed from each copy', () => {
    const { analysis } = analyzeFile(join(ROOT, 'test/fixtures/App.btsx'))
    const copy = analysis.suggestions.find((s) => s.kind === 'duplicate')!
    expect(Object.fromEntries(copy.props.map((p) => [p.name, p.type]))).toMatchObject({
      className: 'string',
      onClick: '() => Promise<void>',
      text: "'Copied' | 'Copy'",
    })
  })
})

describe('renaming before applying', () => {
  test('a chosen name renames the component, its props interface, and every call', async () => {
    const { renameSuggestion } = await import('./analyze.ts')
    const { analysis } = analyzeFile(join(ROOT, 'test/fixtures/App.btsx'))
    const renamed = renameSuggestion(analysis.suggestions.find((s) => s.name === 'LeftArticle')!, 'InputCard')
    expect(renamed.propsType).toBe('InputCardProps')
    expect(renamed.snippet).toContain('interface InputCardProps {')
    expect(renamed.snippet).toContain('component InputCard\n  props { active, copyNote, copiedSide }: InputCardProps')
    expect(renamed.usages[0]).toStartWith('InputCard(')
  })

  test('a chosen array name renames the mapping', async () => {
    const { renameSuggestion } = await import('./analyze.ts')
    const path = join(scratch, 'Links.btsx')
    writeFileSync(path, ['ul', '  li Home', '  li Docs', '  li Blog', ''].join('\n'))
    const { analysis } = analyzeFile(path)
    const renamed = renameSuggestion(analysis.suggestions.find((s) => s.kind === 'map')!, 'pages')
    expect(renamed.usage).toBe('  each item in pages key item.text\n    li #{item.text}')
    expect(renamed.snippet).toContain('const pages = [')
  })
})
