import type { AuditParams, ReasonCode } from '../api/types.ts';

// `/admin/audit?range&from&to&action&outcome&reason&actor&target&request&q`:
// the explorer's filters live in the URL; a range is relative (default the
// last 7 days) so links stay useful, or custom UTC dates.

export const ranges = ['24h', '7d', '30d', '90d', 'all', 'custom'] as const;
export type Range = typeof ranges[number];
export type Outcome = NonNullable<AuditParams['outcome']>;
export interface AuditState { range: Range; from: string | null; to: string | null; action: string | null; outcome: Outcome | null;
  reason: ReasonCode | null; actor: string | null; target: string | null; request: string | null; text: string | null }

const hours: Record<Exclude<Range, 'all' | 'custom'>, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };
/** Actions an operator can filter by; others still show and can be picked from a row. */
export const knownActions = ['suspend', 'unsuspend', 'revoke-sessions', 'require-password-reset', 'resend-verification', 'add-note',
  'signal_reviewed', 'operator_role_changed', 'bulk_action_started', 'bulk_action_cancelled', 'client_disabled', 'client_enabled',
  'permission_denied', 'audit_exported', '/admin/oauth2/create-client', '/oauth2/client/rotate-secret'] as const;
export const reasonCodes: readonly ReasonCode[] = ['spam', 'abuse', 'fraud', 'impersonation', 'legal', 'compromised', 'user-request',
  'support', 'appeal', 'error-correction', 'other'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;

type Search = Record<string, string | string[] | undefined> | URLSearchParams;
const single = (search: Search, key: string) => {
  const value = search instanceof URLSearchParams ? search.get(key) : search[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() ? text.trim().slice(0, 256) : null;
};
const validDay = (value: string | null) => value && day.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;

export function readAuditState(search: Search): AuditState {
  const range = single(search, 'range');
  const outcome = single(search, 'outcome');
  const reason = single(search, 'reason');
  const request = single(search, 'request');
  const [from, to] = [validDay(single(search, 'from')), validDay(single(search, 'to'))];
  const custom = range === 'custom' && (from || to);
  return { range: custom ? 'custom' : ranges.includes(range as Range) && range !== 'custom' ? range as Range : '7d',
    from: custom ? from : null, to: custom ? to : null, action: single(search, 'action'),
    outcome: outcome === 'succeeded' || outcome === 'failed' || outcome === 'attempted' ? outcome : null,
    reason: reasonCodes.includes(reason as ReasonCode) ? reason as ReasonCode : null,
    actor: single(search, 'actor'), target: single(search, 'target'), request: request && uuid.test(request) ? request.toLowerCase() : null,
    text: single(search, 'q') };
}

export function auditHref(state: AuditState): string {
  const params = new URLSearchParams();
  if (state.range !== '7d') params.set('range', state.range);
  if (state.range === 'custom') for (const key of ['from', 'to'] as const) if (state[key]) params.set(key, state[key]!);
  for (const key of ['action', 'outcome', 'reason', 'actor', 'target', 'request'] as const) if (state[key]) params.set(key, state[key]!);
  if (state.text) params.set('q', state.text);
  const query = params.toString();
  return `/admin/audit${query ? `?${query}` : ''}`;
}

/** The next day's first instant: custom ranges include their last day. */
const dayAfter = (value: string) => new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString();

export function auditParams(state: AuditState, now = Date.now()): AuditParams {
  const period = state.range === 'custom' ? { ...(state.from ? { from: `${state.from}T00:00:00.000Z` } : {}),
    ...(state.to ? { to: dayAfter(state.to) } : {}) }
    : state.range === 'all' ? {} : { from: new Date(now - hours[state.range] * 3_600_000).toISOString() };
  return { limit: 50, ...period, ...(state.action ? { action: state.action } : {}), ...(state.outcome ? { outcome: state.outcome } : {}),
    ...(state.reason ? { reasonCode: state.reason } : {}), ...(state.actor ? { actorId: state.actor } : {}),
    ...(state.target ? { targetId: state.target } : {}), ...(state.request ? { requestId: state.request } : {}),
    ...(state.text ? { q: state.text } : {}) };
}

export const filtered = (state: AuditState) => !!(state.action || state.outcome || state.reason || state.actor || state.target
  || state.request || state.text);

/** The search box's text as filters: `actor:`, `target:` and `request:`
 * (quoted when they hold a space), a bare request ID, and the rest as text
 * to find in reasons and messages. */
export function parseAuditSearch(input: string): Pick<AuditState, 'actor' | 'target' | 'request' | 'text'> {
  const found: Pick<AuditState, 'actor' | 'target' | 'request' | 'text'> = { actor: null, target: null, request: null, text: null };
  const words: string[] = [];
  for (const [, key, quoted, bare] of input.matchAll(/(?:(actor|target|request):)?(?:"([^"]*)"?|(\S+))/gi)) {
    const value = (quoted ?? bare ?? '').trim();
    if (!value) continue;
    const name = key?.toLowerCase();
    if (name === 'actor' || name === 'target') found[name] = value;
    else if ((name === 'request' || !name) && uuid.test(value)) found.request = value.toLowerCase();
    else words.push(name ? `${name}:${value}` : value);
  }
  found.text = words.join(' ').slice(0, 200) || null;
  return found;
}

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
