# Third-party notices

## SharkUI

The components in `src/components/`, the hook in `src/hooks/`, `src/prose.css`,
`src/hitbox.css` and the theme mapping and animations in `src/styles.css` are
derived from [SharkUI](https://github.com/sharkui-inc/shark-ui) at commit
`d43c3c2c7a5e683d46930c2ce8eb22eca2f8a0a0` and are distributed under the
following license:

````text
MIT License

Copyright (c) 2026 Vinicius Vicentini

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

## Arca UI

The radius scale, shadows, canvas and surface utilities in `src/styles.css`, and
the component class adjustments described in the
[design system](../../docs/development/design-system.md), follow the Aura theme of
[Arca UI](https://github.com/simonlee-1994/arca-ui) at commit
`90c098c1ae9ea49f28b839dd12d04eaa91d2379c`, distributed under the following
license:

```text
MIT License

Copyright (c) 2026 simonlee-1994

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
````

## shadcn/ui

The components in `src/shadcn/`, `src/hooks/use-mobile.ts`, `src/hooks/use-highlighted-code.ts` and
`src/lib/highlighter.tsx` are written by the [shadcn/ui](https://ui.shadcn.com) CLI from its `base-rhea`
registry style and are never edited by hand. The `shadcn` package provides the Tailwind layer that `src/styles.css`
imports, and `cn`, `@shadcn/react` and `shadcn/ui` itself are distributed under the following license:

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Base UI

The cloned components are built on [Base UI](https://base-ui.com) (`@base-ui/react`), distributed under the MIT
License, Copyright (c) 2019 Material-UI SAS.

## Other libraries the cloned components ship

| Package                    | Licence    | Used by               |
| -------------------------- | ---------- | --------------------- |
| `class-variance-authority` | Apache-2.0 | component variants    |
| `cmdk`                     | MIT        | `command`, `combobox` |
| `date-fns`                 | MIT        | `calendar`            |
| `embla-carousel-react`     | MIT        | `carousel`            |
| `input-otp`                | MIT        | `input-otp`           |
| `react-day-picker`         | MIT        | `calendar`            |
| `react-resizable-panels`   | MIT        | `resizable`           |
| `recharts`                 | MIT        | `chart`               |
| `shiki`                    | MIT        | `code-block`          |
| `thumbhash`                | MIT        | `cover`               |

Each package carries its own licence text in its distribution.
