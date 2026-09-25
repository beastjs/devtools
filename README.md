# @beastjs/devtools

In-page devtools for [Beast](https://www.npmjs.com/package/beast-tsrx) (BTSX)
and [Octane](https://octanejs.dev/) apps. It adds a panel to your app during
`vite dev` that shows live component state, puts each `.btsx` file next to the
TSRX it compiles to, and finds deeply nested templates. It can then extract
those sections into components for you.

Production builds are untouched: the plugin only runs on the dev server.

## Requirements

| Package      | Version     |
| ------------ | ----------- |
| `beast-tsrx` | `^0.4.3`    |
| `octane`     | `^0.4.3`    |
| `vite`       | `^8.0.16`   |
| Node.js      | `>=22.22.2` |

## Install

```bash
bun add -d @beastjs/devtools
```

Or with npm: `npm install -D @beastjs/devtools`.

## Setup

Add the plugin next to `beastOctane()` in `vite.config.ts`:

```ts
import { beastOctane } from 'beast-tsrx/vite'
import { beastDevtools } from '@beastjs/devtools'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    // `profile: 'auto'` compiles Octane's runtime inspection hook into dev
    // builds only. Without it, the Components panel explains how to enable it.
    beastOctane({ octane: { profile: 'auto' } }),
    beastDevtools(),
  ],
})
```

Run `vite` (or `bun run dev`), then open the panel from the **Beast** button in
the bottom-right corner or with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>.
The panel remembers its size, tab and settings per browser.

## Panels

### Components

The live Octane component tree, including the `each`/`if` scopes Beast
templates create. Selecting a component shows:

- its hook values, named after the `setup` bindings that declare them (for
  example `activeId: "language"`);
- context values and the number of effect slots;
- the `.btsx` line that declares it, with buttons to open it in your editor or
  view its compiled TSRX.

### BTSX → TSRX

Any `.btsx` file next to the TSRX that Beast generates for it. Hovering a line
highlights its counterpart through Beast's source map; clicking pins it. A file
that fails to compile shows its `BEAST####` diagnostic and the failing line.
Both panes update when you save.

### Refactor

The structural nesting depth of every template line, with totals and a
per-depth chart, plus two kinds of suggestions:

- **Extract**: a section nested deeper than the depth limit becomes a component.
  Its props and their types are inferred from the bindings the section uses,
  and a loop's `key` stays at the call site.
- **Shared shape**: structurally identical blocks that one component could
  replace.

The toolbar adjusts the depth limit, the smallest section worth extracting,
and the size at which a section defaults to its own file.

## Automatic refactors

Each suggestion card can apply itself in one of two ways:

- **Hoist in file** adds a local `component` above the host component's
  `props`/`setup` and replaces the section with a call.
- **Move to `Name.btsx`** writes the section to a new file next to the source.
  The new file gets the imports it needs. Module-level types and values the
  section uses are exported from the source and imported back (type-only where
  possible), and the source imports the new component.

Sections of at least **New file at** lines (default 30) default to their own
file. Clicking a target first shows a diff of every file it will touch, and
nothing is written until you confirm. After applying, **Undo** restores the
files, unless they have been edited since. Undo history lives in the dev
server's memory, so it is lost when the server restarts.

Automatic refactors are conservative:

- The dev server recomputes the change from the file on disk. The browser only
  names the suggestion, and changes to a file that changed since it was
  analyzed are refused.
- Every resulting file must compile through Beast and Octane before anything
  is written.
- The write endpoints accept only same-origin JSON requests, and only for
  `.btsx` files in the configured directories.
- Automatic refactoring is refused when it cannot be done safely:
  - copies that differ from each other, or that live in different components;
  - components with scoped `style` blocks;
  - moving a section that uses a file-local `component` into a new file.

  The card explains why, and the code can still be copied by hand.

## Options

```ts
beastDevtools({
  include: ['src'],
  analyzer: { depthLimit: 5, minLines: 8, fileLines: 30 },
})
```

| Option                | Default   | Description                                                             |
| --------------------- | --------- | ----------------------------------------------------------------------- |
| `include`             | `['src']` | Directories, relative to the Vite root, scanned for `.btsx` files.      |
| `analyzer.depthLimit` | `5`       | Template nesting depth (0 = component root) above which lines are deep. |
| `analyzer.minLines`   | `8`       | Smallest section, in lines, worth extracting.                           |
| `analyzer.fileLines`  | `30`      | Sections at least this long move to their own file by default.          |

The overlay's own settings override the analyzer defaults for that browser.

## How it works

- The plugin injects the overlay into `index.html` and serves a small JSON API
  under `/__beast-devtools/api`. That API compiles, source-maps, analyzes and
  refactors `.btsx` files with `beast-tsrx`. It also sends an HMR event when a
  `.btsx` file changes.
- The overlay is itself written in BTSX and ships as source, so your app's own
  Beast and Octane versions compile it. It reads the component tree from
  Octane's `__OCTANE_DEVTOOLS__` hook, which `profile: 'auto'` enables in dev
  builds. The plugin dedupes `octane` so the overlay and the app share one
  runtime.
- Opening files in your editor uses Vite's built-in `/__open-in-editor`
  endpoint, which honors the `LAUNCH_EDITOR` environment variable.

## Limitations

- Hook values are matched to `setup` bindings by position and kind. When they
  don't line up (custom hooks, for example), the panel shows positions such as
  `#0` instead of guessing.
- Props whose type cannot be read from the source are typed `any` in extracted
  components.
- Moving a section that uses module-level values makes the two files import
  each other. This is safe because the values are read at render time, but the
  import cycle is worth knowing about.
- Imports that only the moved section used are left in the source file.

## Development

```bash
bun install
bun run check        # type check, tests, and plugin build
bun run pack:check   # list the files npm would publish
```

- `vite.ts` and `server/` hold the Vite plugin. They run in Node and are
  built to `dist/`.
- `client/` holds the overlay, written in BTSX. It ships as source.
- `shared/` holds wire types used by both sides.

To try changes in an app, link the package and add it to the app's
`vite.config.ts`:

```bash
bun link                              # in this repository
bun add -d link:@beastjs/devtools     # in the app
```

Edits under `client/` hot-reload in the linked app. Changes to `vite.ts` or
`server/` need `bun run build` and a dev-server restart.

## License

ISC
