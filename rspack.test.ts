import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { rspack, type Compiler, type RspackOptions } from '@rspack/core'
import { RspackDevServer } from '@rspack/dev-server'
import { beastOctane } from 'beast-tsrx/rspack'
import { beastDevtools } from './rspack.ts'
import { createApp, E2E_TIMEOUT, expectDevtools, OVERLAY_MARKER, OVERLAY_STYLES, type TestApp } from './test/dev-server.ts'

let app: TestApp | null = null
afterEach(() => app?.cleanup())

function config(root: string): RspackOptions {
  return {
    context: root,
    mode: 'development',
    entry: './src/main.ts',
    output: { path: join(root, 'dist') },
    module: { rules: [{ test: /\.css$/u, type: 'css' }] },
    plugins: [beastOctane({ octane: { profile: true, parallel: false } }), beastDevtools()],
    devServer: { host: '127.0.0.1', port: 'auto' },
    infrastructureLogging: { level: 'error' },
    stats: 'none',
  }
}

test(
  'rspack serve bundles the overlay and serves its API',
  async () => {
    app = createApp()
    const compiler = rspack(config(app.root))
    const server = new RspackDevServer(compiler.options.devServer || {}, compiler)
    try {
      await server.start()
      const origin = `http://127.0.0.1:${(server.server!.address() as AddressInfo).port}`

      const bundle = await (await fetch(`${origin}/main.js`)).text()
      expect(bundle).toMatch(OVERLAY_MARKER)
      expect(await (await fetch(`${origin}/main.css`)).text()).toMatch(OVERLAY_STYLES)

      await expectDevtools(origin, app, '/rspack-dev-server/open-editor?fileName=')
    } finally {
      await server.stop()
    }
  },
  E2E_TIMEOUT,
)

test(
  'rspack build leaves the overlay out',
  async () => {
    app = createApp()
    const compiler = rspack(config(app.root))
    await run(compiler)
    expect(readFileSync(join(app.root, 'dist/main.js'), 'utf8')).not.toMatch(OVERLAY_MARKER)
  },
  E2E_TIMEOUT,
)

function run(compiler: Compiler): Promise<void> {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close(() => {
        if (error) reject(error)
        else if (stats?.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    })
  })
}
