import { relationEntries, iri, summary } from '../work-levels/fixtures.ts';
import { contentText } from '../language/untagged.ts';
import type { AvailableSummary, RelationEntry, RelationProjection } from '../work-levels/types.ts';
import type { Loaded, RatingRead, RatingSummary } from '../work-page/types.ts';
import type { IdentityData, IdentityMember, IdentitySectionKind } from './identity-relations.ts';

export const identitySummary = (id: string, name: string) =>
  summary(iri(id), name, 'en', 'resource') as AvailableSummary;
export const saber = identitySummary('501', 'Saber');
export const alter = identitySummary('502', 'Saber Alter');
export const counterpart = identitySummary('503', 'Artoria (another world)');
export const unit = identitySummary('504', 'Saber unit');
export const title = identitySummary('505', 'King of Knights');
export const holder = identitySummary('506', 'Arthur');
export const persona = identitySummary('507', 'Persona');
export const counterpartKind = identitySummary('508', 'Counterpart');
export const continuity = identitySummary('509', 'Fate/stay night');

export function identityEntry(
  from: string,
  to: string,
  target: AvailableSummary,
  kind?: AvailableSummary,
): RelationEntry {
  const projection: RelationProjection = {
    fromRole: from,
    toRole: to,
    presentation: null,
    labels: { noun: to, heading: to, plurals: { other: to }, grammaticalForms: [] },
    language: 'en',
    script: 'Latn',
    direction: contentText(to, 'en').direction,
    reviewStatus: 'reviewed',
    source: null,
    licence: null,
    fallback: null,
    arguments: [
      {
        role: to,
        type: 'resource',
        value: { kind: 'resource', ref: target.reference },
        ...(target.reference === alter.reference
          ? { creditedName: { lexical: 'Saber', language: 'en' } }
          : {}),
      },
    ],
  };
  const key =
    from === 'hub' || from === 'variant'
      ? '601'
      : from === 'unit' || from === 'character'
        ? '602'
        : '603';
  return {
    ...relationEntries[0]!,
    kind: 'occurrence',
    relation: iri(`7${target.reference.slice(-3)}`),
    rendering: {
      profile: 'relation-rendering-v1',
      meaning: { definition: iri(key), revision: iri(`${key}1`), lifecycle: 'active', roles: [] },
      occurrence: null,
      viewingRole: from,
      bindings: [
        { role: from, participant: { kind: 'resource', ref: saber.reference } },
        { role: to, participant: { kind: 'resource', ref: target.reference } },
        ...(kind ? [{ role: 'kind', participant: { kind: 'resource', ref: kind.reference } }] : []),
      ],
      projections: [projection],
    },
    counterparts: [target, ...(kind ? [kind] : [])],
  };
}

export type IdentityState = 'empty' | 'spoiler-hidden' | 'below-threshold' | 'populated';
export function identityRatings(count: number, target = saber.reference): Loaded<RatingRead> {
  const context = {
    context: iri('650'),
    question: 'How do you rate this character?',
    language: 'en',
    targetGrain: 'resource',
    scale: { min: 1, max: 10, step: 1 as const },
  };
  const summary: RatingSummary = {
    profile: 'target-rating-read-v1',
    target,
    targetGrain: 'resource',
    scope: { kind: 'realm', realm: iri('651') },
    context: context.context,
    status: 'available',
    aggregationScope: {
      question: context.question,
      language: 'en',
      grain: 'resource',
      population: 'account-principal',
      countedTarget: target,
    },
    scale: context.scale,
    count,
    mean: count >= 5 ? 8 : null,
    displayThreshold: 5,
    meanDisplay: count >= 5 ? 'shown' : count ? 'withheld-below-threshold' : 'no-data',
    distribution: Array.from({ length: 10 }, (_, i) => ({
      value: i + 1,
      count: i === 7 ? count : 0,
    })),
    sourcePosition: { dataEpoch: 'epoch', sequence: '1' },
  };
  return { ok: true, data: { contexts: [context], context, summary } };
}

export function identityData(
  kind: IdentitySectionKind,
  state: IdentityState,
): Loaded<IdentityData> {
  const count = state === 'below-threshold' ? 1 : 7;
  const member = (
    target: AvailableSummary,
    entry: RelationEntry | null,
    extra: Partial<IdentityMember> = {},
  ): IdentityMember => ({
    summary: target,
    entry,
    kind: null,
    hub: false,
    ratings: identityRatings(count, target.reference),
    applicability: [],
    ...extra,
  });
  const members =
    kind === 'family'
      ? [
          member(saber, null, { hub: true }),
          member(alter, identityEntry('hub', 'variant', alter, persona), {
            kind: persona,
            ratings: identityRatings(count + 1, alter.reference),
          }),
          member(counterpart, identityEntry('hub', 'variant', counterpart, counterpartKind), {
            kind: counterpartKind,
            ratings: identityRatings(0, counterpart.reference),
          }),
        ]
      : kind === 'units'
        ? [member(unit, identityEntry('character', 'unit', unit))]
        : kind === 'represents'
          ? [
              member(saber, identityEntry('unit', 'character', saber)),
              member(alter, identityEntry('unit', 'character', alter)),
            ]
          : kind === 'titles'
            ? [
                member(title, identityEntry('holder', 'title', title), {
                  applicability: [continuity],
                }),
              ]
            : [
                member(alter, identityEntry('title', 'holder', alter), {
                  applicability: [continuity],
                }),
                member(holder, identityEntry('title', 'holder', holder), {
                  applicability: [identitySummary('510', 'Fate/Prototype')],
                }),
              ];
  return {
    ok: true,
    data: {
      sections: [
        {
          kind,
          hub: kind === 'family' && state !== 'empty' && state !== 'spoiler-hidden' ? saber : null,
          members: state === 'empty' || state === 'spoiler-hidden' ? [] : members,
          next: state === 'populated' ? { resource: saber, cursor: 'next-visible' } : null,
        },
      ],
    },
  };
}
