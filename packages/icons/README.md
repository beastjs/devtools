# @beast-ui/icons

The icons the web and docs apps draw. Each icon is one file in `svg/`.
`bun run icons:build` turns them into `src/icons.ts`, which `Icon` reads.

To use the same setup in another app, see [docs/icons.md](../../docs/icons.md).

## Drawing an icon

```
import { Icon } from '@beast-ui/icons'

Icon(name="search" className="size-4")
```

| Prop | Default | Notes |
| --- | --- | --- |
| `name` | required | a file name from `svg/`, without `.svg` |
| `size` | `20` | width and height in pixels. A class such as `size-4` overrides it. |
| `className` | none | classes for the `<svg>` |
| `color` | the text color | any CSS color. A class such as `text-muted-foreground` works too. |
| `label` | none | names an icon that means something on its own. Without it the icon is hidden from screen readers. |

`Icon` renders a single `<svg>`, with no wrapper and no margin. To make an icon
clickable, put it inside a `button` and give the button an `aria-label`.

## Adding an icon

1. Save it as `svg/<name>.svg`, or `svg/color/<name>.svg` if it must keep its
   own colors. Names are lowercase words joined by dashes.
2. Run `bun run icons:build` from the repository root.
3. Commit the `.svg` and `src/icons.ts`.

`bun test` fails when `src/icons.ts` does not match the files in `svg/`.
[docs/icons.md](../../docs/icons.md#what-build-iconsts-does) explains what the
build does to each file, and what its messages mean.
