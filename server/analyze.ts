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
  Mapping,
  TypeImport,
  ComponentMetrics,
  FileAnalysis,
  LineRange,
  RefactorSuggestion,
  Severity,
  SuggestedProp,
} from '../shared/types.js'
import { attributeValue, replaceSlots, scanSlots, type Slot, type SlotKind, type SlotValue } from './slots.js'
import { hookCall, identifiersIn, parsePropsParameter, patternNames, topLevelDeclarations } from './source-scan.js'
import { PROBE_CALL, type ProbeFile, type ProbeResult } from './types.js'

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
  /** Children split by branch (if/else arms, loop body, …); siblings live in one group. */
  groups: NodeInfo[][]
  /** TypeScript that recreates the control flow this node renders inside, for type probes. */
  scope: ProbeScope | null
}

interface ProbeScope {
  open: string
  close: string
}

interface Host {
  name: string
  /** Line of the `component` keyword, or null for the file's default component. */
  declarationLine: number | null
  roots: NodeInfo[]
  insertBeforeLine: number
  /** Scoped `style` blocks match only their owning component's elements. */
  hasStyle: boolean
  propsParameter: string | null
  setupCode: string[]
}

type Draft = Omit<RefactorSuggestion, 'id'>

interface Origin {
  infos: NodeInfo[]
  shape: Shape
  params: Param[]
}

/** How a suggestion's component differs from the plain section: a rewritten body and a refusal. */
interface Shape {
  body?: string[]
  uses?: ReadonlySet<string>
  blocked: string | null
}

/** A value that differs between copies and becomes a prop (or an item field). */
interface Param {
  name: string
  kind: SlotKind
  /** The value in each copy, in order. */
  values: SlotValue[]
}

export interface AnalyzeOptions {
  /** Absolute path of the source; type probes resolve relative imports from it. */
  sourcePath?: string
  /** Derives prop types with TypeScript; heuristic types are kept when absent or failing. */
  resolveTypes?: (file: ProbeFile) => ProbeResult | null
}

interface Context {
  settings: AnalyzerSettings
  lines: string[]
  lineDepths: Array<number | null>
  moduleNames: Set<string>
  takenNames: Set<string>
  localComponents: Set<string>
  /** Names declared at module scope, including types, for naming props interfaces. */
  moduleTypeNames: Set<string>
  origins: Map<Draft, Origin>
  /** Every JavaScript identifier the file binds or reads, so generated names never collide. */
  words: Set<string>
}

export function analyzeDocument(
  document: BeastDocument,
  source: string,
  componentName: string,
  settings: AnalyzerSettings,
  options: AnalyzeOptions = {},
): FileAnalysis {
  const lines = source.split('\n')
  const context: Context = {
    settings,
    lines,
    lineDepths: Array.from({ length: lines.length }, () => null),
    moduleNames: new Set(),
    takenNames: new Set([componentName]),
    localComponents: new Set([componentName]),
    moduleTypeNames: new Set(),
    origins: new Map(),
    words: new Set(),
  }

  for (const declaration of document.declarations) {
    if (declaration.kind === 'module') {
      for (const { names, kind } of topLevelDeclarations(declaration.code)) {
        names.forEach((name) => (kind === 'type' ? context.moduleTypeNames : context.moduleNames).add(name))
      }
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
      propsParameter: declaration.props?.parameter ?? null,
      setupCode: declaration.setup.map((setup) => setup.code),
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
    propsParameter: topProps?.parameter ?? null,
    setupCode: topSetup.map((setup) => setup.code),
  }
  defaultHost.roots = buildAll(context, defaultHost, document.children, 0, null, componentBindings(topProps, topSetup))
  hosts.push(defaultHost)

  for (const info of hosts.flatMap((host) => host.roots.flatMap(flatten))) {
    info.uses.forEach((name) => context.words.add(name))
    info.available.forEach((_type, name) => context.words.add(name))
  }
  for (const name of [...context.moduleNames, ...context.moduleTypeNames, ...context.takenNames]) context.words.add(name)
  const extractions = hosts.flatMap((host) => suggestExtractions(context, host))
  const maps = suggestMaps(context, hosts)
  // A run of repeated siblings is better rendered from an array than merged into a component.
  const insideMap = (info: NodeInfo) => maps.some((map) => map.startLine <= info.start && info.end <= map.endLine)
  const drafts = [...extractions, ...suggestDuplicates(context, hosts, insideMap), ...maps]
  const typed = deriveTypes(context, document, drafts, options)
  const suggestions = typed.map((suggestion, index) => ({ ...suggestion, id: `s${index + 1}` }))

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
    groups: [],
    scope: null,
  }
  markLines(context, node.span.start.line, node.span.end.line, depth)

  const own: string[] = []
  const groups: Array<{ label: string; children: NodeInfo[] }> = []
  const addGroup = (label: string, children: readonly BeastNode[], childDepth: number, bindings: Bindings, scope: ProbeScope | null = null) => {
    const built = buildAll(context, host, children, childDepth, info, bindings)
    for (const child of built) child.scope = scope
    groups.push({ label, children: built })
    info.groups.push(built)
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
      addGroup('scope', node.children, depth + 1, scoped, { open: `{\n${node.setup.map((setup) => setup.code).join('\n')}`, close: '}' })
      break
    }
    case 'if':
      node.branches.forEach((branch, index) => {
        // Replaying earlier branches keeps TypeScript's narrowing for this one.
        const earlier = node.branches.slice(0, index).map((previous) => `if (${previous.test}) {} else `).join('')
        markLines(context, branch.span.start.line, branch.span.end.line, depth)
        info.end = Math.max(info.end, branch.span.end.line)
        if (branch.test !== null) own.push(branch.test)
        info.values.push(branch.test ?? 'else')
        const open = `${earlier}${branch.test === null ? '{' : `if (${branch.test}) {`}`
        addGroup(branch.test === null ? 'else' : 'if', branch.children, depth + 1, available, { open, close: '}' })
      })
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
      const index = node.indexName === null ? '' : ` const ${node.indexName}: number = 0;`
      addGroup('each', node.children, depth + 1, iterated, { open: `for (const ${node.itemName} of ${node.iterable}) {${index}`, close: '}' })
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
        const label = branch.test === null ? 'default' : `case ${branch.test}`
        addGroup('case', branch.children, depth + 2, available, { open: `switch (${node.discriminant}) { ${label}: {`, close: '} }' })
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
        const names = [...identifiersIn(bindings)]
        const open = names.length === 0 ? '{' : `{ const [${bindings}] = [] as unknown as [unknown, () => void];`
        addGroup('catch', node.catchBranch.children, depth + 1, caught, { open, close: '}' })
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

function suggestExtractions(context: Context, host: Host): Draft[] {
  const { depthLimit, minLines } = context.settings
  const suggestions: Draft[] = []
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

function extractSuggestion(context: Context, info: NodeInfo): Draft {
  const { depthLimit } = context.settings
  const reach = info.depth + info.height
  const excess = reach - depthLimit
  const name = uniqueName(context, suggestName(context, info))
  const props = propsFor([info])
  const lines = info.end - info.start + 1
  const severity: Severity = excess >= 3 ? 'critical' : 'warning'
  const where = info.parent?.node.kind === 'each' ? ', repeated by a loop,' : ''
  const draft: Draft = {
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
    usage: usageLine(context, info, name, props),
    usages: [callFor(context, info, name, props, [], 0)],
    insertBeforeLine: info.host.insertBeforeLine,
    occurrences: [{ startLine: info.start, endLine: info.end }],
    mapping: null,
    ...generated(context, [info], name, props, [], false, { blocked: null }),
  }
  context.origins.set(draft, { infos: [info], shape: { blocked: null }, params: [] })
  return draft
}

function suggestDuplicates(context: Context, hosts: readonly Host[], skip: (info: NodeInfo) => boolean): Draft[] {
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
  const suggestions: Draft[] = []
  for (const group of ranked) {
    const variants = countVariants(group)
    const inside = (info: NodeInfo, identicalOnly: boolean) =>
      covered.some((range) => range.startLine <= info.start && info.end <= range.endLine && (range.identical || !identicalOnly))
    if (group.every((info) => inside(info, variants === 0))) continue
    if (group.every(skip)) continue
    covered.push(...group.map((info) => ({ startLine: info.start, endLine: info.end, identical: variants === 0 })))

    const [first] = group as [NodeInfo, ...NodeInfo[]]
    const element = firstElement(first)
    const name = uniqueName(context, element === null ? `${first.host.name}Block` : suggestName(context, element, first))
    let props = propsFor(group)
    let params: Param[] = []
    let shape: Shape = { blocked: null }
    if (variants > 0) {
      // Values that differ between copies become props, so each call passes its own.
      const result = parameterize(context, group, (param) => param, reservedNames(context, first))
      if ('blocked' in result) {
        shape = { blocked: result.blocked }
      } else {
        params = result.params
        const uses = bodyUses(result.body)
        const shared = [...uses]
          .filter((use) => first.available.has(use) && !params.some((param) => param.name === use))
          .map((use) => ({ name: use, type: first.available.get(use)! }))
        props = [...shared, ...params.map((param) => ({ name: param.name, type: heuristicParamType(param) }))]
        shape = { body: result.body.split('\n'), uses, blocked: null }
      }
    }
    const shared = props.filter((prop) => !params.some((param) => param.name === prop.name))
    const lines = first.end - first.start + 1
    const draft: Draft = {
      kind: 'duplicate',
      severity: 'info',
      host: first.host.name,
      name,
      label: labelOf(first.node),
      reason:
        `${group.length} structurally identical blocks of ${lines} lines. ` +
        (variants === 0
          ? `They are identical, so one ${name} can replace every copy.`
          : params.length > 0
            ? `They differ in ${params.length} value${params.length === 1 ? '' : 's'}, which become${params.length === 1 ? 's a prop' : ' props'} of one ${name}: ${params.map((param) => param.name).join(', ')}.`
            : `They differ in ${variants} attribute or text value${variants === 1 ? '' : 's'}.`),
      startLine: first.start,
      endLine: first.end,
      lines,
      depth: first.depth,
      reach: first.depth + first.height,
      props,
      usage: ' '.repeat(first.node.span.start.column - 1) + callFor(context, first, name, shared, params, 0),
      usages: group.map((info, occurrence) => callFor(context, info, name, shared, params, occurrence)),
      insertBeforeLine: first.host.insertBeforeLine,
      occurrences: group.map((info) => ({ startLine: info.start, endLine: info.end })),
      mapping: null,
      ...generated(context, group, name, props, [], false, shape),
    }
    context.origins.set(draft, { infos: group, shape, params })
    suggestions.push(draft)
  }
  return suggestions
}

/** Code and metadata that depend on the props' types, regenerated once TypeScript has derived them. */
function generated(
  context: Context,
  infos: readonly NodeInfo[],
  name: string,
  props: readonly SuggestedProp[],
  typeImports: readonly TypeImport[],
  typesDerived: boolean,
  shape: Shape,
) {
  const [first] = infos as [NodeInfo, ...NodeInfo[]]
  const body = shape.body ?? sectionBody(context, first)
  const propsType = props.length === 0 ? null : propsTypeName(context, name)
  const propsDeclaration = propsType === null ? null : interfaceText(propsType, props)
  return {
    body: body.join('\n'),
    propsType,
    propsDeclaration,
    typeImports: [...typeImports],
    typesDerived,
    snippet: componentSnippet(name, props, propsType, propsDeclaration, body),
    ...applicability(context, infos, props, shape),
  }
}

function interfaceText(propsType: string, props: readonly SuggestedProp[]): string {
  return [`interface ${propsType} {`, ...props.map((prop) => `  ${prop.name}: ${prop.type}`), '}'].join('\n')
}

/** `Name(key={…} a={a} b='…')` for one occurrence; differing values come from that copy. */
function callFor(
  context: Context,
  info: NodeInfo,
  name: string,
  shared: readonly SuggestedProp[],
  params: readonly Param[],
  occurrence: number,
): string {
  const key = keyAttribute(context, info)
  const attrs = [
    ...(key === null ? [] : [`key={${key}}`]),
    ...shared.map((prop) => `${prop.name}={${prop.name}}`),
    ...params.map((param) => `${param.name}=${attributeValue(param.values[occurrence]!)}`),
  ]
  return attrs.length === 0 ? name : `${name}(${attrs.join(' ')})`
}

/**
 * Compare the copies slot by slot (see `./slots.ts`). Their skeletons must
 * match; each differing slot becomes a parameter, referenced in the returned
 * body through `reference(name)`.
 */
function parameterize(
  context: Context,
  infos: readonly NodeInfo[],
  reference: (name: string) => string,
  reserved: ReadonlySet<string>,
): { body: string; params: Param[] } | { blocked: string } {
  const bodies = infos.map((info) => sectionBody(context, info).join('\n'))
  const scans = bodies.map(scanSlots)
  if (scans.some((scan) => scan === null)) return { blocked: 'The copies use markup that cannot be rewritten automatically.' }
  const [first, ...rest] = scans as [NonNullable<(typeof scans)[number]>, ...NonNullable<(typeof scans)[number]>[]]
  if (rest.some((scan) => scan.skeleton !== first.skeleton)) {
    return { blocked: 'The copies differ in tags, selectors, or loop headers, not only in values.' }
  }

  const inner = new Set(infos.flatMap(innerBindings))
  const taken = new Set(reserved)
  const params: Param[] = []
  const references = new Map<Slot, string>()
  for (const [index, slot] of first.slots.entries()) {
    const values = scans.map((scan) => scan!.slots[index]!.value)
    if (values.every((value) => value.code === values[0]!.code)) continue
    const local = values.flatMap((value) => (value.type === 'expr' ? [...identifiersIn(value.code)] : [])).find((use) => inner.has(use))
    if (local !== undefined) return { blocked: `A differing value uses ${local}, which only exists inside the block.` }
    // The same values in several places are one parameter.
    const same = params.find((param) => param.kind === slot.kind && param.values.every((value, i) => value.code === values[i]!.code))
    if (same !== undefined) {
      references.set(slot, reference(same.name))
      continue
    }
    const base = paramBaseName(slot)
    // On a clash, name by element (`codeClassName`) before falling back to numbers.
    const qualified = slot.element === null ? base : `${slot.element.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}${base[0]!.toUpperCase()}${base.slice(1)}`
    const name = uniqueIdentifier(taken.has(base) && !taken.has(qualified) ? qualified : base, taken)
    taken.add(name)
    params.push({ name, kind: slot.kind, values })
    references.set(slot, reference(name))
  }
  return { body: replaceSlots(bodies[0]!, first.slots, references), params }
}

/** Names bound inside a section (loop items, scope setup, catch bindings). */
function innerBindings(info: NodeInfo): string[] {
  return flatten(info).flatMap(({ node }) => {
    if (node.kind === 'each') return [...patternNames(node.itemName), ...(node.indexName === null ? [] : [node.indexName])]
    if (node.kind === 'scope') return node.setup.flatMap((setup) => topLevelDeclarations(setup.code).flatMap((d) => d.names))
    if (node.kind === 'try' && node.catchBranch?.bindings) return [...identifiersIn(node.catchBranch.bindings.replace(/^\(|\)$/g, ''))]
    return []
  })
}

/** Component-scope names a rewritten body still reads (expressions, conditions, loop headers, spreads). */
function bodyUses(body: string): Set<string> {
  const uses = new Set<string>()
  const scan = scanSlots(body)
  for (const slot of scan?.slots ?? []) if (slot.value.type === 'expr') identifiersIn(slot.value.code).forEach((use) => uses.add(use))
  for (const line of body.split('\n')) {
    const each = /^\s*each\s+.+?\s+in\s+(.+)$/.exec(line)
    if (each !== null) identifiersIn(each[1]!.replace(/\bkey\b/, ',')).forEach((use) => uses.add(use))
    for (const spread of line.matchAll(/\{\s*\.\.\.([^}]+)\}/g)) identifiersIn(spread[1]!).forEach((use) => uses.add(use))
  }
  return uses
}

function heuristicParamType(param: Param): string {
  return param.values.every((value) => value.type === 'string') ? 'string' : 'any'
}

function paramBaseName(slot: Slot): string {
  if (slot.attr !== null) {
    const attr = slot.attr === 'class' ? 'className' : slot.attr
    return attr.replace(/[-:.]+([A-Za-z0-9])/g, (_match, char: string) => char.toUpperCase())
  }
  const member = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(slot.value.code) ? /([A-Za-z_$][\w$]*)$/.exec(slot.value.code)?.[1] : undefined
  if (member !== undefined) return member
  return slot.kind === 'test' ? 'condition' : 'text'
}

const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'key', 'let', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'children', 'ref',
])

function reservedNames(context: Context, info: NodeInfo): Set<string> {
  return new Set([...info.available.keys(), ...context.moduleNames, ...context.moduleTypeNames, ...RESERVED_WORDS])
}

function uniqueIdentifier(base: string, taken: ReadonlySet<string>): string {
  let name = RESERVED_WORDS.has(base) ? `${base}Value` : base
  const root = name
  for (let n = 2; taken.has(name); n++) name = `${root}${n}`
  return name
}

/**
 * Runs of adjacent sibling elements with the same markup render better from
 * an array. The differing values become item fields; constant arrays become
 * a module-level `const`, others sit in the `each` header.
 */
function suggestMaps(context: Context, hosts: readonly Host[]): Draft[] {
  const drafts: Draft[] = []
  const siblingGroups = hosts.flatMap((host) => [host.roots, ...host.roots.flatMap(flatten).flatMap((info) => info.groups)])
  for (const siblings of siblingGroups) {
    let start = 0
    while (start < siblings.length) {
      let end = start + 1
      const head = siblings[start]!
      while (
        end < siblings.length &&
        head.node.kind === 'element' &&
        siblings[end]!.shape === head.shape &&
        // Only blank lines may separate them; comments would be lost.
        context.lines.slice(siblings[end - 1]!.end, siblings[end]!.start - 1).every((line) => line.trim() === '')
      ) end++
      const run = siblings.slice(start, end)
      start = end
      if (run.length < 2 || (run.length < 3 && head.nodeCount < 3)) continue
      const draft = mapDraft(context, run)
      if (draft !== null) drafts.push(draft)
    }
  }
  return drafts
}

function mapDraft(context: Context, run: readonly NodeInfo[]): Draft | null {
  const first = run[0]!
  const last = run.at(-1)!
  const taken = new Set([...reservedNames(context, first), ...context.words])
  const itemName = [itemBaseName(first), 'item', 'entry'].find((candidate) => !taken.has(candidate)) ?? uniqueIdentifier('item', taken)
  const result = parameterize(context, run, (param) => `${itemName}.${param}`, new Set(RESERVED_WORDS))
  if ('blocked' in result || result.params.length === 0) return null

  const arrayName = uniqueIdentifier(arrayBaseName(first), taken)
  const constant = result.params.every((param) =>
    param.values.every((value) => value.type === 'string' || ![...identifiersIn(value.code)].some((use) => first.available.has(use))),
  )
  const keyField = result.params.find((param) =>
    param.values.every((value) => value.type === 'string') && new Set(param.values.map((value) => value.code)).size === run.length,
  )
  const mapping: Mapping = {
    arrayName,
    itemName,
    items: run.map((_info, occurrence) => `{ ${result.params.map((param) => `${param.name}: ${param.values[occurrence]!.code}`).join(', ')} }`),
    key: keyField === undefined ? 'index' : `${itemName}.${keyField.name}`,
    index: keyField === undefined,
    placement: constant ? 'module' : 'inline',
    indent: ' '.repeat(first.node.span.start.column - 1),
  }
  const rendered = renderMapping(mapping, result.body)
  const lines = last.end - first.start + 1
  return {
    kind: 'map',
    severity: 'info',
    host: first.host.name,
    name: mapping.placement === 'module' ? arrayName : itemName,
    label: labelOf(first.node),
    reason:
      `${run.length} sibling ${labelOf(first.node)} elements repeat the same markup with different ` +
      `${result.params.map((param) => param.name).join(', ')}. Render them from ` +
      (mapping.placement === 'module' ? `the ${arrayName} array` : 'an array') + ' with each.',
    startLine: first.start,
    endLine: last.end,
    lines,
    depth: first.depth,
    reach: first.depth + first.height,
    props: [],
    usage: rendered.usage,
    usages: [rendered.usage],
    insertBeforeLine: first.host.insertBeforeLine,
    occurrences: [{ startLine: first.start, endLine: last.end }],
    references: [],
    body: result.body,
    propsType: null,
    propsDeclaration: null,
    typeImports: [],
    typesDerived: false,
    snippet: rendered.snippet,
    mapping,
    autoApply: { target: 'inline', blocked: null, fileBlocked: 'Mapping rewrites the markup in place.' },
  }
}

/** The loop variable: named after the element (`row` for `.row`, `link` for `a`), else `item`. */
function itemBaseName(info: NodeInfo): string {
  const node = info.node as ElementNode
  const semantic = node.classes.find((name) => /^[a-z][a-z0-9-]*$/.test(name))
  if (semantic !== undefined) return semantic.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
  const singular: Record<string, string> = { a: 'link', button: 'button', tr: 'row', option: 'option' }
  return singular[node.tag.split('.').at(-1)!] ?? 'item'
}

function arrayBaseName(info: NodeInfo): string {
  const node = info.node as ElementNode
  const semantic = node.classes.find((name) => /^[a-z][a-z0-9-]*$/.test(name))
  if (semantic !== undefined) return `${semantic.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())}s`
  const tag = node.tag.split('.').at(-1)!
  const plural: Record<string, string> = { li: 'items', a: 'links', button: 'buttons', tr: 'rows', option: 'options' }
  return plural[tag] ?? `${tag[0]!.toLowerCase()}${tag.slice(1)}Items`
}

/** The `each` block (and module constant) that renders a mapping. */
export function renderMapping(mapping: Mapping, body: string): { usage: string; declaration: string | null; snippet: string } {
  const { indent } = mapping
  const header = `${indent}each ${mapping.itemName}${mapping.index ? ', index' : ''} in `
  const content = body.split('\n').map((line) => (line === '' ? '' : `${indent}  ${line}`))
  let block: string[]
  let declaration: string | null = null
  if (mapping.placement === 'module') {
    block = [`${header}${mapping.arrayName} key ${mapping.key}`, ...content]
    declaration = [`const ${mapping.arrayName} = [`, ...mapping.items.map((item) => `  ${item},`), ']'].join('\n')
  } else {
    block = [`${header}[`, ...mapping.items.map((item) => `${indent}  ~ ${item},`), `${indent}  ~ ] key ${mapping.key}`, ...content]
  }
  const usage = block.join('\n')
  const snippet = declaration === null ? usage : ['module', ...declaration.split('\n').map((line) => `  ${line}`), '', usage].join('\n')
  return { usage, declaration, snippet }
}

/**
 * Apply a developer-chosen name: the component and its props interface, or
 * for a mapping the array (module placement) or the loop item (inline).
 */
export function renameSuggestion<T extends Draft>(suggestion: T, name: string): T {
  if (name === suggestion.name) return suggestion
  if (suggestion.mapping !== null) {
    const mapping = { ...suggestion.mapping }
    let body = suggestion.body
    if (mapping.placement === 'module') {
      mapping.arrayName = name
    } else {
      const pattern = new RegExp(`\\b${mapping.itemName.replace(/\$/g, '\\$')}\\.`, 'g')
      body = body.replace(pattern, `${name}.`)
      mapping.key = mapping.key.replace(pattern, `${name}.`)
      mapping.itemName = name
    }
    const rendered = renderMapping(mapping, body)
    return { ...suggestion, name, mapping, body, usage: rendered.usage, usages: [rendered.usage], snippet: rendered.snippet }
  }
  const propsType = suggestion.propsType === null ? null : `${name}Props`
  const propsDeclaration = propsType === null ? null : interfaceText(propsType, suggestion.props)
  const rename = (call: string) => (call.trimStart().startsWith(suggestion.name) ? call.replace(suggestion.name, name) : call)
  return {
    ...suggestion,
    name,
    propsType,
    propsDeclaration,
    usage: rename(suggestion.usage),
    usages: suggestion.usages.map(rename),
    snippet: componentSnippet(name, suggestion.props, propsType, propsDeclaration, suggestion.body.split('\n')),
  }
}

/**
 * Replace heuristic prop types with the ones TypeScript infers at each
 * section, in one batched check of a virtual module (see `./types.ts`).
 */
function deriveTypes(context: Context, document: BeastDocument, drafts: readonly Draft[], options: AnalyzeOptions): Draft[] {
  const probed = drafts.filter((draft) => draft.props.length > 0)
  if (options.resolveTypes === undefined || options.sourcePath === undefined || probed.length === 0) return [...drafts]

  const ids = new Map(probed.map((draft, index) => [draft, `__beastProbe${index}`]))
  const code: string[] = []
  for (const declaration of document.declarations) {
    if (declaration.kind === 'import' || declaration.kind === 'module') code.push(declaration.code)
  }
  for (const local of context.localComponents) {
    if (!context.moduleNames.has(local)) code.push(`declare const ${local}: any`)
  }
  code.push(`declare function ${PROBE_CALL}(...values: unknown[]): void`)
  // Shared props are read in the first copy; a differing value is read in
  // each copy, where its own bindings are in scope.
  const probes: Array<{ id: string; names: string[] }> = []
  const probeAt = (id: string, info: NodeInfo, names: readonly string[], expressions: readonly string[]) => {
    const scopes: ProbeScope[] = []
    for (let node: NodeInfo | null = info; node !== null; node = node.parent) if (node.scope !== null) scopes.unshift(node.scope)
    code.push(
      `function ${id}(${info.host.propsParameter ?? ''}) {`,
      ...info.host.setupCode,
      ...scopes.map((scope) => scope.open),
      `${PROBE_CALL}(${expressions.join(', ')})`,
      ...scopes.map((scope) => scope.close).reverse(),
      '}',
    )
    probes.push({ id, names: [...names] })
  }
  for (const draft of probed) {
    const origin = context.origins.get(draft)!
    const id = ids.get(draft)!
    const shared = draft.props.filter((prop) => !origin.params.some((param) => param.name === prop.name)).map((prop) => prop.name)
    probeAt(id, origin.infos[0]!, shared, shared)
    origin.infos.forEach((info, occurrence) => {
      const params = origin.params.filter((param) => heuristicParamType(param) !== 'string')
      if (params.length > 0) probeAt(`${id}_${occurrence}`, info, params.map((param) => param.name), params.map((param) => `(${param.values[occurrence]!.code})`))
    })
  }

  const result = options.resolveTypes({ sourcePath: options.sourcePath, code: code.join('\n'), probes })
  if (result === null) return [...drafts]

  return drafts.map((draft) => {
    const origin = context.origins.get(draft)
    const types = result.get(ids.get(draft) ?? '')
    if (types === undefined || origin === undefined) return draft
    // A parameter's type is the union of its values' types across copies.
    for (const param of origin.params) {
      const parts = origin.infos.map((_info, occurrence) => result.get(`${ids.get(draft)}_${occurrence}`)?.get(param.name))
      if (parts.some((part) => part === undefined)) continue
      const union = [...new Set(parts.flatMap((part) => splitUnion(part!.type)))]
      types.set(param.name, { type: union.join(' | '), imports: parts.flatMap((part) => part!.imports) })
    }
    const imports: TypeImport[] = []
    const props = draft.props.map((prop) => {
      const resolved = types.get(prop.name)
      // When TypeScript only finds `any` (an unresolved import, say), a
      // heuristic type that names something concrete is better.
      if (resolved === undefined || (resolved.type === 'any' && !/\bany\b/.test(prop.type))) return prop
      for (const entry of resolved.imports) {
        if (!imports.some((existing) => existing.name === entry.name && existing.from === entry.from)) imports.push(entry)
      }
      return { name: prop.name, type: resolved.type }
    })
    return { ...draft, props, ...generated(context, origin.infos, draft.name, props, imports, true, origin.shape) }
  })
}

/** Top-level members of a printed union type. */
function splitUnion(type: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < type.length; i++) {
    const char = type[i]!
    if ('([{<'.includes(char)) depth++
    else if (')]}>'.includes(char) && type[i - 1] !== '=') depth--
    else if (char === '|' && depth === 0) {
      parts.push(type.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(type.slice(start).trim())
  return parts
}

function propsTypeName(context: Context, name: string): string {
  const base = `${name}Props`
  let candidate = base
  for (let n = 2; context.moduleTypeNames.has(candidate) || context.moduleNames.has(candidate); n++) candidate = `${base}${n}`
  return candidate
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
  shape: Shape,
): { references: string[]; autoApply: AutoApply } {
  const [first] = infos as [NodeInfo, ...NodeInfo[]]
  const references = new Set<string>()
  if (shape.uses !== undefined) {
    // A parameterized body reads only what is left after its values moved to the call sites.
    shape.uses.forEach((name) => references.add(name))
    for (const line of shape.body ?? []) {
      const tag = /^\s*([A-Z][\w$]*)/.exec(line)
      if (tag !== null) references.add(tag[1]!)
    }
  } else {
    for (const info of infos) info.uses.forEach((name) => references.add(name))
  }
  for (const prop of props) identifiersIn(prop.type).forEach((name) => references.add(name))
  const lines = first.end - first.start + 1

  let blocked: string | null = null
  if (first.host.hasStyle) {
    blocked = `${first.host.name} has a scoped style block, which would stop matching the moved elements.`
  } else if (shape.blocked !== null) {
    blocked = shape.blocked
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

/** The section's source at column 0, with a loop key removed (it moves to the call site). */
function sectionBody(context: Context, info: NodeInfo): string[] {
  const base = info.node.span.start.column - 1
  const headerEnd = info.node.span.end.line
  const key = keyAttribute(context, info)
  const body = context.lines.slice(info.start - 1, info.end).map((line, index) => {
    const indent = /^ */.exec(line)![0].length
    const text = key !== null && info.start + index <= headerEnd
      ? line.replace(KEY_ATTRIBUTE, '').replace(/^(\s*[\w.#$-]+)\(\s*\)/, '$1')
      : line
    return text.trim() === '' || text.trim() === '~' ? '' : text.slice(Math.min(indent, base))
  }).filter((line, index) => line !== '' || index > headerEnd - info.start)
  while (body.at(-1) === '') body.pop()
  return body
}

/** A local `component` declaration, preceded by a `module` block declaring its props interface. */
function componentSnippet(
  name: string,
  props: readonly SuggestedProp[],
  propsType: string | null,
  propsDeclaration: string | null,
  body: readonly string[],
): string {
  const lines: string[] = []
  if (propsDeclaration !== null) {
    lines.push('module', ...propsDeclaration.split('\n').map((line) => `  ${line}`), '')
  }
  lines.push(`component ${name}`)
  if (propsType !== null) lines.push(`  props { ${props.map((prop) => prop.name).join(', ')} }: ${propsType}`)
  lines.push(...body.map((line) => (line === '' ? '' : `  ${line}`)))
  return lines.join('\n')
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
