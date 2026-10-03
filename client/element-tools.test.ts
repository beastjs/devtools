import { expect, test } from 'bun:test'
import { listenForPickerEscape } from './element-tools.ts'

/** Native EventTarget supplies real cancellation and immediate propagation behavior. */
function withKeyboard(run: (window: EventTarget) => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  try { run(target) }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

function keydown(key: string) {
  const event = new Event('keydown', { cancelable: true })
  Object.defineProperty(event, 'key', { value: key })
  return event
}

test('Escape cancels once and prevents page or competing picker handlers from running', () => {
  withKeyboard((window) => {
    let cancellations = 0
    let pageEvents = 0
    const stop = listenForPickerEscape(() => { cancellations++ })
    window.addEventListener('keydown', () => { pageEvents++ })
    const escape = keydown('Escape')
    window.dispatchEvent(escape)
    expect(cancellations).toBe(1)
    expect(escape.defaultPrevented).toBe(true)
    expect(pageEvents).toBe(0)
    // Auto-repeat cannot cancel a selection again before effects finish cleanup.
    window.dispatchEvent(keydown('Escape'))
    expect(cancellations).toBe(1)
    stop()
    stop()
  })
})

test('other keys keep the picker active and remain available to the page', () => {
  withKeyboard((window) => {
    let cancellations = 0
    let pageEvents = 0
    const stop = listenForPickerEscape(() => { cancellations++ })
    window.addEventListener('keydown', () => { pageEvents++ })
    const enter = keydown('Enter')
    window.dispatchEvent(enter)
    expect(cancellations).toBe(0)
    expect(enter.defaultPrevented).toBe(false)
    expect(pageEvents).toBe(1)
    window.dispatchEvent(keydown('Escape'))
    expect(cancellations).toBe(1)
    stop()
  })
})

test('cleanup leaves Escape available once picking and selection end', () => {
  withKeyboard((window) => {
    let cancellations = 0
    const stop = listenForPickerEscape(() => { cancellations++ })
    stop()
    const escape = keydown('Escape')
    window.dispatchEvent(escape)
    expect(cancellations).toBe(0)
    expect(escape.defaultPrevented).toBe(false)
  })
})
