import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/governance-and-delivery.md', [
  {
    id: 'GOV01',
    scenario: 'Report exact catalog name/body/structure/asset use',
    requiredResult: 'Correct component/revision, including empty/unavailable states.',
  },
  {
    id: 'GOV02',
    scenario: 'Target/rule changes during moderation',
    requiredResult:
      'Exact evidence retained; stale basis cannot silently apply to another version.',
  },
  {
    id: 'GOV03',
    scenario: 'Competing reversals and independent Realm decisions',
    requiredResult: 'One effect per operation; other contexts preserved.',
  },
  {
    id: 'GOV04',
    scenario: 'End one rights offering while another is recognized',
    requiredResult: 'Independent history; recognition cannot reopen ended offering.',
  },
  {
    id: 'GOV05',
    scenario: 'Recipient unsubscribes/loses access before delivery',
    requiredResult: 'Current channel eligibility/disclosure applied.',
  },
  {
    id: 'GOV06',
    scenario: 'Lost external ACK or repeated callback',
    requiredResult: 'Idempotent effect or explicit uncertain reconciliation.',
  },
  {
    id: 'GOV07',
    scenario: 'Erasure conflicts with history pin/restored backup',
    requiredResult: 'Erased/unavailable result; no payload resurrection.',
  },
  {
    id: 'GOV08',
    scenario: 'Read watermark/realtime connection race',
    requiredResult: 'Declared monotonicity and gap reconciliation.',
  },
  {
    id: 'GOV09',
    scenario: 'Fit/spoiler edits race',
    requiredResult: 'Independent dimensions and populations preserved.',
  },
  {
    id: 'GOV10',
    scenario: 'Single major spoiler vote, mixed or no evidence',
    requiredResult: 'Separate protection/status/distribution and confidence policy.',
  },
  {
    id: 'GOV11',
    scenario: 'Organization has 100 units and multiple representatives/representation paths',
    requiredResult: 'Operate one entitlement; at most 100 units count.',
  },
  {
    id: 'GOV12',
    scenario: 'Representatives concurrently cast/change/withdraw the same seat, including retries',
    requiredResult:
      'Expected-revision conflict or serialized replacement; one current contribution and idempotent effect.',
  },
  {
    id: 'GOV13',
    scenario:
      'Split 100 into 40 + 60 while activating/opening the poll or submitting the old root ballot',
    requiredResult:
      'No state counts parent and children together; opening freezes one valid allocation plan.',
  },
  {
    id: 'GOV14',
    scenario:
      'Partial allocation, rounding, multiple routes to one leaf or copied root counting identity',
    requiredResult:
      'Conserve exact source units, retain residual ownership, deduplicate leaves and reject duplicate issuance.',
  },
  {
    id: 'GOV15',
    scenario:
      'Switch Person/Org attribution in a one-person poll, or share an operator across independently admitted corporate seats',
    requiredResult:
      'No extra personal entitlement; distinct corporate seats count only when admitted by the electorate.',
  },
  {
    id: 'GOV16',
    scenario: 'Mix approval signatures for different choices/revisions in a k-of-n mandate',
    requiredResult:
      'No mixed-digest approval; independence follows admitted counting/control identities, not persona count.',
  },
  {
    id: 'GOV17',
    scenario: "Internal majority is converted to an organization's external vote",
    requiredResult:
      'Charter selects whole-ballot or explicit proportional aggregation; no implicit multiplication through Access membership.',
  },
  {
    id: 'GOV18',
    scenario:
      'Representative leaves after casting, a replacement arrives, or an old snapshot is used for a new mutation',
    requiredResult:
      'Frozen weight stays with the holder; current authority governs new mutations; past ballot invalidation requires its own declared decision.',
  },
  {
    id: 'GOV19',
    scenario:
      'Proxy casts and the holder overrides; proxy is revoked or routes change during the poll',
    requiredResult:
      'Replace the same source contribution, block revoked new use and preserve the frozen routing/charter contract.',
  },
  {
    id: 'GOV20',
    scenario: 'A proxy tries to redelegate received weight or create a cycle',
    requiredResult:
      'Ordinary proxy remains one-hop; reject cycles and unsupported liquid/live-routing profiles.',
  },
  {
    id: 'GOV21',
    scenario:
      'Quorum is evaluated with several signatures on one seat or with abstaining/uncast weight',
    requiredResult:
      "Count the frozen charter's seats/people/units; signatures do not create seats.",
  },
  {
    id: 'GOV22',
    scenario: 'Crash or uncertain cross-store commit during casting/allocation and tally replay',
    requiredResult:
      'Reconcile by operation identity; current admission and replay preserve conserved quantities without duplicate effects.',
  },
  {
    id: 'GOV23',
    scenario:
      "Passing proposal exceeds the body's scope or its effect/target changes before execution",
    requiredResult:
      'No out-of-scope or retargeted execution; bind approved digest, current admitted capability and expected state.',
  },
  {
    id: 'GOV24',
    scenario: 'Rights complaint concerns one imported cover or synopsis',
    requiredResult:
      'Record notice and exact scope; apply any interim/final restriction to affected copies and uses without deleting unrelated facts.',
  },
  {
    id: 'GOV25',
    scenario: 'Counter-notice or appeal follows a rights restriction while refresh/replay runs',
    requiredResult:
      'Track the applicable process and deadlines; no automatic restoration by refresh, appeal receipt or backup replay. Authorized restoration is an attributable decision.',
  },
]);
