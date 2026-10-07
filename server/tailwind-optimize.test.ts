import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { compileBeastResult, parse } from 'beast-tsrx'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import { createApp } from '../test/dev-server.ts'
import { BeastProject } from './project.ts'
import { optimizeClassNames, optimizeTailwind } from './tailwind-optimize.ts'

test('converts pixel spacing exactly and collapses equal sides and axes', () => {
  expect(optimizeClassNames('pr-[12px] pl-[12px] pt-[8px] pb-[8px] w-[100px] h-[14px] gap-[6px]')).toBe('px-3 py-2 w-25 h-3.5 gap-1.5')
  expect(optimizeClassNames('pl-[12px] pb-3 pr-3 pt-[12px]')).toBe('p-3')
  expect(optimizeClassNames('mt-[4px] mb-[4px] ml-[8px] mr-[8px] gap-x-[12px] gap-y-3')).toBe('my-1 mx-2 gap-3')
  expect(optimizeClassNames('p-[1px] w-[13px] min-w-[0px] max-h-[400px]')).toBe('p-0.25 w-3.25 min-w-0 max-h-100')
})

test('preserves variant selectors, importance and negative signs', () => {
  expect(optimizeClassNames('z-[0] z-[999] md:z-[50]! !z-[-10] -z-[20] -z-[-30]')).toBe('z-0 z-999 md:z-50! !-z-10 -z-20 z-30')
  expect(optimizeClassNames('z-[var(--layer)] z-[calc(10+1)] z-[1.5]')).toBe('z-[var(--layer)] z-[calc(10+1)] z-[1.5]')
  expect(optimizeClassNames('md:!pr-[12px] md:!pl-[12px] hover:pt-[8px]! hover:pb-[8px]!')).toBe('md:!px-3 hover:py-2!')
  expect(optimizeClassNames('[&:nth-child(2)]:mr-[-12px] [&:nth-child(2)]:ml-[-12px] -mt-[8px]')).toBe('[&:nth-child(2)]:-mx-3 -mt-2')
  expect(optimizeClassNames('md:pl-[12px] lg:pr-[12px] !pt-[8px] pb-[8px]')).toBe('md:pl-3 lg:pr-3 !pt-2 pb-2')
})

test('keeps overlapping utilities, non-spacing lengths and unknown values intact', () => {
  expect(optimizeClassNames('w-[-12px] p-[-4px]')).toBe('w-[-12px] p-[-4px]')
  expect(optimizeClassNames('pl-[12px] pr-[12px] pl-4')).toBe('pl-3 pr-3 pl-4')
  expect(optimizeClassNames('pl-3 pr-3 p-1')).toBe('pl-3 pr-3 p-1')
  expect(optimizeClassNames('-ml-3 -mr-3 m-1')).toBe('-ml-3 -mr-3 m-1')
  expect(optimizeClassNames('text-[12px] rounded-[12px] border-[4px] outline-[2px] shadow-[0_4px_12px_black] p-[calc(12px+4px)] w-[50%] custom-[12px]')).toBe('text-[12px] rounded-xl border-4 outline-2 shadow-[0_4px_12px_black] p-[calc(12px+4px)] w-[50%] custom-[12px]')
})

test('normalizes corner radii and combines equal corners without losing overrides', () => {
  expect(optimizeClassNames('rounded-tl-[2px] rounded-tr-[4px] rounded-bl-[6px] rounded-br-[8px]')).toBe('rounded-tl-xs rounded-tr-sm rounded-bl-md rounded-br-lg')
  expect(optimizeClassNames('rounded-tl-[12px] rounded-tr-[12px] rounded-bl-[16px] rounded-br-[16px]')).toBe('rounded-t-xl rounded-b-2xl')
  expect(optimizeClassNames('rounded-tl-[8px] rounded-bl-[8px]')).toBe('rounded-l-lg')
  expect(optimizeClassNames('rounded-tr-xl rounded-br-xl')).toBe('rounded-r-xl')
  const all = 'md:rounded-tl-[12px]! md:rounded-tr-[12px]! md:rounded-bl-[12px]! md:rounded-br-[12px]!'
  expect(optimizeClassNames(all)).toBe('md:rounded-xl!')
  expect(optimizeClassNames('rounded-tl-xl rounded-tr-xl rounded-tl-sm')).toBe('rounded-tl-xl rounded-tr-xl rounded-tl-sm')
  expect(optimizeClassNames('rounded-tl-xl rounded-tr-xl rounded')).toBe('rounded-tl-xl rounded-tr-xl rounded')
  expect(optimizeClassNames('rounded-tl-xl rounded-tr-xl rounded-ss-sm')).toBe('rounded-tl-xl rounded-tr-xl rounded-ss-sm')
  expect(optimizeClassNames('rounded-tl-[10px] rounded-tr-[10px] rounded-bl-[7px]')).toBe('rounded-t-[10px] rounded-bl-[7px]')
  expect(optimizeClassNames('rounded-[0px] rounded-s-[24px] rounded-ee-[32px] rounded-br-[-8px]')).toBe('rounded-none rounded-s-3xl rounded-ee-4xl rounded-br-[-8px]')
  const source = 'div(className="rounded-tl-[12px] rounded-tr-[12px]")\n'
  const after = optimizeTailwind(parse(source), source, 'App', 'App')
  expect(after).toBe('div(className={"rounded-t-xl"})\n')
  expect(() => compileBeastResult(after)).not.toThrow()
  expect(optimizeTailwind(parse(after), after, 'App', 'App')).toBe(after)
})

test('does not collapse conditional object keys or change dynamically interpolated values', () => {
  const source = 'div(className={cx({ "pr-[12px] pl-[12px]": true, "px-3": false })})\nspan(class="p-#{size}")\np(className={`w-${width}px`})\n'
  expect(optimizeTailwind(parse(source), source, 'App', 'App')).toBe(source.replace('class="p-#{size}"', 'className="p-#{size}"'))
})

test('rewrites class attributes and class-producing expression branches without touching conditions or other code', () => {
  const source = `module
  const label = "pl-[12px] pr-[12px]"
props {active, name}: {active: boolean; name: string}
div(
  ~ class="pr-[12px] pl-[12px]"
  ~ title="p-[16px]"
  ~ style={{ padding: '12px' }}
  ~ )
  span(className={cx('pt-[8px] pb-[8px]', name === 'pl-[12px]' && 'm-[8px]', active ? 'w-[16px]' : 'w-[8px]', { 'pr-[4px] pl-[4px]': active })}) Text
  p(class={unknown('p-[12px]')}) Other
`
  const after = optimizeTailwind(parse(source), source, 'App', 'App')
  expect(after).toContain('~ className={"px-3"}')
  expect(after).toContain(`cx("py-2", name === 'pl-[12px]' && "m-2", active ? "w-4" : "w-2", { "px-1": active })`)
  expect(after).toContain("p(className={unknown('p-[12px]')})")
  expect(after).toContain('const label = "pl-[12px] pr-[12px]"')
  expect(after).toContain('title="p-[16px]"')
  expect(after).toContain("style={{ padding: '12px' }}")
  expect(after.split('\n').length).toBe(source.split('\n').length)
  expect(() => compileBeastResult(after)).not.toThrow()
  expect(optimizeTailwind(parse(after), after, 'App', 'App')).toBe(after)
})

test('walks control flow and edits only the selected component', () => {
  const source = `component Card
  div(class="pl-[12px] pr-[12px]")
component Other
  div(class="p-[16px]")
props {active, items}: {active: boolean; items: number[]}
if active
  div(class="p-[8px]")
else
  each item in items key item
    Card(className="p-[12px]")
  empty
    div(className="m-[4px]")
`
  const card = optimizeTailwind(parse(source), source, 'Card', 'App')
  expect(card).toBe(source.replace('class="pl-[12px] pr-[12px]"', 'className={"px-3"}'))
  const app = optimizeTailwind(parse(source), source, 'App', 'App')
  expect(app).toContain('div(className={"p-2"})')
  expect(app).toContain('Card(className={"p-3"})')
  expect(app).toContain('div(className={"m-1"})')
  expect(app).toContain('div(class="pl-[12px] pr-[12px]")')
  expect(app).toContain('div(class="p-[16px]")')
})

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

test('saves a scoped optimization, preserves CRLF, supports undo and rejects stale or unknown requests', () => {
  const app = createApp()
  cleanups.push(app.cleanup)
  const source = 'component Card\r\n  div(class="pr-[12px] pl-[12px]")\r\n\r\ndiv(className="p-[8px]")\r\n'
  writeFileSync(app.appPath, source)
  const project = new BeastProject({ root: app.root, include: ['src'], exclude: [] })
  const hash = project.file('src/App.btsx', DEFAULT_SETTINGS)!.hash
  const request = { path: 'src/App.btsx', host: 'Card', hash }
  expect(() => project.optimizeTailwind({ ...request, host: 'Missing' })).toThrow('no longer available')
  expect(() => project.optimizeTailwind({ ...request, path: '../outside.btsx' })).toThrow('Unknown')
  const result = project.optimizeTailwind(request)
  expect(result.changed).toBe(true)
  expect(readFileSync(app.appPath, 'utf8')).toBe(source.replace('class="pr-[12px] pl-[12px]"', 'className={"px-3"}'))
  expect(() => project.optimizeTailwind(request)).toThrow('file changed')
  const unchanged = project.optimizeTailwind({ ...request, hash: result.hash })
  expect(unchanged).toEqual({ hash: result.hash, undoId: null, changed: false })
  project.undo(result.undoId!)
  expect(readFileSync(app.appPath, 'utf8')).toBe(source)
})
