import { expect, test } from 'bun:test'
import { nestedSelector, splitSelectors } from './stylesheet-rules.ts'

test('selector lists preserve commas and nesting tokens in attributes, escapes and functional selectors', () => {
  expect(splitSelectors('.card, :is(.a, .b), [data-label="a,b"], .escaped\\,comma')).toEqual(['.card', ':is(.a, .b)', '[data-label="a,b"]', '.escaped\\,comma'])
  expect(nestedSelector('& > .title, .subtitle', '.card, .panel')).toBe(':is(.card, .panel) > .title, :is(.card, .panel) .subtitle')
  expect(nestedSelector('[data-label="&"] &', '.card')).toBe('[data-label="&"] :is(.card)')
  expect(nestedSelector('.escaped\\&name', '.card')).toBe(':is(.card) .escaped\\&name')
})
