import type { ElementProperty } from './element-inspector.ts'

/** Only scalar CSS numbers can be scrubbed; keywords and expressions stay editable as text. */
export function numericStyle(property: ElementProperty) {
  if (property.name.startsWith('--')) return null
  const match = /^(-?\d+(?:\.\d+)?)(px|%|em|rem|vh|vw|deg|s|ms)?(\s*!important)?$/.exec(property.value)
  if (!match) return null
  const unit = match[2] ?? ''
  const negative = /^(margin|inset|top$|right$|bottom$|left$|letter-spacing$|word-spacing$|z-index$|order$|rotate$)/.test(property.name)
  const fractional = unit === '' && /opacity|flex-(grow|shrink)|line-height/.test(property.name)
  const value = Number(match[1])
  const step = fractional ? 0.01 : unit === 'em' || unit === 'rem' || unit === 's' ? 0.1 : 1
  const opacity = property.name.includes('opacity')
  return { value, unit, important: match[3] ?? '', min: negative ? -1000000 : 0, max: opacity ? 1 : 1000000, step,
    fillMin: opacity ? 0 : Math.min(0, value * 2), fillMax: opacity ? 1 : Math.max(Math.abs(value) * 2, step * 100),
  }
}
