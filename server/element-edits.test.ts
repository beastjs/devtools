import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'beast-tsrx'
import { DEFAULT_SETTINGS, type ElementEditRequest } from '../shared/types.ts'
import { BeastProject } from './project.ts'
import { editElement } from './element-edits.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'beast-element-edit-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const filename = join(root, 'src/App.btsx')
  writeFileSync(filename, source)
  const project = new BeastProject({ root, include: ['src'], exclude: [] })
  const request: ElementEditRequest = { path: 'src/App.btsx', hash: project.file('src/App.btsx', DEFAULT_SETTINGS)!.hash, line: 1, column: 1, tag: 'div', group: 'attributes', name: 'title', value: 'Changed' }
  return { project, filename, request }
}

test('attribute edits save to disk, preserve handlers and interpolation, and undo restores exact bytes', () => {
  const source = 'setup\n  const name = "world";\n  const click = () => {};\ndiv.foo(title="Hello #{name}" onClick={click}) Hello #{name}\n'
  const { project, filename, request } = fixture(source)
  const result = project.editElement({ ...request, line: 4, name: 'id', value: 'card' })
  const after = readFileSync(filename, 'utf8')
  expect(after).toContain('title="Hello #{name}"')
  expect(after).toContain('onClick={click}')
  expect(after).toContain('id={"card"}')
  expect(after).toContain('#{name}')
  project.undo(result.undoId)
  expect(readFileSync(filename, 'utf8')).toBe(source)
})

test('layout dimensions preserve dynamic styles and continuation source line positions', () => {
  const source = 'setup\n  const color = "red";\ndiv(\n  ~ style={{ color }}\n  ~ )\n  span Child\n'
  const { project, filename, request } = fixture(source)
  project.editElement({ ...request, line: 3, group: 'styles', name: '', value: null, declarations: { width: '320px', 'margin-left': '12px' } })
  const after = readFileSync(filename, 'utf8')
  expect(after).toContain('...({ color })')
  expect(after).toContain('"width": "320px"')
  expect(after).toContain('"margin-left": "12px"')
  const node = parse(after).children[0]!
  expect(node.kind === 'element' && node.children[0]!.span.start.line).toBe(6)
})

test('class and id edits replace selector shorthand and attribute values safely', () => {
  const { project, filename, request } = fixture('div.old#old(className="extra") Hi\n')
  const result = project.editElement({ ...request, name: 'class', value: 'new #{literal}' })
  expect(readFileSync(filename, 'utf8')).toContain('div#old(class={"new #{literal}"})')
  project.editElement({ ...request, hash: result.hash, name: 'id', value: null })
  expect(readFileSync(filename, 'utf8')).not.toContain('#old')
})

test('property edits retain primitive types and text edits replace text children only', () => {
  const { project, filename, request } = fixture('div\n  | Old\n')
  const result = project.editElement({ ...request, group: 'properties', name: 'hidden', value: true })
  expect(readFileSync(filename, 'utf8')).toContain('hidden={true}')
  project.editElement({ ...request, hash: result.hash, group: 'properties', name: 'textContent', value: 'New "text" #{literal}' })
  expect(readFileSync(filename, 'utf8')).not.toContain('| Old')
  expect(readFileSync(filename, 'utf8')).toContain('New \\"text\\" #{literal}')
})

test('stale writes and undo conflicts leave external edits untouched', () => {
  const { project, filename, request } = fixture('div Original\n')
  const result = project.editElement(request)
  expect(() => project.editElement(request)).toThrow('changed')
  writeFileSync(filename, 'div External edit\n')
  expect(() => project.undo(result.undoId)).toThrow('edited after')
  expect(readFileSync(filename, 'utf8')).toBe('div External edit\n')
})

test('reject missing elements, injected attributes, non-project paths and replacing child elements', () => {
  const { project, request } = fixture('div\n  span Child\n')
  expect(() => project.editElement({ ...request, tag: 'span' })).toThrow('changed')
  expect(() => project.editElement({ ...request, name: 'onclick' })).toThrow('cannot be saved')
  expect(() => project.editElement({ ...request, path: '../outside.btsx' })).toThrow('Unknown')
  expect(() => project.editElement({ ...request, group: 'properties', name: 'textContent' })).toThrow('child elements')
})

test('literal styles use browser-normalized CSS and preserve unrelated attributes', () => {
  const source = 'div(style="color: red; width: 10px" title="hi")\n'
  const { project, filename, request } = fixture(source)
  project.editElement({ ...request, group: 'styles', name: 'width', value: null, declarations: { width: null }, cssText: 'color: red;' })
  expect(readFileSync(filename, 'utf8')).toContain('style={"color: red;"}')
  expect(readFileSync(filename, 'utf8')).toContain('title="hi"')
})

test('elements in local components and control flow can be located', () => {
  const source = 'component Card\n  if true\n    div Hello\nCard\n'
  const request: ElementEditRequest = { path: 'src/App.btsx', hash: '', line: 3, column: 5, tag: 'div', group: 'attributes', name: 'title', value: 'Saved' }
  expect(editElement(parse(source), source, request)).toContain('title={"Saved"}')
})

test('boolean attributes and reflected properties preserve DOM semantics', () => {
  const { project, filename, request } = fixture('input(readonly)\n')
  const result = project.editElement({ ...request, tag: 'input', group: 'properties', name: 'readOnly', value: false })
  expect(readFileSync(filename, 'utf8')).toContain('readOnly={false}')
  expect(readFileSync(filename, 'utf8')).not.toContain('(readonly ')
  project.editElement({ ...request, hash: result.hash, tag: 'input', name: 'disabled', value: '' })
  expect(readFileSync(filename, 'utf8')).toContain('disabled={true}')
})

test('computed style strings are refused rather than losing expressions', () => {
  const source = 'setup\n  const color = "red";\ndiv(style={`color: ${color}`})\n'
  const { project, filename, request } = fixture(source)
  expect(() => project.editElement({ ...request, line: 3, group: 'styles', declarations: { width: '10px' }, cssText: 'color: red; width: 10px;' })).toThrow('computed outside')
  expect(readFileSync(filename, 'utf8')).toBe(source)
})
