import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  BeastCompileError,
  compileBeastResult,
  componentNameFromPath,
  formatDiagnostic,
  type BeastDiagnostic,
  type BeastDocument,
  type SetupDeclaration,
} from 'beast-tsrx'
import type {
  AnalyzerSettings,
  ComponentLocation,
  DiagnosticInfo,
  FileReport,
  FileSummary,
  HookBinding,
  ProjectReport,
} from '../shared/types.ts'
import { analyzeDocument } from './analyze.ts'
import { buildLineMap } from './line-map.ts'
import { hookCall, topLevelDeclarations } from './source-scan.ts'

const IGNORED_DIRECTORIES = new Set(['.git', '.beast', 'node_modules', 'dist', 'build', 'coverage'])

export interface ProjectOptions {
  root: string
  /** Directories, relative to root, searched recursively for `.btsx` files. */
  include: readonly string[]
  /** Absolute directories never listed (the overlay's own sources). */
  exclude: readonly string[]
}

interface CompiledEntry {
  mtimeMs: number
  source: string
  result: ReturnType<typeof compileBeastResult> | null
  error: BeastDiagnostic | null
}

/**
 * Compiles project `.btsx` sources on demand for the overlay. Results are
 * cached by modification time, so polling the API stays cheap.
 */
export class BeastProject {
  readonly #options: ProjectOptions
  readonly #cache = new Map<string, CompiledEntry>()

  constructor(options: ProjectOptions) {
    this.#options = options
  }

  report(settings: AnalyzerSettings): ProjectReport {
    const files: FileSummary[] = []
    const components: ComponentLocation[] = []
    for (const absolutePath of this.#discover()) {
      const path = this.#relative(absolutePath)
      const entry = this.#compile(absolutePath)
      const lines = entry.source.split('\n').length
      if (entry.result === null) {
        files.push({ path, lines, maxDepth: null, deepLines: 0, suggestions: 0, error: entry.error?.message ?? 'Compile failed' })
        continue
      }
      const analysis = analyzeDocument(entry.result.ast, entry.source, componentNameFromPath(absolutePath), settings)
      files.push({
        path,
        lines,
        maxDepth: analysis.maxDepth,
        deepLines: analysis.deepLines,
        suggestions: analysis.suggestions.length,
        error: null,
      })
      components.push(...componentLocations(entry.result.ast, absolutePath, path))
    }
    return { root: this.#options.root, settings, files, components }
  }

  file(path: string, settings: AnalyzerSettings): FileReport | null {
    const absolutePath = this.resolve(path)
    if (absolutePath === null) return null
    const entry = this.#compile(absolutePath)
    const relativePath = this.#relative(absolutePath)

    if (entry.result === null) {
      return {
        path: relativePath,
        absolutePath,
        source: entry.source,
        compiled: { ok: false, error: diagnosticInfo(entry.error!, entry.source) },
        analysis: null,
      }
    }

    const { code, map, ast, diagnostics } = entry.result
    const sourceLines = entry.source.split('\n')
    const lineMap = buildLineMap(map, code.split('\n').length, sourceLines.length)
    // `~` continuation lines belong to the node header above them.
    sourceLines.forEach((line, index) => {
      if (index > 0 && line.trimStart().startsWith('~') && lineMap.btsxToTsrx[index]!.length === 0) {
        lineMap.btsxToTsrx[index] = lineMap.btsxToTsrx[index - 1]!
      }
    })
    return {
      path: relativePath,
      absolutePath,
      source: entry.source,
      compiled: {
        ok: true,
        tsrx: code,
        ...lineMap,
        diagnostics: diagnostics.map((diagnostic) => diagnosticInfo(diagnostic, entry.source)),
      },
      analysis: analyzeDocument(ast, entry.source, componentNameFromPath(absolutePath), settings),
    }
  }

  /** Resolve a client-supplied path to a project `.btsx` file, refusing anything else. */
  resolve(path: string): string | null {
    const absolutePath = resolve(this.#options.root, path)
    const inRoot = absolutePath.startsWith(this.#options.root + sep)
    const listed = this.#options.include.some((dir) => absolutePath.startsWith(resolve(this.#options.root, dir) + sep))
    if (!inRoot || !listed || !absolutePath.endsWith('.btsx') || absolutePath.split(sep).includes('node_modules')) return null
    try {
      return statSync(absolutePath).isFile() ? absolutePath : null
    } catch {
      return null
    }
  }

  invalidate(absolutePath: string): void {
    this.#cache.delete(absolutePath)
  }

  #discover(): string[] {
    const found: string[] = []
    const walk = (dir: string) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name) && !this.#options.exclude.includes(full)) walk(full)
        } else if (entry.name.endsWith('.btsx')) {
          found.push(full)
        }
      }
    }
    for (const dir of this.#options.include) walk(resolve(this.#options.root, dir))
    return found.sort()
  }

  #compile(absolutePath: string): CompiledEntry {
    const mtimeMs = statSync(absolutePath).mtimeMs
    const cached = this.#cache.get(absolutePath)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached

    const source = readFileSync(absolutePath, 'utf8')
    let entry: CompiledEntry
    try {
      const result = compileBeastResult(source, {
        filename: this.#relative(absolutePath),
        componentName: componentNameFromPath(absolutePath),
      })
      entry = { mtimeMs, source, result, error: null }
    } catch (error) {
      if (!(error instanceof BeastCompileError)) throw error
      entry = { mtimeMs, source, result: null, error: error.diagnostic }
    }
    this.#cache.set(absolutePath, entry)
    return entry
  }

  #relative(absolutePath: string): string {
    return relative(this.#options.root, absolutePath).split(sep).join('/')
  }
}

function diagnosticInfo(diagnostic: BeastDiagnostic, source: string): DiagnosticInfo {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    line: diagnostic.span.start.line,
    column: diagnostic.span.start.column,
    endLine: diagnostic.span.end.line,
    endColumn: diagnostic.span.end.column,
    ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
    formatted: formatDiagnostic(diagnostic, source),
  }
}

/** Where each component of a file is declared, plus its value hooks in call order. */
function componentLocations(document: BeastDocument, absolutePath: string, path: string): ComponentLocation[] {
  const locations: ComponentLocation[] = []
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'component') continue
    locations.push({
      name: declaration.name,
      path,
      absolutePath,
      line: declaration.span.start.line,
      column: declaration.span.start.column,
      local: true,
      hooks: hookBindings(declaration.setup),
    })
  }
  const root = document.children[0]
  const topSetup = document.declarations.filter((d): d is SetupDeclaration => d.kind === 'setup')
  locations.push({
    name: componentNameFromPath(absolutePath),
    path,
    absolutePath,
    line: root?.span.start.line ?? 1,
    column: root?.span.start.column ?? 1,
    local: false,
    hooks: hookBindings(topSetup),
  })
  return locations
}

function hookBindings(setup: readonly SetupDeclaration[]): HookBinding[] {
  const bindings: HookBinding[] = []
  for (const declaration of setup) {
    for (const { names, init, offset } of topLevelDeclarations(declaration.code)) {
      const call = hookCall(init)
      if (call === null) continue
      const line = declaration.codeStart.line + declaration.code.slice(0, offset).split('\n').length - 1
      bindings.push({ hook: call.hook, names, line })
    }
  }
  return bindings
}
