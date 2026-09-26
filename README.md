# @beastjs/devtools

In-page devtools for [Beast](https://www.npmjs.com/package/beast-tsrx) (BTSX)
and [Octane](https://octanejs.dev/) apps. It adds a panel to your app on the
Vite, Rspack or Rsbuild dev server that shows live component state, puts each
`.btsx` file next to the TSRX it compiles to, and finds deeply nested
templates. It can then extract those sections into components for you.

Production builds are untouched: the plugin only runs on the dev server.

## Requirements

| Package      | Version     |
| ------------ | ----------- |
| `beast-tsrx` | `^0.4.3`    |
| `octane`     | `^0.4.3`    |
| Node.js      | `>=22.22.2` |

And one of these bundlers:

| Bundler | Packages                                | Version   |
| ------- | --------------------------------------- | --------- |
| Vite    | `vite`                                  | `^8.0.16` |
| Rspack  | `@rspack/core` and `@rspack/dev-server` | `^2.0.0`  |
| Rsbuild | `@rsbuild/core`                         | `^2.0.0`  |

## Install

```bash
bun add -d @beastjs/devtools
```

Or with npm: `npm install -D @beastjs/devtools`.

## Setup

Add the plugin next to `beastOctane()`, importing it from the entry point for
your bundler. Octane's `profile` option compiles its runtime inspection hook
into the app; enable it for development only. Without it, the Components panel
explains how to enable it.

### Vite

```ts
// vite.config.ts
import { beastOctane } from 'beast-tsrx/vite'
import { beastDevtools } from '@beastjs/devtools/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    // `profile: 'auto'` enables the inspection hook in dev builds only.
    beastOctane({ octane: { profile: 'auto' } }),
    beastDevtools(),
  ],
})
```

`@beastjs/devtools` without a subpath is also the Vite plugin.

### Rspack

```ts
// rspack.config.ts
import { beastOctane } from 'beast-tsrx/rspack'
import { beastDevtools } from '@beastjs/devtools/rspack'

export default {
  module: { rules: [{ test: /\.css$/, type: 'css' }] },
  plugins: [
    // Rspack's `profile` is a boolean; the CLI sets NODE_ENV before loading this file.
    beastOctane({ octane: { profile: process.env.NODE_ENV !== 'production' } }),
    beastDevtools(),
  ],
}
```

The overlay imports a stylesheet, so the config needs a rule for `.css` files.
The plugin hooks into `devServer.setupMiddlewares`, so it runs under
`rspack serve`. To start `RspackDevServer` yourself, pass it
`compiler.options.devServer`. In a multi-compiler config, add the plugin to
the browser config that has `devServer`.

### Rsbuild

```ts
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core'
import { beastOctane } from 'beast-tsrx/rsbuild'
import { beastDevtools } from '@beastjs/devtools/rsbuild'

export default defineConfig({
  plugins: [
    ...beastOctane({ octane: { profile: process.env.NODE_ENV !== 'production' } }),
    beastDevtools(),
  ],
})
```

The overlay loads in every `web` environment; server environments are left
alone.

### Opening the panel

Start the dev server, then open the panel from the **Beast** button in the
bottom-right corner or with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>. The
panel remembers its size, tab and settings per browser.

### Picking an element

Click the crosshair button (next to the **Beast** button, or in the panel's top
bar) or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>. Hovering any element
of your app then outlines it and shows the component that renders it and its
`.btsx` file and line. Clicking opens that line in your editor and ends
picking. <kbd>Esc</kbd> cancels. While picking, clicks go to the picker, not
your app.

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
per-depth chart, plus three kinds of suggestions:

- **Extract**: a section nested deeper than the depth limit becomes a component.
  Its props and their types are inferred from the bindings the section uses,
  and a loop's `key` stays at the call site.
- **Shared shape**: blocks with the same markup that one component can replace.
  Attribute values, element text, and `if`/`switch` conditions that differ
  between the copies become props, so each copy is replaced by a call that
  passes its own values:
  `CopyNote(onClick={() => copyNote('left', note)} text='Copy')`.
- **Repeated**: runs of sibling elements with the same markup (three or more,
  or two larger ones) are rendered from an array with `each`. The differing
  values become item fields. The array is a module-level `const` when its
  values are constants, and sits inline in the `each` header when they read
  component state. The loop is keyed by a field whose values are unique, or by
  the index.

Every suggestion's name is editable on its card before you apply it: the
component (and its `NameProps` interface and file), or for a repeated run the
array (or loop variable). Names are checked as you type and again on the dev
server, which refuses names already used in the file.

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

The extracted component declares its props as an interface, `NameProps`,
which is exported when the section moves to its own file. Each prop's type
comes from your project's TypeScript, read at the section itself, so loop
variables and narrowing from `if`/`switch` branches are accounted for:

- A type that already has a name you can use keeps it. That covers globals,
  module-level types in the file, and anything the file already imports.
- A named type exported from somewhere else gets a `import type` added for it.
- A type that is not exported anywhere, such as Octane's internal setter type,
  is written out in full, e.g.
  `(next: PanelId | ((prev: PanelId) => PanelId)) => void`.

If TypeScript cannot be loaded from your project, types are estimated from the
source instead, and the card is marked **estimated types**.

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
  - copies that differ in more than values (tags, selectors, loop headers),
    whose differing values use a variable bound inside the block, or that live
    in different components;
  - components with scoped `style` blocks;
  - moving a section that uses a file-local `component` into a new file.

  The card explains why, and the code can still be copied by hand.

## Options

```ts
beastDevtools({
  include: ['src'],
  analyzer: { depthLimit: 5, minLines: 8, fileLines: 30 },
  elementPicker: true,
})
```

| Option                | Default   | Description                                                             |
| --------------------- | --------- | ----------------------------------------------------------------------- |
| `include`             | `['src']` | Directories, relative to the project root, scanned for `.btsx` files.   |
| `analyzer.depthLimit` | `5`       | Template nesting depth (0 = component root) above which lines are deep. |
| `analyzer.minLines`   | `8`       | Smallest section, in lines, worth extracting.                           |
| `analyzer.fileLines`  | `30`      | Sections at least this long move to their own file by default.          |
| `elementPicker`       | `true`    | Tag elements with their component and source line for the picker.       |

The project root is Vite's `root`, Rspack's `context`, or Rsbuild's root
path. The overlay's own settings override the analyzer defaults for that
browser.

## How it works

- The plugin adds the overlay to the page: Vite gets a script tag in
  `index.html`, Rspack a global entry, and Rsbuild a `source.preEntry`.
- It serves a small JSON API under `/__beast-devtools/api`. That API compiles,
  source-maps, analyzes and refactors `.btsx` files with `beast-tsrx`. When a
  `.btsx` file changes, it tells the overlay through a server-sent event
  stream, so every dev server works the same way. Vite's own file watcher
  feeds it; under Rspack and Rsbuild the plugin watches the `include`
  directories itself.
- The overlay is itself written in BTSX and ships as source, so your app's own
  Beast and Octane versions compile it. It reads the component tree from
  Octane's `__OCTANE_DEVTOOLS__` hook, which the `profile` option enables. The
  overlay and the app share one Octane runtime: the Vite plugin dedupes
  `octane`, and Octane's Rspack and Rsbuild plugins resolve it to a single
  copy.
- For the element picker, the plugin adds `data-beast-src="path:line:column"`
  and `data-beast-component` attributes to every HTML element in your project's
  `.btsx` files before Beast compiles them. Component calls are not tagged,
  and neither are files in `node_modules`. The attributes are static, so
  Octane compiles them into its templates at no runtime cost. Only the dev
  server adds them.
- Opening files in your editor goes through the dev server's own launch-editor
  endpoint, which honors the `LAUNCH_EDITOR` environment variable.

## Limitations

- Hook values are matched to `setup` bindings by position and kind. When they
  don't line up (custom hooks, for example), the panel shows positions such as
  `#0` instead of guessing.
- A prop is only as well typed as its binding: a host prop declared as `any`
  stays `any` in the extracted component, because types are read from
  declarations, not from how callers use the component.
- Moving a section that uses module-level values makes the two files import
  each other. This is safe because the values are read at render time, but the
  import cycle is worth knowing about.
- Imports that only the moved section used are left in the source file.
- The picker's attributes are inserted into tagged lines, so dev-server error
  columns on those lines can point a little past the real position. Line
  numbers are exact.
- The picker names the component whose template holds an element. Markup
  passed in as children is attributed to the file that wrote it.

## Development

```bash
bun install
bun run check        # type check, tests, and plugin build
bun run pack:check   # list the files npm would publish
```

- `vite.ts`, `rspack.ts` and `rsbuild.ts` are the bundler plugins. They wire
  `server/devtools.ts` (the API and change events) into each dev server.
  Together with the rest of `server/`, they run in Node and are built to
  `dist/`.
- `client/` holds the overlay, written in BTSX. It ships as source.
- `shared/` holds wire types used by both sides.
- `vite.test.ts`, `rspack.test.ts` and `rsbuild.test.ts` start each real dev
  server on a throwaway app and check the overlay bundle, the API, change
  events and the editor redirect.

To try changes in an app, link the package and add it to the app's bundler
config:

```bash
bun link                              # in this repository
bun add -d link:@beastjs/devtools     # in the app
```

Edits under `client/` hot-reload in the linked app. Changes to the plugins or
`server/` need `bun run build` and a dev-server restart.

## License

ISC
