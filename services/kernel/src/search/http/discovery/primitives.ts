import { memoizedValue } from '../../../memoized.ts';
import { t } from 'elysia';
import { LIST_CURSOR_BOUNDS } from '../../../tokens/list-cursor.ts';
import { routeOf } from '../../../route/route.ts';
import { SearchUnavailableError } from '../../opensearch.ts';
import type { DiscoveryUnionHit } from '../../discovery.ts';
import type { MatchEvidence } from '../../match-evidence.ts';
export const closed = { additionalProperties: false } as const;
export const id = t.String({ format: 'uuid' });
export const nullableText = t.Union([t.String(), t.Null()]);
export function continuationToken() {
  return memoizedValue(continuationToken, () =>
    t.String({ minLength: 1, maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength }),
  );
}
export function continuation() {
  return memoizedValue(continuation, () => t.Union([continuationToken(), t.Null()]));
}
export const key = <Owner extends 'semantic' | 'accounts'>(owner: Owner) =>
  t.Object(
    {
      owner: t.Literal(owner),
      kind: owner === 'accounts' ? t.Literal('account') : t.String(),
      route: t.Integer({ minimum: 0, maximum: 65535 }),
      id,
    },
    closed,
  );
export const unavailable = (): never => {
  throw new SearchUnavailableError('Discovery response is incomplete or malformed');
};

export function evidenceOrDefault(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const hit = value as Record<string, unknown>;
  if ('matchEvidence' in hit) return hit;
  const summary = hit.summary as { kind?: unknown } | undefined;
  return {
    ...hit,
    matchEvidence: summary?.kind === 'subject' ? { state: 'absent' } : { state: 'unsupported' },
  };
}

export function evidenceOf(hit: DiscoveryUnionHit): MatchEvidence {
  return hit.matchEvidence ?? (hit.summary.kind === 'subject' ? { state: 'absent' } : { state: 'unsupported' });
}

export function admitIdentity(hit: { key: { id: string; route: number }; summary: { value: { id: string } } }) {
  if (routeOf(hit.key.id) !== hit.key.route || hit.key.id !== hit.summary.value.id) unavailable();
}
