import { expect, test } from 'bun:test'
import type { ComponentLocation } from '../shared/types.ts'
import { componentSourceSelection } from './source-navigation.ts'

const app: ComponentLocation = {
  name: 'App', path: 'src/App.btsx', absolutePath: '/app/src/App.btsx', line: 50, column: 1, local: false, hooks: [],
  blocks: [{ host: 'App', scope: 'App', kind: 'component', startLine: 1, endLine: 100, indent: '' }],
}
const card: ComponentLocation = {
  ...app, name: 'Card', line: 10, local: true,
  blocks: [{ host: 'Card', scope: 'Card', kind: 'component', startLine: 10, endLine: 30, indent: '' }],
}

test('opens the local component containing the refactor rather than the overlapping file component', () => {
  expect(componentSourceSelection([app, card], { path: app.path, line: 20, nonce: 1 })).toEqual({ path: app.path, host: 'Card', line: 10, kind: 'component' })
  expect(componentSourceSelection([app, card], { path: app.path, line: 75, nonce: 2 })).toEqual({ path: app.path, host: 'App', line: 1, kind: 'component' })
})

test('uses the selected suggestion host and file when names and source ranges overlap', () => {
  const other = { ...card, path: 'src/Other.btsx' }
  expect(componentSourceSelection([other, app, card], { path: app.path, host: 'App', line: 20, nonce: 1 })).toEqual({ path: app.path, host: 'App', line: 1, kind: 'component' })
  expect(componentSourceSelection([other, app, card], { path: app.path, host: 'Card', line: 20, nonce: 2 })).toEqual({ path: app.path, host: 'Card', line: 10, kind: 'component' })
})

test('falls back to declaration locations when block metadata is unavailable', () => {
  expect(componentSourceSelection([{ ...card, blocks: undefined }], { path: card.path, host: 'Card', line: 20, nonce: 1 })?.line).toBe(10)
  expect(componentSourceSelection([{ ...app, blocks: undefined }], { path: app.path, line: 75, nonce: 2 })?.line).toBe(1)
})

test('waits for the requested file and host instead of selecting an unrelated component', () => {
  expect(componentSourceSelection([app], { path: 'src/Other.btsx', line: 20, nonce: 1 })).toBeNull()
  expect(componentSourceSelection([app], { path: app.path, host: 'Card', line: 20, nonce: 2 })).toBeNull()
})
