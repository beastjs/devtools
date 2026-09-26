# Changelog

All notable changes to `@beastjs/devtools` are recorded here.

## Unreleased

### Added

- **Resizable panes**: drag the edges between the file list, component
  details, BTSX and TSRX, and suggestions and source. Widths are saved per
  browser; double-click an edge to reset it.
- **Smoother motion**: the panel slides in and out instead of appearing and
  disappearing, the launcher fades aside while it is open, and the element
  picker's outline glides from element to element, following each element's
  corner radius. Motion is near-instant when the system asks for reduced
  motion.
- **Element picker**: toggle it from the crosshair button or
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>, hover your app to see each
  element's component and `.btsx` line, and click to open that line in your
  editor. The dev server tags elements with `data-beast-src` and
  `data-beast-component`. Turn tagging off with `elementPicker: false`.
- **Editable names**: rename a suggested component (with its props interface
  and file) or a mapping's array before applying. Names are validated in the
  panel and on the dev server.
- **Refactoring copies that differ**: blocks with the same markup but different
  attribute values, text, or conditions can now be merged into one component.
  Each differing value becomes a typed prop, and every copy becomes a call that
  passes its own values.
- **Mapping repeated siblings**: runs of sibling elements with the same markup
  get a new "repeated" suggestion that renders them from an array with `each`,
  keyed by a unique field or the index.

- **Rspack and Rsbuild support**: `@beastjs/devtools/rspack` for
  `rspack serve` and `@beastjs/devtools/rsbuild` for `rsbuild dev`, next to the
  Vite plugin at `@beastjs/devtools/vite`. Both leave production builds
  untouched. `vite`, `@rspack/core` and `@rsbuild/core` are optional
  peer dependencies; install the one you use.
- **Typed props for extracted components**: refactors declare a
  `NameProps` interface (exported when moved to its own file) whose types come
  from the project's TypeScript at the section, including loop variables and
  branch narrowing. Existing named types are reused, exported types from other
  modules are imported with `import type`, and unexported types are written
  out structurally. `typescript` is an optional peer dependency; without it,
  types are estimated and cards say so.

### Changed

- The overlay learns about `.btsx` changes from a server-sent event stream at
  `/__beast-devtools/api/events` instead of Vite's HMR channel, and opens files
  through `/__beast-devtools/api/open-in-editor`, which forwards to the dev
  server's own launch-editor endpoint.
- The Components panel's "Runtime inspection is off" hint shows the `profile`
  setting for Rspack and Rsbuild as well as Vite.
- `sideEffects` lists the overlay's stylesheet and entry instead of `false`,
  which let Rspack drop the stylesheet.
- The repository now contains only this package, at its root. The
  `repository` and `homepage` links point there; the 0.1.0 links pointed into
  a `devtools/` folder that no longer exists.
- `client/env.d.ts` declares `.btsx` modules, so the overlay sources
  type-check on their own.

## 0.1.0

First release: an in-page overlay for Beast (BTSX) and Octane apps during
`vite dev`. Toggle it with Alt+Shift+D.

### Added

- **Components**: the live Octane component tree, including `each`/`if`
  scopes. Hook values are named after their `setup` bindings, alongside
  context values and the `.btsx` line that declares the component.
- **BTSX → TSRX**: each `.btsx` file next to the TSRX Beast generates for it,
  with line linking through Beast's source map and `BEAST####` compile
  diagnostics.
- **Refactor**: nesting depth for every template line, suggestions for
  extracting deep sections into components with inferred, typed props, and
  detection of structurally identical blocks.
- **Automatic refactors**: hoist a section into a local `component`, or move it
  to its own `Name.btsx` with the imports and exported module types and values
  it needs. Every change is previewed as a diff, compiled through Beast and
  Octane before anything is written, and can be undone.
- `beastDevtools({ include, analyzer })` options for source directories and
  analyzer defaults (`depthLimit`, `minLines`, `fileLines`).
