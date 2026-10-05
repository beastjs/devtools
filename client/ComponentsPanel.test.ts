import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const PANEL_PATH = resolve(import.meta.dir, 'ComponentsPanel.btsx')

test('ComponentsPanel relative file imports resolve to real files', () => {
  const source = readFileSync(PANEL_PATH, 'utf8')
  const specifiers = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1])
  const fileImports = specifiers.filter((spec) => /\.(ts|btsx)$/.test(spec))
  expect(fileImports.length).toBeGreaterThan(0)
  const missing = fileImports.filter((spec) => !existsSync(resolve(dirname(PANEL_PATH), spec)))
  expect(missing).toEqual([])
})
