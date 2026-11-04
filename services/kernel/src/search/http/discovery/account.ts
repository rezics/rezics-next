import type { Static } from 'typebox';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { CoverSummarySchema } from '../../../semantic/http/summaries.ts';
import { MatchEvidenceSchema } from '../../http/match-evidence-schema.ts';
import { closed, id, nullableText, key, unavailable, evidenceOrDefault, admitIdentity } from './primitives.ts';
import { AccountContextSchema } from '../../account-context-http.ts';
import { ACCOUNT_CONTEXT_LIMITS } from '../../account-context.ts';
const accountSummary = t.Object(
  {
    context: t.Optional(AccountContextSchema),
    id,
    accountKind: t.Union([t.Literal('actor'), t.Literal('organization')]),
    handle: nullableText,
    displayName: nullableText,
    automated: t.Boolean(),
    operatorId: t.Union([id, t.Null()]),
    avatar: t.Union([t.Object({ ...CoverSummarySchema.anyOf[0].properties, credit: t.Null() }, closed), t.Null()]),
    verifiedAgent: t.Union([t.Object({ id, label: t.String(), type: t.String() }, closed), t.Null()]),
  },
  closed,
);
export const AccountHitSchema = t.Object(
  {
    key: key('accounts'),
    summary: t.Object({ kind: t.Literal('account'), value: accountSummary }, closed),
    matchEvidence: MatchEvidenceSchema,
  },
  closed,
);

export type AccountHttpHit = Static<typeof AccountHitSchema>;
type AccountHit = Extract<DiscoveryUnionHit, { summary: { kind: 'account' } }>;
const check = Compile(AccountHitSchema);

export function admitAccountHit(value: unknown): asserts value is AccountHit {
  const admitted = evidenceOrDefault(value);
  if (!check.Check(admitted)) unavailable();
  const hit = admitted as AccountHttpHit;
  admitIdentity(hit);
  const { key, summary, matchEvidence } = hit;
  if (key.owner !== 'accounts' || key.kind !== 'account') unavailable();
  if (matchEvidence.state !== 'unsupported') unavailable();
  const context = summary.value.context;
  if (context && (Buffer.byteLength(JSON.stringify(context)) > ACCOUNT_CONTEXT_LIMITS.contextBytes ||
      (context.biography.state === 'available' && Buffer.byteLength(context.biography.text) > ACCOUNT_CONTEXT_LIMITS.biographyBytes))) unavailable();
}

/** Detach all nested native values; later owner mutation cannot change the admitted response. */
export function serializeAccountHit(hit: AccountHit): AccountHttpHit {
  return structuredClone(evidenceOrDefault(hit)) as AccountHttpHit;
}
