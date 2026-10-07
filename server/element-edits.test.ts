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
  expect(after).toContain('style={{ color,')
  expect(after).not.toContain('...(')
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


test('repeated inline edits replace camelCase aliases and removal deletes the member', () => {
  const source = 'setup\n  const color = "red";\ndiv(style={{ color, marginLeft: "2px", width: "10px" }})\n'
  const { project, filename, request } = fixture(source)
  const first = project.editElement({ ...request, line: 3, group: 'styles', declarations: { width: '20px', 'margin-left': '5px' } })
  const second = project.editElement({ ...request, hash: first.hash, line: 3, group: 'styles', declarations: { width: '30px' } })
  const after = readFileSync(filename, 'utf8')
  expect(after).not.toContain('10px')
  expect(after).not.toContain('20px')
  expect(after).not.toContain('marginLeft')
  expect(after).toContain('color,')
  expect(after.match(/"width"/g)).toHaveLength(1)
  project.editElement({ ...request, hash: second.hash, line: 3, group: 'styles', declarations: { width: null } })
  expect(readFileSync(filename, 'utf8')).not.toContain('width')
})

test('old spread wrappers are flattened while unrelated dynamic values survive', () => {
  const source = 'setup\n  const color = "red";\ndiv(style={{ ...({ ...({ color, width: "10px" }), "width": "20px" }), "width": "30px" }})\n'
  const { project, filename, request } = fixture(source)
  project.editElement({ ...request, line: 3, group: 'styles', declarations: { width: '40px' } })
  const after = readFileSync(filename, 'utf8')
  expect(after).toContain('style={{ color, "width": "40px" }}')
})

test('Tailwind replaces conflicting utilities, preserves variants, and supports repeated edits', () => {
  const { project, filename, request } = fixture('div.card(className="w-10 hover:w-20 p-4 text-red-500 text-lg")\n')
  const first = project.editElement({ ...request, group: 'styles', styleTarget: 'tailwind', declarations: { width: '30px', 'padding-left': '8px', color: 'blue' } })
  const after = readFileSync(filename, 'utf8')
  expect(after).not.toContain(' w-10')
  expect(after).toContain('hover:w-20')
  expect(after).toContain('text-lg')
  expect(after).not.toContain('text-red-500')
  expect(after).toContain('pt-4 pr-4 pb-4')
  expect(after).toContain('pl-[8px]')
  const second = project.editElement({ ...request, hash: first.hash, group: 'styles', styleTarget: 'tailwind', declarations: { width: '40px' } })
  expect(readFileSync(filename, 'utf8')).not.toContain('w-[30px]')
  expect(readFileSync(filename, 'utf8')).toContain('w-[40px]')
  project.editElement({ ...request, hash: second.hash, group: 'styles', styleTarget: 'tailwind', declarations: { width: null } })
  expect(readFileSync(filename, 'utf8')).not.toContain('w-[40px]')
})

test('CSS file edits replace declarations and undo restores both files exactly', () => {
  const source = 'div.card(style={{ width: "5px", color: "red" }})\n'
  const { project, filename, request } = fixture(source)
  const cssPath = join(filename, '../styles.css')
  const css = '.card { width: 10px; color: blue; width: 20px; }\n.other { width: 1px; }\n'
  writeFileSync(cssPath, css)
  const result = project.editElement({ ...request, group: 'styles', styleTarget: 'css', cssPath: 'src/styles.css', cssSelector: '.card', declarations: { width: '30px !important' } })
  const after = readFileSync(cssPath, 'utf8')
  expect(after).toContain('width: 30px !important')
  expect(after).not.toContain('20px')
  expect(after).not.toContain('10px')
  expect(after).toContain('.other { width: 1px; }')
  expect(readFileSync(filename, 'utf8')).not.toContain('width')
  project.undo(result.undoId)
  expect(readFileSync(filename, 'utf8')).toBe(source)
  expect(readFileSync(cssPath, 'utf8')).toBe(css)
})

test('missing or ambiguous CSS selectors and computed Tailwind classes leave files untouched', () => {
  const source = 'setup\n  const classes = "w-10";\ndiv(className={classes})\n'
  const { project, filename, request } = fixture(source)
  const cssPath = join(filename, '../styles.css')
  writeFileSync(cssPath, '.card { width: 10px; }\n@media (min-width: 10px) { .card { width: 20px; } }')
  const edit = { ...request, line: 3, group: 'styles' as const, declarations: { width: '30px' } }
  expect(() => project.editElement({ ...edit, styleTarget: 'tailwind' })).toThrow('literal className')
  expect(() => project.editElement({ ...edit, styleTarget: 'css', cssPath: 'src/styles.css', cssSelector: '.missing' })).toThrow('No CSS rule')
  expect(() => project.editElement({ ...edit, styleTarget: 'css', cssPath: 'src/styles.css', cssSelector: '.card' })).toThrow('more than once')
  expect(readFileSync(filename, 'utf8')).toBe(source)
})

test('Tailwind keeps independent utility families and replaces enum utilities', () => {
  const { project, filename, request } = fixture('div(className="bg-cover bg-red-500 bg-[url(image.png)] font-sans font-bold text-lg text-red-500 items-center border-solid border-2 border-red-500 size-10")\n')
  project.editElement({ ...request, group: 'styles', styleTarget: 'tailwind', declarations: {
    'background-color': 'blue', 'font-weight': '500', 'font-size': '14px', 'align-items': 'flex-end', 'border-style': 'dashed', width: '40px',
  } })
  const after = readFileSync(filename, 'utf8')
  for (const token of ['bg-cover', 'bg-[url(image.png)]', 'font-sans', 'text-red-500', 'border-2', 'border-red-500', 'h-10', 'w-[40px]', 'items-end', 'border-dashed']) expect(after).toContain(token)
  for (const token of ['bg-red-500', 'font-bold', 'text-lg', 'items-center', 'border-solid', 'size-10']) expect(after).not.toContain(token)
})

test('saving to CSS removes only the edited property from inline CSS strings', () => {
  const { project, filename, request } = fixture('div(style="width: 10px; color: red;")\n')
  const cssPath = join(filename, '../styles.css')
  writeFileSync(cssPath, '.card { width: 20px; }')
  project.editElement({ ...request, group: 'styles', styleTarget: 'css', cssPath: 'src/styles.css', cssSelector: '.card', declarations: { width: '30px' } })
  expect(readFileSync(filename, 'utf8')).toContain('color: red;')
  expect(readFileSync(filename, 'utf8')).not.toContain('width')
  expect(readFileSync(cssPath, 'utf8')).toContain('width: 30px')
})

test('mapped object text edits change the selected array member and undo restores the source', () => {
  const source = 'module\n  const items = [{ title: "One", id: 1 }, { title: "Two", id: 2 }];\neach item in items key item.id\n  p #{item.title}\n'
  const { project, filename, request } = fixture(source)
  const edit = { ...request, line: 4, column: 3, tag: 'p', group: 'properties' as const, name: 'textContent', value: 'Updated "two" #{literal}', textContext: { value: 'Two', index: 1, count: 2 } }
  expect(project.elementTextSource(edit)).toMatchObject({ kind: 'array', label: 'items', path: filename, line: 2 })
  const result = project.editElement(edit)
  const after = readFileSync(filename, 'utf8')
  expect(after).toContain('title: "One", id: 1')
  expect(after).toContain('title: "Updated \\"two\\" #{literal}", id: 2')
  expect(after).toContain('p #{item.title}')
  expect(() => project.editElement(edit)).toThrow('changed')
  project.undo(result.undoId)
  expect(readFileSync(filename, 'utf8')).toBe(source)
})

test('mapped primitive arrays preserve instance identity for duplicate text and repeated edits', () => {
  const source = 'setup\n  const items = ["Same", "Same", "Last"];\neach item in items key item\n  p #{item}\n'
  const { project, filename, request } = fixture(source)
  const edit = { ...request, line: 4, column: 3, tag: 'p', group: 'properties' as const, name: 'innerText', value: 'Second', textContext: { value: 'Same', index: 1, count: 3 } }
  const first = project.editElement(edit)
  expect(readFileSync(filename, 'utf8')).toContain('["Same", "Second", "Last"]')
  project.editElement({ ...edit, hash: first.hash, value: 'Again', textContext: { ...edit.textContext, value: 'Second' } })
  expect(readFileSync(filename, 'utf8')).toContain('["Same", "Again", "Last"]')
  expect(readFileSync(filename, 'utf8')).toContain('p #{item}')
})

test('nested arrays, local components and aliases keep their mapping and source line positions', () => {
  const source = 'component List\n  setup\n    const data = [{ children: [{ title: "A" }, { title: "B" }] }];\n    const groups = data;\n  each group in groups key group\n    each item in group.children key item.title\n      p Name: #{item.title}!\nList\n'.replaceAll('\n', '\r\n')
  const { project, filename, request } = fixture(source)
  project.editElement({ ...request, line: 7, column: 7, tag: 'p', group: 'properties', name: 'textContent', value: 'Name: C!', textContext: { value: 'Name: B!', index: 1, count: 2 } })
  const after = readFileSync(filename, 'utf8')
  expect(after).toContain('title: "A" }, { title: "C"')
  expect(after).toContain('p Name: #{item.title}!')
  expect(after.split('\r\n')).toHaveLength(source.split('\r\n').length)
})

test('imported arrays provide their declaration link and cannot be replaced by template text', () => {
  const source = 'import { labels as items } from "./labels.ts"\neach item in items key item\n  p #{item}\n'
  const { project, filename, request } = fixture(source)
  const imported = join(filename, '../labels.ts')
  const data = '// Labels\nexport const labels = ["One", "Two"];\n'
  writeFileSync(imported, data)
  const edit = { ...request, line: 3, column: 3, tag: 'p', group: 'properties' as const, name: 'textContent', value: 'Changed', textContext: { value: 'Two', index: 1, count: 2 } }
  expect(project.elementTextSource(edit)).toMatchObject({ kind: 'imported', path: imported, line: 2, label: 'items' })
  expect(() => project.editElement(edit)).toThrow('imported')
  expect(readFileSync(filename, 'utf8')).toBe(source)
  expect(readFileSync(imported, 'utf8')).toBe(data)
})

test('imported array aliases and tsconfig path aliases still link to the data file', () => {
  const source = 'import { labels } from "@/labels"\nsetup\n  const items = labels;\neach item in items key item\n  p #{item}\n'
  const { project, filename, request } = fixture(source)
  writeFileSync(join(filename, '../../tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }))
  const imported = join(filename, '../labels.ts')
  writeFileSync(imported, 'export const labels = ["One"];\n')
  expect(project.elementTextSource({ ...request, line: 5, column: 3, tag: 'p', textContext: { value: 'One', index: 0, count: 1 } })).toMatchObject({ kind: 'imported', path: imported, label: 'labels' })
})

test('computed or ambiguous mapped text is refused without modifying the template or data', () => {
  for (const [source, line, value, count] of [
    ['setup\n  const items = ["Same", "Same"];\neach item in items key item\n  p #{item}\n', 4, 'Same', 1],
    ['setup\n  const items = ["One"];\neach item in items key item\n  p #{item.toUpperCase()}\n', 4, 'ONE', 1],
    ['module\n  const items = ["Module"];\nprops { items }: { items: string[] }\neach item in items key item\n  p #{item}\n', 5, 'Module', 1],
  ] as const) {
    const { project, filename, request } = fixture(source)
    expect(() => project.editElement({ ...request, line, column: 3, tag: 'p', group: 'properties', name: 'textContent', value: 'Changed', textContext: { value, index: 0, count } })).toThrow()
    expect(readFileSync(filename, 'utf8')).toBe(source)
  }
})
