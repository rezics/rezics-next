# Rezics UI and the Rezics Aura theme

`packages/ui` (`@rezics/ui`) is the only UI component library for the web app.
It started as a full snapshot of [SharkUI](https://github.com/sharkui-inc/shark-ui)
at [`d43c3c2`](https://github.com/sharkui-inc/shark-ui/tree/d43c3c2c7a5e683d46930c2ce8eb22eca2f8a0a0)
(2026-09-13, MIT) on Ark UI: all 95 components and the `use-is-mobile` hook.
Since 2026-09-27 the project maintains it as Rezics UI. It is not synced from the
SharkUI registry again; change, restyle or add components in place. Attribution
is in [`packages/ui/THIRD_PARTY_NOTICES.md`](../../packages/ui/THIRD_PARTY_NOTICES.md).

The visual language is **Rezics Aura**: the structure of Arca UI's
[Aura theme](https://github.com/simonlee-1994/arca-ui/tree/90c098c1ae9ea49f28b839dd12d04eaa91d2379c/aura)
(MIT) with Rezics colors. The source of truth for tokens is
[`packages/ui/src/styles.css`](../../packages/ui/src/styles.css); this page
explains the rules behind them.

## Package layout

| Path | Contents |
| --- | --- |
| `src/components/<name>.tsx` | One component family per file, imported as `@rezics/ui/<name>`. |
| `src/hooks/` | Shared hooks, imported as `@rezics/ui/hooks/<name>`. |
| `src/utils.ts` | `cn()` (`clsx` plus `tailwind-merge`), imported as `@rezics/ui/utils`. |
| `src/styles.css` | Tailwind entry: theme mapping, Rezics Aura tokens, animations and utilities. The web app imports it once. |
| `src/prose.css`, `src/hitbox.css` | Long-form text styles and hit-area utilities carried over from SharkUI. |

Components use Ark UI primitives, `tailwind-variants` for variants and
`lucide-react` icons. Feature code composes these components and never adds a
second component library. A product-specific component that several features
share belongs here too; a component used by one feature stays in that feature.

## Color roles

Rezics has two theme colors with separate jobs. The logo red is identity; the ink
blue is the readable action color.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--brand` (logo red) | `#df3d35` | `#f0524c` | Non-text marks only: logo, active upvote arrow, unread and "new" dots, chart marks, the faint canvas glow. |
| `--primary` (ink blue) | `#2f63ad` | `#86aee8` | Filled buttons, links, selected tab and navigation text, focus ring, soft buttons and badges, any colored small text. |
| `--accent` / `--accent-foreground` | `#e4ecf7` / `#1f4a85` | `#1b2a3f` / `#c9dbf5` | Hover and selected surfaces, avatars, menu highlight. |
| `--rating` | `#bf7a0e` | `#e9a93a` | Stars and rating bars. |
| `--vote-down` | `#6a5bb5` | `#a99cf0` | Active downvote arrow, kept apart from blue actions. |
| `--destructive` | `#c42840` | `#d63a50` | Destructive fills, always with a label or icon. |

The logo red measures about 4.0–4.3:1 against the page and card, below the
4.5:1 that small text needs, so **red never colors text or sits behind text**.
That includes Realm names, vote scores and badges: use the foreground color or
ink blue. Non-text marks need 3:1, which the red meets. Every text pair in the
theme meets 4.5:1 in both modes (ink blue on page 5.55:1, white on ink blue
5.98:1). Check new pairs against these thresholds before adding a token.

Neutrals come from Aura unchanged: warm paper `#f9f6f2` page, `#fefcf9` cards,
`#efece7` secondary, `#2b343d` text, `#5d646c` muted text and `#dad7d0`
borders; dark mode uses `#0d1218`, `#151b21`, `#232a30`, `#e7e4df`, `#928f88`
and `#2a2e33`.

Semantic tokens follow the SharkUI convention: `--success`, `--info`,
`--warning` and `--destructive` are fills and tints, and each `--*-foreground`
is the text-safe tone of that color on a tint (for example
`bg-success/10 text-success-foreground`). This differs from shadcn, where
`-foreground` means text on a solid fill.

## Radius scale

Rezics UI uses Aura's scale with `--radius: 1rem`. The imported SharkUI classes
were shifted one step up (`rounded-lg` to `rounded-xl`, `rounded-xl` to
`rounded-2xl`, `rounded-2xl` to `rounded-3xl`) so the class names match Aura's
usage.

| Class | Size | Use |
| --- | --- | --- |
| `rounded-sm` | 12px | Cover images, checkboxes. |
| `rounded-lg` | 16px | Small inputs, `xs` buttons, keyboard hints. |
| `rounded-xl` | 20px | Buttons, inputs, tab items, menu items, toggles. A 36px button is fully rounded. |
| `rounded-2xl` | 24px | Cards, tab lists, menus, popovers, alerts, textareas. |
| `rounded-3xl` | 30px | Dialogs, sheets, command palette. |
| `rounded-full` | pill | Badges, avatars, switches, progress, pagination. |

## Elevation, surfaces and type

- **Cards** use a 60% border (`border-border/60`), Aura's hairline-plus-diffuse
  shadow `--aura-shadow-card`, and `--aura-shadow-card-hover` on hover.
  Floating menus and popovers use `--aura-shadow-float`.
- **`aura-canvas`** paints the page ground with soft glows and a 120px/24px
  grid. Use it on page backgrounds, never inside cards.
- **`aura-surface`** is the gradient card for feature headers, such as a Realm
  banner. Keep it to one per view.
- **Type**: Manrope for the interface, Iowan Old Style (Source Serif 4 as the
  web fallback) for Work titles only, Geist Mono for identifiers. The web app
  still has to load these faces; CJK fallbacks are chosen with the zh-CN locale.

## Component alignment

The imported components already use the theme tokens and the shifted radius
scale. These were also aligned to Aura's component classes:

| Component | Aura alignment |
| --- | --- |
| Button | Sizes `sm` 32px, `md` (default) 36px with `px-5`, `lg` 40px, `xl` 44px. Default and destructive fills carry the card shadow; `outline` gains a 70% border and blue-tinted hover; new `soft` variant (`bg-primary/10 text-primary`). |
| Input, Textarea | `bg-primary/5`, 80% border, inset shadow; input sizes 32/36/40px; textarea `rounded-2xl`. |
| Card | 60% border, Aura card and hover shadows. |
| Badge | Pill shape. |

Other components keep SharkUI's structure under the new tokens and radii.
Review each against Aura's matching component when a feature first uses it, and
record material changes here.

## Layout conventions

- **Post and feed cards** put engagement in a bottom bar, as Reddit does: a
  vote group (upvote, score, downvote) on a secondary pill, then comments,
  share and save as small secondary buttons, and an overflow menu at the end.
  Content keeps the full card width, which matters on phones.
- **Phones** get a five-item bottom navigation (Home, Discover, Create, Inbox,
  Shelves) with Create emphasized in the center. The desktop left navigation
  moves into a drawer, and the top bar keeps only the logo, search, notifications
  and the acting-identity avatar.
- Work pages follow the Goodreads pattern: cover and title, rating summary with
  its Context label, shelf actions and rating distribution. A provider's
  aggregate is shown separately as a source statistic.

Component states, accessibility and screenshots are reviewed as described in
[component review](storybook.md).
