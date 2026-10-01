# Rezics UI and Rezics Aura

`packages/ui` is the shared component library. It began as a snapshot of
[SharkUI](https://github.com/sharkui-inc/shark-ui/tree/d43c3c2c7a5e683d46930c2ce8eb22eca2f8a0a0)
(2026-09-13, MIT) and is now maintained in place as Rezics UI. See the
[attribution](../../packages/ui/THIRD_PARTY_NOTICES.md).

Rezics Aura follows the structure of [Arca UI's Aura theme](https://github.com/simonlee-1994/arca-ui/tree/90c098c1ae9ea49f28b839dd12d04eaa91d2379c/aura)
with Rezics colors. [CSS tokens](../../packages/ui/src/styles.css) and component
variants carry the implementation; [component review](storybook.md) checks its
rendered use.

The logo red is for identity marks; ink blue carries readable actions. Red fails
small-text contrast on the light surfaces, so keeping it off text makes the
meaning consistent across themes. Interface text uses Manrope; the serif face
distinguishes Work titles from navigation and controls. Self-hosted faces avoid
a font CDN and keep the first render stable.
