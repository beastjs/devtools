import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileBeastResult, parse } from 'beast-tsrx'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import { analyzeDocument } from './analyze.ts'
import { emptyStyleEdits, removeEmptyStyles } from './empty-styles.ts'
import { BeastProject } from './project.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function cleanup(source: string, location = '1:1') {
  const after = removeEmptyStyles(parse(source), source, location)
  expect(() => compileBeastResult(after, { filename: 'App.btsx' })).not.toThrow()
  return after
}

test('removes empty objects and strings, with or without unrelated attributes', () => {
  expect(cleanup('div(style={{}}) Hello\n  span Child\n')).toBe('div Hello\n  span Child\n')
  expect(cleanup('div(style={{ /* no styles */ }} title="Hi" onClick={() => {}}) Text\n')).toBe('div(title="Hi" onClick={() => {}}) Text\n')
  expect(cleanup('div(title="Hi" style={{}})\n')).toBe('div(title="Hi")\n')
  expect(cleanup('div(title="Hi" style={{}} hidden)\n')).toBe('div(title="Hi" hidden)\n')
  expect(cleanup('div(style="")\n')).toBe('div\n')
  expect(cleanup('div(style={" "})\n')).toBe('div\n')
})

test('removes continuation lines and preserves other attributes, text, children and CRLF', () => {
  expect(cleanup('div(\n  ~ style={{}}\n  ~ title="Hi"\n  ~ ) Text\n  span Child\n')).toBe('div(\n  ~ title="Hi"\n  ~ ) Text\n  span Child\n')
  expect(cleanup('div(\r\n  ~ style={{}}\r\n  ~ ) Hello\r\n  span Child\r\n')).toBe('div Hello\r\n  span Child\r\n')
})

test('detects native styles in local components and control flow but leaves style props and computed styles alone', () => {
  const source = 'component Card\n  if true\n    div(style={{}})\nCard(style={{}})\ndiv(style={{ width: "1px" }})\ndiv(style={styles})\ndiv(style={{ ...styles }})\ndiv(style={getStyle()})\n'
  const document = parse(source)
  expect([...emptyStyleEdits(document, source).keys()]).toEqual(['3:5'])
  const suggestions = analyzeDocument(document, source, 'App', DEFAULT_SETTINGS).suggestions.filter((suggestion) => suggestion.kind === 'empty-style')
  expect(suggestions).toHaveLength(1)
  expect(suggestions[0]!.host).toBe('Card')
  expect(suggestions[0]!.usage).toBe('    div')
  expect(() => removeEmptyStyles(document, source, '4:1')).toThrow('no longer has an empty style')
})

test('cleanup refactor previews, applies, disappears from analysis, and undoes exact bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'beast-empty-style-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const path = join(root, 'src/App.btsx')
  const source = 'div.card(style={{}} title="Hi")\n  span Child\n'
  writeFileSync(path, source)
  const project = new BeastProject({ root, include: ['src'], exclude: [] })
  const file = project.file('src/App.btsx', DEFAULT_SETTINGS)!
  const suggestion = file.analysis!.suggestions.find((suggestion) => suggestion.kind === 'empty-style')!
  const request = { path: file.path, hash: file.hash, settings: DEFAULT_SETTINGS, suggestionId: suggestion.id, target: 'inline' as const, dryRun: true }
  const preview = project.apply(request)
  expect(preview.undoId).toBeNull()
  expect(preview.files[0]!.removed).toBeGreaterThan(0)
  expect(readFileSync(path, 'utf8')).toBe(source)
  expect(() => project.apply({ ...request, target: 'file' })).toThrow('in place')
  const result = project.apply({ ...request, dryRun: false })
  expect(readFileSync(path, 'utf8')).toBe('div.card(title="Hi")\n  span Child\n')
  expect(project.file(file.path, DEFAULT_SETTINGS)!.analysis!.suggestions.some((suggestion) => suggestion.kind === 'empty-style')).toBe(false)
  expect(() => project.apply({ ...request, dryRun: false })).toThrow('changed')
  project.undo(result.undoId!)
  expect(readFileSync(path, 'utf8')).toBe(source)
})
