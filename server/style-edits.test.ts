import { expect, test } from 'bun:test'
import { replaceTailwindClasses } from './style-edits.ts'

test('arbitrary Tailwind values preserve literal backslashes and underscores', () => {
  expect(replaceTailwindClasses([], { 'background-image': String.raw`url(foo\bar_baz.png)` }))
    .toEqual([String.raw`[background-image:url(foo\\bar\_baz.png)]`])
})
