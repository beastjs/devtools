import { DEFAULT_SETTINGS, type AnalyzerSettings } from '../shared/types.ts'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Value previews for inspected hook and context values

export function isExpandable(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0
}

/** One-line, length-capped rendering of an inspected value. */
export function preview(value: unknown, budget = 90): string {
  const text = previewInner(value, 0)
  return text.length > budget ? `${text.slice(0, budget - 1)}…` : text
}

function previewInner(value: unknown, depth: number): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return /^\[(Function|Node|Getter|Array|Object|Unavailable)\]$/.test(value) ? value : JSON.stringify(value)
  if (typeof value !== 'object') return String(value)
  if (depth >= 2) return Array.isArray(value) ? `Array(${value.length})` : '{…}'
  if (Array.isArray(value)) return `[${value.map((item) => previewInner(item, depth + 1)).join(', ')}]`
  const entries = Object.entries(value).map(([key, item]) => `${key}: ${previewInner(item, depth + 1)}`)
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item === undefined ? '__undefined__' : item), 2)
    .replaceAll('"__undefined__"', 'undefined')
}

export function valueTone(value: unknown): string {
  if (value === null || value === undefined) return 'bdt-v-nil'
  if (typeof value === 'string') return /^\[\w+\]$/.test(value) ? 'bdt-v-special' : 'bdt-v-string'
  if (typeof value === 'number' || typeof value === 'bigint') return 'bdt-v-number'
  if (typeof value === 'boolean') return 'bdt-v-boolean'
  return 'bdt-v-object'
}

// ---------------------------------------------------------------------------
// Preferences, persisted per browser

export type TabId = 'components' | 'inspector' | 'refactor'

export interface Preferences {
  open: boolean
  tab: TabId
  height: number
  file: string | null
  showControlFlow: boolean
  settings: AnalyzerSettings
}

const STORAGE_KEY = 'beast-devtools:preferences'

export const DEFAULT_PREFERENCES: Preferences = {
  open: false,
  tab: 'components',
  height: 360,
  file: null,
  showControlFlow: true,
  settings: DEFAULT_SETTINGS,
}

export function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Preferences>
    return {
      ...DEFAULT_PREFERENCES,
      ...stored,
      settings: { ...DEFAULT_SETTINGS, ...stored.settings },
      height: clampHeight(stored.height ?? DEFAULT_PREFERENCES.height),
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage can be unavailable (private mode, blocked site data); preferences are optional.
  }
}

export function clampHeight(height: number): number {
  const max = Math.max(240, (typeof window === 'undefined' ? 900 : window.innerHeight) - 48)
  return Math.round(Math.min(max, Math.max(200, height)))
}

/** Drive a vertical resize from a pointer-down on the panel's top edge. */
export function startResize(event: PointerEvent, height: number, setHeight: (height: number) => void): void {
  event.preventDefault()
  const startY = event.clientY
  const move = (moveEvent: PointerEvent) => setHeight(clampHeight(height + startY - moveEvent.clientY))
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    document.documentElement.style.removeProperty('cursor')
  }
  document.documentElement.style.cursor = 'ns-resize'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

/** Scroll a line into the middle of its scroll container without moving the page. */
export function scrollToLine(container: HTMLElement | null, line: number | null): void {
  if (container === null || line === null) return
  const row = container.querySelector<HTMLElement>(`[data-line="${line}"]`)
  if (row === null) return
  const top = row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

/** A scroll request; the nonce lets the same line be requested twice. */
export interface ScrollTarget {
  line: number
  nonce: number
}

let scrollNonce = 0

export function scrollTarget(line: number): ScrollTarget {
  return { line, nonce: ++scrollNonce }
}

/** The last applied refactor, kept by the shell so Undo survives tab switches. */
export interface RecentRefactor {
  undoId: string
  summary: string
}
