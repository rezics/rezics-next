import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName, readPosition, WORK_READ_COST, workCard }
  from '../work/read-contract.ts';

export const realmHeader = t.Object({ profile: t.Literal('realm-read-v1'), id: readId,
  space: readId, revision: readId, name: readName, icon: readAvatar,
  description: t.Null(), banner: t.Null(), rules: t.Null(),
  membership: t.Object({ count: t.Object({ kind: t.Literal('unknown'), value: t.Null() }),
    publicMembers: t.Null() }),
  moderators: t.Object({ kind: t.Literal('unknown'), items: t.Array(readId, { maxItems: 0 }) }),
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

/** Shares the measured Work envelope. Candidate discovery can still scan/sort the Realm relation. */
export const REALM_READ_COST = { ...WORK_READ_COST,
  candidateRows: 21, typeRows: 160, restoreEdges: 32 } as const;
