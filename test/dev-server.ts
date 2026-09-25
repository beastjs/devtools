/**
 * Shared end-to-end checks for the Vite, Rspack and Rsbuild adapters: each
 * test starts a real dev server on a throwaway app and runs `expectDevtools`.
 */
import { expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_BASE, SOURCE_CHANGED_EVENT, type ProjectReport } from '../shared/types.ts'

const FIXTURE = readFileSync(new URL('./fixtures/App.btsx', import.meta.url), 'utf8')
const NODE_MODULES = new URL('../node_modules', import.meta.url).pathname

/** Long enough for a cold dev-server start and first compile. */
export const E2E_TIMEOUT = 60_000

export interface TestApp {
  root: string
  appPath: string
  cleanup: () => void
}

/** A Beast app in a temporary directory that resolves packages from this repository. */
export function createApp(): TestApp {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'beast-devtools-app-')))
  symlinkSync(NODE_MODULES, join(root, 'node_modules'), 'dir')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/App.btsx'), FIXTURE)
  writeFileSync(
    join(root, 'src/main.ts'),
    `import { createRoot } from 'octane'
import App from './App.btsx'

createRoot(document.getElementById('app')!).render(App, { docsUrl: 'https://example.com' })
`,
  )
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html>
<html>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  )
  return { root, appPath: join(root, 'src/App.btsx'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Matches the overlay's mount point in compiled client code. */
export const OVERLAY_MARKER = /["']beast-devtools["']/

/** Matches the overlay's stylesheet, which bundlers drop if the package hides its side effects. */
export const OVERLAY_STYLES = /\.bdt-/

/**
 * Checks everything the overlay needs from a running dev server: the project
 * API, source-change events, and the editor redirect.
 */
export async function expectDevtools(origin: string, app: TestApp, editorPrefix: string): Promise<void> {
  const project = (await (await fetch(`${origin}${API_BASE}/project`)).json()) as ProjectReport
  expect(project.files.map((file) => file.path)).toEqual(['src/App.btsx'])

  const file = await fetch(`${origin}${API_BASE}/file?path=src/App.btsx`)
  expect(file.status).toBe(200)

  const refused = await fetch(`${origin}${API_BASE}/undo`, { method: 'POST', body: '{}' })
  expect(refused.status).toBe(403)

  const editor = await fetch(`${origin}${API_BASE}/open-in-editor?file=${encodeURIComponent(`${app.appPath}:3:1`)}`, {
    redirect: 'manual',
  })
  expect(editor.status).toBe(307)
  expect(editor.headers.get('location')).toBe(`${editorPrefix}${encodeURIComponent(`${app.appPath}:3:1`)}`)

  const events = await openEvents(origin)
  try {
    expect(events.contentType).toStartWith('text/event-stream')
    const source = readFileSync(app.appPath, 'utf8')
    let edit = 0
    const changed = await events.next(() => writeFileSync(app.appPath, `${source}\n// edit ${++edit}\n`))
    expect(changed).toBe('src/App.btsx')
  } finally {
    events.close()
  }
}

interface EventStream {
  contentType: string
  /** Runs `trigger` until a source-change event arrives (file watchers can start late), and returns its path. */
  next: (trigger: () => void) => Promise<string>
  close: () => void
}

async function openEvents(origin: string): Promise<EventStream> {
  const controller = new AbortController()
  const response = await fetch(`${origin}${API_BASE}/events`, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const read = async () => {
    const { value, done } = await reader.read()
    if (done) throw new Error('Event stream closed.')
    buffer += decoder.decode(value, { stream: true })
  }

  // The server registers a client before its first write, so events sent after it arrive.
  while (!buffer.includes('retry:')) await read()

  const pattern = new RegExp(`event: ${SOURCE_CHANGED_EVENT}\\ndata: (.*)\\n\\n`)
  return {
    contentType: response.headers.get('content-type') ?? '',
    async next(trigger) {
      trigger()
      const retry = setInterval(trigger, 500)
      try {
        for (let match = pattern.exec(buffer); ; match = pattern.exec(buffer)) {
          if (match !== null) return (JSON.parse(match[1]!) as { path: string }).path
          await read()
        }
      } finally {
        clearInterval(retry)
      }
    },
    close: () => controller.abort(),
  }
}
