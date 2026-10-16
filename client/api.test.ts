import { expect, spyOn, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import { applyRefactor, fetchFile, fetchProject, fetchSelection, fetchSourceBlock, saveBlockEdit, undoRefactor } from './api.ts'

test('component source reads, saves, refactors and undo keep the selected project even for identical file paths', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  try {
    const selection = { path: 'src/App.btsx', host: 'Card', line: 1, kind: 'component' }
    const project = 'other-project'
    await fetchProject(DEFAULT_SETTINGS, project)
    await fetchFile(selection.path, DEFAULT_SETTINGS, project)
    await fetchSourceBlock(selection, project)
    await fetchSelection(selection.path, selection.line, DEFAULT_SETTINGS, project)
    await saveBlockEdit({ ...selection, hash: 'original', code: 'component Card\n  p Changed' }, project)
    await applyRefactor({ path: selection.path, hash: 'original', settings: DEFAULT_SETTINGS, suggestionId: 'extract', target: 'inline', dryRun: false }, project)
    await undoRefactor('saved-edit', project)
    expect(fetch.mock.calls).toHaveLength(7)
    for (const [input] of fetch.mock.calls) expect(new URL(String(input), 'http://localhost').searchParams.get('project')).toBe(project)
    await fetchSourceBlock(selection)
    await saveBlockEdit({ ...selection, hash: 'original', code: 'component Card\n  p Running' })
    for (const [input] of fetch.mock.calls.slice(7)) expect(new URL(String(input), 'http://localhost').searchParams.get('project')).toBe('')
  } finally { fetch.mockRestore() }
})
