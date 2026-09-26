import type { RsbuildPlugin } from '@rsbuild/core'
import { CLIENT_ENTRY, createDevtoolsServer, type BeastDevtoolsOptions, type DevtoolsServer } from './server/devtools.js'
import { SourceTagsPlugin } from './rspack.js'
import { API_BASE } from './shared/types.js'

export type { BeastDevtoolsOptions }

/**
 * Beast DevTools: an in-page overlay for Beast + Octane apps during `rsbuild dev`.
 *
 * Pair it with `beastOctane({ octane: { profile: true } })` in development so
 * Octane exposes its runtime inspection hook; the overlay explains how when it
 * is missing.
 */
export function beastDevtools(options: BeastDevtoolsOptions = {}): RsbuildPlugin {
  return {
    name: 'beast:devtools',
    apply: 'serve',

    setup(api) {
      let devtools: DevtoolsServer | null = null

      // Browser environments load the overlay ahead of their entries; server
      // environments (SSR, workers) never render it.
      api.modifyEnvironmentConfig((config, { mergeEnvironmentConfig }) => {
        if (config.output.target !== 'web') return config
        return mergeEnvironmentConfig(config, { source: { preEntry: [CLIENT_ENTRY] } })
      })

      if (options.elementPicker !== false) {
        api.modifyRspackConfig((config) => {
          ;(config.plugins ??= []).push(new SourceTagsPlugin())
        })
      }

      api.onBeforeStartDevServer(({ server }) => {
        devtools = createDevtoolsServer({
          ...options,
          root: api.context.rootPath,
          editorUrl: (location) => `/__open-in-editor?file=${encodeURIComponent(location)}`,
        })
        devtools.watch()
        server.middlewares.use(API_BASE, devtools.middleware)
      })

      api.onCloseDevServer(() => devtools?.close())
    },
  }
}
