# JavaScript/TypeScript to Gleam reference

This reference targets modern Gleam on the JavaScript target and was reviewed
against Gleam 1.17. Check the project compiler, stdlib, and official
documentation before relying on version-sensitive package APIs.

## Contents

- [Functions and control flow](#functions-and-control-flow)
- [Custom types and pattern matching](#custom-types-and-pattern-matching)
- [Lists and arrays](#lists-and-arrays)
- [Result and Option](#result-and-option)
- [Records and structural objects](#records-and-structural-objects)
- [Strings and numbers](#strings-and-numbers)
- [Mutation, loops, and recursion](#mutation-loops-and-recursion)
- [JavaScript boundary](#javascript-boundary)
- [External functions](#external-functions)
- [Validation](#validation)

## Functions and control flow

```ts
export function area(shape: Shape): number {
  return calculate(shape)
}
```

```gleam
pub fn area(shape: Shape) -> Float {
  calculate(shape)
}
```

Gleam is expression-oriented and has no `return` statement, default
parameters, overloads, `this`, exceptions, or implicit numeric conversion.
Labelled arguments place the external label before the internal name:

```gleam
pub fn clamp(value: Int, minimum min: Int, maximum max: Int) -> Int
```

## Custom types and pattern matching

```ts
type Shape =
  | { type: "circle"; radius: number }
  | { type: "rect"; width: number; height: number }
```

```gleam
pub type Shape {
  Circle(radius: Float)
  Rect(width: Float, height: Float)
}
```

```gleam
pub fn area(shape: Shape) -> Float {
  case shape {
    Circle(radius) -> 3.14159 *. radius *. radius
    Rect(width, height) -> width *. height
  }
}
```

`case` is exhaustive. The custom-type constructor is the tag; do not preserve
a redundant `type` field unless the external data format requires it.

## Lists and arrays

Internal collection pipelines often translate directly:

```ts
items.filter(predicate).map(transform)
```

```gleam
import gleam/list

items
|> list.filter(predicate)
|> list.map(transform)
```

Use `list.fold(items, initial, fn(acc, item) { ... })` for a left fold.

Do not reverse append semantics:

```ts
[...items, item] // append
```

```gleam
list.append(items, [item]) // append; traverses/copies `items`
[item, ..items]            // prepend; different order, constant time
```

A Gleam list is a linked-list runtime value, not a native JavaScript array.
For public JS boundaries, evaluate `gleam/javascript/array` from the
`gleam_javascript` package or add explicit conversion wrappers.

## Result and Option

Use `Result(value, error)` for operations that can fail:

```gleam
pub type ParseError {
  EmptyInput
  InvalidNumber(String)
}

pub fn parse(input: String) -> Result(Int, ParseError) {
  // Ok(value) or Error(reason)
}
```

Use `Option(value)` for optional stored data or optional arguments:

```gleam
import gleam/option.{type Option, None, Some}

pub type User {
  User(name: String, nickname: Option(String))
}
```

Do not mechanically translate every nullable or throwing API to `Option`.
Current stdlib search functions such as `list.find` return `Result(a, Nil)`.
Choose an error type that preserves information when failure matters.

## Records and structural objects

```ts
interface User {
  id: string
  name: string
  age: number
}

const older = { ...user, age: user.age + 1 }
```

```gleam
pub type User {
  User(id: String, name: String, age: Int)
}

let older = User(..user, age: user.age + 1)
```

This is an internal modeling translation, not automatic JS interop. Plain JS
objects are not instances of Gleam custom types. At a boundary, use generated
constructors, a wrapper, an external type, or `gleam/dynamic/decode`.

## Strings and numbers

```gleam
import gleam/int

"Hello " <> name <> ", you are " <> int.to_string(age)
```

Gleam uses `+`, `-`, `*`, `/` for `Int` and `+.`, `-.`, `*.`, `/.` for
`Float`. TypeScript `number` can represent either and can also carry `NaN` or
infinity. Validate JavaScript inputs before promising an `Int` or a finite
`Float`.

Review JS-specific coercion, UTF-16 indexing, regular expressions,
`Date`/`Intl`, and property-order behavior rather than assuming identical
semantics.

## Mutation, loops, and recursion

Gleam values are immutable. Rebind a new name, fold a collection, or use
tail recursion:

```gleam
fn sum(items: List(Int), total: Int) -> Int {
  case items {
    [] -> total
    [item, ..rest] -> sum(rest, total + item)
  }
}
```

Property assignment, `push`, `Map.set`, and accumulator loops are redesign
points. They do not automatically make a bounded parser a bad candidate.

## JavaScript boundary

Compiled Gleam modules are `.mjs` ES modules. Since Gleam 1.13, JavaScript can
use generated constructor, test, and accessor APIs for Gleam custom types.
That API is not the same as passing ordinary tagged objects.

Before fixing a public signature, decide:

- native JS array versus Gleam list;
- plain JS object versus custom type, dict, external type, or decoded dynamic;
- `null`/`undefined` policy;
- `Int` versus `Float` validation;
- callback or Promise integration;
- which side owns thrown exceptions and runtime validation.

The `gleam_javascript` package provides JavaScript-target modules including
arrays and promises. Confirm its installed version and current API before
writing version-sensitive code.

## External functions

```gleam
pub type DateTime

@external(javascript, "./clock_ffi.mjs", "now")
pub fn now() -> DateTime
```

The JavaScript path is relative to the Gleam module. Gleam trusts the declared
signature but cannot type-check the external implementation or verify that
the export exists. Test externals more heavily than pure Gleam code.

Prefer an existing Gleam package when suitable. A JavaScript-only external
also prevents Erlang-target compilation unless an Erlang implementation or
Gleam fallback exists.

## Validation

For a real feasibility module:

```bash
gleam format src/path/to/module.gleam
gleam check --target javascript
```

Use `todo` only for intentionally omitted implementation. Record whether the
module was checked, which package versions it assumes, and which adapter code
remains.
