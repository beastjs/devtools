import { afterEach, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../test/dev-server.ts'
import { DEFAULT_SETTINGS, type FileReport } from '../shared/types.ts'
import { createDevtoolsServer } from './devtools.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

async function fixture() {
  const running = createApp()
  const other = createApp()
  cleanups.push(running.cleanup, other.cleanup)
  const devtools = createDevtoolsServer({ root: running.root, editorUrl: (file) => `/editor?file=${encodeURIComponent(file)}` })
  const server = createServer((req, res) => devtools.middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { devtools.close(); server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = (path: string) => fetch(`${origin}${path}`)
  const post = (path: string, body: unknown, headers = {}) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { running, other, get, post }
}

test('opening a folder scopes reads, refactors and undo without changing the running project', async () => {
  const { running, other, get, post } = await fixture()
  writeFileSync(join(other.root, 'OutsideSrc.btsx'), 'h1 Another project\n')
  const opened = await post('/open-project', { path: other.root })
  expect(opened.status).toBe(200)
  const { id, root } = await opened.json()
  expect(root).toBe(other.root)
  expect((await (await post('/open-project', { path: other.root })).json()).id).toBe(id)
  const report = await (await get(`/project?project=${id}`)).json()
  expect(report.files.map((file: { path: string }) => file.path)).toEqual(['OutsideSrc.btsx', 'src/App.btsx'])
  expect((await (await get('/project')).json()).root).toBe(running.root)
  expect((await get('/file?path=OutsideSrc.btsx')).status).toBe(404)
  expect((await get(`/file?project=${id}&path=${encodeURIComponent(running.appPath)}`)).status).toBe(404)
  expect((await get('/project?project=missing')).status).toBe(404)

  const before = readFileSync(other.appPath, 'utf8')
  const file = await (await get(`/file?project=${id}&path=src/App.btsx&depthLimit=2`)).json() as FileReport
  const suggestion = file.analysis!.suggestions.find((item) => item.name === 'AppHeader')!
  const request = { path: file.path, hash: file.hash, suggestionId: suggestion.id, settings: { ...DEFAULT_SETTINGS, depthLimit: 2 }, target: 'inline', dryRun: false }
  const applied = await post(`/apply?project=${id}`, request)
  expect(applied.status).toBe(200)
  const { undoId } = await applied.json()
  expect(readFileSync(other.appPath, 'utf8')).not.toBe(before)
  expect(readFileSync(running.appPath, 'utf8')).toBe(before)
  expect((await post('/undo', { id: undoId })).status).toBe(409)
  expect((await post(`/undo?project=${id}`, { id: undoId })).status).toBe(200)
  expect(readFileSync(other.appPath, 'utf8')).toBe(before)
  expect((await (await post('/open-project', { path: running.root })).json()).id).toBe('')
})

test('opening folders validates paths, permits empty folders and enforces same-origin JSON', async () => {
  const { other, get, post } = await fixture()
  for (const path of ['', 'relative/path', other.appPath, join(other.root, 'missing')]) {
    expect((await post('/open-project', { path })).status).toBe(422)
  }
  expect((await post('/open-project', { path: other.root }, { Origin: 'http://other.example' })).status).toBe(403)
  expect((await post('/open-project', { path: other.root }, { 'Content-Type': 'text/plain' })).status).toBe(403)
  const empty = join(other.root, 'empty')
  mkdirSync(empty)
  const { id } = await (await post('/open-project', { path: empty })).json()
  expect((await (await get(`/project?project=${id}`)).json()).files).toEqual([])
})

test('opened folder saves emit source-change events', async () => {
  const { other, get, post } = await fixture()
  await post('/open-project', { path: other.root })
  const events = await get('/events')
  const reader = events.body!.getReader()
  await reader.read() // Initial retry frame.
  writeFileSync(other.appPath, readFileSync(other.appPath, 'utf8') + '\n// saved\n')
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('No source-change event')), 3000) }),
    ])
    expect(new TextDecoder().decode(chunk.value)).toContain('"path":"src/App.btsx"')
  } finally {
    clearTimeout(timeout)
    await reader.cancel()
  }
})


test('manual selections can be renamed, previewed, applied and undone in the selected project', async () => {
  const { running, other, get, post } = await fixture()
  const originalRunning = readFileSync(running.appPath, 'utf8')
  const source = 'props { title }: { title: string }\nmain\n  section#summary\n    h2 #{title}\n    p Details\n  footer Done\n'
  writeFileSync(other.appPath, source)
  const { id } = await (await post('/open-project', { path: other.root })).json()
  const settings = { ...DEFAULT_SETTINGS, depthLimit: 20, minLines: 200 }
  const selected = await (await get(`/file?project=${id}&path=src/App.btsx&line=3&depthLimit=20&minLines=200`)).json() as FileReport
  const suggestion = selected.analysis!.suggestions[0]!
  expect(suggestion.id).toBe('manual:3')
  expect(suggestion.endLine).toBe(5)
  const request = { path: selected.path, hash: selected.hash, suggestionId: suggestion.id, settings, name: 'CustomSummary', target: 'file', dryRun: true }
  const preview = await post(`/apply?project=${id}`, request)
  expect(preview.status).toBe(200)
  expect((await preview.json()).component).toBe('CustomSummary')
  expect(readFileSync(other.appPath, 'utf8')).toBe(source)
  const applied = await post(`/apply?project=${id}`, { ...request, dryRun: false })
  expect(applied.status).toBe(200)
  const { undoId } = await applied.json()
  expect(readFileSync(other.appPath, 'utf8')).toContain('CustomSummary(title={title})')
  expect(readFileSync(running.appPath, 'utf8')).toBe(originalRunning)
  expect((await post(`/undo?project=${id}`, { id: undoId })).status).toBe(200)
  expect(readFileSync(other.appPath, 'utf8')).toBe(source)
  expect((await get(`/file?project=${id}&path=src/App.btsx&line=-1`)).status).toBe(422)
  expect((await post(`/apply?project=${id}`, { ...request, suggestionId: 'manual:1' })).status).toBe(409)
  writeFileSync(other.appPath, source + '\n// changed\n')
  expect((await post(`/apply?project=${id}`, request)).status).toBe(409)
})

test('continuation endpoint previews, writes, rejects stale selections and supports undo', async () => {
  const { running, other, get, post } = await fixture()
  const source = 'button(type="button" disabled) Hello\n'
  writeFileSync(other.appPath, source)
  const { id } = await (await post('/open-project', { path: other.root })).json()
  const file = await (await get(`/file?project=${id}&path=src/App.btsx`)).json() as FileReport
  expect(file.continuationLines).toEqual([1])
  const request = { path: file.path, hash: file.hash, line: 1, dryRun: true }
  const preview = await post(`/continue-props?project=${id}`, request)
  expect(preview.status).toBe(200)
  expect((await preview.json()).undoId).toBeNull()
  expect(readFileSync(other.appPath, 'utf8')).toBe(source)
  expect((await post(`/continue-props?project=${id}`, { ...request, line: 0 })).status).toBe(422)
  expect((await post(`/continue-props?project=${id}`, { ...request, path: '../Outside.btsx' })).status).toBe(422)
  const originalRunning = readFileSync(running.appPath, 'utf8')
  const applied = await post(`/continue-props?project=${id}`, { ...request, dryRun: false })
  expect(applied.status).toBe(200)
  const { undoId } = await applied.json()
  expect(readFileSync(other.appPath, 'utf8')).toBe('button(\n  ~ type="button"\n  ~ disabled\n  ~ ) Hello\n')
  expect(readFileSync(running.appPath, 'utf8')).toBe(originalRunning)
  expect((await post(`/continue-props?project=${id}`, { ...request, dryRun: false })).status).toBe(409)
  expect((await post(`/undo?project=${id}`, { id: undoId })).status).toBe(200)
  expect(readFileSync(other.appPath, 'utf8')).toBe(source)
})

test('refactor continuation suggestions honor settings and support preview, apply and undo', async () => {
  const { running, get, post } = await fixture()
  const source = 'button(type="button" disabled title="Save" aria-label="Save" tabIndex={0}) Save\n'
  writeFileSync(running.appPath, source)
  const file = await (await get('/file?path=src/App.btsx')).json() as FileReport
  const suggestion = file.analysis!.suggestions.find((item) => item.kind === 'continuation')!
  expect(suggestion.id).toBe('continuation:1')
  const above = await (await get('/file?path=src/App.btsx&continuationMinProps=6')).json() as FileReport
  expect(above.analysis!.suggestions.some((item) => item.kind === 'continuation')).toBe(false)
  const project = await (await get('/project')).json()
  expect(project.files[0].suggestions).toBe(file.analysis!.suggestions.length)
  const request = { path: file.path, hash: file.hash, suggestionId: suggestion.id, settings: DEFAULT_SETTINGS, target: 'inline', dryRun: true }
  const preview = await post('/apply', request)
  expect(preview.status).toBe(200)
  const plan = await preview.json()
  expect(plan.undoId).toBeNull()
  expect(plan.files[0].added).toBeGreaterThan(1)
  expect(readFileSync(running.appPath, 'utf8')).toBe(source)
  const applied = await post('/apply', { ...request, dryRun: false })
  expect(applied.status).toBe(200)
  const { undoId } = await applied.json()
  const after = await (await get('/file?path=src/App.btsx')).json() as FileReport
  expect(after.analysis!.suggestions.some((item) => item.kind === 'continuation')).toBe(false)
  expect((await post('/undo', { id: undoId })).status).toBe(200)
  expect(readFileSync(running.appPath, 'utf8')).toBe(source)
})

test('element edits persist through the JSON endpoint with conflict checks and undo', async () => {
  const { running, get, post } = await fixture()
  writeFileSync(running.appPath, 'div Hello\n')
  const file = await (await get('/file?path=src/App.btsx')).json() as FileReport
  const request = { path: file.path, hash: file.hash, line: 1, column: 1, tag: 'div', group: 'attributes', name: 'title', value: 'Saved' }
  expect((await post('/element-edit', request, { Origin: 'http://other.example' })).status).toBe(403)
  expect((await post('/element-edit', { ...request, group: 'unknown' })).status).toBe(422)
  expect((await post('/element-edit', { ...request, declarations: { width: {} } })).status).toBe(422)
  const result = await post('/element-edit', request)
  expect(result.status).toBe(200)
  const { hash, undoId } = await result.json()
  expect(hash).not.toBe(file.hash)
  expect(readFileSync(running.appPath, 'utf8')).toContain('title={"Saved"}')
  expect((await post('/element-edit', request)).status).toBe(409)
  expect((await post('/undo', { id: undoId })).status).toBe(200)
  expect(readFileSync(running.appPath, 'utf8')).toBe('div Hello\n')
})
