import { basename, dirname, join } from 'node:path'
import type { BeastDocument, ModuleDeclaration } from 'beast-tsrx'
import type { LineRange, RefactorSuggestion, RefactorTarget } from '../shared/types.js'
import { parseImport, renderImport, topLevelDeclarations, type Declaration, type ImportSpecifier } from './source-scan.js'

/** A refusal with an HTTP status: 409 for stale input, 422 for refactors that cannot be done safely. */
export class RefactorError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 422,
  ) {
    super(message)
  }
}

export interface FileChange {
  absolutePath: string
  /** Previous content, or null when the file is created. */
  before: string | null
  after: string
}

export interface RefactorPlan {
  component: string
  summary: string
  changes: FileChange[]
}

export interface PlanInput {
  absolutePath: string
  source: string
  document: BeastDocument
  suggestion: RefactorSuggestion
  target: RefactorTarget
  exists: (absolutePath: string) => boolean
}

interface LineEdit {
  /** 1-based line where the edit starts; insertions go before it. */
  start: number
  deleteCount: number
  insert: string[]
}

/**
 * Turn a refactor suggestion into concrete file contents, either hoisting the
 * section into a local `component` of the same file or moving it to a sibling
 * `.btsx` file. The caller validates and writes the result.
 */
export function planRefactor(input: PlanInput): RefactorPlan {
  const { suggestion, target } = input
  if (suggestion.autoApply.blocked !== null) throw new RefactorError(suggestion.autoApply.blocked, 422)
  if (target === 'file' && suggestion.autoApply.fileBlocked !== null) {
    throw new RefactorError(suggestion.autoApply.fileBlocked, 422)
  }
  return target === 'inline' ? planInline(input) : planFile(input)
}

function planInline({ absolutePath, source, suggestion }: PlanInput): RefactorPlan {
  const lines = source.split('\n')
  const edits: LineEdit[] = [
    ...replaceOccurrences(lines, suggestion, suggestion.name),
    { start: suggestion.insertBeforeLine, deleteCount: 0, insert: [...suggestion.snippet.split('\n'), ''] },
  ]
  return {
    component: suggestion.name,
    summary: `Hoisted ${suggestion.name} into ${basename(absolutePath)}`,
    changes: [{ absolutePath, before: source, after: applyEdits(lines, edits).join('\n') }],
  }
}

function planFile({ absolutePath, source, document, suggestion, exists }: PlanInput): RefactorPlan {
  const lines = source.split('\n')
  const dir = dirname(absolutePath)
  const name = availableName(suggestion.name, source, (candidate) => exists(join(dir, `${candidate}.btsx`)))
  const newPath = join(dir, `${name}.btsx`)
  const references = new Set(suggestion.references)
  suggestion.props.forEach((prop) => references.delete(prop.name))

  // Imports the section relies on are copied; both files sit in one directory,
  // so relative specifiers stay valid.
  const header: string[] = []
  const imports = document.declarations.filter((d) => d.kind === 'import')
  for (const declaration of imports) {
    const parsed = parseImport(declaration.code)
    if (parsed === null) continue
    const used = parsed.specifiers.filter((specifier) => references.has(specifier.local))
    if (used.length > 0) header.push(...renderImport(parsed, used))
  }

  // Module-level types and values the section uses are exported from the
  // source and imported back. Type imports are erased, so only values create
  // a (render-time, cycle-safe) runtime import.
  const exported = new Map<string, { declaration: Declaration; module: ModuleDeclaration }>()
  const directives: string[] = []
  for (const module of document.declarations) {
    if (module.kind !== 'module') continue
    directives.push(...leadingDirectives(module.code))
    for (const declaration of topLevelDeclarations(module.code)) {
      for (const binding of declaration.names) {
        if (references.has(binding) && !exported.has(binding)) exported.set(binding, { declaration, module })
      }
    }
  }
  const quote = imports.length > 0 ? (parseImport(imports[0]!.code)?.quote ?? "'") : "'"
  const sourceSpecifier = `./${basename(absolutePath)}`
  const specifiers: ImportSpecifier[] = [...exported].map(([binding, { declaration }]) => ({
    local: binding,
    imported: binding,
    typeOnly: declaration.kind === 'type',
  }))
  if (specifiers.length > 0) {
    header.push(...renderImport({ source: sourceSpecifier, quote, typeOnly: false, specifiers }, specifiers))
  }

  const [, ...rest] = suggestion.snippet.split('\n')
  const body = rest.map((line) => line.replace(/^ {2}/, ''))
  const content = [
    ...(directives.length > 0 ? ['module', ...directives.map((directive) => `  ${directive}`)] : []),
    ...header,
    ...(body[0]?.startsWith('props ') ? [body.shift()!] : []),
    ...(header.length > 0 || directives.length > 0 ? [''] : []),
    ...body,
    '',
  ]

  const edits: LineEdit[] = [
    ...replaceOccurrences(lines, suggestion, name),
    ...exportEdits(lines, [...exported.values()]),
    {
      start: importInsertLine(document),
      deleteCount: 0,
      insert: [`import ${name} from ${quote}./${name}.btsx${quote}`],
    },
  ]

  return {
    component: name,
    summary: `Moved ${name} to ${name}.btsx`,
    changes: [
      { absolutePath, before: source, after: applyEdits(lines, edits).join('\n') },
      { absolutePath: newPath, before: null, after: content.join('\n') },
    ],
  }
}

/** Replace every occurrence with a call, keeping each occurrence's indentation. */
function replaceOccurrences(lines: readonly string[], suggestion: RefactorSuggestion, name: string): LineEdit[] {
  const call = suggestion.usage.trimStart().replace(suggestion.name, name)
  return suggestion.occurrences.map((range: LineRange) => {
    const indent = /^ */.exec(lines[range.startLine - 1] ?? '')![0]
    return { start: range.startLine, deleteCount: range.endLine - range.startLine + 1, insert: [indent + call] }
  })
}

/** Add `export` to each module declaration another file now imports. */
function exportEdits(
  lines: readonly string[],
  targets: ReadonlyArray<{ declaration: Declaration; module: ModuleDeclaration }>,
): LineEdit[] {
  const byLine = new Map<number, Declaration[]>()
  const seen = new Set<Declaration>()
  for (const { declaration, module } of targets) {
    // One `const { a, b } = …` can supply several imported bindings.
    if (declaration.exported || seen.has(declaration)) continue
    seen.add(declaration)
    const line = module.codeStart.line + module.code.slice(0, declaration.offset).split('\n').length - 1
    byLine.set(line, [...(byLine.get(line) ?? []), declaration])
  }
  return [...byLine].map(([line, declarations]) => {
    let text = lines[line - 1] ?? ''
    for (const declaration of declarations) {
      const keyword = declaration.keyword.replace(/\s+/g, '\\s+')
      const pattern = new RegExp(`(^|[^\\w$.])(${keyword}\\s+)`)
      if (!pattern.test(text)) throw new RefactorError(`Could not export ${declaration.names.join(', ')} on line ${line}.`, 422)
      text = text.replace(pattern, '$1export $2')
    }
    return { start: line, deleteCount: 1, insert: [text] }
  })
}

/** After the last import, or after a leading directive-only `module`, or at the top. */
function importInsertLine(document: BeastDocument): number {
  const imports = document.declarations.filter((d) => d.kind === 'import')
  if (imports.length > 0) return Math.max(...imports.map((d) => d.span.end.line)) + 1
  const first = document.declarations[0]
  if (first?.kind === 'module' && leadingDirectives(first.code).length > 0) {
    return first.codeStart.line + first.code.trimEnd().split('\n').length
  }
  return 1
}

/** `"use strong";`-style directives at the start of a module block. */
function leadingDirectives(code: string): string[] {
  const directives: string[] = []
  for (const line of code.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (!/^(['"])use [\w ]+\1;?$/.test(text)) break
    directives.push(text)
  }
  return directives
}

/** The suggested name, suffixed until it is free as a file and as an identifier. */
function availableName(base: string, source: string, taken: (name: string) => boolean): string {
  let name = base
  for (let n = 2; taken(name) || (name !== base && new RegExp(`\\b${name}\\b`).test(source)); n++) name = `${base}${n}`
  return name
}

function applyEdits(lines: readonly string[], edits: readonly LineEdit[]): string[] {
  // Bottom-up keeps earlier line numbers valid; at one line, rewrites go
  // before insertions so an insertion never lands on a rewritten line.
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.deleteCount - a.deleteCount)
  const next = [...lines]
  let floor = Number.POSITIVE_INFINITY
  for (const edit of ordered) {
    if (edit.start + edit.deleteCount > floor) throw new RefactorError('Refactor edits overlap.', 422)
    next.splice(edit.start - 1, edit.deleteCount, ...edit.insert)
    floor = edit.start
  }
  return next
}
