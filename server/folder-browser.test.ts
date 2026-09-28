import { expect, test } from 'bun:test'
import { createFolderBrowser } from './folder-browser.ts'

test('preserves spaces and Unicode in the selected directory and handles cancel', async () => {
  const results = ['/Users/test/Projects/日本語 app /\n', '']
  const browse = createFolderBrowser('darwin', async () => ({ stdout: results.shift()! }))
  expect(await browse()).toBe('/Users/test/Projects/日本語 app /')
  expect(await browse()).toBeNull()
})

test('concurrent requests share a dialog and a later request opens a new one', async () => {
  let calls = 0
  let finish!: (result: { stdout: string }) => void
  const browse = createFolderBrowser('win32', () => {
    calls++
    return new Promise((resolve) => { finish = resolve })
  })
  const first = browse()
  const second = browse()
  expect(calls).toBe(1)
  finish({ stdout: 'C:\\Projects\\app\r\n' })
  expect(await first).toBe('C:\\Projects\\app')
  expect(await second).toBe('C:\\Projects\\app')
  const next = browse()
  expect(calls).toBe(2)
  finish({ stdout: '' })
  expect(await next).toBeNull()
})

test('Linux falls back to KDialog only when Zenity is missing', async () => {
  const commands: string[] = []
  const browse = createFolderBrowser('linux', async (command) => {
    commands.push(command)
    if (command === 'zenity') throw Object.assign(new Error(), { code: 'ENOENT' })
    return { stdout: '/home/test/app\n' }
  })
  expect(await browse()).toBe('/home/test/app')
  expect(commands).toEqual(['zenity', 'kdialog'])
  const cancel = createFolderBrowser('linux', async () => { throw { code: 1, stderr: '' } })
  expect(await cancel()).toBeNull()
})

test('dialog failures offer manual entry and allow retry', async () => {
  let calls = 0
  const browse = createFolderBrowser('linux', async () => {
    if (++calls === 1) throw { code: 1, stderr: 'Cannot open display' }
    return { stdout: '/home/test/app\n' }
  })
  await expect(browse()).rejects.toThrow('Enter the folder path manually')
  expect(await browse()).toBe('/home/test/app')
})
