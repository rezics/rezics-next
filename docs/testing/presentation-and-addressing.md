# Presentation and addressing acceptance

These prospective cases qualify route/selection/rendering contracts. Rendered
checks follow the authorized component/full-application boundary.

| ID | Scenario | Required result |
| --- | --- | --- |
| VIEW01 | Concurrent normalized slug claim in one namespace | One winner; no retargeted identity. The first `work` namespace profile is exercised by `tests/qa/integration/work-address-api.test.ts` through Account, Access, Main, native graph receipts, public resolution and relay handoff. The same owner test races two different slugs for one Work and counts adapter calls on denied, success, conflict, replay and read paths. |
| VIEW02 | Rename/merge/retire with direct and reverse links | Bounded resolution; exact selection does not become HEAD. |
| VIEW03 | Zone mounts private content or changes fixed-Realm context | No widening through SSR/browser/API. |
| VIEW04 | Malformed/unknown historical Block | Safe isolated rendering; no execution or authoritative rewrite. |
| VIEW05 | Nested query Blocks | One shared budget, not a fresh allowance per Block. |
| VIEW06 | Ordinary UI edits advanced API configuration | Unedited semantic state preserved. |
| VIEW07 | Stale SEO/sitemap/preview for private/erased resource | No leaked metadata or public delivery. |
| VIEW08 | Main Version language fallback, metadata-only and RTL | Actual selection/availability, accessibility and safe empty states. |
| VIEW09 | Changed theme dependency or expired approval | Reapproval/denial; no rollback reactivation. |
