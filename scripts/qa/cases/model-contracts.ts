import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/model-contracts.md', [
  {
    id: 'MODEL01',
    scenario: 'Create multiple semantic types on one Resource',
    requiredResult: 'Stable identity; capability admission remains independent.',
  },
  {
    id: 'MODEL02',
    scenario: 'Round-trip zero/false/empty/absent/unknown/no-value',
    requiredResult: 'No conflation in storage/query/API/export.',
  },
  {
    id: 'MODEL03',
    scenario: 'Use huge integer/exact fractional quantity',
    requiredResult: 'No loss through JSON numeric conversion.',
  },
  {
    id: 'MODEL04',
    scenario: 'Store temporal offset/precision/calendar and language direction',
    requiredResult: 'Original meaning survives engine normalization.',
  },
  {
    id: 'MODEL05',
    scenario: 'Repeat same participants in two associations',
    requiredResult: 'Role predicates bind one identified occurrence.',
  },
  {
    id: 'MODEL06',
    scenario: 'Retire/change a semantic definition',
    requiredResult: 'Old exact interpretation remains resolvable.',
  },
  {
    id: 'MODEL07',
    scenario: 'Move physical placement',
    requiredResult: 'Native identity and retained revision references remain valid.',
  },
  {
    id: 'MODEL08',
    scenario: 'Classify a resource as privileged/executable',
    requiredResult: 'No permission/capability is granted.',
  },
  {
    id: 'MODEL09',
    scenario: 'Ingest source reification without adoption',
    requiredResult: 'No alleged base edge becomes accepted native truth.',
  },
  {
    id: 'MODEL10',
    scenario: 'Use missing private/external reference',
    requiredResult: 'Typed unavailable state without identity fabrication or disclosure.',
  },
  {
    id: 'MODEL11',
    scenario: 'Anchor resolver crashes after the source transaction commits',
    requiredResult:
      'Rebuild locator from retained anchor metadata and immutable objects; missing committed payload is unavailable, never guessed HEAD.',
  },
  {
    id: 'MODEL12',
    scenario: 'Garbage collection or relocation sees a retained exact anchor',
    requiredResult:
      'Preserve its required history/payload or complete the explicit retirement contract first.',
  },
  {
    id: 'MODEL13',
    scenario: 'Use a standard Statement/Annotation/Label/ListItem with admitted local fields',
    requiredResult:
      'Profile preserves claim/target/lexical/occurrence meaning without requiring a duplicate local class.',
  },
  {
    id: 'MODEL14',
    scenario: 'Add an unrelated admitted semantic type/property',
    requiredResult:
      'Open resource shapes preserve multi-type data; closed component shapes apply only to their owned projection.',
  },
  {
    id: 'MODEL15',
    scenario: 'Remove type/profile/target predicate during an invalid edit',
    requiredResult:
      'Owning command still selects its required validation; no vacuous pass bypasses lifecycle rules.',
  },
  {
    id: 'MODEL16',
    scenario: "Edit a referenced child's state/type without editing its parent",
    requiredResult:
      'Validate the complete affected dependency footprint or reject/stage the transition; no invalid parent is silently retained.',
  },
  {
    id: 'MODEL17',
    scenario: 'Supply unsupported shape terms, no shapes, or no expected focus',
    requiredResult:
      'Activation fails with explicit unsupported/coverage outcome, even if a generic validator reports conformance.',
  },
  {
    id: 'MODEL18',
    scenario: 'Two new states each pass SHACL but race the same expected head',
    requiredResult:
      'Only one admitted mutation commits with its own receipt; no losing success event.',
  },
  {
    id: 'MODEL19',
    scenario: 'OWL functional/key inference encounters distinct native IDs',
    requiredResult:
      'No automatic native merge or authority pooling; reject inappropriate identity axioms in the selected reasoning profile.',
  },
  {
    id: 'MODEL20',
    scenario: 'Source/Realm union or partial rule closure appears to yield an answer',
    requiredResult:
      'No unqualified accepted fact, silent fallback, exact count or authorization is derived.',
  },
  {
    id: 'MODEL21',
    scenario: 'Bulk import or validation-mode override attempts to reach native state',
    requiredResult:
      'Owner-controlled staging/activation and fixed reject posture preserve the active profile.',
  },
  {
    id: 'MODEL22',
    scenario: 'Model/rule generation changes during a prepared command',
    requiredResult:
      'Commit guards reject or revalidate the command; old exact interpretations remain resolvable.',
  },
  {
    id: 'MODEL23',
    scenario: 'Prepare candidate, then insert a previously absent dependent/slot',
    requiredResult:
      'Complete dependency/absence guards reject stale validation; no phantom admission.',
  },
  {
    id: 'MODEL24',
    scenario: 'Configure a Fuseki SHACL report endpoint, then attempt raw native writes',
    requiredResult:
      'Product ingress blocks the bypass; endpoint availability is never treated as automatic update validation.',
  },
  {
    id: 'MODEL25',
    scenario: 'Edit current state and compact TDB2, then resolve an old revision',
    requiredResult:
      'Immutable manifest/payload still reproduces exact state; no internal MVCC generation is required.',
  },
  {
    id: 'MODEL26',
    scenario: 'Missing/corrupt revision object or mutable context dependency',
    requiredResult:
      'Typed unavailable/corrupt outcome and recovery; never current-head substitution or guessed lexical values.',
  },
  {
    id: 'MODEL27',
    scenario:
      'Main helper times out, sees no expected focus, or validates only part of the candidate',
    requiredResult: 'No activation receipt; report completion and required coverage are enforced.',
  },
]);
