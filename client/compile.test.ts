import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { compileBeastResult, componentNameFromPath, mapGeneratedError } from 'beast-tsrx'
import { createOctaneCompiler } from 'octane/compiler/bundler'

// The overlay only compiles under `vite dev`, so `vite build` never sees it.
// Compile every overlay component through Beast and Octane here instead.
const dir = new URL('.', import.meta.url).pathname
const octane = createOctaneCompiler({ root: process.cwd(), environment: 'client', hmr: false, dev: true })

for (const name of readdirSync(dir).filter((file) => file.endsWith('.btsx'))) {
  test(`${name} compiles through Beast and Octane`, () => {
    const filename = `${dir}${name}`
    const source = readFileSync(filename, 'utf8')
    const { code, map } = compileBeastResult(source, { filename, componentName: componentNameFromPath(filename) })
    try {
      expect(octane.transform(code, filename.replace(/\.btsx$/, '.tsrx'), { environment: 'client', dev: true })).not.toBeNull()
    } catch (error) {
      throw mapGeneratedError(error, map, source, filename)
    }
  })
}
