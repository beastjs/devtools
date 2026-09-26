import type { Compiler, DevServerMiddleware, RspackPluginInstance } from '@rspack/core'
import { CLIENT_ENTRY, createDevtoolsServer, PACKAGE_ROOT, SOURCE_TAGS_LOADER, type BeastDevtoolsOptions } from './server/devtools.js'
import type { SourceTagsLoaderOptions } from './server/source-tags-loader.js'
import { API_BASE } from './shared/types.js'

export type { BeastDevtoolsOptions }

const NAME = 'beast:devtools'

/**
 * Beast DevTools for `rspack serve`. Builds are untouched: the overlay entry and
 * its API are added only when the dev server sets up its middlewares.
 */
export class BeastDevtoolsRspackPlugin implements RspackPluginInstance {
  readonly options: Readonly<BeastDevtoolsOptions>

  constructor(options: BeastDevtoolsOptions = {}) {
    this.options = options
  }

  apply(compiler: Compiler): void {
    const configured = compiler.options.devServer
    if (configured === false) return
    const devServer = configured ?? (compiler.options.devServer = {})
    const setupMiddlewares = devServer.setupMiddlewares

    // The dev server calls this before its first compilation, which is also
    // when it adds its own client entries; `rspack build` never calls it.
    devServer.setupMiddlewares = (middlewares, server) => {
      const result = setupMiddlewares === undefined ? middlewares : setupMiddlewares(middlewares, server)
      if (compiler.platform.web) {
        // A global entry joins every entrypoint, so the overlay shares the app's Octane runtime.
        new compiler.rspack.EntryPlugin(compiler.context, CLIENT_ENTRY, { name: undefined }).apply(compiler)
      }
      if (this.options.elementPicker !== false) {
        // Rules are read when the first compilation starts, which is still ahead of us.
        compiler.options.module.rules.push(sourceTagsRule(compiler.context))
      }

      const devtools = createDevtoolsServer({
        ...this.options,
        root: compiler.context,
        editorUrl: (location) => `/rspack-dev-server/open-editor?fileName=${encodeURIComponent(location)}`,
      })
      devtools.watch()
      compiler.hooks.shutdown.tap(NAME, devtools.close)

      // Serve the API ahead of the bundle middleware and any proxies, but after the host checks.
      const api: DevServerMiddleware = { name: NAME, path: API_BASE, middleware: devtools.middleware }
      const bundle = result.findIndex((middleware) => typeof middleware === 'object' && middleware.name === '@rspack/dev-middleware')
      result.splice(bundle === -1 ? result.length : bundle, 0, api)
      return result
    }
  }
}

/**
 * A pre-loader rule that tags `.btsx` elements for the element picker. Beast's
 * loader is also `enforce: 'pre'`, and loaders run from the last matching rule
 * to the first, so this rule must be added after Beast's.
 */
function sourceTagsRule(root: string) {
  const options: SourceTagsLoaderOptions = { root, packageRoot: PACKAGE_ROOT }
  return { test: /\.btsx$/u, enforce: 'pre' as const, loader: SOURCE_TAGS_LOADER, options }
}

/** Adds `sourceTagsRule` once every plugin, Beast's included, has added its own rules. */
export class SourceTagsPlugin implements RspackPluginInstance {
  apply(compiler: Compiler): void {
    compiler.hooks.afterEnvironment.tap(NAME, () => {
      compiler.options.module.rules.push(sourceTagsRule(compiler.context))
    })
  }
}

/**
 * Beast DevTools: an in-page overlay for Beast + Octane apps during `rspack serve`.
 *
 * Pair it with `beastOctane({ octane: { profile: true } })` in development so
 * Octane exposes its runtime inspection hook; the overlay explains how when it
 * is missing.
 */
export function beastDevtools(options: BeastDevtoolsOptions = {}): BeastDevtoolsRspackPlugin {
  return new BeastDevtoolsRspackPlugin(options)
}
