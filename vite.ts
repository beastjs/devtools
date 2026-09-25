import { relative, resolve, sep } from 'node:path'
import { searchForWorkspaceRoot, type Plugin } from 'vite'
import { CLIENT_ENTRY, createDevtoolsServer, PACKAGE_ROOT, toPosix, type BeastDevtoolsOptions } from './server/devtools.js'
import { API_BASE } from './shared/types.js'

export type { BeastDevtoolsOptions }

/**
 * Beast DevTools: an in-page overlay for Beast + Octane apps during `vite dev`.
 *
 * Pair it with `beastOctane({ octane: { profile: 'auto' } })` so Octane exposes
 * its runtime inspection hook; the overlay explains how when it is missing.
 */
export function beastDevtools(options: BeastDevtoolsOptions = {}): Plugin {
  let root = process.cwd()

  return {
    name: 'beast:devtools',
    apply: 'serve',

    config(config) {
      const appRoot = resolve(config.root ?? process.cwd())
      return {
        // The overlay must share the app's Octane runtime: a second copy would
        // install its own inspection hook and see only the overlay's root.
        resolve: { dedupe: ['octane'] },
        // A linked package can live outside the workspace root Vite serves.
        server: { fs: { allow: [searchForWorkspaceRoot(appRoot), PACKAGE_ROOT] } },
      }
    },

    configResolved(config) {
      root = config.root
    },

    configureServer(server) {
      const devtools = createDevtoolsServer({
        ...options,
        root,
        editorUrl: (location) => `/__open-in-editor?file=${encodeURIComponent(location)}`,
      })
      server.middlewares.use(API_BASE, devtools.middleware)
      // Vite already watches the project, so reuse its watcher instead of `devtools.watch()`.
      server.watcher.on('change', devtools.notify)
      server.watcher.on('add', devtools.notify)
      server.watcher.on('unlink', devtools.notify)
      server.httpServer?.once('close', devtools.close)
    },

    transformIndexHtml() {
      const inRoot = CLIENT_ENTRY.startsWith(root + sep)
      const src = inRoot ? `/${toPosix(relative(root, CLIENT_ENTRY))}` : `/@fs/${toPosix(CLIENT_ENTRY).replace(/^\//, '')}`
      return [{ tag: 'script', attrs: { type: 'module', src }, injectTo: 'body' }]
    },
  }
}
