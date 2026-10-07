import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { createOctaneCompiler } from 'octane/compiler/bundler'
import type {
  AnalyzerSettings,
  ElementEditRequest,
  ElementEditResult,
  ElementTextRequest,
  ElementTextSource,
  ApplyRequest,
  ContinuationRequest,
  ApplyResult,
  ComponentLocation,
  DiagnosticInfo,
  FileReport,
  FileSummary,
  HookBinding,
  ProjectReport,
  RefactorSuggestion,
  UndoResult,
  SourceBlock,
  SourceBlockSelection,
  SourceBlockReport,
  BlockEditRequest,
  BlockEditResult,
  TailwindOptimizeRequest,
  TailwindOptimizeResult,
} from '../shared/types.js'
import { pinBlockIndent } from '../shared/block-indent.js'
import { sourceBlocks } from './source-blocks.js'
import { tagSource } from './source-tags.js'
import { replaceCssRule } from './style-edits.js'
import { editElement } from './element-edits.js'
import { elementTextSource } from './element-text.js'
import { optimizeTailwind } from './tailwind-optimize.js'
import { continuationEdits, continueProps } from './continuation.js'
import { entryComponents } from './entry.js'
import { analyzeDocument, renameSuggestion, type AnalyzeOptions } from './analyze.js'
import { diffLines } from './diff.js'
import { buildLineMap } from './line-map.js'
import { planRefactor, RefactorError, type FileChange } from './refactor.js'
import { TypeResolver } from './types.js'
import { hookCall, topLevelDeclarations } from './source-scan.js'

const IGNORED_DIRECTORIES = new Set(['.git', '.beast', 'node_modules', 'dist', 'build', 'coverage'])

export interface ProjectOptions {
  root: string
  /** Directories, relative to root, searched recursively for `.btsx` files. */
  include: readonly string[]
  /** Absolute directories never listed (the overlay's own sources). */
  exclude: readonly string[]
  /** The app's entry modules, as absolute paths; read on every report. */
  entries?: () => readonly string[]
  sourceTags?: boolean
}

interface CompiledEntry {
  mtimeMs: number
  source: string
  result: ReturnType<typeof compileBeastResult> | null
  error: BeastDiagnostic | null
  blocks?: SourceBlock[]
}

interface AppliedRefactor {
  summary: string
  changes: FileChange[]
}

/** How many applied refactors can still be undone. */
const UNDO_LIMIT = 20

/**
 * Compiles project `.btsx` sources on demand for the overlay. Results are
 * cached by modification time, so polling the API stays cheap.
 */
export class BeastProject {
  readonly #options: ProjectOptions
  readonly #cache = new Map<string, CompiledEntry>()
  readonly #applied = new Map<string, AppliedRefactor>()
  #octane: ReturnType<typeof createOctaneCompiler> | null = null
  readonly #types: TypeResolver

  constructor(options: ProjectOptions) {
    this.#options = options
    this.#types = new TypeResolver(options.root, (absolutePath) => {
      if (!existsSync(absolutePath)) return null
      const entry = this.#compile(absolutePath)
      if (entry.result === null) return null
      const declarations = entry.result.ast.declarations
      return {
        imports: declarations.flatMap((d) => (d.kind === 'import' ? [d.code] : [])),
        moduleCode: declarations.flatMap((d) => (d.kind === 'module' ? [d.code] : [])),
      }
    })
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
      const blocks = this.#blocks(entry, absolutePath)
      components.push(...componentLocations(entry.result.ast, absolutePath, path).map((location) => ({
        ...location, blocks: blocks.filter((block) => block.host === location.name && block.scope !== null),
      })))
    }
    const entryNames = entryComponents(this.#options.entries?.() ?? [])
    return { root: this.#options.root, settings, files, components, entryComponents: entryNames }
  }

  file(path: string, settings: AnalyzerSettings, selectionLine?: number): FileReport | null {
    const absolutePath = this.resolve(path)
    if (absolutePath === null) return null
    const entry = this.#compile(absolutePath)
    const relativePath = this.#relative(absolutePath)

    if (entry.result === null) {
      return {
        path: relativePath,
        absolutePath,
        hash: contentHash(entry.source),
        source: entry.source,
        compiled: { ok: false, error: diagnosticInfo(entry.error!, entry.source) },
        analysis: null,
        continuationLines: [],
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
      hash: contentHash(entry.source),
      source: entry.source,
      continuationLines: [...continuationEdits(ast, entry.source).keys()],
      compiled: {
        ok: true,
        tsrx: code,
        ...lineMap,
        diagnostics: diagnostics.map((diagnostic) => diagnosticInfo(diagnostic, entry.source)),
      },
      analysis: analyzeDocument(ast, entry.source, componentNameFromPath(absolutePath), settings, { ...this.#typed(absolutePath), ...(selectionLine === undefined ? {} : { selectionLine }) }),
    }
  }

  /**
   * Plan a refactor suggestion and, unless `dryRun`, write it. The suggestion
   * is recomputed from the file on disk: the client names it but never supplies
   * code, and every resulting file must compile through Beast and Octane
   * before anything is written.
   */
  apply(request: ApplyRequest): ApplyResult {
    const absolutePath = this.resolve(request.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    this.invalidate(absolutePath)
    const entry = this.#compile(absolutePath)
    if (contentHash(entry.source) !== request.hash) {
      throw new RefactorError('The file changed since it was analyzed. Review the refreshed suggestions and try again.', 409)
    }
    if (entry.result === null) throw new RefactorError('The file does not compile.', 422)

    const analysis = analyzeDocument(
      entry.result.ast,
      entry.source,
      componentNameFromPath(absolutePath),
      request.settings,
      {
        ...this.#typed(absolutePath),
        ...(/^manual:[1-9]\d*(?::map:[1-9]\d*:[1-9]\d*)?$/.test(request.suggestionId)
          ? { selectionLine: Number(request.suggestionId.split(':')[1]) } : {}),
      },
    )
    const found = analysis.suggestions.find((candidate) => candidate.id === request.suggestionId)
    if (found === undefined) throw new RefactorError('That suggestion no longer applies.', 409)
    if (found.kind === 'continuation') return this.continueProps({ ...request, line: found.startLine })
    const name = found.kind === 'empty-style' ? found.name : request.name?.trim() || found.name
    if (name !== found.name) validateName(name, found, entry.source)
    const suggestion = renameSuggestion(found, name)

    const plan = planRefactor({
      absolutePath,
      source: entry.source,
      document: entry.result.ast,
      suggestion,
      target: request.target,
      exists: existsSync,
      nameChosen: name !== found.name,
    })
    for (const change of plan.changes) this.#validate(change)

    const files = plan.changes.map((change) => ({
      path: this.#relative(change.absolutePath),
      action: change.before === null ? ('create' as const) : ('edit' as const),
      ...diffLines(change.before === null ? [] : change.before.split('\n'), change.after.split('\n')),
    }))
    if (request.dryRun) return { undoId: null, component: plan.component, summary: plan.summary, files }

    this.#write(plan.changes)
    const undoId = randomUUID()
    this.#applied.set(undoId, { summary: plan.summary, changes: plan.changes })
    if (this.#applied.size > UNDO_LIMIT) this.#applied.delete(this.#applied.keys().next().value!)
    return { undoId, component: plan.component, summary: plan.summary, files }
  }

  continueProps(request: ContinuationRequest): ApplyResult {
    const absolutePath = this.resolve(request.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    this.invalidate(absolutePath)
    const entry = this.#compile(absolutePath)
    if (contentHash(entry.source) !== request.hash) throw new RefactorError('The file changed. Refresh and select the element again.', 409)
    if (entry.result === null) throw new RefactorError('The file does not compile.', 422)
    const change = { absolutePath, before: entry.source, after: continueProps(entry.result.ast, entry.source, request.line) }
    this.#validate(change)
    const summary = `Continued props on line ${request.line}`
    const files = [{ path: this.#relative(absolutePath), action: 'edit' as const, ...diffLines(change.before.split('\n'), change.after.split('\n')) }]
    if (request.dryRun) return { undoId: null, component: '', summary, files }
    this.#write([change])
    const undoId = randomUUID()
    this.#applied.set(undoId, { summary, changes: [change] })
    if (this.#applied.size > UNDO_LIMIT) this.#applied.delete(this.#applied.keys().next().value!)
    return { undoId, component: '', summary, files }
  }

  elementTextSource(request: ElementTextRequest): ElementTextSource {
    const absolutePath = this.resolve(request.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    const entry = this.#compile(absolutePath)
    if (entry.result === null) throw new RefactorError('The source file does not compile.', 422)
    return elementTextSource(entry.result.ast, entry.source, request, absolutePath, this.#options.root)
  }

  editElement(request: ElementEditRequest): ElementEditResult {
    const absolutePath = this.resolve(request.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    this.invalidate(absolutePath)
    const entry = this.#compile(absolutePath)
    if (contentHash(entry.source) !== request.hash) throw new RefactorError('The source file changed. Pick the element again before editing.', 409)
    if (entry.result === null) throw new RefactorError('The source file does not compile.', 422)
    const after = editElement(entry.result.ast, entry.source, request)
    const change = { absolutePath, before: entry.source, after }
    this.#validate(change)
    const changes: FileChange[] = [change]
    if (request.group === 'styles' && request.styleTarget === 'css') {
      const cssPath = resolve(this.#options.root, request.cssPath ?? '')
      if (!request.cssSelector?.trim() || !cssPath.endsWith('.css') || !existsSync(cssPath) ||
        !realpathSync(cssPath).startsWith(realpathSync(this.#options.root) + sep) || cssPath.split(sep).includes('node_modules') ||
        this.#options.exclude.some((path) => cssPath === path || cssPath.startsWith(path + sep))) throw new RefactorError('Choose an existing CSS file inside the project and a selector.', 422)
      const before = readFileSync(cssPath, 'utf8')
      changes.push({ absolutePath: cssPath, before, after: replaceCssRule(before, request.cssSelector.trim(), request.declarations ?? {}) })
    }
    this.#write(changes)
    const undoId = randomUUID()
    this.#applied.set(undoId, { summary: 'Element edit', changes })
    if (this.#applied.size > UNDO_LIMIT) this.#applied.delete(this.#applied.keys().next().value!)
    return { hash: contentHash(after), undoId }
  }

  optimizeTailwind(request: TailwindOptimizeRequest): TailwindOptimizeResult {
    const absolutePath = this.resolve(request.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    this.invalidate(absolutePath)
    const entry = this.#compile(absolutePath)
    if (contentHash(entry.source) !== request.hash) throw new RefactorError('The source file changed. Reload before optimizing.', 409)
    if (entry.result === null) throw new RefactorError('The source file does not compile.', 422)
    const defaultHost = componentNameFromPath(absolutePath)
    if (request.host !== defaultHost && !entry.result.ast.declarations.some((d) => d.kind === 'component' && d.name === request.host)) throw new RefactorError('That component is no longer available. Select it again.', 409)
    const after = optimizeTailwind(entry.result.ast, entry.source, request.host, defaultHost)
    if (after === entry.source) return { hash: request.hash, undoId: null, changed: false }
    const change = { absolutePath, before: entry.source, after }
    this.#validate(change)
    this.#write([change])
    const undoId = randomUUID()
    this.#applied.set(undoId, { summary: `Tailwind optimization in ${request.host}`, changes: [change] })
    if (this.#applied.size > UNDO_LIMIT) this.#applied.delete(this.#applied.keys().next().value!)
    return { hash: contentHash(after), undoId, changed: true }
  }

  sourceBlock(selection: SourceBlockSelection): SourceBlockReport {
    const absolutePath = this.resolve(selection.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    const entry = this.#compile(absolutePath)
    const block = this.#blocks(entry, absolutePath).find((candidate) => candidate.host === selection.host && candidate.startLine === selection.line && candidate.kind === selection.kind)
    if (!block) throw new RefactorError('That source block is no longer available. Select it again.', 409)
    return { path: this.#relative(absolutePath), hash: contentHash(entry.source), block,
      code: entry.source.split(/\r?\n/).slice(block.startLine - 1, block.endLine).join('\n') }
  }

  editBlock(request: BlockEditRequest): BlockEditResult {
    const absolutePath = this.resolve(request.path)
    if (absolutePath === null) throw new RefactorError('Unknown .btsx file.', 422)
    this.invalidate(absolutePath)
    const entry = this.#compile(absolutePath)
    if (contentHash(entry.source) !== request.hash) throw new RefactorError('The source file changed. Reload the block before saving.', 409)
    const original = this.sourceBlock(request)
    const code = pinBlockIndent(request.code, original.block.indent)
    if (!code.trim()) throw new RefactorError('A code block cannot be empty.', 422)
    const lines = entry.source.split(/\r?\n/)
    const eol = entry.source.includes('\r\n') ? '\r\n' : '\n'
    lines.splice(original.block.startLine - 1, original.block.endLine - original.block.startLine + 1, ...code.split('\n'))
    let after = lines.join(eol)
    if (original.block.endLine === entry.source.split('\n').length && entry.source.endsWith('\n')) after += eol
    const change = { absolutePath, before: entry.source, after }
    this.#validate(change)
    this.#write([change])
    const undoId = randomUUID()
    this.#applied.set(undoId, { summary: 'Code block edit', changes: [change] })
    if (this.#applied.size > UNDO_LIMIT) this.#applied.delete(this.#applied.keys().next().value!)
    const next = this.#compile(absolutePath)
    const nextBlocks = this.#blocks(next, absolutePath)
    const candidates = nextBlocks.filter((block) => block.host === request.host && block.startLine === request.line)
    const block = candidates.find((block) => block.kind === request.kind) ?? candidates.find((block) => block.kind !== 'component')
      ?? (request.kind === 'component' && request.host !== componentNameFromPath(absolutePath)
        ? nextBlocks.find((block) => block.kind === 'component' && block.host !== componentNameFromPath(absolutePath) && block.startLine === request.line) : undefined)
    if (!block) return { ...original, hash: contentHash(after), code, undoId }
    return { ...this.sourceBlock({ ...request, host: block.host, kind: block.kind }), undoId }
  }

  #blocks(entry: CompiledEntry, absolutePath: string): SourceBlock[] {
    if (entry.blocks) return entry.blocks
    if (!entry.result) return []
    const name = componentNameFromPath(absolutePath)
    let beast = entry.result
    let compiled: { code: string; map: import('beast-tsrx').BeastSourceMap } | null = null
    try {
      if (this.#options.sourceTags !== false) beast = compileBeastResult(tagSource(entry.source, absolutePath, this.#relative(absolutePath)), { filename: absolutePath, componentName: name })
      this.#octane ??= createOctaneCompiler({ root: this.#options.root, environment: 'client', hmr: false, dev: true })
      const result = this.#octane.transform(beast.code, absolutePath.replace(/\.btsx$/, '.tsrx'), { environment: 'client', dev: true })
      if (result?.map) compiled = { code: result.code, map: result.map as import('beast-tsrx').BeastSourceMap }
    } catch {
      // Components remain source-backed even when Octane cannot map a scope.
    }
    entry.blocks = sourceBlocks(entry.result.ast, entry.source, name, absolutePath, compiled, beast, (file) => this.#types.resolve(file))
    return entry.blocks
  }

  /** Restore the files an applied refactor touched, if nobody has edited them since. */
  undo(id: string): UndoResult {
    const applied = this.#applied.get(id)
    if (applied === undefined) throw new RefactorError('Nothing to undo for that refactor.', 409)
    for (const change of applied.changes) {
      const current = existsSync(change.absolutePath) ? readFileSync(change.absolutePath, 'utf8') : null
      if (current !== change.after) {
        throw new RefactorError(`${this.#relative(change.absolutePath)} was edited after the refactor, so it was not undone.`, 409)
      }
    }
    // Restore edited files first so nothing imports a file about to be removed.
    const ordered = [...applied.changes].sort((a, b) => Number(a.before === null) - Number(b.before === null))
    for (const change of ordered) {
      if (change.before === null) unlinkSync(change.absolutePath)
      else writeFileSync(change.absolutePath, change.before)
      this.invalidate(change.absolutePath)
    }
    this.#applied.delete(id)
    return { summary: `Undid: ${applied.summary}` }
  }

  #typed(sourcePath: string): AnalyzeOptions {
    return { sourcePath, resolveTypes: (file) => this.#types.resolve(file) }
  }

  #validate(change: FileChange): void {
    const filename = change.absolutePath
    const { code } = (() => {
      try {
        return compileBeastResult(change.after, { filename, componentName: componentNameFromPath(filename) })
      } catch (error) {
        const detail = error instanceof BeastCompileError ? formatDiagnostic(error.diagnostic, change.after) : String(error)
        throw new RefactorError(`The refactored ${this.#relative(filename)} would not compile:\n${detail}`, 422)
      }
    })()
    this.#octane ??= createOctaneCompiler({ root: this.#options.root, environment: 'client', hmr: false, dev: true })
    try {
      this.#octane.transform(code, filename.replace(/\.btsx$/, '.tsrx'), { environment: 'client', dev: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RefactorError(`Octane rejected the refactored ${this.#relative(filename)}: ${message}`, 422)
    }
  }

  #write(changes: readonly FileChange[]): void {
    for (const change of changes) {
      const current = existsSync(change.absolutePath) ? readFileSync(change.absolutePath, 'utf8') : null
      if (current !== change.before) {
        throw new RefactorError(`${this.#relative(change.absolutePath)} changed while the refactor was prepared.`, 409)
      }
    }
    // New files first, so the edited importer never points at a missing module.
    const ordered = [...changes].sort((a, b) => Number(b.before === null) - Number(a.before === null))
    const written: FileChange[] = []
    try {
      for (const change of ordered) {
        writeFileSync(change.absolutePath, change.after, change.before === null ? { flag: 'wx' } : {})
        written.push(change)
        this.invalidate(change.absolutePath)
      }
    } catch (error) {
      for (const change of written.reverse()) {
        if (change.before === null) unlinkSync(change.absolutePath)
        else writeFileSync(change.absolutePath, change.before)
      }
      throw error
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

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
])

/** A chosen name must be a fresh identifier: PascalCase for components, camelCase for mappings. */
function validateName(name: string, suggestion: RefactorSuggestion, source: string): void {
  const component = suggestion.mapping === null
  const shape = component ? /^[A-Z][A-Za-z0-9_$]*$/ : /^[a-z_$][A-Za-z0-9_$]*$/
  if (!shape.test(name) || RESERVED.has(name)) {
    throw new RefactorError(
      component ? `"${name}" is not a valid component name. Use PascalCase, like UserCard.` : `"${name}" is not a valid variable name.`,
      422,
    )
  }
  const used = (word: string) => new RegExp(`(^|[^\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$])`).test(source)
  if (used(name)) throw new RefactorError(`${name} is already used in this file. Choose another name.`, 422)
  if (component && suggestion.propsType !== null && used(`${name}Props`)) {
    throw new RefactorError(`${name}Props is already used in this file. Choose another name.`, 422)
  }
}

function contentHash(source: string): string {
  return createHash('sha1').update(source).digest('hex').slice(0, 16)
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
