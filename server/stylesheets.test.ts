import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BeastProject } from './project.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beast-css-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const project = new BeastProject({ root, include: ['src'], exclude: [join(root, 'overlay')] })
  const write = (path: string, text: string) => writeFileSync(join(root, path), text)
  return { root, project, write }
}

test('discovers authored CSS outside src and reports syntax errors without losing other files', () => {
  const { root, project, write } = fixture()
  for (const dir of ['public', 'theme', 'node_modules', 'dist', 'overlay']) mkdirSync(join(root, dir))
  for (const file of ['reset.css', 'src/app.css', 'public/public.css', 'theme/dark.css', 'node_modules/vendor.css', 'dist/bundle.css', 'overlay/devtools.css']) write(file, '.card { color: red; }')
  write('src/broken.css', '.broken { color:')
  const { files } = project.stylesheets()
  expect(files.map((file) => file.path)).toEqual(['public/public.css', 'reset.css', 'src/app.css', 'src/broken.css', 'theme/dark.css'])
  expect(files.find((file) => file.path === 'src/broken.css')?.error).toBeTruthy()
  expect(files.find((file) => file.path === 'src/app.css')?.rules[0]).toMatchObject({ selector: '.card', line: 1, column: 1, declarations: [{ name: 'color', value: 'red' }] })
})

test('captures nested contexts, custom properties, duplicate rules and important declarations', () => {
  const { project, write } = fixture()
  write('src/app.css', '.card { --brand: teal; color: var(--brand) !important; }\n@media (min-width: 600px) {\n  .card { width: 20px; }\n}\n.card { & > .title { color: navy; } }')
  const file = project.stylesheets().files[0]!
  expect(file.rules[0]?.declarations).toEqual([{ name: '--brand', value: 'teal' }, { name: 'color', value: 'var(--brand) !important' }])
  expect(file.rules[1]).toMatchObject({ index: 1, line: 3, context: [{ name: 'media', params: '(min-width: 600px)' }] })
  expect(file.rules[3]).toMatchObject({ index: 3, selector: '& > .title', context: [{ name: 'nest', params: '.card' }] })
})

test('edits precisely one repeated selector, preserves formatting, supports repeated saves and undo without a Beast file', () => {
  const { root, project, write } = fixture()
  const css = '/* keep */\r\n.card { color: red; }\r\n@media (min-width: 600px) { .card { color: blue; padding: 4px; } }\r\n'
  write('src/app.css', css)
  const file = project.stylesheets().files[0]!
  const request = { path: file.path, hash: file.hash, index: 1, selector: '.card', declarations: { color: 'green !important', '--brand': 'teal' } }
  const first = project.editCssRule(request)
  const saved = readFileSync(join(root, file.path), 'utf8')
  expect(saved).toContain('.card { color: red; }\r\n')
  expect(saved).toContain('color: green !important')
  expect(saved).toContain('padding: 4px')
  expect(saved).toContain('--brand: teal')
  expect(() => project.editCssRule(request)).toThrow('CSS file changed')
  const second = project.editCssRule({ ...request, hash: first.file.hash, declarations: { color: null } })
  expect(second.file.rules[1]?.declarations.some((declaration) => declaration.name === 'color')).toBe(false)
  project.undo(second.undoId)
  expect(readFileSync(join(root, file.path), 'utf8')).toBe(saved)
  project.undo(first.undoId)
  expect(readFileSync(join(root, file.path), 'utf8')).toBe(css)
})

test('refuses outside paths, symlinks, mismatched rules, injected declarations and undo conflicts', () => {
  const { root, project, write } = fixture()
  const other = fixture()
  write('src/app.css', '.card { color: red; }')
  other.write('src/outside.css', '.card { color: blue; }')
  symlinkSync(join(other.root, 'src/outside.css'), join(root, 'src/link.css'))
  expect(project.stylesheets().files.map((file) => file.path)).toEqual(['src/app.css'])
  const file = project.stylesheets().files[0]!
  const request = { path: file.path, hash: file.hash, index: 0, selector: '.card', declarations: { color: 'green' } }
  expect(() => project.editCssRule({ ...request, path: '../outside.css' })).toThrow('project CSS')
  expect(() => project.editCssRule({ ...request, path: 'src/link.css' })).toThrow('project CSS')
  expect(() => project.editCssRule({ ...request, selector: '.other' })).toThrow('No CSS rule')
  expect(() => project.editCssRule({ ...request, index: 5 })).toThrow('No CSS rule')
  expect(() => project.editCssRule({ ...request, declarations: { color: 'red; width: 10px' } })).toThrow('Invalid CSS declaration')
  expect(() => project.editCssRule({ ...request, declarations: { 'bad;property': 'red' } })).toThrow('Invalid CSS property')
  expect(readFileSync(join(root, file.path), 'utf8')).toBe('.card { color: red; }')
  const result = project.editCssRule(request)
  write(file.path, '.card { color: purple; }')
  expect(() => project.undo(result.undoId)).toThrow('edited after')
  expect(readFileSync(join(root, file.path), 'utf8')).toContain('purple')
})
