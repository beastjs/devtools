import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import type { Connect, Plugin } from 'vite'
import { BeastProject } from './server/project.ts'
import { RefactorError } from './server/refactor.ts'
import { API_BASE, DEFAULT_SETTINGS, SOURCE_CHANGED_EVENT, type AnalyzerSettings, type ApplyRequest } from './shared/types.ts'

export interface BeastDevtoolsOptions {
  /** Directories, relative to the Vite root, scanned for `.btsx` sources. Default: `['src']`. */
  include?: string[]
  /** Default analyzer thresholds; the overlay can override them per session. */
  analyzer?: Partial<AnalyzerSettings>
}

const DEVTOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = resolve(DEVTOOLS_DIR, 'client')
const CLIENT_ENTRY = resolve(CLIENT_DIR, 'mount.ts')

/**
 * Beast DevTools: an in-page overlay for Beast + Octane apps during `vite dev`.
 *
 * Pair it with `beastOctane({ octane: { profile: 'auto' } })` so Octane exposes
 * its runtime inspection hook; the overlay explains how when it is missing.
 */
export function beastDevtools(options: BeastDevtoolsOptions = {}): Plugin {
  const defaults: AnalyzerSettings = { ...DEFAULT_SETTINGS, ...options.analyzer }
  let root = process.cwd()
  let project: BeastProject | null = null

  return {
    name: 'beast:devtools',
    apply: 'serve',

    configResolved(config) {
      root = config.root
      project = new BeastProject({ root, include: options.include ?? ['src'], exclude: [DEVTOOLS_DIR] })
    },

    configureServer(server) {
      server.middlewares.use(API_BASE, apiMiddleware(() => project, defaults))

      const notify = (file: string) => {
        if (!file.endsWith('.btsx') || file.startsWith(DEVTOOLS_DIR + sep)) return
        project?.invalidate(file)
        server.ws.send({ type: 'custom', event: SOURCE_CHANGED_EVENT, data: { path: toPosix(relative(root, file)) } })
      }
      server.watcher.on('change', notify)
      server.watcher.on('add', notify)
      server.watcher.on('unlink', notify)
    },

    transformIndexHtml() {
      const inRoot = CLIENT_ENTRY.startsWith(root + sep)
      const src = inRoot ? `/${toPosix(relative(root, CLIENT_ENTRY))}` : `/@fs/${toPosix(CLIENT_ENTRY).replace(/^\//, '')}`
      return [{ tag: 'script', attrs: { type: 'module', src }, injectTo: 'body' }]
    },
  }
}

function apiMiddleware(getProject: () => BeastProject | null, defaults: AnalyzerSettings): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const project = getProject()
    if (project === null || req.url === undefined || (req.method !== 'GET' && req.method !== 'POST')) return next()

    const url = new URL(req.url, 'http://beast.devtools')
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }

    try {
      if (req.method === 'GET') {
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

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
