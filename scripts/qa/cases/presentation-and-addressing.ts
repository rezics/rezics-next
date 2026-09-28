import { defineCases, type PendingSubcase } from './types.ts';

// Keep the former page path as the frozen acceptance-inventory identity.
// Rendered checks follow the authorized component or full-application boundary.
export const cases = defineCases('docs/testing/presentation-and-addressing.md', [
  {
    id: 'VIEW01',
    scenario: 'Concurrent normalized slug claim in one namespace',
    requiredResult:
      'One winner; no retargeted identity. The first `work` namespace profile is exercised by `tests/qa/integration/work-address-api.test.ts` through Account, Access, Main, native graph receipts, public resolution and relay handoff. The same owner test races two different slugs for one Work and counts adapter calls on denied, success, conflict, replay and read paths.',
  },
  {
    id: 'VIEW02',
    scenario: 'Rename/merge/retire with direct and reverse links',
    requiredResult:
      'Bounded resolution; exact selection does not become HEAD. The real owner integration covers direct and chained merge, rename and retirement, reverse reads, exact revisions, and rejection of a cycle-forming merge. Unit boundary checks cover the last allowed hop, overflow, a cycle and a missing target. Longer valid chains return 503, never an exact-route 404.',
  },
  {
    id: 'VIEW03',
    scenario: 'Zone mounts private content or changes fixed-Realm context',
    requiredResult: 'No widening through SSR/browser/API.',
  },
  {
    id: 'VIEW04',
    scenario: 'Malformed/unknown historical Block',
    requiredResult: 'Safe isolated rendering; no execution or authoritative rewrite.',
  },
  {
    id: 'VIEW05',
    scenario: 'Nested query Blocks',
    requiredResult: 'One shared budget, not a fresh allowance per Block.',
  },
  {
    id: 'VIEW06',
    scenario: 'Ordinary UI edits advanced API configuration',
    requiredResult: 'Unedited semantic state preserved.',
  },
  {
    id: 'VIEW07',
    scenario: 'Stale SEO/sitemap/preview for private/erased resource',
    requiredResult: 'No leaked metadata or public delivery.',
  },
  {
    id: 'VIEW08',
    scenario: 'Main Version language fallback, metadata-only and RTL',
    requiredResult: 'Actual selection/availability, accessibility and safe empty states.',
  },
  {
    id: 'VIEW09',
    scenario: 'Changed theme dependency or expired approval',
    requiredResult:
      'Reapproval/denial; no rollback reactivation. `tests/qa/integration/theme-activation-api.test.ts` verifies expired-state reads, new approval for a changed dependency, old-key replay without head rollback, Account and Access denial, stale and concurrent writers, and Content projection recovery.',
  },
]);

// Prospective obligations under existing IDs: addressing and search metadata
// beyond the `work` namespace profile, resource summaries beyond image and
// fallback avatars, and the visual-selection design adopted on 2026-09-27.
// None is recorded evidence; each needs its own owner-backed assertion.
export const pendingPresentationSubcases = [
  { caseIds: ['VIEW02', 'VIEW07'], scenario: 'A slug, former slug or reverse lookup names a private, erased or unavailable Work',
    requiredResult: 'Resolution checks the target\'s ownership and disclosure before answering with a Work identity, redirect or canonical slug; a hidden Work\'s address answers like an absent one.', status: 'pending' },
  { caseIds: ['VIEW01', 'VIEW02'], scenario: 'A namespace beyond `work`, a scoped namespace slug or an admitted dynamic route is added',
    requiredResult: 'Precedence and parameter codecs stay deterministic, concurrent claims have one winner, slugs stay reserved and reverse links use the same canonical preference; dynamic resolvers are registered bounded capabilities, never uploaded code.', status: 'pending' },
  { caseIds: ['VIEW03'], scenario: 'A fixed-site Realm is reached by browser navigation, SSR, direct API or a shared link, including an escape attempt',
    requiredResult: 'The Realm boundary and its publication context hold on every path; no route widens disclosure.', status: 'pending' },
  { caseIds: ['VIEW02', 'VIEW07'], scenario: 'A route or metadata cache answers after revocation, identity correction or a configuration change',
    requiredResult: 'Cache keys bind the selection and the configuration and disclosure epochs; revocation and identity correction invalidate the affected entries.', status: 'pending' },
  { caseIds: ['VIEW07'], scenario: 'The web publishes sitemaps for public Works at corpus scale',
    requiredResult: 'A bounded per-resource projection maintained after accepted changes feeds fixed sitemap shards and an index; one change never scans the graph, and private, erased, unavailable or unreviewed Works never enter it. Main\'s keyset `/v1/sitemap` cannot back an index without walking every page.', status: 'pending' },
  { caseIds: ['VIEW07'], scenario: 'Work pages gain structured data',
    requiredResult: 'It exports only public, sourced semantic claims under the page\'s disclosure and names the Work by its native identity.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'A metadata-only Work appears in search results or link previews',
    requiredResult: 'Its metadata states that no text is available rather than implying a readable body.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'Work, character, concept, Context, role and relation-definition summaries carry an emoji or icon choice',
    requiredResult: 'Each returns a stable reference, selected name and non-null emoji, icon, image or fallback avatar; the shipped summary provides only image and fallback.', status: 'pending' },
  { caseIds: ['VIEW07'], scenario: 'A selected image has no available rendition',
    requiredResult: 'The summary resolves the same safe fallback, without an asset ID, URL or reason.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'Summaries show same-label classifications, or personal and Realm speech',
    requiredResult: 'Each exposes its distinct readable interpretation basis, attribution and semantic revision; a viewer preference or Realm default cannot rewrite an existing statement or exact shared link, and a hidden Context or definition does not leak.', status: 'pending' },
  { caseIds: ['VIEW05', 'VIEW08'], scenario: 'Summaries hydrate names and avatars inside a query Block',
    requiredResult: 'Hydration draws on the parent query\'s budget, not a fresh allowance.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'Emoji sequences, admitted icon IDs with background tokens and image Uses are authored as avatars',
    requiredResult: 'They round-trip as authored choices; removal resolves a stable fallback, and an unknown or retired icon falls back without discarding the saved choice.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'An avatar crop is saved and its mask changes',
    requiredResult: 'Crops are 1:1 in oriented source pixels; equal normalized width and height on a rectangular source is not square; a mask change rewrites neither the crop nor the original bytes.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'Cover and Banner ratio keys are written',
    requiredResult: 'Keys normalize to canonical positive integer ratios (`1920:1080` and `32:18` are `16:9`); duplicates after normalization and malformed or nonpositive components are rejected; distinct nearby ratios survive; keys select frames and never impose a ratio on originals.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'Several Cover and Banner ratios coexist and reuse one asset',
    requiredResult: 'Each changes independently; a 16:9 Cover and a 16:9 Banner keep different compositions; Uses of one asset share no crop, focal point or fit; rendition sizes add no ratio entries.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'An editor keeps a ratio beyond its presets, or a reader asks for a ratio without a selection',
    requiredResult: 'Editors preserve valid ratios, including when changing a known entry; reads prefer an eligible exact ratio, then only an admitted role-local full-image fallback or none; numerical proximity never authorizes a crop or a cross-role selection.', status: 'pending' },
  { caseIds: ['VIEW06', 'VIEW08'], scenario: 'A Cover or Banner update omits fields, sends null at a key or an empty map, or clears a requested context',
    requiredResult: 'Omission preserves selections; null clears only that key; an empty patch clears nothing; whole-set replacement needs explicit semantics; requested-context clearing is not absent configuration; missing images resolve without hidden references, ratio-key leaks or persisted substitutions.', status: 'pending' },
  { caseIds: ['VIEW07', 'VIEW08'], scenario: 'Visual selections are written concurrently or read from a stale descriptor',
    requiredResult: 'Selections obey current authority, expected revision and idempotency; no accepted change is lost; a stale descriptor cannot deliver a private, suppressed or erased image.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'A Post\'s attachments are edited, reordered or removed, or its preview is chosen',
    requiredResult: 'Order, original dimensions and exact identity survive; preview `auto`, `selected` and `none` stay distinct; a selected attachment is referenced by identity and survives reordering, removal resolves the authored reference, revoked media cannot leak through previews, and a separate preview image leaves the body unchanged.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'Rendered review of avatars, covers and banners',
    requiredResult: 'Circular avatar previews match the saved square; title-bearing and square covers work in contain and crop modes; simultaneous ratio selections, the default 3:1 banner and a requested alternative frame render with their actual overlays; a missing banner leaves no empty region.', status: 'pending' },
  { caseIds: ['VIEW08'], scenario: 'The candidate Feed media height budget (docs/contracts/presentation.md) meets single images, very long screenshots, panoramas and mixed-ratio sets at several widths and short and tall viewports',
    requiredResult: 'Images scale without distortion, long images expose full-image access and truncation, attachments share one bounded region in order, the composer shows the active policy, originals, crops and bytes stay unchanged, and full-image and article views keep no Feed cap. Only rendered review adopts the numbers; API checks alone are not rendered acceptance.', status: 'pending' },
] as const satisfies readonly PendingSubcase[];
