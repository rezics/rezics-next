# Presentation and addressing acceptance

These prospective cases qualify route/selection/rendering contracts. Rendered
checks follow the authorized component/full-application boundary.

| ID | Scenario | Required result |
| --- | --- | --- |
| VIEW01 | Concurrent normalized slug claim in one namespace | One winner; no retargeted identity. The first `work` namespace profile is exercised by `tests/qa/integration/work-address-api.test.ts` through Account, Access, Main, native graph receipts, public resolution and relay handoff. The same owner test races two different slugs for one Work and counts adapter calls on denied, success, conflict, replay and read paths. |
| VIEW02 | Rename/merge/retire with direct and reverse links | Bounded resolution; exact selection does not become HEAD. The real owner integration covers direct and chained merge, rename and retirement, reverse reads, exact revisions, and rejection of a cycle-forming merge. Unit boundary checks cover the last allowed hop, overflow, a cycle and a missing target. Longer valid chains return 503, never an exact-route 404. |
| VIEW03 | Zone mounts private content or changes fixed-Realm context | No widening through SSR/browser/API. |
| VIEW04 | Malformed/unknown historical Block | Safe isolated rendering; no execution or authoritative rewrite. |
| VIEW05 | Nested query Blocks | One shared budget, not a fresh allowance per Block. |
| VIEW06 | Ordinary UI edits advanced API configuration | Unedited semantic state preserved. |
| VIEW07 | Stale SEO/sitemap/preview for private/erased resource | No leaked metadata or public delivery. |
| VIEW08 | Main Version language fallback, metadata-only and RTL | Actual selection/availability, accessibility and safe empty states. |
| VIEW09 | Changed theme dependency or expired approval | Reapproval/denial; no rollback reactivation. |

## Resource summary API acceptance

The [universal avatar contract](../contracts/media.md#universal-avatar-selection)
is backend behavior independent of rendered QA. Refine VIEW07/VIEW08 and the
corresponding resource/model owners with these required cases:

- Work, character, concept, Context, role and relation-definition summaries each return a
  stable reference, selected name and non-null image-or-fallback avatar.
- No upload, explicit removal, unavailable rendition, revoked access and erased
  media produce an admitted safe result without a hidden asset ID or URL.
- Different context/language selections report their actual readable basis;
  a stale cached summary cannot deliver a revoked selection.
- Same-label classifications expose distinct readable interpretation bases;
  personal and Realm speech retain their actual attribution and semantic revision.
  A viewer preference or Realm default cannot rewrite an existing statement or
  exact shared link. A hidden Context/definition cannot leak through the summary.
- Bounded batch reads hydrate names and avatars without one owner round trip per
  result, preserve partial/unavailable semantics and obey the parent query budget.

These requirements introduce no new inventory IDs or backend passes. UI rendering
and human usability acceptance remain outside the active backend Goal.
