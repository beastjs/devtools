import { expect, test } from 'bun:test'
import { canResize, resizeDeclarations, type BoxStart } from './element-layout.ts'

const start: BoxStart = { width: 200, height: 100, marginTop: 10, marginLeft: 20 }
const html = (localName: string) => ({ localName, namespaceURI: 'http://www.w3.org/1999/xhtml' })
const svg = (localName: string) => ({ localName, namespaceURI: 'http://www.w3.org/2000/svg' })

test('the right and bottom sides set width and height', () => {
  expect(resizeDeclarations('right', start, 30.4, 99)).toEqual({ width: '230px' })
  expect(resizeDeclarations('bottom', start, 99, -40)).toEqual({ height: '60px' })
})

test('the left and top sides keep the opposite side in place', () => {
  expect(resizeDeclarations('left', start, -50, 0)).toEqual({ width: '250px', 'margin-left': '-30px' })
  expect(resizeDeclarations('top', start, 0, 25)).toEqual({ height: '75px', 'margin-top': '35px' })
})

test('a side never drags the size below zero', () => {
  expect(resizeDeclarations('right', start, -500, 0)).toEqual({ width: '0px' })
  expect(resizeDeclarations('left', start, 500, 0)).toEqual({ width: '0px', 'margin-left': '220px' })
})

test('fractional sizes round the size and move the margin by the same amount', () => {
  expect(resizeDeclarations('left', { ...start, width: 200.5 }, 10, 0)).toEqual({ width: '191px', 'margin-left': '29.5px' })
})

test('only boxes that CSS width and height affect can be resized', () => {
  expect(canResize(html('div'), 'block')).toBe(true)
  expect(canResize(html('span'), 'inline')).toBe(false)
  expect(canResize(html('img'), 'inline')).toBe(true)
  expect(canResize(html('div'), 'contents')).toBe(false)
  expect(canResize(svg('rect'), 'inline')).toBe(true)
  expect(canResize(svg('path'), 'inline')).toBe(false)
})
