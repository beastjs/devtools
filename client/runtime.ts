/**
 * External store over Octane's `__OCTANE_DEVTOOLS__` inspection hook.
 *
 * The overlay is itself an Octane root, so every overlay render also flushes
 * and notifies the hook. The store therefore publishes a new snapshot only
 * when the (overlay-filtered) tree or the selected node's detail actually
 * changes; an overlay-only flush produces an identical key and stops there.
 */

interface HookTreeNode {
  id: number
  name: string
  kind: string
  children: HookTreeNode[]
}

export interface HookCell {
  kind: 'state' | 'reducer' | 'ref' | 'memo-or-callback' | 'other'
  value: unknown
}

export interface NodeDetail {
  id: number
  name: string
  hooks: HookCell[]
  context: Array<{ name: string; value: unknown }>
  effectCount: number
}

interface OctaneDevtoolsHook {
  version: number
  getTree(): HookTreeNode[]
  inspect(id: number): NodeDetail | null
  subscribe(listener: () => void): () => void
}

export interface RuntimeNode {
  id: number
  name: string
  /** Display name: generated control-flow scopes such as `__item$1` become `@item`. */
  label: string
  kind: string
  controlFlow: boolean
  children: RuntimeNode[]
}

export interface RuntimeSnapshot {
  status: 'connecting' | 'unavailable' | 'connected'
  roots: RuntimeNode[]
  componentCount: number
  selectedId: number | null
  detail: NodeDetail | null
}

/** The overlay's own root component; it is hidden from the inspected tree. */
export const OVERLAY_ROOT = 'BeastDevtools'

const listeners = new Set<() => void>()
let snapshot: RuntimeSnapshot = { status: 'connecting', roots: [], componentCount: 0, selectedId: null, detail: null }
let treeKey = ''
let detailKey = ''
let selectedId: number | null = null
let frame = 0
let retry: ReturnType<typeof setTimeout> | undefined
let disconnect: (() => void) | null = null

function hook(): OctaneDevtoolsHook | undefined {
  return (globalThis as { __OCTANE_DEVTOOLS__?: OctaneDevtoolsHook }).__OCTANE_DEVTOOLS__
}

export function subscribeRuntime(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) connect(0)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    disconnect?.()
    disconnect = null
    clearTimeout(retry)
    cancelAnimationFrame(frame)
    frame = 0
  }
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return snapshot
}

export function selectRuntimeNode(id: number | null): void {
  selectedId = id
  refresh()
}

function connect(attempt: number): void {
  const current = hook()
  if (current === undefined) {
    // Octane installs the hook with its first profiled root. Give slow boots a
    // few seconds before reporting that profiling is off.
    if (attempt < 10) retry = setTimeout(() => connect(attempt + 1), 300)
    else publish({ ...snapshot, status: 'unavailable' })
    return
  }
  disconnect = current.subscribe(schedule)
  refresh()
}

function schedule(): void {
  if (frame !== 0) return
  frame = requestAnimationFrame(() => {
    frame = 0
    refresh()
  })
}

function refresh(): void {
  const current = hook()
  if (current === undefined) return

  const roots = current
    .getTree()
    .filter((root) => root.name !== OVERLAY_ROOT)
    .map(describe)
  const ids = new Set<number>()
  let componentCount = 0
  const visit = (node: RuntimeNode) => {
    ids.add(node.id)
    if (!node.controlFlow) componentCount++
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  if (selectedId !== null && !ids.has(selectedId)) selectedId = null

  const detail = selectedId === null ? null : current.inspect(selectedId)
  const nextTreeKey = JSON.stringify(roots)
  const nextDetailKey = `${selectedId}:${safeStringify(detail)}`
  if (snapshot.status === 'connected' && nextTreeKey === treeKey && nextDetailKey === detailKey) return

  treeKey = nextTreeKey
  detailKey = nextDetailKey
  publish({ status: 'connected', roots, componentCount, selectedId, detail })
}

function publish(next: RuntimeSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function describe(node: HookTreeNode): RuntimeNode {
  const generated = /^__([A-Za-z]+)\$\d+$/.exec(node.name)
  const controlFlow = node.kind === 'control-flow' || generated !== null
  return {
    id: node.id,
    name: node.name,
    label: generated === null ? node.name : `@${generated[1]}`,
    kind: node.kind,
    controlFlow,
    children: node.children.map(describe),
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item)) ?? 'undefined'
  } catch {
    // Must stay stable: a changing key would republish on every overlay flush.
    return '[unserializable]'
  }
}
