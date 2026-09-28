interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Keep the whole card in the viewport and outside the element, with an 8px gap. */
export function placeElementPickerCard(rect: Rect, width: number, height: number, viewportWidth: number, viewportHeight: number): { left: number; top: number } | null {
  const gap = 8
  const edge = 4
  const maxLeft = viewportWidth - width - edge
  const maxTop = viewportHeight - height - edge
  if (maxLeft < edge || maxTop < edge) return null
  const left = Math.max(edge, Math.min(rect.left, maxLeft))
  const top = Math.max(edge, Math.min(rect.top, maxTop))
  const candidates = [
    { left, top: rect.top - height - gap },
    { left, top: rect.bottom + gap },
    { left: rect.right + gap, top },
    { left: rect.left - width - gap, top },
  ]
  return candidates.find((point) => point.left >= edge && point.left <= maxLeft && point.top >= edge && point.top <= maxTop) ?? null
}
