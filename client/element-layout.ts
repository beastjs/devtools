/**
 * Direct layout editing for the element open in the Elements panel: a thin
 * outline on the page with a handle on each side. Dragging the right or bottom
 * side sets `width` or `height`. Dragging the left or top side also shifts
 * `margin-left` or `margin-top`, so the opposite side stays put and the edge
 * follows the pointer. Each drag is one undo step; Escape cancels it.
 *
 * Like the picker highlight, this is plain DOM that follows the element every
 * frame, so dragging never re-renders the overlay.
 */
import type { ElementInspection, StyleEdit } from './element-inspector.ts'

export type Edge = 'top' | 'right' | 'bottom' | 'left'

export interface BoxStart {
  /** Computed `width` and `height`, which follow the element's `box-sizing`. */
  width: number
  height: number
  marginTop: number
  marginLeft: number
}

const EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left']
/** Replaced elements take a size even when they are `display: inline`. */
const REPLACED = new Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'input', 'textarea', 'select'])
/** SVG elements whose geometry CSS `width` and `height` control. */
const SIZED_SVG = new Set(['svg', 'rect', 'image', 'foreignObject', 'use'])
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
/** The overlay's own host; the pickers ignore everything inside it. */
const OVERLAY_HOST = 'beast-devtools'
const DRAGGING_CLASS = 'bdt-layout-dragging'

const px = (value: number) => `${Number(value.toFixed(2))}px`

/** The inline declarations for dragging `edge` by `dx`/`dy` pixels from `start`. */
export function resizeDeclarations(edge: Edge, start: BoxStart, dx: number, dy: number): Record<string, string> {
  switch (edge) {
    case 'right':
      return { width: px(Math.max(0, Math.round(start.width + dx))) }
    case 'bottom':
      return { height: px(Math.max(0, Math.round(start.height + dy))) }
    case 'left': {
      const width = Math.max(0, Math.round(start.width - dx))
      return { width: px(width), 'margin-left': px(start.marginLeft + start.width - width) }
    }
    case 'top': {
      const height = Math.max(0, Math.round(start.height - dy))
      return { height: px(height), 'margin-top': px(start.marginTop + start.height - height) }
    }
  }
}

/** Whether CSS `width` and `height` change this element's box. */
export function canResize(element: Pick<Element, 'localName' | 'namespaceURI'>, display: string): boolean {
  if (display === 'none' || display === 'contents') return false
  if (element.namespaceURI === SVG_NAMESPACE) return SIZED_SVG.has(element.localName)
  return display !== 'inline' || REPLACED.has(element.localName)
}

/** Shows the outline and side handles until the returned cleanup runs. */
export function startLayoutEditor(inspection: ElementInspection, onCommit: () => void): () => void {
  if (!inspection.canSave) return () => {}
  const frame = document.createElement('div')
  frame.className = 'bdt-layout-frame'
  const size = document.createElement('span')
  size.className = 'bdt-layout-size'
  frame.append(size)
  const handles = EDGES.map((edge) => {
    const handle = document.createElement('div')
    handle.className = `bdt-layout-handle is-${edge}`
    handle.title = edge === 'left' || edge === 'right' ? 'Drag to change width' : 'Drag to change height'
    handle.addEventListener('pointerdown', (event) => begin(event, edge, handle))
    frame.append(handle)
    return handle
  })
  ;(document.getElementById(OVERLAY_HOST) ?? document.body).append(frame)

  let drag: { edge: Edge; x: number; y: number; start: BoxStart; edit: StyleEdit; handle: HTMLElement; pointer: number } | null = null
  let frameRequest = 0

  const place = () => {
    frameRequest = requestAnimationFrame(place)
    const element = inspection.element
    const rect = element.getBoundingClientRect()
    const display = element.isConnected ? getComputedStyle(element).display : 'none'
    const visible = element.isConnected && display !== 'none'
    frame.classList.toggle('is-visible', visible)
    if (!visible) return
    frame.classList.toggle('is-fixed', drag === null && !canResize(element, display))
    frame.style.transform = `translate(${rect.left}px, ${rect.top}px)`
    frame.style.width = `${rect.width}px`
    frame.style.height = `${rect.height}px`
    size.textContent = inspection.error ?? (inspection.saving ? 'Saving…' : `${Number(rect.width.toFixed(1))} × ${Number(rect.height.toFixed(1))}`)
  }

  const finish = (keep: boolean, notify = true) => {
    if (drag === null) return
    const { edit, handle, pointer } = drag
    drag = null
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
    document.documentElement.classList.remove(DRAGGING_CLASS)
    frame.classList.remove('is-dragging')
    delete document.documentElement.dataset.bdtLayoutEdge
    window.removeEventListener('keydown', onKeyDown, true)
    if (keep) void edit.commit().catch(() => {}).finally(onCommit)
    else edit.cancel()
    if (notify) onCommit()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    finish(false)
  }

  const begin = (event: PointerEvent, edge: Edge, handle: HTMLElement) => {
    const element = inspection.element
    if (event.button !== 0 || drag !== null || !element.isConnected) return
    const computed = getComputedStyle(element)
    if (!canResize(element, computed.display)) return
    event.preventDefault()
    event.stopPropagation()
    let edit: StyleEdit
    try { edit = inspection.beginStyleEdit() } catch { return }
    drag = {
      edge, x: event.clientX, y: event.clientY, edit, handle, pointer: event.pointerId,
      start: {
        width: parseFloat(computed.width) || element.getBoundingClientRect().width,
        height: parseFloat(computed.height) || element.getBoundingClientRect().height,
        marginTop: parseFloat(computed.marginTop) || 0,
        marginLeft: parseFloat(computed.marginLeft) || 0,
      },
    }
    handle.setPointerCapture(event.pointerId)
    document.documentElement.classList.add(DRAGGING_CLASS)
    document.documentElement.dataset.bdtLayoutEdge = edge
    frame.classList.add('is-dragging')
    window.addEventListener('keydown', onKeyDown, true)
  }

  for (const handle of handles) {
    handle.addEventListener('pointermove', (event) => {
      if (drag === null || drag.handle !== handle) return
      drag.edit.set(resizeDeclarations(drag.edge, drag.start, event.clientX - drag.x, event.clientY - drag.y))
    })
    handle.addEventListener('pointerup', () => finish(true))
    handle.addEventListener('pointercancel', () => finish(false))
  }

  place()
  return () => {
    cancelAnimationFrame(frameRequest)
    // Tearing down (unmount or element switch) reverts a partial drag instead
    // of committing it, and stays silent: the panel is gone, so notifying it
    // would setState on an unmounted component.
    finish(false, false)
    frame.remove()
  }
}
