import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import postcss from 'postcss'
import type { CssRuleEditRequest, StylesheetFile, StylesheetReport, StylesheetRule } from '../shared/types.js'
import { RefactorError, type FileChange } from './refactor.js'
import { replaceCssRule } from './style-edits.js'

const IGNORED = new Set(['node_modules', '.git', '.beast', '.next', '.nuxt', '.cache', 'dist', 'build', 'coverage'])

export function stylesheetFile(path: string, source: string): StylesheetFile {
  const hash = createHash('sha1').update(source).digest('hex').slice(0, 16)
  try {
    const rules: StylesheetRule[] = []
    postcss.parse(source, { from: path }).walkRules((rule) => {
      // Keyframe steps are not element selectors, but keep their indexes stable.
      const context: StylesheetRule['context'] = []
      for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
        if (parent.type === 'atrule') context.unshift({ name: parent.name.toLowerCase(), params: parent.params })
        if (parent.type === 'rule') context.unshift({ name: 'nest', params: parent.selector })
      }
      rules.push({
        index: rules.length, selector: rule.selector,
        line: rule.source?.start?.line ?? 1, column: rule.source?.start?.column ?? 1, context,
        declarations: rule.nodes.flatMap((node) => node.type === 'decl'
          ? [{ name: node.prop, value: `${node.value}${node.important ? ' !important' : ''}` }] : []),
      })
    })
    return { path, hash, rules }
  } catch (error) {
    return { path, hash, rules: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Index authored CSS throughout the project, including public/ and root-level files. */
export class StylesheetFiles {
  readonly #root: string
  readonly #exclude: readonly string[]
  readonly #cache = new Map<string, { mtime: number; size: number; file: StylesheetFile }>()

  constructor(root: string, exclude: readonly string[]) {
    this.#root = realpathSync(root)
    this.#exclude = exclude.map((path) => existsSync(path) ? realpathSync(path) : resolve(this.#root, relative(resolve(root), resolve(path))))
  }

  #excluded(path: string): boolean {
    return path.split(sep).some((part) => IGNORED.has(part)) || this.#exclude.some((dir) => path === dir || path.startsWith(dir + sep))
  }

  #resolve(path: string): string {
    const absolute = resolve(this.#root, path)
    if (!absolute.endsWith('.css') || !existsSync(absolute)) throw new RefactorError('Choose an existing project CSS file.', 422)
    const real = realpathSync(absolute)
    if (!real.startsWith(this.#root + sep) || this.#excluded(absolute) || this.#excluded(real) || !statSync(real).isFile()) throw new RefactorError('Choose an existing project CSS file.', 422)
    return real
  }

  report(): StylesheetReport {
    const files: StylesheetFile[] = []
    const walk = (dir: string) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (this.#excluded(path)) continue
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && entry.name.endsWith('.css')) {
          const stat = statSync(path)
          let cached = this.#cache.get(path)
          if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
            cached = { mtime: stat.mtimeMs, size: stat.size, file: stylesheetFile(relative(this.#root, path).split(sep).join('/'), readFileSync(path, 'utf8')) }
            this.#cache.set(path, cached)
          }
          files.push(cached.file)
        }
      }
    }
    walk(this.#root)
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)) }
  }

  edit(request: CssRuleEditRequest): { change: FileChange; file: StylesheetFile } {
    const absolutePath = this.#resolve(request.path)
    const before = readFileSync(absolutePath, 'utf8')
    const file = stylesheetFile(request.path, before)
    if (file.hash !== request.hash) throw new RefactorError('The CSS file changed. Refresh its rules before editing.', 409)
    if (file.error) throw new RefactorError('Fix the CSS syntax error before editing this file.', 422)
    const after = replaceCssRule(before, request.selector, request.declarations, request.index)
    this.#cache.delete(absolutePath)
    return { change: { absolutePath, before, after }, file: stylesheetFile(request.path, after) }
  }
}
