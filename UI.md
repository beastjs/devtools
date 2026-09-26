Both icons and the launcher's markup are in [client/BeastDevtools.btsx](client/BeastDevtools.btsx), and their styles are in [client/devtools.css](client/devtools.css).

**Icons** (each is defined once and used in both the launcher and the panel's top bar):

- **Beast logo:** the `BeastLogo` component at [BeastDevtools.btsx:31](client/BeastDevtools.btsx:31). It draws the SVG path in the `LOGO_PATH` constant at [line 17](client/BeastDevtools.btsx:17), so to swap the logo, replace that path string (it's drawn in a 16×16 viewBox).
- **Picker icon:** the `PickIcon` component at [BeastDevtools.btsx:35](client/BeastDevtools.btsx:35). It's a small inline SVG: corner brackets plus a dot. Edit its `path`/`circle`, or replace them with your own SVG in the same 16×16 viewBox.

**Launcher markup:** the last block of the file, starting at [BeastDevtools.btsx:230](client/BeastDevtools.btsx:230). It holds:

- the picker button (`.bdt-launcher-pick`);
- the main launcher button (`.bdt-launcher`), with the logo, the "Beast" label and the live-status dot.

The panel's top-bar copies of the icons are at [line 175](client/BeastDevtools.btsx:175) (logo) and [line 192](client/BeastDevtools.btsx:192) (picker button).

**Styles in [devtools.css](client/devtools.css):**

| What                                         | Selector                | Line                           |
| -------------------------------------------- | ----------------------- | ------------------------------ |
| Launcher position, gap, show/hide transition | `.bdt-launcher-host`    | [93](client/devtools.css:93)   |
| Round picker button, and its icon size       | `.bdt-launcher-pick`    | [118](client/devtools.css:118) |
| "Beast" pill button                          | `.bdt-launcher`         | [145](client/devtools.css:145) |
| Status dot                                   | `.bdt-launcher-dot`     | [167](client/devtools.css:167) |
| Logo size and color                          | `.bdt-logo`             | [179](client/devtools.css:179) |
| Picker button's active (red) state           | `.bdt-root .is-picking` | (search for it)                |

The playground dev server hot-reloads both files, so edits show up right away.
