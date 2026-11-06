import { memoizedValue } from '../../../memoized.ts';
import { SpaceEntryPresentationSchema } from '../../../community/space-discovery-entry-contract.ts';
import type { Static } from 'typebox';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import { MatchEvidenceSchema } from '../match-evidence-schema.ts';
import { closed, id, nullableText, key, unavailable, evidenceOrDefault, admitIdentity } from './primitives.ts';
function spaceKey() {
  return memoizedValue(spaceKey, () =>
    t.Object(
      { owner: t.Literal('community'), kind: t.Literal('space'), route: t.Integer({ minimum: 0, maximum: 65535 }), id },
      closed,
    ),
  );
}
function spaceSummary() {
  return memoizedValue(spaceSummary, () =>
    t.Object(
      {
        presentation: t.Optional(SpaceEntryPresentationSchema),
        id,
        title: t.String({ minLength: 1 }),
        address: t.String({ minLength: 1, maxLength: 256 }),
        summary: t.Optional(t.String()),
        realm: t.Optional(t.Union([t.Object({ id, title: nullableText }, closed), t.Null()])),
      },
      closed,
    ),
  );
}
export function SpaceHitSchema() {
  return memoizedValue(SpaceHitSchema, () =>
    t.Object(
      {
        key: spaceKey(),
        summary: t.Object({ kind: t.Literal('space'), value: spaceSummary() }, closed),
        matchEvidence: MatchEvidenceSchema,
      },
      closed,
    ),
  );
}

export type SpaceHttpHit = Static<ReturnType<typeof SpaceHitSchema>>;
type SpaceHit = Extract<DiscoveryUnionHit, { summary: { kind: 'space' } }>;
function check() {
  return memoizedValue(check, () => Compile(SpaceHitSchema()));
}

export function admitSpaceHit(value: unknown): asserts value is SpaceHit {
  const admitted = evidenceOrDefault(value);
  if (!check().Check(admitted)) unavailable();
  const hit = admitted as SpaceHttpHit;
  admitIdentity(hit);
  const { key, summary, matchEvidence } = hit;
  if (key.owner !== 'community' || key.kind !== 'space') unavailable();
  if (matchEvidence.state !== 'unsupported') unavailable();
}

/** Detach all nested native values; later owner mutation cannot change the admitted response. */
export function serializeSpaceHit(hit: SpaceHit): SpaceHttpHit {
  return structuredClone(evidenceOrDefault(hit)) as SpaceHttpHit;
}
import type { DiscoveryHttpPage } from './page.ts';
export function admitSpaceEntries(page: DiscoveryHttpPage) {
  const spaces = page.hits.filter((hit) => hit.summary.kind === 'space');
  for (const hit of spaces) {
    if (hit.summary.kind !== 'space') continue;
    const value = hit.summary.value,
      presentation = value.presentation;
    if (
      presentation &&
      (presentation.identity.id !== (value.realm?.id ?? value.id) ||
        presentation.identity.kind !== (value.realm ? 'realm' : 'space') ||
        (presentation.avatar.state === 'available' && presentation.avatar.realmId !== value.realm?.id))
    )
      unavailable();
  }
  if (page.spaceEntries) {
    if (page.spaceEntries.rows.length !== spaces.length || Buffer.byteLength(JSON.stringify(page.spaceEntries)) > 65536)
      unavailable();
    page.spaceEntries.rows.forEach((row, index) => {
      const hit = spaces[index]!;
      if (hit.summary.kind !== 'space') return unavailable();
      const value = hit.summary.value;
      if (
        !value.presentation ||
        row.id !== hit.key.id ||
        (row.destination.kind === 'realm' && row.destination.realmId !== value.realm?.id) ||
        (row.destination.kind === 'space' &&
          (value.realm || row.destination.spaceId !== value.id || row.destination.address !== value.address)) ||
        (row.entry === 'allowed' && row.destination.kind === 'unavailable') ||
        (page.spaceEntries!.reader === null
          ? row.follow.state !== 'sign-in'
          : row.follow.state === 'sign-in' || (row.follow.state === 'current' && row.follow.action === 'sign-in'))
      )
        unavailable();
    });
  }
}
