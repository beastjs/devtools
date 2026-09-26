# Gleam migration criteria

Use this reference to correct the analyzer after reading each candidate. A
file is attractive only when its language fit, JavaScript boundary, and
migration value all make sense.

## Contents

- [Language fit](#language-fit)
- [JavaScript boundary cost](#javascript-boundary-cost)
- [Migration value](#migration-value)
- [Interpreting analyzer output](#interpreting-analyzer-output)
- [Manual review checklist](#manual-review-checklist)

## Language fit

Strong signals:

- Discriminated unions, literal unions, and state transitions that become
  custom types plus exhaustive `case`.
- Parsers, validators, normalizers, calculators, formatters, reducers, and
  business rules that compute outputs from inputs.
- Composition through `map`, `filter`, folds, recursion, and small named
  functions.
- Explicit domain models and expected-failure paths that become typed
  `Result` values.
- Little shared mutation, inheritance, metaprogramming, or exception-driven
  control flow.

Mutation and loops are redesign cost, not automatic rejection. A bounded
parser that fills an accumulator may still port cleanly using a fold or
tail-recursive helper.

Poor whole-file fits:

- JSX rendering, component lifecycle, hooks, and UI framework adapters.
- DOM, filesystem, network, database, process, timer, or audio orchestration.
- Inheritance, decorators, prototype mutation, `eval`, `Function`, `Proxy`,
  or reflective behavior.
- Thin wrappers whose behavior belongs to an npm library or host runtime.
- Existing generated Gleam imports or JavaScript `_ffi` modules.

## JavaScript boundary cost

Inspect exported signatures and actual callers, not only internal logic.

- Compiled Gleam modules are ES modules.
- A Gleam `List(a)` is not a JavaScript array. Convert deliberately or use
  `gleam/javascript/array` from `gleam_javascript` when a native array is the
  right boundary type.
- Gleam custom types do not accept arbitrary tagged JS objects. JavaScript
  callers use generated constructors/accessors, a wrapper, an external type,
  or decoded `Dynamic` data.
- Optional JS fields may be absent, `undefined`, or `null`; choose and enforce
  one Gleam representation.
- TypeScript `number` does not decide `Int` versus `Float`. Whole-number,
  `NaN`, and infinity constraints matter at runtime.
- Promises and callback APIs need an explicit JavaScript-target design.
- Returning a caller-owned object, function, or cached value preserves
  observable JavaScript identity; a structurally equal fresh Gleam value may
  not be equivalent.
- URI codecs, JSON, Unicode normalization, numeric coercion, property
  enumeration, and weak-key caches carry JavaScript-specific semantics that
  need differential tests.
- External functions are trusted declarations: Gleam cannot verify their
  implementation or runtime return values.

Boundary work can change a whole-file recommendation into “extract pure
core.” Keep host interaction in a small JS adapter and call a typed Gleam
module for the computation.

## Migration value

Easy is not the same as worthwhile. Verify:

- the module contains behavior, not only declarations or constants;
- important production callers would actually use the compiled module;
- tests or stable examples protect semantics;
- the boundary is smaller than the logic being protected;
- the code changes often enough, or is risky enough, for stronger modeling to
  pay back;
- the module is not already a wrapper around Gleam output.

Prefer a small vertical slice with a stable API over a large isolated rewrite.

## Interpreting analyzer output

- `Strong candidate`: high combined evidence; still inspect the file and
  boundary.
- `Possible candidate`: review-worthy, often with redesign or extraction.
- `Low priority`: weak benefit or excessive boundary cost.
- `Not a fit`: excluded from whole-file ranking because of JSX, dynamic
  metaprogramming, prototype writes, existing Gleam interop, or FFI-adapter
  status.

`languageFit` is higher-is-better. `boundaryCost` is higher-is-worse.
`migrationValue` is only a local heuristic; the analyzer does not know
business importance or fully resolve the call graph.

The TypeScript engine parses syntax but does not run a type checker. The
lexical fallback masks comments and strings yet is less precise. Neither
engine proves purity or semantic equivalence.

## Manual review checklist

For each leading file:

1. Summarize its real responsibility.
2. Separate computation from coordination.
3. Verify mutations, exceptions, dynamic types, globals, and runtime imports.
4. Inspect exported arrays, objects, callbacks, promises, optional values,
   and numbers.
5. Inspect direct callers and tests.
6. Check JS-specific semantics: identity, coercion, URI/Unicode behavior,
   property order, regex behavior, `Date`/`Intl`, `NaN`, infinity, and thrown
   library errors.
7. Choose whole port, redesign, pure-core extraction, keep, or already
   migrated.
8. Explain why the migration would improve safety or maintainability, not
   merely why translation is possible.
