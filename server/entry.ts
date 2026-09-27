import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { componentNameFromPath } from 'beast-tsrx'

/** Extensions tried when an entry is written without one, as bundlers allow. */
const MODULE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

/** A default import of a `.btsx` module: `import App from './App.btsx'`. */
const BTSX_IMPORT = /\bimport\s+[A-Za-z_$][\w$]*\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+\.btsx)['"]/gu

/**
 * The Beast components an app's entry modules import, such as `App` from
 * `main.ts`. The Components panel starts its block view at the first of these,
 * hiding the providers the entry wraps it in. Names follow Beast's own
 * `componentNameFromPath`, so aliased imports (`@/App.btsx`) need no resolving.
 */
export function entryComponents(entries: readonly string[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    const file = MODULE_EXTENSIONS.map((extension) => entry + extension).find((candidate) => existsSync(candidate))
    if (file === undefined) continue
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const match of source.matchAll(BTSX_IMPORT)) names.add(componentNameFromPath(match[1]!))
  }
  return [...names]
}

/** Module scripts of a Vite `index.html`, as absolute paths. */
export function htmlEntries(root: string): string[] {
  let html: string
  try {
    html = readFileSync(resolve(root, 'index.html'), 'utf8')
  } catch {
    return []
  }
  const entries: string[] = []
  for (const [tag] of html.matchAll(/<script\b[^>]*>/giu)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1]
    if (src === undefined || !/\btype\s*=\s*["']module["']/iu.test(tag) || /^[a-z][a-z0-9+.-]*:/iu.test(src)) continue
    entries.push(resolve(root, `.${src.startsWith('/') ? '' : '/'}${src.replace(/[?#].*$/u, '')}`))
  }
  return entries
}

/**
 * Local entry modules from an Rspack or Rsbuild `entry`: a string, an array,
 * `{ import }` descriptions, or a record of any of these. Package entries and
 * dynamic (function) entries are skipped.
 */
export function configEntries(entry: unknown, context: string): string[] {
  if (typeof entry === 'string') return entry.startsWith('.') || isAbsolute(entry) ? [resolve(context, entry)] : []
  if (Array.isArray(entry)) return entry.flatMap((item) => configEntries(item, context))
  if (entry === null || typeof entry !== 'object') return []
  if ('import' in entry) return configEntries((entry as { import: unknown }).import, context)
  return Object.values(entry).flatMap((item) => configEntries(item, context))
}
