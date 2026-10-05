import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = new URL('.', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] }
const inclusions = pkg.files.filter((entry) => !entry.startsWith('!'))
const negations = pkg.files.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))

const toPosix = (path: string): string => path.split(sep).join('/')

const matchesNegation = (rel: string, pattern: string): boolean => {
  const regex = new RegExp(
    `^${pattern.split('/').map((part) => (part === '**' ? '.*' : part.replace(/\*/g, '[^/]*'))).join('/')}$`,
  )
  return regex.test(rel)
}

// The overlay ships as source and is compiled by the host app, so every file
// a shipped source file reaches with a relative import must be published too.
const published = (rel: string): boolean => {
  if (negations.some((pattern) => matchesNegation(rel, pattern))) return false
  return inclusions.some((entry) => rel === entry || rel.startsWith(`${entry}/`))
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.btsx', '.mts', '.cts']

function probe(base: string): string | null {
  const candidates = ['' , ...CODE_EXTENSIONS].map((ext) => `${base}${ext}`)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Host toolchains probe extensions and resolve names case-insensitively on
  // case-insensitive volumes; mirror that so this test stays about publish
  // coverage rather than local resolution quirks.
  try {
    const dir = base.slice(0, base.lastIndexOf(sep))
    const name = base.slice(base.lastIndexOf(sep) + 1).toLowerCase()
    const entries = readdirSync(dir).map((entry) => entry.toLowerCase())
    for (const candidate of candidates) {
      const wanted = candidate.slice(candidate.lastIndexOf(sep) + 1).toLowerCase()
      const hit = entries.indexOf(wanted)
      if (hit >= 0) return join(dir, readdirSync(dir)[hit]!)
    }
    void name
  } catch {
    // Parent directory does not exist.
  }
  return null
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry)
    if (statSync(absolute).isDirectory()) {
      out.push(...collectSourceFiles(absolute))
    } else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !entry.endsWith('.test.ts')) {
      out.push(absolute)
    }
  }
  return out
}

// Directories the package ships as source. `dist` is our own build output and
// `server` is compiled into it, so neither needs its imports published.
const scanRoots: string[] = []
for (const entry of inclusions) {
  const absolute = join(root, entry)
  if (entry === 'dist' || !existsSync(absolute)) continue
  if (statSync(absolute).isDirectory()) {
    scanRoots.push(absolute)
  } else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
    scanRoots.push(absolute)
  }
}

test('shipped source relative imports are published files', () => {
  expect(scanRoots.length).toBeGreaterThan(0)
  const violations: Array<{ importer: string; spec: string; reason: string }> = []
  const importers = scanRoots.flatMap((scanRoot) =>
    statSync(scanRoot).isDirectory() ? collectSourceFiles(scanRoot) : [scanRoot],
  )
  for (const importer of importers) {
    const source = readFileSync(importer, 'utf8')
    const specs = [
      ...source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g),
    ].map((match) => match[1]!)
    for (const spec of new Set(specs)) {
      const target = probe(join(importer.slice(0, importer.lastIndexOf(sep)), spec))
      if (target === null) {
        violations.push({ importer: toPosix(relative(root, importer)), spec, reason: 'unresolvable' })
        continue
      }
      const rel = toPosix(relative(root, target))
      if (!published(rel)) {
        violations.push({ importer: toPosix(relative(root, importer)), spec, reason: `not published: ${rel}` })
      }
    }
  }
  expect(violations).toEqual([])
})
