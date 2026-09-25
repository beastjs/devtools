import type {
  BeastDocument,
  BeastNode,
  ElementNode,
  PropsDeclaration,
  SetupDeclaration,
} from 'beast-tsrx'
import type {
  AnalyzerSettings,
  AutoApply,
  ComponentMetrics,
  FileAnalysis,
  LineRange,
  RefactorSuggestion,
  Severity,
  SuggestedProp,
} from '../shared/types.js'
import { hookCall, identifiersIn, parsePropsParameter, topLevelDeclarations } from './source-scan.js'

/** Component-scope bindings visible at a template position, mapped to a best-effort type. */
type Bindings = ReadonlyMap<string, string>

interface NodeInfo {
  node: BeastNode
  host: Host
  depth: number
  start: number
  end: number
  height: number
  nodeCount: number
  uses: Set<string>
  shape: string
  /** Attribute, text, and expression values in document order, for variant diffing. */
  values: string[]
  available: Bindings
  parent: NodeInfo | null
  children: NodeInfo[]
}

interface Host {
  name: string
  /** Line of the `component` keyword, or null for the file's default component. */
  declarationLine: number | null
  roots: NodeInfo[]
  insertBeforeLine: number
  /** Scoped `style` blocks match only their owning component's elements. */
  hasStyle: boolean
}

interface Context {
  settings: AnalyzerSettings
  lines: string[]
  lineDepths: Array<number | null>
  moduleNames: Set<string>
  takenNames: Set<string>
  localComponents: Set<string>
}

export function analyzeDocument(
  document: BeastDocument,
  source: string,
  componentName: string,
  settings: AnalyzerSettings,
): FileAnalysis {
  const lines = source.split('\n')
  const context: Context = {
    settings,
    lines,
    lineDepths: Array.from({ length: lines.length }, () => null),
    moduleNames: new Set(),
    takenNames: new Set([componentName]),
    localComponents: new Set([componentName]),
  }

  for (const declaration of document.declarations) {
    if (declaration.kind === 'module') {
      for (const { names } of topLevelDeclarations(declaration.code)) names.forEach((name) => context.moduleNames.add(name))
    } else if (declaration.kind === 'import') {
      for (const name of identifiersIn(declaration.code.replace(/\bfrom\s+(['"]).*?\1/, ''))) {
        if (/^[A-Z]/.test(name)) context.takenNames.add(name)
      }
    } else if (declaration.kind === 'component') {
      context.takenNames.add(declaration.name)
      context.localComponents.add(declaration.name)
    }
  }

  const hosts: Host[] = []
  const topProps = document.declarations.find((d): d is PropsDeclaration => d.kind === 'props') ?? null
  const topSetup = document.declarations.filter((d): d is SetupDeclaration => d.kind === 'setup')
  const firstOwnDeclaration = [topProps, ...topSetup]
    .filter((d) => d !== null)
    .reduce((min, d) => Math.min(min, d.span.start.line), Number.POSITIVE_INFINITY)

  for (const declaration of document.declarations) {
    if (declaration.kind !== 'component') continue
    const host: Host = {
      name: declaration.name,
      declarationLine: declaration.span.start.line,
      roots: [],
      insertBeforeLine: declaration.span.start.line,
      hasStyle: false,
    }
    host.roots = buildAll(context, host, declaration.children, 0, null, componentBindings(declaration.props, declaration.setup))
    hosts.push(host)
  }

  const defaultHost: Host = {
    name: componentName,
    declarationLine: null,
    roots: [],
    insertBeforeLine: Number.isFinite(firstOwnDeclaration)
      ? firstOwnDeclaration
      : (document.children[0]?.span.start.line ?? lines.length + 1),
    hasStyle: false,
  }
  defaultHost.roots = buildAll(context, defaultHost, document.children, 0, null, componentBindings(topProps, topSetup))
  hosts.push(defaultHost)

  const suggestions = [
    ...hosts.flatMap((host) => suggestExtractions(context, host)),
    ...suggestDuplicates(context, hosts),
  ].map((suggestion, index) => ({ ...suggestion, id: `s${index + 1}` }))

  const components: ComponentMetrics[] = hosts.map((host) => {
    const all = host.roots.flatMap(flatten)
    const templateLineSet = new Set<number>()
    for (const info of all) for (let line = info.start; line <= info.end; line++) {
      if (context.lineDepths[line - 1] != null) templateLineSet.add(line)
    }
    return {
      name: host.name,
      line: host.declarationLine ?? host.roots[0]?.start ?? 1,
      templateLines: templateLineSet.size,
      maxDepth: all.reduce((max, info) => Math.max(max, info.depth), 0),
    }
  })

  const depths = context.lineDepths.filter((depth): depth is number => depth !== null)
  const maxDepth = depths.reduce((max, depth) => Math.max(max, depth), 0)
  const histogram = Array.from({ length: maxDepth + 1 }, () => 0)
  for (const depth of depths) histogram[depth]!++

  return {
    settings,
    indentUnit: detectIndentUnit(lines, context.lineDepths),
    lineDepths: context.lineDepths,
    maxDepth,
    averageDepth: depths.length === 0 ? 0 : round(depths.reduce((sum, depth) => sum + depth, 0) / depths.length),
    templateLines: depths.length,
    deepLines: depths.filter((depth) => depth > settings.depthLimit).length,
    histogram,
    components,
    suggestions,
  }
}

// ---------------------------------------------------------------------------
// Tree construction

function buildAll(
  context: Context,
  host: Host,
  nodes: readonly BeastNode[],
  depth: number,
  parent: NodeInfo | null,
  available: Bindings,
): NodeInfo[] {
  return nodes.map((node) => build(context, host, node, depth, parent, available))
}

function build(
  context: Context,
  host: Host,
  node: BeastNode,
  depth: number,
  parent: NodeInfo | null,
  available: Bindings,
): NodeInfo {
  const info: NodeInfo = {
    node,
    host,
    depth,
    start: node.span.start.line,
    end: node.span.end.line,
    height: 0,
    nodeCount: 1,
    uses: new Set(),
    shape: '',
    values: [],
    available,
    parent,
    children: [],
  }
  markLines(context, node.span.start.line, node.span.end.line, depth)

  const own: string[] = []
  const groups: Array<{ label: string; children: NodeInfo[] }> = []
  const addGroup = (label: string, children: readonly BeastNode[], childDepth: number, bindings: Bindings) => {
    const built = buildAll(context, host, children, childDepth, info, bindings)
    groups.push({ label, children: built })
    info.children.push(...built)
  }

  switch (node.kind) {
    case 'element': {
      // A component tag references a binding just like an expression does.
      if (node.isComponent) own.push(node.tag)
      if (node.id !== null) info.values.push(`#${node.id}`)
      for (const name of node.classes) info.values.push(`.${name}`)
      for (const attr of node.attrs) {
        if (attr.kind === 'spread') {
          own.push(attr.code)
          info.values.push(`...${attr.code}`)
        } else {
          if (attr.value.type === 'expr') own.push(attr.value.code)
          info.values.push(`${attr.name}=${attr.value.type === 'string' ? attr.value.value : attr.value.type === 'expr' ? attr.value.code : ''}`)
        }
      }
      for (const span of node.inlineSpans ?? []) {
        if (span.type === 'expr') own.push(span.code)
        info.values.push(span.type === 'expr' ? span.code : span.text)
      }
      addGroup(node.isComponent ? node.tag : node.tag.toLowerCase(), node.children, depth + 1, available)
      break
    }
    case 'text':
      for (const span of node.spans) {
        if (span.type === 'expr') own.push(span.code)
        info.values.push(span.type === 'expr' ? span.code : span.text)
      }
      groups.push({ label: 't', children: [] })
      break
    case 'fragment':
      addGroup('fragment', node.children, depth + 1, available)
      break
    case 'style':
      host.hasStyle = true
      groups.push({ label: 'style', children: [] })
      break
    case 'scope': {
      markSetupLines(context, node.setup, depth + 1)
      const scoped = new Map(available)
      for (const setup of node.setup) {
        own.push(setup.code)
        for (const declaration of topLevelDeclarations(setup.code)) {
          for (const [name, type] of inferDeclarationTypes(declaration.names, declaration.init)) scoped.set(name, type)
        }
      }
      addGroup('scope', node.children, depth + 1, scoped)
      break
    }
    case 'if':
      for (const branch of node.branches) {
        markLines(context, branch.span.start.line, branch.span.end.line, depth)
        info.end = Math.max(info.end, branch.span.end.line)
        if (branch.test !== null) own.push(branch.test)
        info.values.push(branch.test ?? 'else')
        addGroup(branch.test === null ? 'else' : 'if', branch.children, depth + 1, available)
      }
      break
    case 'each': {
      own.push(node.iterable)
      info.values.push(node.iterable)
      const iterated = new Map(available)
      const iterable = node.iterable.trim()
      iterated.set(
        node.itemName,
        /^[A-Za-z_$][\w$]*$/.test(iterable) && context.moduleNames.has(iterable) ? `(typeof ${iterable})[number]` : 'any',
      )
      if (node.indexName !== null) iterated.set(node.indexName, 'number')
      if (node.key !== null) own.push(node.key)
      addGroup('each', node.children, depth + 1, iterated)
      if (node.emptyChildren !== null) addGroup('empty', node.emptyChildren, depth + 1, available)
      break
    }
    case 'switch':
      own.push(node.discriminant)
      info.values.push(node.discriminant)
      for (const branch of node.branches) {
        markLines(context, branch.span.start.line, branch.span.end.line, depth + 1)
        info.end = Math.max(info.end, branch.span.end.line)
        if (branch.test !== null) own.push(branch.test)
        info.values.push(branch.test ?? 'default')
        addGroup('case', branch.children, depth + 2, available)
      }
      break
    case 'try': {
      addGroup('try', node.children, depth + 1, available)
      if (node.pendingBranch !== null) {
        markLines(context, node.pendingBranch.span.start.line, node.pendingBranch.span.end.line, depth)
        info.end = Math.max(info.end, node.pendingBranch.span.end.line)
        addGroup('pending', node.pendingBranch.children, depth + 1, available)
      }
      if (node.catchBranch !== null) {
        markLines(context, node.catchBranch.span.start.line, node.catchBranch.span.end.line, depth)
        info.end = Math.max(info.end, node.catchBranch.span.end.line)
        const caught = new Map(available)
        const bindings = (node.catchBranch.bindings ?? '').replace(/^\(|\)$/g, '')
        for (const name of identifiersIn(bindings)) caught.set(name, 'any')
        addGroup('catch', node.catchBranch.children, depth + 1, caught)
      }
      break
    }
  }

  for (const code of own) for (const name of identifiersIn(code)) info.uses.add(name)
  for (const child of info.children) {
    info.end = Math.max(info.end, child.end)
    info.height = Math.max(info.height, child.height + (child.depth - depth))
    info.nodeCount += child.nodeCount
    child.uses.forEach((name) => info.uses.add(name))
  }
  info.shape = `${node.kind === 'element' ? '' : node.kind}${groups
    .map((group) => `${group.label}(${group.children.map((child) => child.shape).join(',')})`)
    .join('|')}`
  return info
}

function markLines(context: Context, start: number, end: number, depth: number): void {
  for (let line = start; line <= end; line++) context.lineDepths[line - 1] ??= depth
}

/**
 * Component setup is not template, but a `scope` block's setup sits inside the
 * template and adds indentation the reader must track.
 */
function markSetupLines(context: Context, setup: readonly SetupDeclaration[], depth: number): void {
  for (const declaration of setup) {
    const end = declaration.codeStart.line + declaration.code.split('\n').length - 1
    markLines(context, declaration.span.start.line, Math.max(end, declaration.span.end.line), depth)
  }
}

function flatten(info: NodeInfo): NodeInfo[] {
  return [info, ...info.children.flatMap(flatten)]
}

// ---------------------------------------------------------------------------
// Bindings and types

function componentBindings(
  props: PropsDeclaration | null,
  setup: readonly SetupDeclaration[],
): Bindings {
  const bindings = new Map<string, string>()
  if (props !== null) {
    const { names, type } = parsePropsParameter(props.parameter)
    const indexable = type === null ? null : /^[A-Za-z_$][\w$.]*$/.test(type) ? type : `(${type})`
    for (const name of names) bindings.set(name, indexable === null ? 'any' : `${indexable}['${name}']`)
  }
  for (const declaration of setup) {
    for (const { names, init } of topLevelDeclarations(declaration.code)) {
      for (const [name, type] of inferDeclarationTypes(names, init)) bindings.set(name, type)
    }
  }
  return bindings
}

function inferDeclarationTypes(names: readonly string[], init: string): Array<[string, string]> {
  const call = hookCall(init)
  const [first, second] = names
  if (call !== null) {
    const valueType = call.typeArgument ?? literalType(call.argument)
    switch (call.hook) {
      case 'useState':
        return pairs(names, [valueType, `(value: ${valueType}) => void`])
      case 'useLinkedState':
        return pairs(names, [call.typeArgument ?? 'any', `(value: ${call.typeArgument ?? 'any'}) => void`])
      case 'useRef':
        return pairs(names, [`{ current: ${call.typeArgument ?? 'any'} }`])
      case 'useReducer':
        return pairs(names, ['any', '(action: any) => void', '() => any'])
      case 'useTransition':
        return pairs(names, ['boolean', '(callback: () => void) => void'])
      case 'useId':
        return pairs(names, ['string'])
      case 'useMemo':
      case 'useCallback':
      case 'useDeferredValue':
        return pairs(names, [call.typeArgument ?? 'any'])
    }
  }
  if (first !== undefined && second === undefined) return [[first, literalType(init)]]
  return names.map((name) => [name, 'any'])
}

function pairs(names: readonly string[], types: readonly string[]): Array<[string, string]> {
  return names.map((name, index) => [name, types[index] ?? 'any'])
}

function literalType(expression: string): string {
  const text = expression.trim()
  if (/^(['"`])/.test(text)) return 'string'
  if (/^-?\d[\d_]*(\.\d+)?$/.test(text)) return 'number'
  if (text === 'true' || text === 'false') return 'boolean'
  return 'any'
}

function propsFor(infos: readonly NodeInfo[]): SuggestedProp[] {
  const props = new Map<string, string>()
  for (const info of infos) {
    for (const name of info.uses) {
      const type = info.available.get(name)
      if (type !== undefined && !props.has(name)) props.set(name, type)
    }
  }
  return [...props].map(([name, type]) => ({ name, type }))
}

// ---------------------------------------------------------------------------
// Suggestions

function suggestExtractions(context: Context, host: Host): Array<Omit<RefactorSuggestion, 'id'>> {
  const { depthLimit, minLines } = context.settings
  const suggestions: Array<Omit<RefactorSuggestion, 'id'>> = []
  const all = host.roots.flatMap(flatten)
  if (all.length === 0) return suggestions
  const hostLines = Math.max(...all.map((info) => info.end)) - Math.min(...all.map((info) => info.start)) + 1

  const scan = (infos: readonly NodeInfo[], baseDepth: number, maxLines: number) => {
    for (const info of infos) {
      const relativeDepth = info.depth - baseDepth
      if (relativeDepth + info.height <= depthLimit) continue
      const lines = info.end - info.start + 1
      // A loop body is a natural component boundary at any size.
      const loopBody = info.parent?.node.kind === 'each'
      if (info.node.kind === 'element' && relativeDepth >= 1 && lines >= minLines && (loopBody || lines <= maxLines)) {
        suggestions.push(extractSuggestion(context, info))
        if (info.height > depthLimit) scan(info.children, info.depth, Math.max(minLines, Math.floor(lines * 0.6)))
      } else {
        scan(info.children, baseDepth, maxLines)
      }
    }
  }
  scan(host.roots, 0, Math.max(minLines * 2, Math.floor(hostLines * 0.5)))
  return suggestions
}

function extractSuggestion(context: Context, info: NodeInfo): Omit<RefactorSuggestion, 'id'> {
  const { depthLimit } = context.settings
  const reach = info.depth + info.height
  const excess = reach - depthLimit
  const name = uniqueName(context, suggestName(context, info))
  const props = propsFor([info])
  const lines = info.end - info.start + 1
  const severity: Severity = excess >= 3 ? 'critical' : 'warning'
  const where = info.parent?.node.kind === 'each' ? ', repeated by a loop,' : ''
  return {
    kind: 'extract',
    severity,
    host: info.host.name,
    name,
    label: labelOf(info.node),
    reason:
      `${lines} lines${where} reach depth ${reach} (limit ${depthLimit}). ` +
      `Extracted as ${name}, its deepest line drops to depth ${info.height}` +
      (props.length === 0 ? ' and it needs no props.' : ` and it needs ${props.length} prop${props.length === 1 ? '' : 's'}.`),
    startLine: info.start,
    endLine: info.end,
    lines,
    depth: info.depth,
    reach,
    props,
    snippet: componentSnippet(context, info, name, props),
    usage: usageLine(context, info, name, props),
    insertBeforeLine: info.host.insertBeforeLine,
    occurrences: [{ startLine: info.start, endLine: info.end }],
    ...applicability(context, [info], props, 0),
  }
}

function suggestDuplicates(context: Context, hosts: readonly Host[]): Array<Omit<RefactorSuggestion, 'id'>> {
  const minLines = Math.max(4, Math.ceil(context.settings.minLines / 2))
  const groups = new Map<string, NodeInfo[]>()
  for (const info of hosts.flatMap((host) => host.roots.flatMap(flatten))) {
    if (info.node.kind === 'text' || info.node.kind === 'style' || info.nodeCount < 3) continue
    if (info.end - info.start + 1 < minLines) continue
    const group = groups.get(info.shape) ?? []
    group.push(info)
    groups.set(info.shape, group)
  }

  const ranked = [...groups.values()]
    .map((group) => group.filter((info) => !group.some((other) => other !== info && contains(other, info))))
    .filter((group) => group.length >= 2)
    .sort((a, b) => weight(b) - weight(a))

  // An accepted group hides the groups nested in it, except that an identical
  // inner group still surfaces when its container's copies differ, because
  // only identical copies can be replaced automatically.
  const covered: Array<LineRange & { identical: boolean }> = []
  const suggestions: Array<Omit<RefactorSuggestion, 'id'>> = []
  for (const group of ranked) {
    const variants = countVariants(group)
    const inside = (info: NodeInfo, identicalOnly: boolean) =>
      covered.some((range) => range.startLine <= info.start && info.end <= range.endLine && (range.identical || !identicalOnly))
    if (group.every((info) => inside(info, variants === 0))) continue
    covered.push(...group.map((info) => ({ startLine: info.start, endLine: info.end, identical: variants === 0 })))

    const [first] = group as [NodeInfo, ...NodeInfo[]]
    const element = firstElement(first)
    const name = uniqueName(context, element === null ? `${first.host.name}Block` : suggestName(context, element, first))
    const props = propsFor(group)
    const lines = first.end - first.start + 1
    suggestions.push({
      kind: 'duplicate',
      severity: 'info',
      host: first.host.name,
      name,
      label: labelOf(first.node),
      reason:
        `${group.length} structurally identical blocks of ${lines} lines. ` +
        (variants === 0
          ? `They are identical, so one ${name} can replace every copy.`
          : `They differ in ${variants} attribute or text value${variants === 1 ? '' : 's'}; pass those as props to one ${name}.`),
      startLine: first.start,
      endLine: first.end,
      lines,
      depth: first.depth,
      reach: first.depth + first.height,
      props,
      snippet: componentSnippet(context, first, name, props),
      usage: usageLine(context, first, name, props),
      insertBeforeLine: first.host.insertBeforeLine,
      occurrences: group.map((info) => ({ startLine: info.start, endLine: info.end })),
      ...applicability(context, group, props, variants),
    })
  }
  return suggestions
}

/**
 * What a section references, and whether it can be rewritten automatically.
 * Refusals are conservative: anything that could change behavior is left to
 * the developer.
 */
function applicability(
  context: Context,
  infos: readonly NodeInfo[],
  props: readonly SuggestedProp[],
  variants: number,
): { references: string[]; autoApply: AutoApply } {
  const [first] = infos as [NodeInfo, ...NodeInfo[]]
  const references = new Set<string>()
  for (const info of infos) info.uses.forEach((name) => references.add(name))
  for (const prop of props) identifiersIn(prop.type).forEach((name) => references.add(name))
  const lines = first.end - first.start + 1

  let blocked: string | null = null
  if (first.host.hasStyle) {
    blocked = `${first.host.name} has a scoped style block, which would stop matching the moved elements.`
  } else if (variants > 0) {
    blocked = `The copies differ in ${variants} value${variants === 1 ? '' : 's'}, so replacing them with one call would change behavior.`
  } else if (infos.some((info) => info.host !== first.host)) {
    blocked = 'The copies live in different components, which may not share the bindings the props need.'
  }

  const locals = [...references].filter((name) => context.localComponents.has(name) && !props.some((p) => p.name === name))
  const fileBlocked = locals.length === 0
    ? null
    : `Uses ${locals.join(', ')}, which ${locals.length === 1 ? 'is' : 'are'} declared in this file and cannot be imported.`

  return {
    references: [...references].sort(),
    autoApply: {
      target: lines >= context.settings.fileLines && fileBlocked === null ? 'file' : 'inline',
      blocked,
      fileBlocked,
    },
  }
}

function contains(outer: NodeInfo, inner: NodeInfo): boolean {
  return outer.start <= inner.start && inner.end <= outer.end && outer.nodeCount > inner.nodeCount
}

function weight(group: readonly NodeInfo[]): number {
  return group.reduce((sum, info) => sum + (info.end - info.start + 1), 0)
}

function countVariants(group: readonly NodeInfo[]): number {
  const values = group.map((info) => flatten(info).flatMap((node) => node.values))
  const [base, ...rest] = values as [string[], ...string[][]]
  let differences = 0
  for (let index = 0; index < base.length; index++) {
    if (rest.some((other) => other[index] !== base[index])) differences++
  }
  return differences + Math.max(0, ...rest.map((other) => other.length - base.length))
}

function firstElement(info: NodeInfo): NodeInfo | null {
  if (info.node.kind === 'element') return info
  for (const child of info.children) {
    const found = firstElement(child)
    if (found !== null) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Naming and code generation

function suggestName(context: Context, info: NodeInfo, root: NodeInfo = info): string {
  const node = info.node as ElementNode
  // String attributes name a section; so does the static lead of a template
  // literal, e.g. aria-label={`Copy note: ${note}`} → `CopyNote`.
  const stringAttr = (name: string) => {
    const attr = node.attrs.find((a) => a.kind === 'attribute' && a.name === name)
    if (attr?.kind !== 'attribute') return null
    if (attr.value.type === 'string') return attr.value.value
    if (attr.value.type !== 'expr') return null
    const lead = /^\s*(['"`])([^'"`$]*)/.exec(attr.value.code)?.[2]?.split(':')[0]?.trim()
    return lead === undefined || lead === '' ? null : lead
  }
  const tag = node.isComponent
    ? pascal(node.tag.split('.').at(-1) ?? node.tag)
    : (TAG_SUFFIX[node.tag] ?? pascal(node.tag))

  if (node.id !== null) return pascal(node.id)
  const label = stringAttr('aria-label')
  if (label !== null && pascal(label) !== '') return pascal(label)
  const comment = commentAbove(context, root)
  if (comment !== null) return withSuffix(pascal(comment), tag)
  if (info.parent?.node.kind === 'each') return withSuffix(pascal(info.parent.node.itemName), tag)
  const semanticClass = node.classes.find((name) => /^[a-z][a-z0-9-]*$/.test(name))
  if (semanticClass !== undefined) return pascal(semanticClass)
  const role = stringAttr('role')
  if (role !== null) return withSuffix(pascal(role), tag)
  return node.isComponent ? `${tag}Section` : `${info.host.name}${tag || 'Section'}`
}

/** Friendlier name suffixes for generic tags: `each product` + `li` → `ProductItem`. */
const TAG_SUFFIX: Record<string, string> = {
  a: 'Link',
  div: '',
  li: 'Item',
  ol: 'List',
  p: 'Text',
  span: '',
  td: 'Cell',
  th: 'Cell',
  tr: 'Row',
  ul: 'List',
}

/** A `//` comment on the line directly above a section names it: `// LEFT` → `Left`. */
function commentAbove(context: Context, info: NodeInfo): string | null {
  const line = context.lines[info.start - 2]?.trim() ?? ''
  if (!line.startsWith('//')) return null
  const text = line.replace(/^\/+/, '').trim()
  return text === '' ? null : text
}

function withSuffix(base: string, suffix: string): string {
  if (base === '') return suffix || 'Section'
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`
}

function uniqueName(context: Context, base: string): string {
  const safe = /^[A-Z]/.test(base) ? base : `Section${base}`
  let name = safe
  for (let n = 2; context.takenNames.has(name); n++) name = `${safe}${n}`
  context.takenNames.add(name)
  return name
}

function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join('')
    .replace(/^\d+/, '')
}

function labelOf(node: BeastNode): string {
  if (node.kind !== 'element') return node.kind
  return `${node.tag}${node.id === null ? '' : `#${node.id}`}${node.classes.map((c) => `.${c}`).join('')}`
}

function componentSnippet(context: Context, info: NodeInfo, name: string, props: readonly SuggestedProp[]): string {
  const base = info.node.span.start.column - 1
  const headerEnd = info.node.span.end.line
  const key = keyAttribute(context, info)
  const body = context.lines.slice(info.start - 1, info.end).map((line, index) => {
    const indent = /^ */.exec(line)![0].length
    // A loop key identifies the call site, so it moves to the usage line.
    const text = key !== null && info.start + index <= headerEnd
      ? line.replace(KEY_ATTRIBUTE, '').replace(/^(\s*[\w.#$-]+)\(\s*\)/, '$1')
      : line
    return text.trim() === '' || text.trim() === '~' ? '' : `  ${text.slice(Math.min(indent, base))}`
  }).filter((line, index) => line !== '' || index > headerEnd - info.start)
  while (body.at(-1) === '') body.pop()
  const header = [`component ${name}`]
  if (props.length > 0) {
    header.push(
      `  props { ${props.map((p) => p.name).join(', ')} }: { ${props.map((p) => `${p.name}: ${p.type}`).join('; ')} }`,
    )
  }
  return [...header, ...body].join('\n')
}

function usageLine(context: Context, info: NodeInfo, name: string, props: readonly SuggestedProp[]): string {
  const indent = ' '.repeat(info.node.span.start.column - 1)
  const key = keyAttribute(context, info)
  const attrs = [...(key === null ? [] : [`key={${key}}`]), ...props.map((p) => `${p.name}={${p.name}}`)]
  return attrs.length === 0 ? `${indent}${name}` : `${indent}${name}(${attrs.join(' ')})`
}

const KEY_ATTRIBUTE = /[\s,]*\bkey=\{[^{}]*\}/

/** Beast hoists a loop root's `key=` into the `each` header, so read it from source. */
function keyAttribute(context: Context, info: NodeInfo): string | null {
  if (info.node.kind !== 'element') return null
  const header = context.lines.slice(info.start - 1, info.node.span.end.line).join('\n')
  return /\bkey=\{([^{}]*)\}/.exec(header)?.[1]?.trim() ?? null
}

function detectIndentUnit(lines: readonly string[], lineDepths: ReadonlyArray<number | null>): number {
  let unit = 0
  lines.forEach((line, index) => {
    if (lineDepths[index] == null || line.trim() === '' || line.trimStart().startsWith('~')) return
    const indent = /^ */.exec(line)![0].length
    if (indent > 0) unit = gcd(unit, indent)
  })
  return unit || 2
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
