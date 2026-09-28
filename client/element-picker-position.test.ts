import { expect, test } from 'bun:test'
import { placeElementPickerCard } from './element-picker-position.ts'

test('places the card above, below, right or left without covering the element', () => {
  expect(placeElementPickerCard({ left: 100, top: 250, right: 300, bottom: 350 }, 340, 180, 800, 600)).toEqual({ left: 100, top: 62 })
  expect(placeElementPickerCard({ left: 100, top: 0, right: 300, bottom: 100 }, 340, 180, 800, 600)).toEqual({ left: 100, top: 108 })
  expect(placeElementPickerCard({ left: 10, top: 0, right: 200, bottom: 600 }, 340, 180, 800, 600)).toEqual({ left: 208, top: 4 })
  expect(placeElementPickerCard({ left: 500, top: 0, right: 800, bottom: 600 }, 340, 180, 800, 600)).toEqual({ left: 152, top: 4 })
})

test('clamps along the free side for targets near or beyond viewport edges', () => {
  expect(placeElementPickerCard({ left: 780, top: 250, right: 850, bottom: 350 }, 340, 180, 800, 600)).toEqual({ left: 456, top: 62 })
  expect(placeElementPickerCard({ left: -100, top: -50, right: 200, bottom: 100 }, 340, 180, 800, 600)).toEqual({ left: 4, top: 108 })
})

test('hides details when there is no non-overlapping space or the viewport is too small', () => {
  expect(placeElementPickerCard({ left: 0, top: 0, right: 800, bottom: 600 }, 340, 180, 800, 600)).toBeNull()
  expect(placeElementPickerCard({ left: 10, top: 10, right: 50, bottom: 50 }, 340, 180, 300, 600)).toBeNull()
})
