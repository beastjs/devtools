import { expect, test } from 'bun:test'
import { codeFolds, hiddenCodeLines } from './code-folds.ts'
import { compileBeastResult } from 'beast-tsrx'

test('folds generated TSRX tags and control flow including closing lines', () => {
  const { code } = compileBeastResult('props { items }: { items: string[] }\nmain\n  each item in items key item\n    if item\n      p #{item}\n    else\n      span Empty\n  footer End', { filename: 'Demo.btsx', componentName: 'Demo' })
  const folds = codeFolds(code, 'tsrx')
  expect(folds.get(1)).toBe(12)
  expect(folds.get(2)).toBe(11)
  expect(folds.get(3)).toBe(9)
  expect(folds.get(4)).toBe(5)
  expect(folds.get(6)).toBe(8)
  const hidden = hiddenCodeLines(folds, new Set([3]))
  expect(hidden.has(9)).toBe(true)
  expect(hidden.has(10)).toBe(false)
  expect(folds.has(9)).toBe(false)
})

test('TSRX folding also handles space indentation and self-closing siblings', () => {
  const folds = codeFolds('<main>\n  <section>\n    <img />\n  </section>\n  <footer />\n</main>', 'tsrx')
  expect([...folds]).toEqual([[2, 4], [1, 6]])
})

test('folds nested blocks with continuation headers and preserves sibling lines', () => {
  const source = 'main\n  section(\n    ~ aria-label="Cards"\n    ~ )\n    h2 Title\n    div\n      p Body\n\n  footer End\n'
  const folds = codeFolds(source)
  expect([...folds]).toEqual([[6, 7], [2, 7], [1, 9]])
  expect([...hiddenCodeLines(folds, new Set([2]))]).toEqual([3, 4, 5, 6, 7])
  expect(hiddenCodeLines(folds, new Set([6])).has(9)).toBe(false)
})

test('expanding a parent preserves independently collapsed nested blocks', () => {
  const folds = codeFolds('main\n  div\n    p Body\n  footer End')
  const collapsed = new Set([1, 2])
  expect([...hiddenCodeLines(folds, collapsed)].sort()).toEqual([2, 3, 4])
  collapsed.delete(1)
  expect([...hiddenCodeLines(folds, collapsed)]).toEqual([3])
  collapsed.delete(2)
  expect(hiddenCodeLines(folds, collapsed).size).toBe(0)
})
