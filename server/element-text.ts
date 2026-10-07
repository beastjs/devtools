import ts from 'typescript'
import { dirname, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { BeastDocument, BeastNode, EachNode, ElementNode, SetupDeclaration, ModuleDeclaration, TextSpan, SourceTextFragment } from 'beast-tsrx'
import type { ElementTextRequest, ElementTextSource } from '../shared/types.js'
import { RefactorError } from './refactor.js'
import { parsePropsParameter } from './source-scan.js'

type CodeBlock = SetupDeclaration | ModuleDeclaration
interface Selection { node: ElementNode; loops: EachNode[]; blocks: CodeBlock[]; props: string[] }
interface Value { expression: ts.Expression; file: ts.SourceFile; block: CodeBlock }
interface Candidate { value: Value; text: string }
interface Resolution { info: ElementTextSource; candidate?: Candidate; prefix?: string; suffix?: string }

function selection(document: BeastDocument, request: ElementTextRequest): Selection {
  let found: Selection | undefined
  const moduleBlocks = document.declarations.filter((d): d is ModuleDeclaration => d.kind === 'module')
  const visit = (nodes: readonly BeastNode[], loops: EachNode[], blocks: CodeBlock[], props: string[]) => {
    for (const node of nodes) {
      if (node.kind === 'element' && node.span.start.line === request.line && node.span.start.column === request.column && node.tag === request.tag && !node.isComponent) found = { node, loops, blocks, props }
      switch (node.kind) {
        case 'element': case 'fragment': visit(node.children, loops, blocks, props); break
        case 'scope': visit(node.children, loops, [...blocks, ...node.setup], props); break
        case 'each': visit(node.children, [...loops, node], blocks, props); visit(node.emptyChildren ?? [], loops, blocks, props); break
        case 'if': case 'switch': node.branches.forEach((branch) => visit(branch.children, loops, blocks, props)); break
        case 'try': visit(node.children, loops, blocks, props); visit(node.pendingBranch?.children ?? [], loops, blocks, props); visit(node.catchBranch?.children ?? [], loops, blocks, props); break
      }
    }
  }
  const props = document.declarations.find((d) => d.kind === 'props')
  visit(document.children, [], [...moduleBlocks, ...document.declarations.filter((d): d is SetupDeclaration => d.kind === 'setup')], props?.kind === 'props' ? parsePropsParameter(props.parameter).names : [])
  for (const d of document.declarations) if (d.kind === 'component') visit(d.children, [], [...moduleBlocks, ...d.setup], d.props ? parsePropsParameter(d.props.parameter).names : [])
  if (!found) throw new RefactorError('The source element changed. Pick it again.', 409)
  return found
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression
  return expression
}

function expression(code: string): ts.Expression | undefined {
  const file = ts.createSourceFile('expression.ts', `const value = (${code});`, ts.ScriptTarget.Latest, true)
  const statement = file.statements[0]
  return statement && ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.initializer ? unwrap(statement.declarationList.declarations[0]!.initializer!) : undefined
}

function memberPath(expr: ts.Expression): string[] | null {
  expr = unwrap(expr)
  if (ts.isIdentifier(expr)) return [expr.text]
  if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
    const base = memberPath(expr.expression)
    return base && [...base, expr.name.text]
  }
  if (ts.isElementAccessExpression(expr) && !expr.questionDotToken && (ts.isStringLiteral(expr.argumentExpression) || ts.isNumericLiteral(expr.argumentExpression))) {
    const base = memberPath(expr.expression)
    return base && [...base, expr.argumentExpression.text]
  }
  return null
}

function field(value: Value, path: readonly string[]): Value | null {
  let expr = unwrap(value.expression)
  for (const name of path) {
    if (ts.isArrayLiteralExpression(expr) && /^\d+$/.test(name)) {
      const item = expr.elements[Number(name)]
      if (!item || ts.isSpreadElement(item)) return null
      expr = unwrap(item)
    } else if (ts.isObjectLiteralExpression(expr)) {
      // Computed members and spreads may override a literal member at runtime.
      if (expr.properties.some((p) => ts.isSpreadAssignment(p) || p.name && ts.isComputedPropertyName(p.name))) return null
      const properties = expr.properties.filter((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) && p.name.text === name)
      const property = properties.at(-1)
      if (!property || !ts.isPropertyAssignment(property)) return null
      expr = unwrap(property.initializer)
    } else return null
  }
  return { ...value, expression: expr }
}

function scalar(value: Value): string | null {
  const expr = unwrap(value.expression)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return String(Number(expr.text))
  return null
}

function offset(source: string, fragments: SourceTextFragment[], position: number, end = false): number | null {
  const fragment = fragments.find((f) => end ? position > f.start && position <= f.end : position >= f.start && position < f.end)
  if (!fragment) return null
  // Beast offsets normalize CRLF; authored line/column positions retain exact bytes.
  const lines = source.split('\n')
  const start = lines.slice(0, fragment.source.start.line - 1).reduce((offset, line) => offset + line.length + 1, 0) + fragment.source.start.column - 1
  return start + position - fragment.start
}

function position(source: string, at: number): { line: number; column: number } {
  const before = source.slice(0, at)
  return { line: before.split('\n').length, column: at - before.lastIndexOf('\n') }
}

function importedSource(document: BeastDocument, binding: string, sourcePath: string, root: string): ElementTextSource | null {
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'import') continue
    const file = ts.createSourceFile(sourcePath + '.ts', declaration.code, ts.ScriptTarget.Latest, true)
    const statement = file.statements[0]
    if (!statement || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    const named = clause?.namedBindings
    const specifier = named && ts.isNamedImports(named) ? named.elements.find((item) => item.name.text === binding) : undefined
    if (clause?.name?.text !== binding && !(named && ts.isNamespaceImport(named) && named.name.text === binding) && !specifier) continue
    const configPath = ts.findConfigFile(root, ts.sys.fileExists)
    const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {}
    const options = ts.parseJsonConfigFileContent(config, ts.sys, configPath ? dirname(configPath) : root).options
    const spec = statement.moduleSpecifier.text
    let path = ts.resolveModuleName(spec, sourcePath, { ...options, allowArbitraryExtensions: true }, ts.sys).resolvedModule?.resolvedFileName
    if (!path && spec.startsWith('.')) {
      const base = resolve(dirname(sourcePath), spec)
      path = [base, ...['.ts', '.tsx', '.js', '.json', '.btsx', '/index.ts', '/index.js'].map((ext) => base + ext)].find((candidate) => existsSync(candidate) && ts.sys.fileExists(candidate))
    }
    const exported = specifier?.propertyName?.text ?? (specifier ? binding : 'default')
    let line = 1
    let column = 1
    if (path && !path.endsWith('.btsx')) {
      const imported = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const statement of imported.statements) {
        if (!ts.isVariableStatement(statement)) continue
        const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === exported)
        if (declaration) { const pos = imported.getLineAndCharacterOfPosition(declaration.getStart(imported)); line = pos.line + 1; column = pos.character + 1; break }
      }
    }
    return { kind: 'imported', label: binding, path: path ?? sourcePath, line: path ? line : declaration.span.start.line, column: path ? column : declaration.span.start.column, message: path ? `This text comes from ${binding} in an imported file. Edit its array in source.` : `This text comes from imported ${binding}. Open its import to locate the array.` }
  }
  return null
}

/** Resolve mapped text to a literal data value without executing app code. */
function resolveText(document: BeastDocument, source: string, request: ElementTextRequest, sourcePath: string, root: string): Resolution {
  const selected = selection(document, request)
  const spans: TextSpan[] = [...selected.node.inlineSpans ?? [], ...selected.node.children.flatMap((child) => child.kind === 'text' ? child.spans : [])]
  const expressions = spans.filter((span) => span.type === 'expr')
  if (selected.loops.length === 0 || expressions.length === 0) return { info: { kind: 'direct' } }
  const unsupported = (message = 'This mapped text is computed. Edit the array in source to preserve its mapping.'): Resolution => ({ info: { kind: 'unsupported', message } })
  if (selected.node.children.some((child) => child.kind !== 'text') || expressions.length !== 1) return unsupported()
  const expr = expression(expressions[0]!.code)
  const path = expr && memberPath(expr)
  if (!path) return unsupported()
  let loopIndex = -1
  selected.loops.forEach((loop, index) => { if (loop.itemName === path[0]) loopIndex = index })
  if (loopIndex < 0) return unsupported()
  const bindings = new Map<string, Value | null>()
  for (const block of selected.blocks) {
    const file = ts.createSourceFile('data.ts', block.code, ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) bindings.set(declaration.name.text, declaration.initializer ? { expression: unwrap(declaration.initializer), file, block } : null)
        else for (const name of declaration.name.elements) if (ts.isBindingElement(name) && ts.isIdentifier(name.name)) bindings.set(name.name.text, null)
      }
    }
  }
  selected.props.forEach((name) => bindings.set(name, null))
  const rootPath = expression(selected.loops[0]!.iterable)
  const rootNames = rootPath && memberPath(rootPath)
  if (!rootNames) return unsupported()
  let origin = rootNames[0]!
  const aliases = new Set<string>()
  while (!aliases.has(origin)) {
    aliases.add(origin)
    if (!bindings.has(origin)) {
      const imported = importedSource(document, origin, sourcePath, root)
      if (imported) return { info: imported }
      break
    }
    const value = bindings.get(origin)
    const alias = value && memberPath(value.expression)
    if (!alias) break
    origin = alias[0]!
  }
  const resolveBinding = (name: string, seen = new Set<string>()): Value | null => {
    const value = bindings.get(name)
    if (!value || seen.has(name)) return null
    const alias = memberPath(value.expression)
    if (!alias) return value
    seen.add(name)
    const base = resolveBinding(alias[0]!, seen)
    return base && field(base, alias.slice(1))
  }
  const base = resolveBinding(rootNames[0]!)
  const rootValue = base && field(base, rootNames.slice(1))
  if (!rootValue) return unsupported()
  let instances: Map<string, Value>[] = [new Map()]
  for (let i = 0; i <= loopIndex; i++) {
    const loop = selected.loops[i]!
    const iterable = expression(loop.iterable)
    const names = iterable && memberPath(iterable)
    if (!names) return unsupported()
    const expanded: Map<string, Value>[] = []
    for (const instance of instances) {
      const parent = i === 0 ? rootValue : instance.get(names[0]!) ?? resolveBinding(names[0]!)
      const value = i === 0 ? parent : parent && field(parent, names.slice(1))
      const array = value && unwrap(value.expression)
      if (!value || !array || !ts.isArrayLiteralExpression(array) || array.elements.some((item) => ts.isSpreadElement(item) || ts.isOmittedExpression(item))) return unsupported()
      for (const item of array.elements) expanded.push(new Map([...instance, [loop.itemName, { ...value, expression: unwrap(item) }]]))
      if (expanded.length > 10000) return unsupported('This mapped array is too large to resolve safely. Edit it in source.')
    }
    instances = expanded
  }
  const expressionIndex = spans.indexOf(expressions[0]!)
  const prefix = spans.slice(0, expressionIndex).map((span) => span.type === 'literal' ? span.text : '').join('')
  const suffix = spans.slice(expressionIndex + 1).map((span) => span.type === 'literal' ? span.text : '').join('')
  const candidates: Candidate[] = []
  for (const instance of instances) {
    const item = instance.get(path[0]!)
    const value = item && field(item, path.slice(1))
    const text = value && scalar(value)
    if (!value || text === null) return unsupported()
    candidates.push({ value, text: prefix + text + suffix })
  }
  const matching = candidates.filter((candidate) => candidate.text === request.textContext.value)
  const indexed = request.textContext.count === candidates.length ? candidates[request.textContext.index] : undefined
  const candidate = indexed?.text === request.textContext.value ? indexed : matching.length === 1 ? matching[0] : undefined
  if (!candidate) return unsupported('The mapped item could not be identified uniquely. Pick it again or edit the array in source.')
  const at = offset(source, candidate.value.block.codeFragments, candidate.value.expression.getStart(candidate.value.file))
  if (at === null) return unsupported()
  return { info: { kind: 'array', label: selected.loops[0]!.iterable, path: sourcePath, ...position(source, at) }, candidate, prefix, suffix }
}

export function elementTextSource(document: BeastDocument, source: string, request: ElementTextRequest, sourcePath: string, root: string): ElementTextSource {
  return resolveText(document, source, request, sourcePath, root).info
}

/** Returns null for ordinary text; mapped text must never become a template literal. */
export function editMappedText(document: BeastDocument, source: string, request: ElementTextRequest, value: string): string | null {
  const result = resolveText(document, source, request, request.path, dirname(request.path))
  if (result.info.kind === 'direct') return null
  if (!result.candidate) throw new RefactorError(result.info.message ?? 'Edit the mapped array in source.', 422)
  const { prefix = '', suffix = '', candidate } = result
  if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length < prefix.length + suffix.length) throw new RefactorError('Keep the surrounding text unchanged when editing an array value.', 422)
  const next = value.slice(prefix.length, value.length - suffix.length || undefined)
  const { expression: expr, file, block } = candidate.value
  const start = offset(source, block.codeFragments, expr.getStart(file))
  const end = offset(source, block.codeFragments, expr.end, true)
  if (start === null || end === null || source.slice(start, end) !== expr.getText(file)) throw new RefactorError('The array value cannot be edited safely. Edit it in source.', 422)
  const numeric = ts.isNumericLiteral(expr)
  if (numeric && (!next.trim() || !Number.isFinite(Number(next)))) throw new RefactorError('Enter a finite number for this array value.', 422)
  return source.slice(0, start) + (numeric ? String(Number(next)) : JSON.stringify(next)) + source.slice(end)
}
