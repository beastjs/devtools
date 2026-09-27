/**
 * Row models for the Components panel's two views of the runtime tree: the
 * indented tree, and the block view, which starts at the app's entry component
 * and folds the providers above it into a single bar.
 */
import type { RuntimeNode } from './runtime.ts'

export type ComponentsView = 'blocks' | 'tree'

export interface TreeRow {
  node: RuntimeNode
  depth: number
  expandable: boolean
  open: boolean
  /** Visible children; collapsed rows still report them for their count. */
  childCount: number
  /** An ancestor of the entry component, shown only when wrappers are revealed. */
  wrapper: boolean
}

export interface Wrappers {
  /** The entry component's ancestors, outermost first. */
  chain: RuntimeNode[]
  /** What the block view shows at depth 0 while the wrappers are hidden. */
  tops: RuntimeNode[]
}

export function childrenOf(node: RuntimeNode, showControlFlow: boolean): RuntimeNode[] {
  if (showControlFlow) return node.children
  return node.children.flatMap((child) => (child.controlFlow ? childrenOf(child, false) : [child]))
}

export function matches(node: RuntimeNode, query: string, showControlFlow: boolean): boolean {
  return node.label.toLowerCase().includes(query) || childrenOf(node, showControlFlow).some((child) => matches(child, query, showControlFlow))
}

export function treeRows(
  roots: readonly RuntimeNode[],
  collapsed: ReadonlySet<number>,
  showControlFlow: boolean,
  query: string,
  wrapperIds: ReadonlySet<number> = new Set(),
): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (node: RuntimeNode, depth: number) => {
    if (query !== '' && !matches(node, query, showControlFlow)) return
    const children = childrenOf(node, showControlFlow)
    const open = query !== '' || !collapsed.has(node.id)
    rows.push({ node, depth, expandable: children.length > 0, open, childCount: children.length, wrapper: wrapperIds.has(node.id) })
    if (open) children.forEach((child) => visit(child, depth + 1))
  }
  roots.forEach((root) => visit(root, 0))
  return rows
}

/** Context providers and routers conventionally carry these suffixes. */
const WRAPPER_NAME = /(Provider|Providers|Router|Boundary)$/u

/**
 * Find the app's entry component and the wrappers above it. The entry is the
 * shallowest component that the entry module imports (`App` from `main.ts`)
 * and that is not itself a provider. Without such a match, the view descends
 * from a single root through provider-named components. Returns null when
 * nothing sits above the entry.
 */
export function findWrappers(roots: readonly RuntimeNode[], entryNames: readonly string[], showControlFlow: boolean): Wrappers | null {
  const parents = new Map<RuntimeNode, RuntimeNode | null>()
  let entry: RuntimeNode | null = null

  // Breadth-first, so the shallowest match wins.
  const queue: RuntimeNode[] = []
  for (const root of roots) {
    parents.set(root, null)
    queue.push(root)
  }
  const names = new Set(entryNames)
  while (queue.length > 0 && entry === null) {
    const node = queue.shift()!
    if (names.has(node.name) && !WRAPPER_NAME.test(node.name)) {
      entry = node
      break
    }
    for (const child of childrenOf(node, showControlFlow)) {
      parents.set(child, node)
      queue.push(child)
    }
  }

  if (entry === null && roots.length === 1) {
    let node = roots[0]!
    for (;;) {
      const children = childrenOf(node, showControlFlow)
      // Only names mark a wrapper here: the root itself is often the app.
      if (!WRAPPER_NAME.test(node.name) || children.length !== 1) break
      parents.set(children[0]!, node)
      node = children[0]!
    }
    entry = node
  }
  if (entry === null) return null

  const chain: RuntimeNode[] = []
  for (let parent = parents.get(entry) ?? null; parent !== null; parent = parents.get(parent) ?? null) chain.unshift(parent)
  if (chain.length === 0) return null

  // Keep whatever else the wrappers render (a toaster, a portal) beside the entry.
  const onChain = new Set(chain)
  const found = entry
  const unwrap = (node: RuntimeNode): RuntimeNode[] => {
    if (node === found) return [node]
    if (!onChain.has(node)) return [node]
    return childrenOf(node, showControlFlow).flatMap(unwrap)
  }
  return { chain, tops: roots.flatMap(unwrap) }
}
