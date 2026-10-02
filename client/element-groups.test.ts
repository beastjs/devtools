import { expect, test } from 'bun:test'
import { groupAttributes, groupProperties, groupStyles, type ElementSection } from './element-groups.ts'
import type { ElementProperty } from './element-inspector.ts'

const prop = (name: string, value = '', extra: Partial<ElementProperty> = {}): ElementProperty => ({ name, value, editable: false, ...extra })
const ids = (sections: readonly ElementSection[]) => sections.map((section) => section.id)
const names = (sections: readonly ElementSection[], id: string) => sections.find((section) => section.id === id)?.properties.map((property) => property.name)

test('editable DOM properties come first, fields before booleans', () => {
  const sections = groupProperties([
    prop('checked', 'false', { editable: true, type: 'boolean' }),
    prop('className', 'card', { editable: true, type: 'string' }),
    prop('textContent', 'Hi', { editable: true, type: 'string' }),
    prop('tagName', 'DIV', { type: 'string' }),
  ])
  expect(sections[0]?.id).toBe('editable')
  expect(names(sections, 'editable')).toEqual(['textContent', 'className', 'checked'])
  expect(names(sections, 'identity')).toEqual(['tagName'])
})

test('read-only DOM properties are grouped by category', () => {
  const sections = groupProperties([
    prop('ELEMENT_NODE', '1'), prop('appendChild', '[Function]'), prop('onclick', 'null'), prop('ariaLabel', 'null'),
    prop('offsetWidth', '10'), prop('parentElement', '[object HTMLBodyElement]'), prop('innerHTML', ''), prop('somethingNew', 'x'),
  ])
  expect(ids(sections)).toEqual(['content', 'accessibility', 'layout', 'tree', 'other', 'events', 'methods', 'constants'])
  expect(sections.filter((section) => section.collapsed).map((section) => section.id)).toEqual(['events', 'methods', 'constants'])
  expect(sections.every((section) => section.columns === 2)).toBe(true)
})

test('styles are grouped by category in a stable order', () => {
  const sections = groupStyles(['--brand', 'color', 'column-gap', 'column-count', 'border-radius', 'margin-top', 'width', 'font-size', 'transform', 'cursor', 'display', 'overflow-wrap', 'transition-duration', 'some-future-property'].map((name) => prop(name)))
  expect(ids(sections)).toEqual(['layout', 'size', 'spacing', 'typography', 'color', 'border', 'effects', 'motion', 'interaction', 'custom', 'other'])
  expect(names(sections, 'layout')).toEqual(['column-gap', 'column-count', 'display'])
  expect(names(sections, 'typography')).toEqual(['font-size', 'overflow-wrap'])
})

test('attributes stay a single headerless list', () => {
  expect(groupAttributes([prop('id', 'x')])).toEqual([{ id: 'all', label: null, properties: [prop('id', 'x')], collapsed: false, columns: 1 }])
  expect(groupAttributes([])).toEqual([])
})
