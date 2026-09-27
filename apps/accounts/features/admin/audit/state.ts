import type { AuditParams } from '../api/types.ts';

// `/admin/audit?range&action&outcome&actor&target`: the explorer's filters live
// in the URL; a range is relative (default the last 7 days) so links stay useful.

export const ranges = ['24h', '7d', '30d', '90d', 'all'] as const;
export type Range = typeof ranges[number];
export type Outcome = NonNullable<AuditParams['outcome']>;
export interface AuditState { range: Range; action: string | null; outcome: Outcome | null; actor: string | null; target: string | null }

const hours: Record<Exclude<Range, 'all'>, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };
/** Actions an operator can filter by; others still show and can be picked from a row. */
export const knownActions = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset', 'resend-verification', 'add-note',
  'operator_role_changed', 'bulk_action_started', 'client_disabled', 'client_enabled', 'permission_denied', 'audit_exported',
  '/admin/oauth2/create-client', '/oauth2/client/rotate-secret'] as const;

type Search = Record<string, string | string[] | undefined> | URLSearchParams;
const single = (search: Search, key: string) => {
  const value = search instanceof URLSearchParams ? search.get(key) : search[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() ? text.trim().slice(0, 256) : null;
};

export function readAuditState(search: Search): AuditState {
  const range = single(search, 'range');
  const outcome = single(search, 'outcome');
  return { range: ranges.includes(range as Range) ? range as Range : '7d', action: single(search, 'action'),
    outcome: outcome === 'succeeded' || outcome === 'failed' || outcome === 'attempted' ? outcome : null,
    actor: single(search, 'actor'), target: single(search, 'target') };
}

export function auditHref(state: AuditState): string {
  const params = new URLSearchParams();
  if (state.range !== '7d') params.set('range', state.range);
  for (const key of ['action', 'outcome', 'actor', 'target'] as const) if (state[key]) params.set(key, state[key]!);
  const query = params.toString();
  return `/admin/audit${query ? `?${query}` : ''}`;
}

export function auditParams(state: AuditState, now = Date.now()): AuditParams {
  return { limit: 50, ...(state.range === 'all' ? {} : { from: new Date(now - hours[state.range] * 3_600_000).toISOString() }),
    ...(state.action ? { action: state.action } : {}), ...(state.outcome ? { outcome: state.outcome } : {}),
    ...(state.actor ? { actorId: state.actor } : {}), ...(state.target ? { targetId: state.target } : {}) };
}

export const filtered = (state: AuditState) => !!(state.action || state.outcome || state.actor || state.target);

/** The fields whose values differ between an audit record's before and after summaries. */
export function changes(before: unknown, after: unknown): { key: string; before: unknown; after: unknown }[] {
  const object = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const left = object(before);
  const right = object(after);
  if (!left || !right) return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ key: '', before, after }];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map(key => ({ key, before: left[key], after: right[key] }));
}
