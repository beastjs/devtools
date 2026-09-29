import { expect, test } from 'bun:test'
import { snapshotKey, type ElementSnapshot } from './element-inspector.ts'

const snapshot = (extra: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  label: 'div#card',
  component: 'Card',
  source: 'src/Card.btsx:10:3',
  connected: true,
  width: 200,
  height: 100,
  attributes: [{ name: 'id', value: 'card', editable: true }],
  styles: [{ name: 'display', value: 'block', editable: true, inline: false }],
  properties: [{ name: 'id', value: 'card', editable: true, type: 'string' }],
  ...extra,
})

test('null snapshots share one key', () => {
  expect(snapshotKey(null)).toBe(snapshotKey(null))
})

test('structurally identical snapshots share a key, so idle ticks skip setState', () => {
  expect(snapshotKey(snapshot())).toBe(snapshotKey(snapshot()))
})

test('any visible change produces a new key', () => {
  const before = snapshotKey(snapshot())
  expect(snapshotKey(snapshot({ width: 201 }))).not.toBe(before)
  expect(snapshotKey(snapshot({ connected: false }))).not.toBe(before)
  expect(snapshotKey(snapshot({ attributes: [] }))).not.toBe(before)
  expect(snapshotKey(snapshot({ styles: [] }))).not.toBe(before)
  expect(snapshotKey(snapshot({ properties: [] }))).not.toBe(before)
  expect(snapshotKey(null)).not.toBe(before)
})
