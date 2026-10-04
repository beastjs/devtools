import { expect, test } from 'bun:test'
import { compileBeastResult } from 'beast-tsrx'
import { analyzeDocument } from '../server/analyze.ts'
import { DEFAULT_SETTINGS, type FileReport } from '../shared/types.ts'
import { mappingTitle, miniSuggestions, nameIssue, templateLine } from './refactor-actions.ts'

test('compact refactors use manual extraction and only offer a map when siblings can be mapped', () => {
  const source = 'main\n  section\n    button Save\n    button Cancel\n  footer Done'
  const document = compileBeastResult(source, { filename: 'App.btsx' }).ast
  const suggestions = analyzeDocument(document, source, 'App', DEFAULT_SETTINGS, { selectionLine: 2 }).suggestions
  const { extract, mapping } = miniSuggestions(suggestions, 2)
  expect(extract?.id).toBe('manual:2')
  expect(mapping?.id).toBe('manual:2:map:3:4')
  expect(nameIssue(extract!, 'Toolbar')).toBeNull()
  expect(nameIssue(mapping!, mappingTitle('Toolbar'))).toBeNull()
  expect(miniSuggestions(suggestions, 3).extract).toBeNull()
  expect(miniSuggestions([extract!], 2).mapping).toBeNull()
})

test('one title produces valid component and mapped names without allowing invalid identifiers', () => {
  expect(mappingTitle('UserCards')).toBe('userCards')
  expect(mappingTitle('URLCards')).toBe('urlCards')
  expect(mappingTitle('  items ')).toBe('items')
  expect(mappingTitle('Invalid title')).toBe('invalid title')
})

test('old source metadata resolves the owning template and skips existing component calls', () => {
  const source = 'component Header\n  header Top\n\nHeader\nmain\n  p Body\n'
  const document = compileBeastResult(source, { filename: 'App.btsx' }).ast
  const analysis = analyzeDocument(document, source, 'App', DEFAULT_SETTINGS)
  const file = { source, analysis } as FileReport
  expect(templateLine(file, { host: 'App', scope: 'App', kind: 'component', startLine: 1, endLine: 7, indent: '' })).toBe(5)
  expect(templateLine(file, { host: 'Header', scope: 'Header', kind: 'component', startLine: 1, endLine: 2, indent: '' })).toBe(2)
})
