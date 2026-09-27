import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configEntries, entryComponents, htmlEntries } from './entry.ts'

const root = mkdtempSync(join(tmpdir(), 'beast-devtools-entry-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('entryComponents reads the .btsx components an entry imports', () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src/main.ts'),
    `import { createRoot } from 'octane'
import App, { type AppProps } from './App.btsx'
import Providers from '@/app-providers.btsx'
import './styles.css'
createRoot(document.body).render(Providers, { children: App })
`,
  )
  // Bundler entries may omit the extension.
  expect(entryComponents([join(root, 'src/main')])).toEqual(['App', 'AppProviders'])
  expect(entryComponents([join(root, 'src/missing.ts')])).toEqual([])
})

test('htmlEntries lists local module scripts of index.html', () => {
  writeFileSync(
    join(root, 'index.html'),
    `<script type="module" src="/src/main.ts?v=1"></script>
<script src="/legacy.js"></script>
<script src="https://cdn.example.com/x.js" type="module"></script>`,
  )
  expect(htmlEntries(root)).toEqual([join(root, 'src/main.ts')])
  expect(htmlEntries(join(root, 'nowhere'))).toEqual([])
})

test('configEntries accepts every entry shape and skips packages', () => {
  const entry = {
    index: './src/main.ts',
    admin: ['./src/admin.ts', 'some-polyfill'],
    worker: { import: './src/worker.ts' },
    normalized: { import: ['./src/normalized.ts'] },
  }
  expect(configEntries(entry, root)).toEqual(
    ['src/main.ts', 'src/admin.ts', 'src/worker.ts', 'src/normalized.ts'].map((path) => join(root, path)),
  )
  expect(configEntries(() => ({}), root)).toEqual([])
})
