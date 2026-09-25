# Changelog

All notable changes to `@beastjs/devtools` are recorded here.

## Unreleased

### Changed

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
