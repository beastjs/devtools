/**
 * Component Finder identifies the owning component and source file, and opens
 * its source on click. Element Picker shows basic properties for any page
 * element without requiring source tags.
 *
 * It reads the `data-beast-src`/`data-beast-component` attributes the dev
 * server adds to project `.btsx` elements (see `server/source-tags.ts`). The
 * highlight is plain DOM, so moving the pointer never re-renders the overlay.
 */
import { elementLabel } from './element-inspector.ts'
import { placeElementPickerCard } from './element-picker-position.ts'
import { COMPONENT_ATTRIBUTE, SOURCE_ATTRIBUTE } from '../shared/types.ts'

export type ElementTool = 'component-finder' | 'element-picker'

export interface ComponentFinderSource {
  component: string
  /** Project-relative path of the `.btsx` file. */
  path: string
  line: number
  column: number
}

/** The overlay's own host; it stays clickable while either tool is active. */
const OVERLAY_HOST = 'beast-devtools'

/** Find a component and its source file; returns cleanup. */
export function startComponentFinder(onComponentFound: (source: ComponentFinderSource) => void, onCancel: () => void): () => void {
  return startElementTool(onComponentFound, onCancel, 'component-finder')
}

/** Show basic element properties; returns cleanup. */
export function startElementPicker(onElementPicked: (element: Element) => void, onCancel: () => void): () => void {
  return startElementTool(() => {}, onCancel, 'element-picker', onElementPicked)
}

/** Shared pointer tracking and highlighting for both tools. */
function startElementTool(onComponentFound: (source: ComponentFinderSource) => void, onCancel: () => void, mode: ElementTool, onElementPicked?: (element: Element) => void): () => void {
  const activeToolClass = `bdt-${mode}-active`
  const box = document.createElement('div')
  box.className = `bdt-${mode}-highlight`
  const label = document.createElement('div')
  label.className = mode === 'element-picker' ? 'bdt-element-picker-card' : 'bdt-component-finder-label'
  const name = document.createElement('strong')
  const where = document.createElement('span')
  label.append(name, where)
  if (mode === 'element-picker') {
    const hint = document.createElement('small')
    hint.textContent = 'Click to edit · Esc to exit'
    label.append(hint)
  }
  document.body.append(box, label)
  document.documentElement.classList.add(activeToolClass)

  let current: Element | null = null
  let visible = false
  let elementPickerCardTimer: ReturnType<typeof setTimeout> | undefined

  const show = (element: Element | null, revealDetails = false) => {
    current = element
    const source = element === null ? null : readComponentSource(element)
    if (element === null || (mode === 'component-finder' && source === null)) {
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
    const style = getComputedStyle(element)
    box.style.borderRadius = cappedRadius(style.borderRadius, Math.min(rect.width, rect.height) / 2)

    if (mode === 'element-picker') {
      name.textContent = elementLabel(element)
      where.textContent = `${Number(rect.width.toFixed(1))} × ${Number(rect.height.toFixed(1))}`
    } else if (source !== null) {
      name.textContent = source.component
      where.textContent = `${source.path}:${source.line}`
    }
    const height = label.offsetHeight
    let showLabel = true
    if (mode === 'element-picker') {
      const position = revealDetails
        ? placeElementPickerCard(rect, label.offsetWidth, height, window.innerWidth, window.innerHeight)
        : null
      showLabel = position !== null
      if (position !== null) label.style.transform = `translate(${position.left}px, ${position.top}px)`
    } else {
      const preferredTop = rect.top - height - 4 >= 0 ? rect.top - height - 4 : Math.max(0, rect.top) + 4
      const top = Math.max(4, Math.min(preferredTop, window.innerHeight - height - 4))
      const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - label.offsetWidth - 4))
      label.style.transform = `translate(${left}px, ${top}px)`
    }

    if (snap) {
      void box.offsetWidth // commit the snapped position before transitions return
      box.classList.remove('is-snapping')
      label.classList.remove('is-snapping')
    }
    visible = true
    box.classList.add('is-visible')
    label.classList.toggle('is-visible', showLabel)
  }

  const targetElement = (event: Event) => {
    const path = event.composedPath()
    if (path.some(inOverlay)) return null
    const target = path.find((node): node is Element => node instanceof Element) ?? null
    return mode === 'element-picker' ? target : findTaggedElement(target)
  }
  // Outline immediately; restart the card's delay on movement, scroll or resize.
  const update = (element: Element | null) => {
    clearTimeout(elementPickerCardTimer)
    show(element)
    if (mode === 'element-picker' && element !== null) {
      elementPickerCardTimer = setTimeout(() => show(element.isConnected ? element : null, true), 200)
    }
  }
  const onMove = (event: PointerEvent) => update(targetElement(event))
  const onLeave = () => update(null)
  const onOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) onLeave()
  }
  const onScroll = () => update(current !== null && current.isConnected ? current : null)
  // Swallow the whole press so the app neither focuses, drags nor clicks.
  const onPress = (event: Event) => {
    if (event.composedPath().some(inOverlay)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onClick = (event: MouseEvent) => {
    if (event.composedPath().some(inOverlay)) return
    onPress(event)
    const element = targetElement(event)
    if (mode === 'element-picker') {
      if (element !== null) onElementPicked?.(element)
      return
    }
    const source = element === null ? null : readComponentSource(element)
    if (source !== null) onComponentFound(source)
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
  window.addEventListener('pointerout', onOut, capture)
  window.addEventListener('blur', onLeave)
  window.addEventListener('scroll', onScroll, capture)
  window.addEventListener('resize', onScroll)
  window.addEventListener('click', onClick, capture)
  window.addEventListener('keydown', onKeyDown, capture)
  for (const type of presses) window.addEventListener(type, onPress, capture)

  return () => {
    clearTimeout(elementPickerCardTimer)
    window.removeEventListener('pointermove', onMove, capture)
    window.removeEventListener('pointerout', onOut, capture)
    window.removeEventListener('blur', onLeave)
    window.removeEventListener('scroll', onScroll, capture)
    window.removeEventListener('resize', onScroll)
    window.removeEventListener('click', onClick, capture)
    window.removeEventListener('keydown', onKeyDown, capture)
    for (const type of presses) window.removeEventListener(type, onPress, capture)
    document.documentElement.classList.remove(activeToolClass)
    box.remove()
    label.remove()
  }
}

function findTaggedElement(target: EventTarget | null): Element | null {
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

function readComponentSource(element: Element): ComponentFinderSource | null {
  const match = /^(.+):(\d+):(\d+)$/.exec(element.getAttribute(SOURCE_ATTRIBUTE) ?? '')
  if (match === null) return null
  return {
    component: element.getAttribute(COMPONENT_ATTRIBUTE) ?? 'Unknown',
    path: match[1]!,
    line: Number(match[2]),
    column: Number(match[3]),
  }
}
