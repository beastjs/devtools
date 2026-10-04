import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { codeFolding, foldEffect, foldable, foldedRanges } from '@codemirror/language'
import { codeEditorLanguage, EditorDocumentSync } from './code-editor.ts'

test('delayed draft updates never roll back newer keystrokes or toggle changes', () => {
  const sync = new EditorDocumentSync('p ')
  sync.edited('p h')
  sync.edited('p hi')
  // An unrelated prop update and the older draft echo arrive before the latest echo.
  expect(sync.receive('p ')).toBe(false)
  expect(sync.receive('p h')).toBe(false)
  expect(sync.receive('p hi')).toBe(false)
  // Normalization and reloads still replace the document, exactly once.
  expect(sync.receive('  p hi')).toBe(true)
  expect(sync.receive('  p hi')).toBe(false)
  expect(sync.receive('p Reloaded')).toBe(true)
})

test('editable code shares BTSX token colors and recomputes them after edits', () => {
  let state = EditorState.create({ doc: 'setup\n  const count = 2;\ndiv #{count}', extensions: codeEditorLanguage('btsx') })
  const tokens = () => {
    const spans: Array<[string, string]> = []
    for (const decorations of state.facet(EditorView.decorations)) {
      if (typeof decorations === 'function') continue
      ;(decorations as DecorationSet).between(0, state.doc.length, (from, to, value) => { spans.push([state.sliceDoc(from, to), value.spec.class]) })
    }
    return spans
  }
  expect(tokens()).toContainEqual(['const', 'tk-keyword'])
  expect(tokens()).toContainEqual(['2', 'tk-number'])
  expect(tokens()).toContainEqual(['div', 'tk-tag'])
  const position = state.doc.toString().indexOf('2')
  state = state.update({ changes: { from: position, to: position + 1, insert: '"hello"' } }).state
  expect(tokens()).toContainEqual(['"hello"', 'tk-string'])
  expect(tokens()).not.toContainEqual(['2', 'tk-number'])
})

test('folding hides complete nested blocks without changing saved source and tracks edits', () => {
  const source = 'div\n  each item in items key item.id\n    span #{item.label}\np Next'
  let state = EditorState.create({ doc: source, extensions: [codeEditorLanguage('btsx'), codeFolding()] })
  const first = state.doc.line(1)
  const range = foldable(state, first.from, first.to)!
  expect(range).toEqual({ from: first.to, to: state.doc.line(3).to })
  state = state.update({ effects: foldEffect.of(range) }).state
  expect(state.doc.toString()).toBe(source)
  expect(foldedRanges(state).size).toBe(1)
  state = state.update({ changes: { from: state.doc.line(3).to, insert: '\n    small Extra' } }).state
  expect(foldable(state, 0, state.doc.line(1).to)?.to).toBe(state.doc.line(4).to)
  expect(state.doc.toString()).toContain('span #{item.label}\n    small Extra\np Next')
})

test('TSRX folding and CRLF source use document positions rather than rendered rows', () => {
  const state = EditorState.create({ doc: '<main>\r\n  <p>Hello</p>\r\n</main>', extensions: codeEditorLanguage('tsrx') })
  expect(foldable(state, 0, state.doc.line(1).to)).toEqual({ from: state.doc.line(1).to, to: state.doc.line(3).to })
})
