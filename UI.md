The icons and launcher markup are in [client/BeastDevtools.btsx](client/BeastDevtools.btsx), with styles in [client/devtools.css](client/devtools.css).

**Tools**

- **Component Finder** identifies the component that owns an element and its source file. Click to open the source in your editor. Shortcut: Alt+Shift+C.
- **Element Picker** shows basic element properties on a card: type, ID, dimensions, padding and margin. Shortcut: Alt+Shift+E.

Both tools appear in the launcher and panel toolbar. Only one is active at a time; Escape exits it.

**Icons and state**

- `BeastLogo` draws the SVG path stored in `LOGO_PATH`.
- `ComponentFinderIcon` draws the corner brackets and dot.
- `ElementPickerIcon` draws the ruler.
- `activeElementTool` selects `component-finder`, `element-picker`, or `null`.
- `componentFinderActive` and `elementPickerActive` control each button's active state.

**Behavior**

[client/element-tools.ts](client/element-tools.ts) exports `startComponentFinder` and `startElementPicker`, sharing pointer tracking and highlight behavior. [client/element-picker-position.ts](client/element-picker-position.ts) exports `placeElementPickerCard` for card placement.

**Styles**

| What | Selector |
| --- | --- |
| Launcher placement and transitions | `.bdt-launcher-host` |
| Component Finder launcher button | `.bdt-launcher-component-finder` |
| Element Picker launcher button | `.bdt-launcher-element-picker` |
| Component Finder button active state | `.is-component-finder-active` |
| Element Picker button active state | `.is-element-picker-active` |
| Component Finder page highlight and label | `.bdt-component-finder-highlight`, `.bdt-component-finder-label` |
| Element Picker page highlight and card | `.bdt-element-picker-highlight`, `.bdt-element-picker-card` |
| Page cursor while a tool is active | `html.bdt-component-finder-active`, `html.bdt-element-picker-active` |
| Main launcher, status dot and logo | `.bdt-launcher`, `.bdt-launcher-dot`, `.bdt-logo` |

The playground dev server hot-reloads the component and CSS files.
