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
| VIEW09 | Changed theme dependency or expired approval | Reapproval/denial; no rollback reactivation. `tests/qa/integration/theme-activation-api.test.ts` verifies expired-state reads, new approval for a changed dependency, old-key replay without head rollback, Account and Access denial, stale and concurrent writers, and Content projection recovery. |

## Resource summary API acceptance

The [universal avatar contract](../contracts/media.md#universal-avatar-selection)
is backend behavior independent of rendered QA. Refine VIEW07/VIEW08 and the
corresponding resource/model owners with these required cases:

- Work, character, concept, Context, role and relation-definition summaries each return a
  stable reference, selected name and non-null emoji/icon/image/fallback avatar
  under the adopted target contract. The existing implementation only provides
  image/fallback; the additional choices require new implementation evidence.
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

## Visual selection extension acceptance

These prospective checks cover the design adopted on 2026-09-27; none is a new
recorded pass. They introduce no new acceptance inventory IDs. Implementation
and frontend work are deferred by the maintainer's documentation-only direction.

- Emoji sequences, admitted icon IDs/background tokens and image Uses round-trip
  as authored choices. Removal resolves a stable fallback; unknown/retired icons
  safely fall back without discarding the saved choice.
- Avatar crops are 1:1 in oriented source-image pixels. A rectangular source with
  equal normalized crop width/height is not accepted as square solely on that
  basis. Mask changes do not rewrite the crop or original bytes.
- Portrait and landscape cover slots coexist and change independently; Banner
  is a third independent selection. Reusing an asset never shares mutable crop,
  focal point or fit settings between its Uses.
- Omitted update fields preserve selections; explicit null clears only its slot.
  Requested-context clearing is not mistaken for absent configuration where
  context inheritance is admitted. Missing covers/banners resolve without hidden
  references or implicit persisted substitutions.
- New selections obey current authority, expected revision and idempotency.
  Concurrent writers cannot lose an accepted change; stale cached descriptors
  cannot deliver private, suppressed or erased images.
- Post attachment order, original dimensions and exact identity survive edits.
  Preview `auto`, `selected` and `none` remain distinct; a selected attachment is
  referenced by identity rather than index. Reordering does not retarget it;
  removal resolves the authored reference, and revoked media cannot leak through
  previews. A separate preview image leaves the body unchanged.

Future rendered review must inspect circular avatar previews against the saved
square, title-bearing and square covers in contain/crop modes, simultaneous
portrait/landscape selections, and 3:1 desktop/mobile banners with actual overlays.
Missing banners must leave no empty banner region. Long/wide single-image Posts
and multi-image layouts must preserve full-image access and authored order.
API checks alone do not establish rendered or human-usability acceptance.
