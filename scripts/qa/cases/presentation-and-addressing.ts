import { defineCases } from './types.ts';

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
