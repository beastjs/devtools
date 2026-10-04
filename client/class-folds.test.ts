import { expect, test } from 'bun:test'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { classDisplayTokens, classRanges, toggleClassOverrides } from './class-folds.ts'
import { collapseClasses, editorClassFolding, expandClass, toggleClassAttribute } from './editor-class-folds.ts'
import { highlight } from './highlight.ts'

function foldedTexts(state: EditorState): string[] {
  const texts: string[] = []
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue
    set.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.widget) texts.push(state.sliceDoc(from, to))
    })
  }
  return texts
}

test('finds literal classes in inline attributes, continuation props and conditional expressions', () => {
  const source = `div(class="grid gap-4" title="className='not classes'")
  button(
    ~ className = {active ? 'bg-red-500 p-4' : "bg-blue-500 p-2"}
    ~ title="Keep this text"
    ~ ) Save`
  expect(classRanges(source, 'btsx').map((range) => range.text)).toEqual(['grid gap-4', 'bg-red-500 p-4', 'bg-blue-500 p-2'])
})

test('leaves comments, setup variables, CSS and interpolated template strings alone', () => {
  const source = '// div(class="hidden")\nsetup\n  const className = "p-4";\nstyle\n  .className { color: red; }\ndiv(className={`bg-${tone} p-4`})\n  p Text'
  expect(classRanges(source, 'btsx')).toEqual([])
})

test('escaped quotes and arbitrary Tailwind values keep their exact contents', () => {
  const source = 'div(className="before:content-[\\\"hello_world\\\"] w-[calc(100%_-_2rem)] bg-[#123456]")'
  const [range] = classRanges(source, 'btsx')
  expect(range!.text).toBe('before:content-[\\"hello_world\\"] w-[calc(100%_-_2rem)] bg-[#123456]')
  const display = classDisplayTokens(highlight(source, 'btsx')[0]!, 0, [range!])
  expect(display.map((token) => token.value).join('')).toBe('div(className="…")')
  expect(display.find((token) => token.classFold)?.classFold?.text).toBe(range!.text)
})

test('generated JSX classes fold while TypeScript assignments do not', () => {
  const source = 'const className = "keep this";\n<main\n  className={cx("flex p-4", active && \'bg-red-500\')}\n  title="Keep"\n/> '
  expect(classRanges(source, 'tsrx').map((range) => range.text)).toEqual(['flex p-4', 'bg-red-500'])
})

test('multiline class folding keeps reader line numbers and leaves editable source intact', () => {
  const source = 'div(className={`grid\n  gap-4 p-4`})\np Text'
  const ranges = classRanges(source, 'btsx')
  let from = 0
  const lines = highlight(source, 'btsx').map((tokens) => {
    const display = classDisplayTokens(tokens, from, ranges).map((token) => token.value).join('')
    from += tokens.reduce((total, token) => total + token.value.length, 1)
    return display
  })
  expect(lines).toEqual(['div(className={`…', '`})', 'p Text'])
  let state = EditorState.create({ doc: source, extensions: editorClassFolding('btsx') })
  const count = () => foldedTexts(state).length
  expect(count()).toBe(0)
  state = state.update({ effects: collapseClasses.of(true) }).state
  expect(count()).toBe(1)
  expect(state.doc.toString()).toBe(source)
  state = state.update({ effects: collapseClasses.of(false) }).state
  expect(count()).toBe(0)
  expect(state.doc.toString()).toBe(source)
})

test('placing a cursor inside folded classes reveals them for editing', () => {
  const source = 'div(class="grid gap-4")'
  let state = EditorState.create({ doc: source, extensions: editorClassFolding('btsx', true) })
  state = state.update({ selection: EditorSelection.cursor(source.indexOf('gap')) }).state
  expect(foldedTexts(state)).toEqual([])
  expect(state.doc.toString()).toBe(source)
})

test('reader keywords remain toggleable after expanding an ellipsis, including conditional branches', () => {
  const source = 'div(className={active ? "p-4" : "p-2"} title="className")\nspan(class="flex gap-2")'
  const ranges = classRanges(source, 'btsx')
  const keyword = source.indexOf('className')
  let overrides = new Map([[ranges[0]!.from, false], [ranges[1]!.from, false]])
  overrides = toggleClassOverrides(ranges, true, overrides, keyword)
  expect(ranges.filter((range) => overrides.get(range.from) ?? true).map((range) => range.text)).toEqual(['p-4', 'p-2', 'flex gap-2'])
  overrides = toggleClassOverrides(ranges, true, overrides, keyword)
  const folded = ranges.filter((range) => overrides.get(range.from) ?? true)
  expect(folded.map((range) => range.text)).toEqual(['flex gap-2'])
  const tokens = classDisplayTokens(highlight(source, 'btsx')[0]!, 0, folded, ranges)
  expect(tokens.filter((token) => token.classKeyword !== undefined).map((token) => [token.value, token.classKeyword])).toEqual([['className', keyword]])
  expect(tokens.map((token) => token.value).join('')).toBe(source.split('\n')[0]!)
})

test('editable keyword toggles collapse and re-expand one list after an ellipsis expansion', () => {
  const source = 'div(className="grid gap-4")\nspan(class="text-sm")'
  const ranges = classRanges(source, 'btsx')
  let state = EditorState.create({ doc: source, extensions: editorClassFolding('btsx', true) })
  state = state.update({ effects: expandClass.of(ranges[0]!.from) }).state
  expect(foldedTexts(state)).toEqual(['text-sm'])
  state = state.update({ effects: toggleClassAttribute.of(ranges[0]!.keywordFrom) }).state
  expect(foldedTexts(state)).toEqual(['grid gap-4', 'text-sm'])
  state = state.update({ effects: toggleClassAttribute.of(ranges[0]!.keywordFrom) }).state
  expect(foldedTexts(state)).toEqual(['text-sm'])
  expect(state.doc.toString()).toBe(source)
})

test('individual toggles work with global expansion, track edits, and reset with the toolbar', () => {
  const source = '<div\n className={active ? "p-4" : "p-2"}\n><span class="text-sm" /></div>'
  let state = EditorState.create({ doc: source, extensions: editorClassFolding('tsrx') })
  const first = source.indexOf('className')
  state = state.update({ effects: toggleClassAttribute.of(first) }).state
  expect(foldedTexts(state)).toEqual(['p-4', 'p-2'])
  state = state.update({ changes: { from: 0, insert: '\n' } }).state
  expect(foldedTexts(state)).toEqual(['p-4', 'p-2'])
  state = state.update({ effects: toggleClassAttribute.of(first + 1) }).state
  expect(foldedTexts(state)).toEqual([])
  state = state.update({ effects: collapseClasses.of(true) }).state
  expect(foldedTexts(state)).toEqual(['p-4', 'p-2', 'text-sm'])
  state = state.update({ effects: collapseClasses.of(false) }).state
  expect(foldedTexts(state)).toEqual([])
  expect(state.doc.toString()).toBe('\n' + source)
})
