import type { BeastDocument, BeastNode, EachNode, BeastSourceMap } from 'beast-tsrx'
import type { SourceBlock } from '../shared/types.js'
import { buildLineMap } from './line-map.js'
import { PROBE_CALL, type ProbeFile, type ProbeResult } from './types.js'

interface BlockInfo {
  block: SourceBlock
  node?: BeastNode
  scopes: Array<{ open: string; close: string }>
  parameter: string
  setup: string[]
}

function children(node: BeastNode): BeastNode[] {
  switch (node.kind) {
    case 'element': case 'fragment': case 'scope': return node.children
    case 'if': case 'switch': return node.branches.flatMap((branch) => branch.children)
    case 'each': return [...node.children, ...node.emptyChildren ?? []]
    case 'try': return [...node.children, ...node.pendingBranch?.children ?? [], ...node.catchBranch?.children ?? []]
    default: return []
  }
}

function lastLine(node: BeastNode): number {
  const extra = node.kind === 'if' || node.kind === 'switch' ? node.branches.map((branch) => branch.span.end.line)
    : node.kind === 'try' ? [node.pendingBranch?.span.end.line ?? 0, node.catchBranch?.span.end.line ?? 0] : []
  return Math.max(node.span.end.line, ...extra, ...children(node).map(lastLine))
}

function templateLine(nodes: readonly BeastNode[]): number | undefined {
  return nodes.find((node) => node.kind !== 'text' && node.kind !== 'style' && !(node.kind === 'element' && node.isComponent))?.span.start.line
}

/** Source ranges come from Beast's AST; generated names come from Octane's source map. */
export function sourceBlocks(document: BeastDocument, source: string, hostName: string, sourcePath: string,
  compiled: { code: string; map: BeastSourceMap } | null, beast: { code: string; map: BeastSourceMap },
  resolveTypes?: (file: ProbeFile) => ProbeResult | null): SourceBlock[] {
  const lines = source.split('\n')
  const infos: BlockInfo[] = []
  const walk = (nodes: readonly BeastNode[], host: string, parameter: string, setup: string[], scopes: Array<{ open: string; close: string }>) => {
    for (const node of nodes) {
      const startLine = node.span.start.line
      const block: SourceBlock = { host, scope: null, kind: node.kind, startLine, endLine: lastLine(node), indent: /^[ \t]*/.exec(lines[startLine - 1] ?? '')![0] }
      if (node.kind === 'each') Object.assign(block, { itemName: node.itemName, iterable: node.iterable })
      const nextScopes = node.kind === 'each' ? [...scopes, { open: `for (const ${node.itemName} of (${node.iterable})) {${node.indexName ? `const ${node.indexName} = 0;` : ''}`, close: '}' }]
        : node.kind === 'scope' ? [...scopes, { open: `{ ${node.setup.map((entry) => entry.code).join('\n')}`, close: '}' }] : scopes
      infos.push({ block, node, scopes: nextScopes, parameter, setup })
      // Each empty branches do not bind the item.
      if (node.kind === 'each') {
        walk(node.children, host, parameter, setup, nextScopes)
        walk(node.emptyChildren ?? [], host, parameter, setup, scopes)
      } else if (node.kind === 'if') {
        node.branches.forEach((branch, index) => {
          const earlier = node.branches.slice(0, index).map((previous) => `if (${previous.test}) {} else `).join('')
          walk(branch.children, host, parameter, setup, [...scopes, { open: `${earlier}${branch.test === null ? '{' : `if (${branch.test}) {`}`, close: '}' }])
        })
      } else if (node.kind === 'switch') {
        for (const branch of node.branches) walk(branch.children, host, parameter, setup, [...scopes,
          { open: `switch (${node.discriminant}) { ${branch.test === null ? 'default' : `case ${branch.test}`}: {`, close: '} }' }])
      } else walk(children(node), host, parameter, setup, nextScopes)
    }
  }
  const topProps = document.declarations.find((entry) => entry.kind === 'props')
  const topSetup = document.declarations.flatMap((entry) => entry.kind === 'setup' ? [entry.code] : [])
  infos.push({ block: { host: hostName, scope: hostName, kind: 'component', startLine: 1, endLine: lines.length, indent: '', templateLine: templateLine(document.children) }, scopes: [], parameter: '', setup: [] })
  walk(document.children, hostName, topProps?.kind === 'props' ? topProps.parameter : '', topSetup, [])
  for (const declaration of document.declarations) {
    if (declaration.kind !== 'component') continue
    infos.push({ block: { host: declaration.name, scope: declaration.name, kind: 'component', startLine: declaration.span.start.line,
      endLine: Math.max(declaration.span.end.line, ...declaration.children.map(lastLine), ...declaration.setup.map((entry) => entry.span.end.line)), indent: '', templateLine: templateLine(declaration.children) }, scopes: [], parameter: '', setup: [] })
    walk(declaration.children, declaration.name, declaration.props?.parameter ?? '', declaration.setup.map((entry) => entry.code), [])
  }
  if (compiled !== null) {
    const generated = compiled.code.split('\n')
    const jsMap = buildLineMap(compiled.map, generated.length, beast.code.split('\n').length)
    const beastMap = buildLineMap(beast.map, beast.code.split('\n').length, lines.length)
    generated.forEach((line, index) => {
      const match = /^function (__([A-Za-z]+)\$\d+)\(/.exec(line)
      const tsrxLine = jsMap.tsrxToBtsx[index]
      const sourceLine = tsrxLine == null ? null : beastMap.tsrxToBtsx[tsrxLine - 1]
      if (!match || sourceLine == null) return
      const kind = match[2] === 'item' || match[2] === 'empty' ? 'each' : /^(then|else)$/.test(match[2]!) ? 'if'
        : /^case/.test(match[2]!) ? 'switch' : /^(try|catch|pending)$/.test(match[2]!) ? 'try' : 'scope'
      const found = infos.filter((info) => info.block.kind === kind && info.block.startLine < sourceLine && sourceLine <= info.block.endLine)
        .sort((a, b) => b.block.startLine - a.block.startLine)[0]
      if (found) infos.push({ ...found, block: { ...found.block, scope: match[1]! } })
    })
  }
  const loops = infos.filter((info) => info.node?.kind === 'each' && info.block.scope === null)
  if (resolveTypes && loops.length) {
    const code = document.declarations.flatMap((entry) => entry.kind === 'import' || entry.kind === 'module' ? [entry.code] : [])
    code.push(`declare function ${PROBE_CALL}(...values: unknown[]): void;`)
    const probes = loops.map((info, index) => {
      const node = info.node as EachNode
      const id = `__beastBlock${index}`
      code.push(`function ${id}(${info.parameter}) {`, ...info.setup, ...info.scopes.map((scope) => scope.open),
        `${PROBE_CALL}(${node.itemName});`, ...info.scopes.map((scope) => scope.close).reverse(), '}')
      return { id, names: [node.itemName] }
    })
    const result = resolveTypes({ sourcePath, code: code.join('\n'), probes })
    loops.forEach((info, index) => {
      const type = result?.get(probes[index]!.id)?.get(info.block.itemName!)?.type
      for (const related of infos) if (related.block.host === info.block.host && related.block.startLine === info.block.startLine && related.block.kind === 'each') related.block.itemType = type ?? 'unknown'
    })
  }
  return infos.map((info) => info.block)
}
