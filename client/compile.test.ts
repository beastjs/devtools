import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { compileBeastResult, componentNameFromPath, mapGeneratedError } from 'beast-tsrx'
import { createOctaneCompiler } from 'octane/compiler/bundler'

// The overlay only compiles under `vite dev`, so `vite build` never sees it.
// Compile every overlay component through Beast and Octane here instead.
const dir = new URL('.', import.meta.url).pathname
const octane = createOctaneCompiler({ root: process.cwd(), environment: 'client', hmr: false, dev: true })

for (const filename of [dir, new URL('../components/', import.meta.url).pathname].flatMap((folder) => readdirSync(folder).filter((file) => file.endsWith('.btsx')).map((file) => `${folder}${file}`))) {
  const name = filename.split('/').at(-1)!
  test(`${name} compiles through Beast and Octane`, () => {
    const source = readFileSync(filename, 'utf8')
    const { code, map } = compileBeastResult(source, { filename, componentName: componentNameFromPath(filename) })
    try {
      expect(octane.transform(code, filename.replace(/\.btsx$/, '.tsrx'), { environment: 'client', dev: true })).not.toBeNull()
    } catch (error) {
      throw mapGeneratedError(error, map, source, filename)
    }
  })
}
