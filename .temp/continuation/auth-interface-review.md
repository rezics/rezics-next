---
goal: web
manager: web
kind: interface
paths:
  - apps/auth/scripts/screenshots.ts
  - apps/auth/src/stories/accounts-security/consent/consent.stories.tsx
  - apps/auth/src/stories/accounts-security/security/security.stories.tsx
  - apps/auth/src/stories/operator-transfer/transfer.stories.tsx
riskAreas:
  - authorization
criticalPath: false
after:
  - 4cdc7da0-1213-4c53-b4f0-51fe3f5cc30f
waiting: []
estimate:
  lines: 100
  files: 4
acceptance:
  - With browser capture enabled, use the exact handoff command and inspect every original image.
  - Complete the route, locale, theme, viewport and applicable state matrix, with keyboard and target observations.
---
# Complete the Auth route and story interface review

Supply `.temp/goal/web/quality/auth-page-review.md`, absent from the assigned worktree and main checkout. Use its exact capture command and named states when the launch policy enables browser capture. Security Denied is already admitted for development in the integrated base; retain the focused DOM test of its presentation.

Discover canonical story IDs from the admitted current Storybook index. Inspect the actual `/login`, `/signup`, `/consent`, `/recovery`, `/security` and `/step-up` routes, plus existing consent/security/transfer stories where compositions match. For every original image, record source SHA, route/URL, story ID, persona/state, locale, theme, measured viewport, image path and console/overlay failures.

Cover en, zh-Hant, zh-Hans, ja, ko, de, fr and es; light and dark; phone390 and desktop1280. Include populated/long-content and applicable preparing, empty, denied, unavailable, refusal, pending and recovery states from the handoff. Observe keyboard focus/return and actual 44px phone/coarse-pointer targets separately.

Keep the existing local/test response seam. Presentation fixtures do not prove native outcomes. Preserve actual route captures rather than adding broad page-story coverage. Distinguish missing observations from source concerns and reproduced failures, and fix only reproduced interface defects.

The current launch policy defers browser, native and acceptance checks. The visual matrix, original-image inspection, keyboard observations and physical target measurements remain for a launch that enables them.
