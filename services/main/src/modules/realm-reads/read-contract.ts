import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName, readPosition, WORK_READ_COST, workCard }
  from '../work/read-contract.ts';
import { ZonePresentation } from '../zone/presentation-format.ts';

export const realmHeader = t.Object({ profile: t.Literal('realm-read-v1'), id: readId,
  space: readId, revision: readId, name: readName, icon: readAvatar,
  visibility: t.Union([t.Literal('public'),t.Literal('restricted'),t.Literal('private')]),
  reviewMode: t.Union([t.Literal('mandatory'),t.Literal('trusted-members'),t.Literal('open')]),
  policyRevision: t.Nullable(t.String()),
  profileRevision: t.Nullable(readId), description: t.Nullable(readName),
  banner: t.Nullable(readAvatar),
  rules: t.Nullable(t.Array(t.Object({ id: t.String(), title: readName,
    body: readName, governanceRule: t.Nullable(t.Object({ ref: t.String(),
      revision: t.String() })) }), { maxItems: 12 })),
  membership: t.Object({ count: t.Union([
    t.Object({ kind: t.Literal('unknown'), value: t.Null() }),
    t.Object({ kind: t.Literal('exact'), value: t.Integer({ minimum: 0 }), revision: t.String() }),
    t.Object({ kind: t.Literal('estimated'), value: t.Integer({ minimum: 0 }) }),
  ]),
    publicMembers: t.Null() }),
  moderators: t.Object({ kind: t.Union([t.Literal('unknown'), t.Literal('known')]),
    items: t.Array(readId, { maxItems: 16 }) }),
  sourcePosition: readPosition,
  links: t.Object({ works: t.String(), decisions: t.String() }) });

export const realmWork = t.Object({ ...workCard.properties, selection: readId,
  contribution: readId, language: t.String() });
export const realmWorksPage = t.Object({ profile: t.Literal('realm-works-v1'),
  items: t.Array(realmWork), ...pageFields });

export const realmDecision = t.Object({ id: readId,
  kind: t.Union([t.Literal('adoption'), t.Literal('classification'),
    t.Literal('semantic-rule-change')]),
  dataEpoch: t.String(), sequence: t.String(),
  work: t.Nullable(readId), subject: t.Nullable(readId),
  outcome: t.Nullable(t.Union([t.Literal('accepted'), t.Literal('rejected')])) });
export const realmDecisionsPage = t.Object({ profile: t.Literal('realm-decisions-v1'),
  items: t.Array(realmDecision), ...pageFields });
export const realmDecisionRead = t.Object({ profile: t.Literal('realm-decision-v1'),
  ...realmDecision.properties, sourcePosition: readPosition });
export const realmZoneRead = t.Object({ profile: t.Literal('realm-zone-v1'), realm: readId,
  zone: readId, routeSegment: t.Nullable(t.String()), revision: readId,
  presentation: ZonePresentation, presentationUrl: t.String(), sourcePosition: readPosition });

/** Shares the measured Work envelope. Candidate discovery can still scan/sort the Realm relation. */
export const REALM_READ_COST = { ...WORK_READ_COST,
  candidateRows: 21, typeRows: 160, restoreEdges: 32 } as const;
