import { describe, expect, test } from 'bun:test';
import { type AuditState, auditHref, auditParams, changes, parseAuditSearch, readAuditState } from './state.ts';

const empty: AuditState = { range: '7d', from: null, to: null, action: null, outcome: null, reason: null, actor: null, target: null, request: null,
  text: null };

describe('audit explorer state', () => {
  test('defaults to the last 7 days and keeps filters in the URL', () => {
    const state = readAuditState({});
    expect(state).toEqual(empty);
    expect(auditHref(state)).toBe('/admin/audit');
    const now = Date.parse('2026-09-28T00:00:00Z');
    expect(auditParams(state, now)).toEqual({ limit: 50, from: '2026-09-21T00:00:00.000Z' });
    const filtered = readAuditState(new URLSearchParams('range=all&action=suspend&outcome=failed&actor=u1&target=u2&reason=spam&q=%231182&extra=x'));
    expect(auditHref(filtered)).toBe('/admin/audit?range=all&action=suspend&outcome=failed&reason=spam&actor=u1&target=u2&q=%231182');
    expect(auditParams(filtered, now)).toEqual({ limit: 50, action: 'suspend', outcome: 'failed', reasonCode: 'spam', actorId: 'u1',
      targetId: 'u2', q: '#1182' });
    expect(readAuditState({ range: 'forever', outcome: 'maybe', reason: 'vibes', request: 'not-a-uuid' }))
      .toMatchObject({ range: '7d', outcome: null, reason: null, request: null });
  });

  test('custom dates are whole UTC days, both included', () => {
    const custom = readAuditState({ range: 'custom', from: '2026-09-01', to: '2026-09-15' });
    expect(auditParams(custom)).toEqual({ limit: 50, from: '2026-09-01T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' });
    expect(auditHref(custom)).toBe('/admin/audit?range=custom&from=2026-09-01&to=2026-09-15');
    // A custom range without a valid date falls back to the default period.
    expect(readAuditState({ range: 'custom', from: '2026-13-45' })).toMatchObject({ range: '7d', from: null });
  });

  test('the search box reads people, a request and text', () => {
    const id = '6D1F3C1E-3B7A-4F5E-9A51-2F6C0A1D7E11';
    expect(parseAuditSearch(`actor:olive@rezics.test report #1182 target:"u 2"`)).toEqual({ actor: 'olive@rezics.test', target: 'u 2',
      request: null, text: 'report #1182' });
    expect(parseAuditSearch(` ${id} `)).toEqual({ actor: null, target: null, request: id.toLowerCase(), text: null });
    expect(parseAuditSearch('request:nope')).toMatchObject({ request: null, text: 'request:nope' });
    expect(readAuditState({ request: id }).request).toBe(id.toLowerCase());
  });

  test('a record shows only the fields that changed', () => {
    expect(changes({ status: 'active', name: 'Ada' }, { status: 'suspended', name: 'Ada' }))
      .toEqual([{ key: 'status', before: 'active', after: 'suspended' }]);
    expect(changes({ role: null }, { role: 'admin' })).toEqual([{ key: 'role', before: null, after: 'admin' }]);
    expect(changes(null, null)).toEqual([]);
    expect(changes(null, { rows: 3 })).toEqual([{ key: '', before: null, after: { rows: 3 } }]);
  });
});
