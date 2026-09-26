/**
 * Element picker: hover the app to see which component and `.btsx` line
 * rendered an element, click to open that line in the editor.
 *
 * It reads the `data-beast-src`/`data-beast-component` attributes the dev
 * server adds to project `.btsx` elements (see `server/source-tags.ts`). The
 * highlight is plain DOM, so moving the pointer never re-renders the overlay.
 */
import { COMPONENT_ATTRIBUTE, SOURCE_ATTRIBUTE } from '../shared/types.ts'

export interface PickedSource {
  component: string
  /** Project-relative path of the `.btsx` file. */
  path: string
  line: number
  column: number
}

/** The overlay's own host; it stays clickable while picking. */
const OVERLAY_HOST = 'beast-devtools'
const PICKING_CLASS = 'bdt-picking'

/** Start picking; returns a function that stops. `onPick` fires once per click on a tagged element. */
export function startPicker(onPick: (source: PickedSource) => void, onCancel: () => void): () => void {
  const box = document.createElement('div')
  box.className = 'bdt-picker-box'
  const label = document.createElement('div')
  label.className = 'bdt-picker-label'
  const name = document.createElement('strong')
  const where = document.createElement('span')
  label.append(name, where)
  document.body.append(box, label)
  document.documentElement.classList.add(PICKING_CLASS)

  let current: Element | null = null
  let visible = false

  const show = (element: Element | null) => {
    current = element
    const source = element === null ? null : readSource(element)
    if (element === null || source === null) {
      visible = false
      box.classList.remove('is-visible')
      label.classList.remove('is-visible')
      return
    }

    // Glide from element to element, but appear in place after being hidden.
    const snap = !visible
    box.classList.toggle('is-snapping', snap)
    label.classList.toggle('is-snapping', snap)

    const rect = element.getBoundingClientRect()
    box.style.transform = `translate(${rect.left}px, ${rect.top}px)`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    box.style.borderRadius = cappedRadius(getComputedStyle(element).borderRadius, Math.min(rect.width, rect.height) / 2)

    name.textContent = source.component
    where.textContent = `${source.path}:${source.line}`
    // Above the element when there is room, otherwise just inside its top edge.
    const height = label.offsetHeight
    const top = rect.top - height - 4 >= 0 ? rect.top - height - 4 : Math.max(0, rect.top) + 4
    const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - label.offsetWidth - 4))
    label.style.transform = `translate(${left}px, ${top}px)`

    if (snap) {
      void box.offsetWidth // commit the snapped position before transitions return
      box.classList.remove('is-snapping')
      label.classList.remove('is-snapping')
    }
    visible = true
    box.classList.add('is-visible')
    label.classList.add('is-visible')
  }

  const onMove = (event: PointerEvent) => show(tagged(event.target))
  const onScroll = () => show(current !== null && current.isConnected ? current : null)
  // Swallow the whole press so the app neither focuses, drags nor clicks.
  const onPress = (event: Event) => {
    if (inOverlay(event.target)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onClick = (event: MouseEvent) => {
    if (inOverlay(event.target)) return
    onPress(event)
    const element = tagged(event.target)
    const source = element === null ? null : readSource(element)
    if (source !== null) onPick(source)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    onCancel()
  }

  const capture = { capture: true } as const
  const presses = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu'] as const
  window.addEventListener('pointermove', onMove, capture)
  window.addEventListener('scroll', onScroll, capture)
  window.addEventListener('resize', onScroll)
  window.addEventListener('click', onClick, capture)
  window.addEventListener('keydown', onKeyDown, capture)
  for (const type of presses) window.addEventListener(type, onPress, capture)

  return () => {
    window.removeEventListener('pointermove', onMove, capture)
    window.removeEventListener('scroll', onScroll, capture)
    window.removeEventListener('resize', onScroll)
    window.removeEventListener('click', onClick, capture)
    window.removeEventListener('keydown', onKeyDown, capture)
    for (const type of presses) window.removeEventListener(type, onPress, capture)
    document.documentElement.classList.remove(PICKING_CLASS)
    box.remove()
    label.remove()
  }
}

function tagged(target: EventTarget | null): Element | null {
  if (!(target instanceof Element) || inOverlay(target)) return null
  return target.closest(`[${SOURCE_ATTRIBUTE}]`)
}

function inOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`#${OVERLAY_HOST}`) !== null
}

/**
 * Pill shapes such as Tailwind's `rounded-full` compute to a huge radius, which
 * would make the corners snap instead of ease; no corner needs more than half the
 * shorter side.
 */
function cappedRadius(radius: string, max: number): string {
  return radius.replace(/[\d.e+]+px/gu, (value) => `${Math.min(parseFloat(value), max)}px`)
}

function readSource(element: Element): PickedSource | null {
  const match = /^(.+):(\d+):(\d+)$/.exec(element.getAttribute(SOURCE_ATTRIBUTE) ?? '')
  if (match === null) return null
  return {
    component: element.getAttribute(COMPONENT_ATTRIBUTE) ?? 'Unknown',
    path: match[1]!,
    line: Number(match[2]),
    column: Number(match[3]),
  }
}
