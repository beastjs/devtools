import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = new URL('.', import.meta.url).pathname
const css = readFileSync(resolve(root, 'client/devtools.css'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files: string[] }

// Every font referenced by the overlay stylesheet must resolve to a file the
// bundler can emit in a production build.
test('overlay fonts resolve to published files', () => {
  const refs = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((match) => match[1]!)
  const fonts = refs.filter((ref) => /\.(woff2?|woff|ttf|otf)$/u.test(ref))
  expect(fonts.length).toBeGreaterThan(0)
  for (const ref of fonts) {
    const absolute = resolve(root, 'client', ref)
    expect(existsSync(absolute)).toBe(true)
    const posix = absolute.slice(root.length)
    const covered = pkg.files.some((entry) => !entry.startsWith('!') && (posix === entry || posix.startsWith(`${entry}/`)))
    expect({ ref, posix, covered }).toEqual({ ref, posix, covered: true })
  }
})

// A stray `!` (a half-typed `!important`) passes dev servers unminified but
// fails production minifiers, breaking the whole stylesheet including fonts.
test('overlay stylesheet has no stray important markers', () => {
  const strays = [...css.matchAll(/!(?!\s*important\b)/g)].map((match) => {
    const start = Math.max(0, (match.index ?? 0) - 40)
    return css.slice(start, (match.index ?? 0) + 10).replace(/\n/g, ' ')
  })
  expect(strays).toEqual([])
})
