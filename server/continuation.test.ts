import { expect, test } from 'bun:test'
import { compileBeastResult, parse } from 'beast-tsrx'
import { continuationEdits, continueProps } from './continuation.ts'

function convert(source: string, line: number) {
  const after = continueProps(parse(source, 'App.btsx'), source, line)
  expect(compileBeastResult(after, { filename: 'App.btsx' }).code)
    .toBe(compileBeastResult(source, { filename: 'App.btsx' }).code)
  return after
}

test('continues each prop and preserves inline text, children and expressions', () => {
  const source = 'section\n  button.action(type="button" disabled onClick={() => console.log("a ) b", { x: 1 })}) Hello #{name}\n    span Child\n'
  expect(convert(source, 2)).toBe('section\n  button.action(\n    ~ type="button"\n    ~ disabled\n    ~ onClick={() => console.log("a ) b", { x: 1 })}\n    ~ ) Hello #{name}\n    span Child\n')
})

test('supports component calls, spreads and quoted spaces', () => {
  const source = 'Card(title="hello world" {...props} value={{ text: `x ${fn(1)}` }})\n'
  expect(convert(source, 1)).toContain('  ~ {...props}\n')
})

test('finds elements inside local components and control flow', () => {
  const source = 'component Card\n  if visible\n    div(title="local")\n\nCard(value={1})\n'
  expect([...continuationEdits(parse(source, 'App.btsx'), source).keys()].sort()).toEqual([3, 5])
  convert(source, 3)
})

test('refuses lines without inline props and already continued headers', () => {
  for (const source of ['div\n', 'div()\n', 'div(\n  ~ title="hi"\n  ~ )\n', 'div(title="hi")\n  ~ .active\n']) {
    const doc = parse(source, 'App.btsx')
    expect(continuationEdits(doc, source).size).toBe(0)
    expect(() => continueProps(doc, source, 1)).toThrow('Select a component or element')
  }
})

test('preserves CRLF and non-ASCII text', () => {
  const source = 'section\r\n  p(title="👋 hello") Héllo\r\n'
  const after = convert(source, 2)
  expect(after).toContain('  p(\r\n    ~ title="👋 hello"\r\n    ~ ) Héllo\r\n')
})

import { analyzeDocument } from './analyze.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

test('automatically suggests at five props and respects the adjustable threshold', () => {
  const source = 'div(a={1} b={2} c={3} d={4})\nCard(a={1} b={2} c={3} d={4} e={5})\n'
  const doc = parse(source, 'App.btsx')
  const suggestions = (minimum = DEFAULT_SETTINGS.continuationMinProps) =>
    analyzeDocument(doc, source, 'App', { ...DEFAULT_SETTINGS, continuationMinProps: minimum }).suggestions
      .filter((suggestion) => suggestion.kind === 'continuation')
  expect(DEFAULT_SETTINGS.continuationMinProps).toBe(5)
  expect(suggestions().map((suggestion) => suggestion.startLine)).toEqual([2])
  expect(suggestions(4).map((suggestion) => suggestion.startLine)).toEqual([1, 2])
  expect(suggestions(6)).toEqual([])
  const continued = continueProps(doc, source, 2)
  expect(analyzeDocument(parse(continued, 'App.btsx'), continued, 'App', DEFAULT_SETTINGS).suggestions
    .filter((suggestion) => suggestion.kind === 'continuation')).toEqual([])
  expect(analyzeDocument(doc, source, 'App', DEFAULT_SETTINGS, { selectionLine: 1 }).suggestions
    .every((suggestion) => suggestion.id === 'manual:1')).toBe(true)
})
