/**
 * Resizable splits inside the panels. Each split is a CSS custom property on
 * the overlay's host element, which Octane does not render, so a drag updates
 * one style property per frame and never re-renders the overlay. Sizes are
 * saved per browser once a drag ends; double-clicking a splitter resets it.
 */

export type SplitId = 'sidebar' | 'detail' | 'inspector' | 'refactor'

interface SplitSpec {
  variable: string
  /** The element the split divides, found from the splitter. */
  container: string
  /** Size from the pointer's x within the container: pixels, or a share of the width. */
  measure: (x: number, width: number) => number
  format: (value: number) => string
}

/** Neither side of a split gets narrower than this. */
const MIN_PANE = 200

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))
const share = (value: number) => String(Math.round(value * 1000) / 1000)

const SPLITS: Record<SplitId, SplitSpec> = {
  // The file list, from the panel's left edge.
  sidebar: {
    variable: '--bdt-sidebar-width',
    container: '.bdt-body',
    measure: (x, width) => Math.round(clamp(x, 140, Math.min(480, width - MIN_PANE))),
    format: (value) => `${value}px`,
  },
  // The selected component's details, from the panel's right edge.
  detail: {
    variable: '--bdt-detail-share',
    container: '.bdt-body',
    measure: (x, width) => clamp((width - x) / width, MIN_PANE / width, 1 - MIN_PANE / width),
    format: share,
  },
  // BTSX next to generated TSRX.
  inspector: {
    variable: '--bdt-inspector-share',
    container: '.bdt-split',
    measure: (x, width) => clamp(x / width, MIN_PANE / width, 1 - MIN_PANE / width),
    format: share,
  },
  // Suggestions next to the depth-annotated source.
  refactor: {
    variable: '--bdt-refactor-share',
    container: '.bdt-refactor',
    measure: (x, width) => clamp(x / width, 260 / width, 1 - MIN_PANE / width),
    format: share,
  },
}

const STORAGE_KEY = 'beast-devtools:layout'
const RESIZING_CLASS = 'bdt-resizing'

type Layout = Partial<Record<SplitId, number>>

function load(): Layout {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    const layout: Layout = {}
    for (const id of Object.keys(SPLITS) as SplitId[]) {
      const value = stored[id]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) layout[id] = value
    }
    return layout
  } catch {
    return {}
  }
}

function save(layout: Layout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the layout is optional.
  }
}

let layout: Layout = {}

/** Apply the saved splits to the overlay's host element; call once when mounting. */
export function applyLayout(host: HTMLElement): void {
  layout = load()
  for (const [id, value] of Object.entries(layout) as Array<[SplitId, number]>) {
    host.style.setProperty(SPLITS[id].variable, SPLITS[id].format(value))
  }
}

/** Start dragging a splitter; wired to its `onPointerDown`. */
export function startSplit(event: PointerEvent, id: SplitId): void {
  const handle = event.currentTarget
  if (event.button !== 0 || !(handle instanceof HTMLElement)) return
  const container = handle.closest<HTMLElement>(SPLITS[id].container)
  const host = handle.closest<HTMLElement>('#beast-devtools')
  if (container === null || host === null) return
  event.preventDefault()

  const spec = SPLITS[id]
  const rect = container.getBoundingClientRect()
  let value = layout[id]
  let frame = 0
  let x = event.clientX

  const apply = () => {
    frame = 0
    value = spec.measure(x - rect.left, rect.width)
    host.style.setProperty(spec.variable, spec.format(value))
  }
  const move = (moveEvent: PointerEvent) => {
    x = moveEvent.clientX
    frame ||= requestAnimationFrame(apply)
  }
  const stop = () => {
    cancelAnimationFrame(frame)
    if (frame !== 0) apply()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    document.documentElement.classList.remove(RESIZING_CLASS)
    handle.classList.remove('is-dragging')
    if (value === undefined) return
    layout = { ...layout, [id]: value }
    save(layout)
  }

  document.documentElement.classList.add(RESIZING_CLASS)
  handle.classList.add('is-dragging')
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

/** Put a split back to its default size; wired to the splitter's `onDoubleClick`. */
export function resetSplit(event: MouseEvent, id: SplitId): void {
  const host = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest<HTMLElement>('#beast-devtools') : null
  host?.style.removeProperty(SPLITS[id].variable)
  const { [id]: _removed, ...rest } = layout
  layout = rest
  save(layout)
}
