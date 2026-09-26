import { existsSync, watch, type FSWatcher } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS, SOURCE_CHANGED_EVENT, type AnalyzerSettings, type ApplyRequest } from '../shared/types.js'
import { BeastProject } from './project.js'
import { RefactorError } from './refactor.js'

export interface BeastDevtoolsOptions {
  /** Directories, relative to the project root, scanned for `.btsx` sources. Default: `['src']`. */
  include?: string[]
  /** Default analyzer thresholds; the overlay can override them per session. */
  analyzer?: Partial<AnalyzerSettings>
  /**
   * Tag the DOM elements of project `.btsx` files with their component and
   * source line, so the overlay's element picker can name them and open them
   * in your editor. Default: `true`.
   */
  elementPicker?: boolean
}

export interface DevtoolsServerOptions extends BeastDevtoolsOptions {
  root: string
  /** The dev server's own open-in-editor URL for a `file:line:column` location. */
  editorUrl: (location: string) => string
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void

/** The bundler-independent half of the devtools: the JSON API and source-change events. */
export interface DevtoolsServer {
  /** Serves requests under `API_BASE`; mount it there so the prefix is stripped. */
  middleware: Middleware
  /** Report a changed, added or removed file; anything but project `.btsx` sources is ignored. */
  notify: (file: string) => void
  /** Watch the `include` directories, for bundlers whose dev server does not watch the project. */
  watch: () => void
  close: () => void
}

// This module runs from source (`server/`) during development and from
// `dist/server/` once published; the overlay sources sit in `client/` either way.
const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT =
  [resolve(HERE, '..'), resolve(HERE, '../..')].find((dir) => existsSync(resolve(dir, 'client/mount.ts'))) ?? resolve(HERE, '..')
export const CLIENT_ENTRY = resolve(PACKAGE_ROOT, 'client/mount.ts')
/** The Rspack pre-loader beside this module, as `.ts` from source or `.js` once built. */
export const SOURCE_TAGS_LOADER = resolve(HERE, `source-tags-loader${extname(fileURLToPath(import.meta.url))}`)

/** Editors often save with several filesystem events; the overlay refreshes once per burst. */
const NOTIFY_DELAY_MS = 50

export function createDevtoolsServer(options: DevtoolsServerOptions): DevtoolsServer {
  const { root, editorUrl } = options
  const include = options.include ?? ['src']
  const defaults: AnalyzerSettings = { ...DEFAULT_SETTINGS, ...options.analyzer }
  const project = new BeastProject({ root, include, exclude: [PACKAGE_ROOT] })
  const clients = new Set<ServerResponse>()
  const watchers: FSWatcher[] = []
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    for (const path of pending) {
      const message = `event: ${SOURCE_CHANGED_EVENT}\ndata: ${JSON.stringify({ path })}\n\n`
      for (const client of clients) client.write(message)
    }
    pending.clear()
  }

  const notify = (file: string) => {
    if (!file.endsWith('.btsx') || file.startsWith(PACKAGE_ROOT + sep)) return
    project.invalidate(file)
    pending.add(toPosix(relative(root, file)))
    timer ??= setTimeout(flush, NOTIFY_DELAY_MS)
  }

  const events = (req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-store')
    // Compression middlewares decide on the first chunk and pass small ones
    // through uncompressed, so a short write here keeps the stream unbuffered.
    res.write('retry: 1000\n\n')
    clients.add(res)
    req.once('close', () => clients.delete(res))
  }

  const middleware: Middleware = async (req, res, next) => {
    if (req.url === undefined || (req.method !== 'GET' && req.method !== 'POST')) return next()

    const url = new URL(req.url, 'http://beast.devtools')
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }

    try {
      if (req.method === 'GET') {
        if (url.pathname === '/events') return events(req, res)
        if (url.pathname === '/open-in-editor') {
          const location = url.searchParams.get('file')
          if (location === null || location === '') return send(400, { error: 'Missing file.' })
          res.statusCode = 307
          // The element picker sends project-relative locations; absolute ones pass through.
          res.setHeader('Location', editorUrl(resolve(root, location)))
          return res.end()
        }
        const settings = readSettings((name) => url.searchParams.get(name), defaults)
        if (url.pathname === '/project') return send(200, project.report(settings))
        if (url.pathname === '/file') {
          const report = project.file(url.searchParams.get('path') ?? '', settings)
          return report === null ? send(404, { error: 'Unknown .btsx file' }) : send(200, report)
        }
        return send(404, { error: `Unknown endpoint ${url.pathname}` })
      }

      // Writes are same-origin JSON only: a cross-site page can neither send
      // this content type without a preflight nor pass the origin check.
      const refusal = writeRefusal(req)
      if (refusal !== null) return send(403, { error: refusal })
      const body = await readJson(req)
      if (url.pathname === '/apply') {
        const request: ApplyRequest = {
          path: String(body.path ?? ''),
          hash: String(body.hash ?? ''),
          suggestionId: String(body.suggestionId ?? ''),
          ...(typeof body.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim().slice(0, 80) } : {}),
          target: body.target === 'file' ? 'file' : 'inline',
          dryRun: body.dryRun !== false,
          settings: readSettings((name) => (body.settings as Record<string, unknown> | undefined)?.[name], defaults),
        }
        return send(200, project.apply(request))
      }
      if (url.pathname === '/undo') return send(200, project.undo(String(body.id ?? '')))
      return send(404, { error: `Unknown endpoint ${url.pathname}` })
    } catch (error) {
      if (error instanceof RefactorError) return send(error.status, { error: error.message })
      return send(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    middleware,
    notify,
    watch() {
      for (const dir of include) {
        const absolute = resolve(root, dir)
        if (!existsSync(absolute)) continue
        const watcher = watch(absolute, { recursive: true }, (_event, name) => {
          if (name !== null) notify(resolve(absolute, name))
        })
        // Without the watcher the overlay still works; it just stops refreshing on save.
        watcher.on('error', (error) => {
          console.warn(`[beast-devtools] Stopped watching ${dir}: ${error.message}`)
          watcher.close()
        })
        watchers.push(watcher)
      }
    },
    close() {
      for (const watcher of watchers.splice(0)) watcher.close()
      for (const client of clients) client.end()
      clients.clear()
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}

function writeRefusal(req: IncomingMessage): string | null {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) return 'Expected a JSON request.'
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Cross-site requests cannot modify files.'
  const origin = req.headers.origin
  if (origin !== undefined && new URL(origin).host !== req.headers.host) return 'Cross-origin requests cannot modify files.'
  return null
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 64 * 1024) throw new RefactorError('Request body too large.', 422)
  }
  const value: unknown = JSON.parse(text || '{}')
  if (value === null || typeof value !== 'object') throw new RefactorError('Expected a JSON object.', 422)
  return value as Record<string, unknown>
}

function readSettings(get: (name: string) => unknown, defaults: AnalyzerSettings): AnalyzerSettings {
  const read = (name: keyof AnalyzerSettings, min: number, max: number) => {
    const raw = get(name)
    const value = Number(raw)
    return raw != null && raw !== '' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : defaults[name]
  }
  return {
    depthLimit: read('depthLimit', 1, 20),
    minLines: read('minLines', 2, 200),
    fileLines: read('fileLines', 2, 1000),
  }
}

export function toPosix(path: string): string {
  return path.split(sep).join('/')
}
