The launcher markup is in [client/BeastDevtools.btsx](client/BeastDevtools.btsx), the panel's top bar in [client/Topbar.btsx](client/Topbar.btsx), and the icons both share in [client/Icons.btsx](client/Icons.btsx). Styles are in [client/devtools.css](client/devtools.css).

**Tools**

- **Component Finder** identifies the component that owns an element and its source file. Click to open the source in your editor. Shortcut: Alt+Shift+C.
- **Element Picker** shows a compact tag/ID and dimensions preview. Clicking selects an element for source-backed style, attribute and DOM-property edits with undo. It switches to the Elements tab without opening a closed panel, so layout handles can be used on the unobstructed page. Shortcut: Alt+Shift+E.

[client/ElementsPanel.btsx](client/ElementsPanel.btsx) contains the source-backed editor; [client/element-inspector.ts](client/element-inspector.ts) captures properties and saves edits through the Elements API, with file-backed undo. Styles and layout drags update inline styles in the owning `.btsx` element. Untagged elements and runtime-only properties remain read-only; computed style expressions that cannot be safely patched report an error instead of claiming to save. [client/element-groups.ts](client/element-groups.ts) sorts styles and DOM properties into the panel's category groups. [client/element-layout.ts](client/element-layout.ts) draws the open element's outline and side handles for resizing it on the page.

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
| Resize outline, side handles and size readout | `.bdt-layout-frame`, `.bdt-layout-handle`, `.bdt-layout-size` |
| Page cursor while a tool is active | `html.bdt-component-finder-active`, `html.bdt-element-picker-active` |
| Main launcher, status dot and logo | `.bdt-launcher`, `.bdt-launcher-dot`, `.bdt-logo` |

The playground dev server hot-reloads the component and CSS files.
