import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'
import { BeastProject } from './server/project.ts'
import { API_BASE, DEFAULT_SETTINGS, SOURCE_CHANGED_EVENT, type AnalyzerSettings } from './shared/types.ts'

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
  return (req, res, next) => {
    const project = getProject()
    if (project === null || req.method !== 'GET' || req.url === undefined) return next()

    const url = new URL(req.url, 'http://beast.devtools')
    const settings = readSettings(url.searchParams, defaults)
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }

    try {
      if (url.pathname === '/project') return send(200, project.report(settings))
      if (url.pathname === '/file') {
        const report = project.file(url.searchParams.get('path') ?? '', settings)
        return report === null ? send(404, { error: 'Unknown .btsx file' }) : send(200, report)
      }
      return send(404, { error: `Unknown endpoint ${url.pathname}` })
    } catch (error) {
      return send(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function readSettings(params: URLSearchParams, defaults: AnalyzerSettings): AnalyzerSettings {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(params.get(name))
    return params.has(name) && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
  }
  return {
    depthLimit: read('depthLimit', defaults.depthLimit, 1, 20),
    minLines: read('minLines', defaults.minLines, 2, 200),
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
