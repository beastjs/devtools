import { afterEach, expect, test } from 'bun:test'
import { createRsbuild } from '@rsbuild/core'
import { beastOctane } from 'beast-tsrx/rsbuild'
import { beastDevtools } from './rsbuild.ts'
import { createApp, E2E_TIMEOUT, expectDevtools, OVERLAY_MARKER, OVERLAY_STYLES, type TestApp } from './test/dev-server.ts'

let app: TestApp | null = null
afterEach(() => app?.cleanup())

test(
  'rsbuild dev bundles the overlay and serves its API',
  async () => {
    app = createApp()
    const rsbuild = await createRsbuild({
      cwd: app.root,
      config: {
        logLevel: 'error',
        source: { entry: { index: './src/main.ts' } },
        html: { template: './index.html' },
        server: { host: '127.0.0.1', printUrls: false },
        dev: { cliShortcuts: false },
        plugins: [...beastOctane({ octane: { profile: true } }), beastDevtools()],
      },
    })
    const { port, server } = await rsbuild.startDevServer()
    try {
      const origin = `http://127.0.0.1:${port}`

      const html = await (await fetch(origin)).text()
      const assets = [...html.matchAll(/<(?:script[^>]*src|link[^>]*href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]!)
      const bundles = (await Promise.all(assets.map(async (src) => (await fetch(new URL(src, origin))).text()))).join('\n')
      expect(bundles).toMatch(OVERLAY_MARKER)
      expect(bundles).toMatch(OVERLAY_STYLES)

      await expectDevtools(origin, app, '/__open-in-editor?file=')
    } finally {
      await server.close()
    }
  },
  E2E_TIMEOUT,
)
