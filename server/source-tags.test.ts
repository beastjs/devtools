import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { compileBeastResult } from 'beast-tsrx'
import { createOctaneCompiler } from 'octane/compiler/bundler'
import { isTaggable, tagSource } from './source-tags.ts'

const FIXTURE = readFileSync(new URL('../test/fixtures/App.btsx', import.meta.url), 'utf8')

describe('tagSource', () => {
  test('tags elements with their component and location, leaving component calls alone', () => {
    const source = `module
  const items = ['a']

component Badge
  props { label }: { label: string }
  span.badge #{label}

main#app.shell
  h1 Title
  button(
    ~ type="button"
    ~ )
    | Go
  each item in items key item
    Badge(label={item})
`
    const lines = tagSource(source, '/app/src/Page.btsx', 'src/Page.btsx').split('\n')
    expect(lines).toHaveLength(source.split('\n').length)
    expect(lines[5]).toBe('  span.badge(data-beast-src="src/Page.btsx:6:3" data-beast-component="Badge") #{label}')
    expect(lines[7]).toBe('main#app.shell(data-beast-src="src/Page.btsx:8:1" data-beast-component="Page")')
    expect(lines[8]).toBe('  h1(data-beast-src="src/Page.btsx:9:3" data-beast-component="Page") Title')
    expect(lines[9]).toBe('  button(data-beast-src="src/Page.btsx:10:3" data-beast-component="Page" ')
    expect(lines[14]).toBe('    Badge(label={item})')
  })

  test('leaves unparsable sources for Beast to report', () => {
    const broken = 'div(class="x"\n'
    expect(tagSource(broken, '/app/src/Broken.btsx', 'src/Broken.btsx')).toBe(broken)
  })

  test('keeps attribute values plain string literals', () => {
    const tagged = tagSource('div\n', '/app/src/A.btsx', `src/it's #{odd}.btsx`)
    expect(tagged).toBe('div(data-beast-src="src/it_s __odd_.btsx:1:1" data-beast-component="A")\n')
  })

  test('the tagged fixture compiles through Beast and Octane with the tags in its templates', () => {
    const tagged = tagSource(FIXTURE, '/app/src/App.btsx', 'src/App.btsx')
    expect(tagged).not.toBe(FIXTURE)
    const tsrx = compileBeastResult(tagged, { filename: '/app/src/App.btsx', componentName: 'App' })
    expect(tsrx.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    const compiler = createOctaneCompiler({ root: '/app', environment: 'client', dev: true, profile: true, hmr: false })
    const { code } = compiler.transform(tsrx.code, '/app/src/App.tsrx', { environment: 'client', dev: true })
    expect(code).toMatch(/_\$template\("<main data-beast-src=\\"src\/App\.btsx:\d+:1\\" data-beast-component=\\"App\\"/)
  })
})

test('isTaggable skips the overlay and installed packages', () => {
  expect(isTaggable('/app/src/App.btsx', '/devtools')).toBe(true)
  expect(isTaggable('/app/src/main.ts', '/devtools')).toBe(false)
  expect(isTaggable('/devtools/client/BeastDevtools.btsx', '/devtools')).toBe(false)
  expect(isTaggable('/app/node_modules/ui/Card.btsx', '/devtools')).toBe(false)
})
