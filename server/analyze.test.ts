import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { compileBeastResult } from 'beast-tsrx'
import { createOctaneCompiler } from 'octane/compiler/bundler'
import type { AnalyzerSettings, FileAnalysis, RefactorSuggestion } from '../shared/types.ts'
import { analyzeDocument } from './analyze.ts'
import { buildLineMap } from './line-map.ts'
import { hookCall, identifiersIn, parsePropsParameter, patternNames, topLevelDeclarations } from './source-scan.ts'

const APP = readFileSync(new URL('../test/fixtures/App.btsx', import.meta.url), 'utf8')

function analyze(source: string, settings: Partial<AnalyzerSettings> = {}, name = 'Fixture'): FileAnalysis {
  const { ast } = compileBeastResult(source, { filename: `${name}.btsx`, componentName: name })
  return analyzeDocument(ast, source, name, { depthLimit: 5, minLines: 8, fileLines: 30, ...settings })
}

/** Apply a suggestion the way a developer would: insert the component, replace the section. */
function apply(source: string, suggestion: RefactorSuggestion): string {
  const lines = source.split('\n')
  const replaced = [
    ...lines.slice(0, suggestion.startLine - 1),
    suggestion.usage,
    ...lines.slice(suggestion.endLine),
  ]
  const at = suggestion.insertBeforeLine - 1
  return [...replaced.slice(0, at), ...suggestion.snippet.split('\n'), ...replaced.slice(at)].join('\n')
}

function compilesThroughOctane(source: string, name: string): void {
  const { code } = compileBeastResult(source, { filename: `${name}.btsx`, componentName: name })
  const octane = createOctaneCompiler({ root: process.cwd(), environment: 'client', hmr: false, dev: false })
  expect(octane.transform(code, `/virtual/${name}.tsrx`, { environment: 'client' })).not.toBeNull()
}

describe('source scanning', () => {
  test('identifiersIn skips property names, keywords, and string contents', () => {
    const names = identifiersIn("copyNote('left', active.left.note) ?? `tab-${panel.id}` + typeof x")
    expect([...names].sort()).toEqual(['active', 'copyNote', 'panel', 'x'])
  })

  test('identifiersIn keeps spread targets and optional-chain roots', () => {
    expect([...identifiersIn('{...cardProps} ref?.current')].sort()).toEqual(['cardProps', 'ref'])
  })

  test('patternNames handles nested, renamed, defaulted, and rest bindings', () => {
    expect(patternNames('{ a, b: renamed, c = 1, d: [e, ...f], ...rest }')).toEqual(['a', 'renamed', 'c', 'e', 'f', 'rest'])
  })

  test('topLevelDeclarations ignores declarations nested in function bodies', () => {
    const code = [
      "const [count, setCount] = useState<number>(0);",
      'const save = async () => { const inner = 1; await send(inner); };',
      'function helper() { let hidden = 2 }',
    ].join('\n')
    expect(topLevelDeclarations(code).map((d) => d.names)).toEqual([['count', 'setCount'], ['save'], ['helper']])
  })

  test('parsePropsParameter splits names from the type annotation', () => {
    expect(parsePropsParameter('{ user, compact = false }: { user: User; compact?: boolean }')).toEqual({
      names: ['user', 'compact'],
      type: '{ user: User; compact?: boolean }',
    })
  })

  test('hookCall reads generic type arguments', () => {
    expect(hookCall("useState<PanelSide | null>(null)")).toEqual({ hook: 'useState', typeArgument: 'PanelSide | null', argument: 'null' })
    expect(hookCall('useRef<Map<string, number>>(new Map())')?.typeArgument).toBe('Map<string, number>')
    expect(hookCall('panels.find(Boolean)')).toBeNull()
  })
})

describe('line map', () => {
  test('maps the App component header both ways', () => {
    const { code, map } = compileBeastResult(APP, { filename: 'App.btsx', componentName: 'App' })
    const generated = code.split('\n')
    const { tsrxToBtsx, btsxToTsrx } = buildLineMap(map, generated.length, APP.split('\n').length)
    const mainLine = APP.split('\n').findIndex((line) => line.startsWith('main(')) + 1
    const targets = btsxToTsrx[mainLine - 1]!
    expect(targets.length).toBeGreaterThan(0)
    expect(generated[targets[0]! - 1]).toContain('<main')
    expect(tsrxToBtsx[targets[0]! - 1]).toBe(mainLine)
  })
})

describe('refactor analyzer', () => {
  const analysis = analyze(APP, {}, 'App')

  test('measures structural depth per line, including continuation lines', () => {
    const lines = APP.split('\n')
    const depthOf = (prefix: string) => analysis.lineDepths[lines.findIndex((line) => line.trimStart().startsWith(prefix))]
    expect(depthOf('main(')).toBe(0)
    expect(depthOf('~ aria-labelledby="showcase-title"')).toBe(1)
    expect(depthOf('li(')).toBe(7)
    expect(depthOf('setup')).toBeNull()
    expect(analysis.maxDepth).toBe(7)
    expect(analysis.indentUnit).toBe(2)
  })

  test('suggests extracting the deep sections with inferred, typed props', () => {
    const extracts = analysis.suggestions.filter((s) => s.kind === 'extract')
    expect(extracts.map((s) => s.name)).toEqual(['AppHeader', 'LeftArticle', 'RightArticle'])
    const header = extracts[0]!
    expect(header.props).toEqual([
      { name: 'activeId', type: 'PanelId' },
      { name: 'setActiveId', type: '(value: PanelId) => void' },
      { name: 'setCopiedSide', type: '(value: PanelSide | null) => void' },
    ])
    expect(header.snippet.split('\n').slice(0, 2)).toEqual(['module', '  interface AppHeaderProps {'])
    expect(header.snippet).toContain('\ncomponent AppHeader\n  props { activeId, setActiveId, setCopiedSide }: AppHeaderProps\n')
    expect(header.usage.trim()).toBe('AppHeader(activeId={activeId} setActiveId={setActiveId} setCopiedSide={setCopiedSide})')
  })

  test('finds the structurally identical copy-note blocks', () => {
    const duplicate = analysis.suggestions.find((s) => s.kind === 'duplicate')
    expect(duplicate?.name).toBe('CopyNote')
    expect(duplicate?.occurrences).toHaveLength(2)
  })

  test('applied extraction suggestions still compile through Beast and Octane', () => {
    for (const suggestion of analysis.suggestions.filter((s) => s.kind === 'extract')) {
      compilesThroughOctane(apply(APP, suggestion), 'App')
    }
  })

  test('keeps a hoisted loop key at the call site', () => {
    const source = [
      'props { groups }: { groups: { id: string; items: string[] }[] }',
      '.list',
      '  each group in groups',
      '    .group(key={group.id})',
      '      h2 Title',
      '      ul',
      '        each item in group.items',
      '          li #{item}',
      '',
    ].join('\n')
    const [suggestion] = analyze(source, { depthLimit: 3, minLines: 4 }).suggestions
    expect(suggestion?.name).toBe('Group')
    expect(suggestion?.usage.trim()).toBe('Group(key={group.id} group={group})')
    expect(suggestion?.body.split('\n')[0]).toBe('.group')
    compilesThroughOctane(apply(source, suggestion!), 'Fixture')
  })

  test('stays quiet about shallow components', () => {
    const shallow = analyze('section\n  h1 Title\n  p Body\n')
    expect(shallow.suggestions).toEqual([])
    expect(shallow.maxDepth).toBe(1)
  })
})
