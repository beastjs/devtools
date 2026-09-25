import { afterEach, expect, test } from 'bun:test'
import type { AddressInfo } from 'node:net'
import { beastOctane } from 'beast-tsrx/vite'
import { createServer } from 'vite'
import { createApp, E2E_TIMEOUT, expectDevtools, type TestApp } from './test/dev-server.ts'
import { beastDevtools } from './vite.ts'

let app: TestApp | null = null
afterEach(() => app?.cleanup())

test(
  'vite dev serves the overlay and its API',
  async () => {
    app = createApp()
    const server = await createServer({
      root: app.root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [beastOctane({ octane: { profile: 'auto' } }), beastDevtools()],
    })
    try {
      await server.listen()
      const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`

      const html = await (await fetch(origin)).text()
      const overlay = /<script type="module" src="([^"]*client\/mount\.ts)"/.exec(html)?.[1]
      expect(overlay).toBeDefined()
      expect((await fetch(`${origin}${overlay}`)).status).toBe(200)

      await expectDevtools(origin, app, '/__open-in-editor?file=')
    } finally {
      await server.close()
    }
  },
  E2E_TIMEOUT,
)
