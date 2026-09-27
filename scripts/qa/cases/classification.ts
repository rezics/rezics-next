import { defineCases } from './types.ts';

const baseCases = defineCases('docs/testing/classification.md', [
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

type CtxCaseId = 'CTX01' | 'CTX02' | 'CTX03' | 'CTX04' | 'CTX05'
  | 'CTX06' | 'CTX07' | 'CTX08' | 'CTX09' | 'CTX10';

// Additional obligations of the shared Context and replacement Statement profiles.
// The original scenario/requiredResult fields stay byte-for-byte stable for the
// B00 migration digest; qualification must review these subcases as well.
export const qualifyingSubcases = {
  CTX01: [
    'One Realm-free public Context revision is eligible for two Realms and one private personal selection; a Realm can retain Global for another scope.',
    'Shared definitions do not merge speakers, acceptance, voters, ratings or adopted text. Personal and authorized Realm statements keep separate voice and meaning.',
    'Eligible public use needs no creator-Realm membership and grants neither Context edit nor Realm speech; allowed, denied, revoked, stale, replayed and concurrent transitions retain receipts.',
    'Statement creation allocates no mandatory Scheme, Path, Expression, Sense or Application companions; independent supports remain identifiable.',
  ],
  CTX02: [
    'Fallback compares exact meaning: broad Global acceptance cannot satisfy a narrower local criterion without admitted mapping and evidence.',
    'Only confirmed absence or withdrawal may inherit; local rejection suppresses. Resolve before grouping and never fabricate votes or leak protected support.',
  ],
  CTX03: [
    'Hidden Context/base/definition, missing retained revision and unresolved or disabled entries never become absence or public fallback.',
    'Private selection reveals no identity or count; public statements expose a readable basis or an incomplete/unavailable outcome.',
    'Faulted graph reads fail closed without leaking decision IDs or private errors.',
  ],
  CTX04: [
    'Global may hold a complete specialist definition without a Realm. Omitted default, explicit Global and explicit local choices differ; polysemy yields candidates or ambiguity.',
    'Both 後宮 and 真後宮 can have independent Realm/personal interpretations; neither name settles open-ending, cohabitation or marriage criteria.',
    'Concept creation never forces a rename, deletion, automatic equivalence or Sense identity. Authored statements retain meaning.',
    'Criterion change alters qualified meaning; evidence disagreement and preference do not.',
  ],
  CTX05: [
    'Bare Red, hairColor=Red and eyeColor=Red have distinct meaning and judgment targets.',
    'A reviewed RedHair pattern agrees with its expanded Statement without merging RedHair and Red identities; unmapped source terms gain no equivalence.',
    'Relation, value, definition and applicability qualify meaning. Contexts with the same exact definition may share a meaning key but retain separate support and decisions.',
  ],
  CTX06: [
    'Explicit selection precedes admitted speaker object/relation, object, domain and default scopes, disclosed entry default and Global.',
    'Equal-priority overlap, pinned-base cycles and over-budget depth fail explicitly; conflicting Realm rules cannot be unioned before derivation.',
    'Derived results retain the selected exact Context closure and provenance.',
  ],
  CTX07: [
    'Same-language preferred names remain Context-scoped and SKOS export stays valid.',
    'Language, name, emphasis, avatar or order changes preserve semantic and authored Statement/filter pins.',
  ],
  CTX08: [
    'Concurrent reparenting has one expected-head winner and leaves an acyclic topology without a global corpus lock.',
    'A successor does not advance pinned consumers or Statements; adoption has its own CAS and derived Contexts retain their base.',
    'Display groups and navigation paths create no facts and cannot multiply Statement identity or counts.',
  ],
  CTX09: [
    'Retirement blocks new use while old exact Statement meaning remains readable under current disclosure.',
    'Retire, restore and replay retain definitions, selections, speaker, decisions, private ownership and immutable v1 receipts; labels never reinterpret history.',
    'New semantic revisions do not silently retarget retained statements or selections.',
  ],
  CTX10: [
    'Rule changes switch only dependent generations through bounded pages; unrelated consumers and Statements do not enlarge one-slot resolution.',
    'No member scan, per-object interpretation calls, Cartesian Resource x Realm rewrite or semantic rewrite on preference-only changes.',
    'Overlapping display groups and navigation paths cannot multiply targets or rewrite facts.',
  ],
} as const satisfies Record<CtxCaseId, readonly string[]>;

export const cases = baseCases.map(row => {
  const subcases = qualifyingSubcases[row.id as CtxCaseId];
  if (!subcases) throw new Error(`missing qualifying CTX subcases: ${row.id}`);
  return { ...row, qualifyingSubcases: subcases };
});
