import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { compileBeastResult } from 'beast-tsrx'
import { createApp } from '../test/dev-server.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import { pinBlockIndent } from '../shared/block-indent.ts'
import { BeastProject } from './project.ts'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const SOURCE = `module
  interface Item { id: string; name: string }
props {items}: {items: Item[]}
section
  each item in items key item.id
    p #{item.name}
  footer End
`
function fixture(source = SOURCE) {
  const app = createApp()
  cleanups.push(app.cleanup)
  writeFileSync(app.appPath, source)
  const project = new BeastProject({ root: app.root, include: ['src'], exclude: [] })
  return { app, project }
}

test('pins pasted margins and preserves internal nesting, including tabs and blank lines', () => {
  expect(pinBlockIndent('        div\n          span Child\n\n          p Text\n', '  ')).toBe('  div\n    span Child\n\n    p Text')
  expect(pinBlockIndent('div\n  p Child', '    ')).toBe('    div\n      p Child')
  expect(pinBlockIndent('\tdiv\n\t\tp Child', '  ')).toBe('  div\n    p Child')
})

test('maps authored scopes and derives the each item type', () => {
  const { project } = fixture()
  const location = project.report(DEFAULT_SETTINGS).components.find((component) => component.name === 'App')!
  const loop = location.blocks!.find((block) => block.scope?.startsWith('__item$'))!
  expect(loop).toMatchObject({ host: 'App', kind: 'each', startLine: 5, endLine: 6, indent: '  ', itemName: 'item', itemType: 'Item', iterable: 'items' })
  expect(project.sourceBlock({ path: 'src/App.btsx', host: 'App', line: 5, kind: 'each' }).code).toBe('  each item in items key item.id\n    p #{item.name}')
})

test('saves larger blocks at the original margin, keeps surrounding code, and supports undo', () => {
  const { project, app } = fixture()
  const selection = { path: 'src/App.btsx', host: 'App', line: 5, kind: 'each' }
  const original = project.sourceBlock(selection)
  const result = project.editBlock({ ...selection, hash: original.hash, code: '        each item in items key item.id\n          div\n            strong #{item.name}\n            p Added' })
  const after = readFileSync(app.appPath, 'utf8')
  expect(after).toContain('  each item in items key item.id\n    div\n      strong #{item.name}\n      p Added\n  footer End\n')
  expect(result.hash).not.toBe(original.hash)
  expect(result.block.endLine).toBe(8)
  expect(result.code).toContain('  each item')
  expect(() => compileBeastResult(after, { filename: app.appPath })).not.toThrow()
  project.undo(result.undoId)
  expect(readFileSync(app.appPath, 'utf8')).toBe(SOURCE)
})

test('rejects stale, invalid, empty and unknown edits without changing the file', () => {
  const { project, app } = fixture()
  const selection = { path: 'src/App.btsx', host: 'App', line: 5, kind: 'each' }
  const report = project.sourceBlock(selection)
  const request = { ...selection, hash: report.hash, code: 'each item in items key item.id\n  p Good' }
  expect(() => project.editBlock({ ...request, hash: 'stale' })).toThrow('file changed')
  expect(() => project.editBlock({ ...request, code: '' })).toThrow('cannot be empty')
  expect(() => project.editBlock({ ...request, code: 'each item in' })).toThrow()
  expect(() => project.editBlock({ ...request, line: 6, kind: 'each' })).toThrow('no longer available')
  expect(() => project.editBlock({ ...request, path: '../outside.btsx' })).toThrow('Unknown')
  expect(readFileSync(app.appPath, 'utf8')).toBe(SOURCE)
})

test('selects complete local components and keeps adjacent declarations intact', () => {
  const source = 'component Card\n  props {name}: {name: string}\n  div\n    span #{name}\n\ncomponent Other\n  p Other\n\nCard(name="Hello")\n'
  const { project, app } = fixture(source)
  const report = project.sourceBlock({ path: 'src/App.btsx', host: 'Card', line: 1, kind: 'component' })
  expect(report.code).toBe('component Card\n  props {name}: {name: string}\n  div\n    span #{name}')
  project.editBlock({ path: report.path, host: 'Card', line: 1, kind: 'component', hash: report.hash, code: report.code.replace('span', 'strong') })
  expect(readFileSync(app.appPath, 'utf8')).toContain('\n\ncomponent Other\n  p Other\n\nCard(name="Hello")\n')
})

test('preserves CRLF while rebasing edits', () => {
  const { project, app } = fixture(SOURCE.replaceAll('\n', '\r\n'))
  const selection = { path: 'src/App.btsx', host: 'App', line: 5, kind: 'each' }
  const report = project.sourceBlock(selection)
  project.editBlock({ ...selection, hash: report.hash, code: 'each item in items key item.id\n  strong #{item.name}' })
  expect(readFileSync(app.appPath, 'utf8')).toBe(SOURCE.replace('p #{item.name}', 'strong #{item.name}').replaceAll('\n', '\r\n'))
})

test('anchors the first line even when another pasted line tries to outdent it', () => {
  expect(pinBlockIndent('      div\n  p Sibling', '  ')).toBe('  div\n  p Sibling')
})

test('maps nested loops separately and derives types inside narrowed branches', () => {
  const { project } = fixture(`module
  interface Item { id: string; name: string }
  interface Group { id: string; items: Item[] }
props {groups}: {groups: Group[] | null}
main
  if groups
    each group in groups key group.id
      section
        each item in group.items key item.id
          p #{item.name}
`)
  const loops = project.report(DEFAULT_SETTINGS).components.find((component) => component.name === 'App')!.blocks!.filter((block) => block.scope?.startsWith('__item$'))
  expect(loops.map((block) => [block.startLine, block.endLine, block.itemType]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[7, 10, 'Group'], [9, 10, 'Item']])
})
