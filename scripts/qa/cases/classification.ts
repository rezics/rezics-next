import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/classification.md', [
  {
    id: 'CTX01',
    scenario: 'Use one object and shared Context across two Realms, an individual and Zones',
    requiredResult:
      'Shared identities/definitions with independent scoped selections, speaker authority, acceptance, ratings and adopted text.',
  },
  {
    id: 'CTX02',
    scenario: 'Local reject with inherited Global acceptance',
    requiredResult: 'Rejection suppresses; no absent-state fallback.',
  },
  {
    id: 'CTX03',
    scenario: 'Local decision is unreadable or unavailable',
    requiredResult: 'Do not infer absence or reveal private state.',
  },
  {
    id: 'CTX04',
    scenario:
      'Same label/object reaches different personal/Realm meanings while a narrower named concept exists',
    requiredResult:
      'Exact resource/definition/canon references remain independent; concept creation does not remove local reinterpretation. Global/default selection, Realm voice and personal voice stay explicit; existing statements retain their meaning. No mandatory Sense identity.',
  },
  {
    id: 'CTX05',
    scenario: 'HairColor=Red versus bare Red and EyeColor=Red',
    requiredResult:
      'Distinct meanings and judgment targets; an explicitly equivalent RedHair definition resolves the hair-color meaning without merging RedHair and Red identities.',
  },
  {
    id: 'CTX06',
    scenario: 'Union conflicting Realm rules before inference',
    requiredResult: 'Rejected plan; derivation stays context-bound.',
  },
  {
    id: 'CTX07',
    scenario: 'Different same-language preferred names',
    requiredResult: 'Context label selection preserves SKOS export validity.',
  },
  {
    id: 'CTX08',
    scenario: 'Cycle/reparent vocabulary concurrently or move a display group',
    requiredResult:
      'Admitted topology remains valid without global corpus locks; group movement creates no facts and changes no statement identity/count.',
  },
  {
    id: 'CTX09',
    scenario: 'Retire a definition used by earlier Statements or retained v1 records',
    requiredResult:
      'Old exact meaning remains resolvable; new use obeys admission; historical receipts/replay cannot reinterpret labels.',
  },
  {
    id: 'CTX10',
    scenario: 'Change one rule with many targets',
    requiredResult: 'Bounded invalidation/generation switch; no Resource x Realm rewrite.',
  },
]);
