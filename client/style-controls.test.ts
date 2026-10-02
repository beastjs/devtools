import { expect, test } from 'bun:test'
import { numericStyle } from './style-controls.ts'

const numeric = (name: string, value: string) => numericStyle({ name, value, editable: true })

test('scrubbing preserves CSS units and priority with appropriate limits', () => {
  expect(numeric('margin-left', '-12.5px !important')).toMatchObject({ value: -12.5, unit: 'px', important: ' !important', min: -1000000 })
  expect(numeric('width', '50%')).toMatchObject({ value: 50, unit: '%', min: 0 })
  expect(numeric('font-size', '1.5rem')).toMatchObject({ value: 1.5, unit: 'rem', step: 0.1 })
  expect(numeric('opacity', '0.5')).toMatchObject({ value: 0.5, max: 1, step: 0.01 })
})

test('keywords, compound values, custom properties and expressions remain text fields', () => {
  for (const value of ['auto', 'none', '1fr 1fr', 'calc(100% - 8px)', 'var(--gap)']) expect(numeric('width', value)).toBeNull()
  expect(numeric('--size', '12px')).toBeNull()
})

test('fill uses a visible local range without restricting CSS value edits', () => {
  const width = numeric('width', '400px')!
  expect(width.max).toBe(1000000)
  expect((width.value - width.fillMin) / (width.fillMax - width.fillMin)).toBe(0.5)
  expect(numeric('opacity', '0.5')).toMatchObject({ fillMin: 0, fillMax: 1 })
})
