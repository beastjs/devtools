import { describe, expect, test } from 'bun:test'
import type { RuntimeNode } from './runtime.ts'
import { findWrappers, treeRows } from './tree.ts'

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
