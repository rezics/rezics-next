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
(MIT) with Rezics colors. Tokens, radii, font stacks and the canvas and surface
utilities are defined, with their uses, in
[`packages/ui/src/styles.css`](../../packages/ui/src/styles.css). This page keeps
the reasons behind them.

Components use Ark UI primitives, `tailwind-variants` for variants and
`lucide-react` icons. Feature code composes these components and never adds a
second component library. A product-specific component that several features
share belongs in `packages/ui`; a component used by one feature stays in that
feature.

## Two theme colors

Rezics has two theme colors with separate jobs: the logo red (`--brand`) is
identity, the ink blue (`--primary`) is the readable action color.

The logo red measures about 4.0–4.3:1 against the page and card, below the
4.5:1 that small text needs, so **red never colors text or sits behind text**.
That includes Realm names, vote scores and badges: use the foreground color or
ink blue. Non-text marks need 3:1, which the red meets. Every text pair in the
theme meets 4.5:1 in both modes (ink blue on page 5.55:1, white on ink blue
5.98:1). Check new pairs against these thresholds before adding a token.

Semantic tokens follow the SharkUI convention: `--success`, `--info`,
`--warning` and `--destructive` are fills and tints, and each `--*-foreground`
is the text-safe tone of that color on a tint (for example
`bg-success/10 text-success-foreground`). This differs from shadcn, where
`-foreground` means text on a solid fill; the fill tones fail text contrast.

## Theme selection

Light and dark follow the system preference unless the person picks one. The
choice is a cookie the server reads, and the `dark` variant in `styles.css`
answers both an explicit `.dark` class and the system preference, so the first
paint is right without an inline script and without a hydration mismatch.
[`features/shell/preferences.ts`](../../apps/web/features/shell/preferences.ts)
holds the cookie contract. A `.dark` class on any element also switches the
colors inside it, which stories use to show both themes side by side.

## Radius, surfaces and type

The imported SharkUI classes were shifted one radius step up (`rounded-lg` to
`rounded-xl`, and so on) so that class names mean what they mean in Aura.

Cards pair a 60% border with Aura's hairline-plus-diffuse shadow, which keeps
them legible on the gridded `aura-canvas` ground. The canvas belongs on page
grounds only; `aura-surface` is for one feature header per view, such as the
home hero or a Work header, so it stays a signal.

Manrope is the interface face; `font-heading` maps to it too, so SharkUI titles
do not pick up the serif. Iowan Old Style, with self-hosted Source Serif 4 as
the web fallback, is reserved for Work titles (`font-work-title`), which makes a
Work's name recognizable wherever it appears. Geist Mono sets identifiers. The
faces are self-hosted (Fontsource) rather than fetched from a font CDN; zh-CN
falls back to the platform's Simplified Chinese faces.

## Components

Button, Input, Textarea, Card and Badge are aligned with Aura's classes; their
`tv()` variants are the record. Other components keep SharkUI's structure under
the new tokens and radii: review each against Aura's matching component when a
feature first uses it, and align it in place.

## Layout

The application frame (top bar, collapsible side navigation, phone bottom bar
and drawer) is [`features/shell`](../../apps/web/features/shell); routes render
inside it with `PageContainer`. Patterns still ahead of the code:

- **Post and feed cards** put engagement in a bottom bar, as Reddit does: a
  vote group (upvote, score, downvote) on a secondary pill, then comments,
  share and save as small secondary buttons, and an overflow menu at the end.
  Content keeps the full card width, which matters on phones.
- **Work pages** follow the Goodreads pattern: cover and title, rating summary
  with its Context label, shelf actions and rating distribution. A provider's
  aggregate is shown separately as a source statistic. Each Work view is a tab
  on the revision page.

Component states, accessibility and screenshots are reviewed as described in
[component review](storybook.md).
