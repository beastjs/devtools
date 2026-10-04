import { describe, expect, test } from 'bun:test'
import type { RuntimeNode } from './runtime.ts'
import { findWrappers, treeRows, sourceSelections } from './tree.ts'
import type { ComponentLocation } from '../shared/types.ts'

let nextId = 1
function node(name: string, children: RuntimeNode[] = [], kind = 'component'): RuntimeNode {
  const controlFlow = name.startsWith('@')
  return { id: nextId++, name, label: name, kind, controlFlow, children }
}
const names = (nodes: readonly RuntimeNode[]) => nodes.map((item) => item.name)

describe('findWrappers', () => {
  test('hides the providers above the entry component and keeps their other children', () => {
    const app = node('App', [node('Header')])
    const toaster = node('Toaster')
    const roots = [node('Root', [node('ThemeProvider', [node('QueryProvider', [app, toaster])])], 'root')]
    const wrappers = findWrappers(roots, ['App'], true)
    expect(names(wrappers!.chain)).toEqual(['Root', 'ThemeProvider', 'QueryProvider'])
    expect(names(wrappers!.tops)).toEqual(['App', 'Toaster'])
  })

  test('skips an entry import that is itself a provider', () => {
    const roots = [node('AppProviders', [node('App')], 'root')]
    expect(names(findWrappers(roots, ['AppProviders', 'App'], true)!.tops)).toEqual(['App'])
  })

  test('finds the entry through control-flow scopes when they are hidden', () => {
    const roots = [node('Providers', [node('@if', [node('App')])], 'root')]
    expect(names(findWrappers(roots, ['App'], false)!.chain)).toEqual(['Providers'])
  })

  test('returns null when the entry is the root', () => {
    expect(findWrappers([node('App', [node('Header')], 'root')], ['App'], true)).toBeNull()
  })

  test('without entry names, descends through provider-named components only', () => {
    const app = node('App', [node('Header')])
    const roots = [node('ThemeProvider', [node('RouterProvider', [app])], 'root')]
    expect(names(findWrappers(roots, [], true)!.tops)).toEqual(['App'])
    expect(findWrappers([node('App', [node('Header')], 'root')], [], true)).toBeNull()
  })
})

test('treeRows reports child counts and marks wrappers', () => {
  const header = node('Header')
  const app = node('App', [header])
  const provider = node('ThemeProvider', [app], 'root')
  const rows = treeRows([provider], new Set([app.id]), true, '', new Set([provider.id]))
  expect(rows.map((row) => [row.node.name, row.depth, row.childCount, row.open, row.wrapper])).toEqual([
    ['ThemeProvider', 0, 1, true, true],
    ['App', 1, 1, false, false],
  ])
})

test('block view groups each instances once and leaves unrelated siblings and tree view intact', () => {
  const items = [node('__item$1', [node('Card')], 'control-flow'), node('__item$1', [node('Card')], 'control-flow'), node('__item$9', [node('Other')], 'control-flow')]
  items.forEach((item) => { item.controlFlow = true; item.label = '@item' })
  const app = node('App', [...items, node('Card'), node('Card')])
  const blocks = treeRows([app], new Set(), true, '', new Set(), true)
  expect(blocks.filter((row) => row.mappedCount !== null).map((row) => [row.node.name, row.mappedCount])).toEqual([['__item$1', 2], ['__item$9', 1]])
  expect(blocks.filter((row) => row.node.name === 'Card')).toHaveLength(3)
  expect(treeRows([app], new Set(), true, '').filter((row) => row.node.name === '__item$1')).toHaveLength(2)
  expect(treeRows([app], new Set(), false, '', new Set(), true).filter((row) => row.mappedCount !== null)).toHaveLength(2)
})

test('group search finds a match in a later instance and reports the full count', () => {
  const items = [node('__item$1', [node('Empty')]), node('__item$1', [node('Match')])]
  items.forEach((item) => { item.controlFlow = true; item.label = '@item' })
  const rows = treeRows([node('App', items)], new Set(), true, 'match', new Set(), true)
  expect(rows.find((row) => row.mappedCount !== null)?.mappedCount).toBe(2)
  expect(rows.some((row) => row.node.name === 'Match')).toBe(true)
})

test('resolves generated scopes through their owner and refuses ambiguous component names', () => {
  const scope = node('__item$1', [node('Card')], 'control-flow')
  scope.controlFlow = true
  const app = node('App', [scope])
  const location: ComponentLocation = { name: 'App', path: 'src/App.btsx', absolutePath: '/app/src/App.btsx', line: 1, column: 1, local: false, hooks: [],
    blocks: [{ host: 'App', scope: '__item$1', kind: 'each', startLine: 5, endLine: 8, indent: '  ' }] }
  expect(sourceSelections([app], [location]).get(scope.id)?.selection).toEqual({ path: 'src/App.btsx', host: 'App', line: 5, kind: 'each' })
  expect(sourceSelections([app], [location, { ...location, path: 'src/Other.btsx' }]).has(scope.id)).toBe(false)
})

test('Octane descriptor wrappers disappear from blocks while tree view can inspect their owner', () => {
  const header = node('HeaderSection')
  const inner = node('deoptItemBody', [header])
  const outer = node('hostElementBody', [inner])
  const app = node('App', [outer])
  const location: ComponentLocation = { name: 'App', path: 'src/App.btsx', absolutePath: '/app/src/App.btsx', line: 12, column: 1, local: false, hooks: [],
    blocks: [{ host: 'App', scope: 'App', kind: 'component', startLine: 1, endLine: 80, indent: '' }] }
  expect(treeRows([app], new Set(), true, '', new Set(), true).map((row) => [row.node.name, row.depth])).toEqual([['App', 0], ['HeaderSection', 1]])
  expect(treeRows([app], new Set(), true, '').map((row) => row.node.name)).toEqual(['App', 'hostElementBody', 'deoptItemBody', 'HeaderSection'])
  const sources = sourceSelections([app], [location])
  expect(sources.get(outer.id)?.selection).toEqual({ path: location.path, host: 'App', line: 1, kind: 'component' })
  expect(sources.get(inner.id)?.selection).toEqual(sources.get(app.id)?.selection)
  expect(sources.has(header.id)).toBe(false)
})

test('component selection works without generated scope metadata and uses the local declaration line', () => {
  const local = node('Card')
  const location: ComponentLocation = { name: 'Card', path: 'src/App.btsx', absolutePath: '/app/src/App.btsx', line: 24, column: 1, local: true, hooks: [] }
  expect(sourceSelections([local], [location]).get(local.id)?.selection).toEqual({ path: location.path, host: 'Card', line: 24, kind: 'component' })
})
