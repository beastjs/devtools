# @beast-ui/icons

The icons the web and docs apps draw. Each icon is one file in `svg/`.
`bun run icons:build` turns them into `src/icons.ts`, which `Icon` reads.

This source package uses the host app’s Beast/Octane compiler.

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

1. Save it as `svg/<name>.svg`. Names are lowercase words joined by dashes.
   Each SVG must include its own `viewBox`; its colors and paths are preserved.
2. Run `bun run icons:build` from the repository root.
3. Commit the `.svg` and `src/icons.ts`.

Run `bun run --cwd packages/icons typecheck` from the repository root to check the package.
