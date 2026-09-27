import { describe, expect, test } from 'bun:test';
import { auditHref, auditParams, changes, readAuditState } from './state.ts';

describe('audit explorer state', () => {
  test('defaults to the last 7 days and keeps filters in the URL', () => {
    const state = readAuditState({});
    expect(state).toEqual({ range: '7d', action: null, outcome: null, actor: null, target: null });
    expect(auditHref(state)).toBe('/admin/audit');
    const now = Date.parse('2026-09-28T00:00:00Z');
    expect(auditParams(state, now)).toEqual({ limit: 50, from: '2026-09-21T00:00:00.000Z' });
    const filtered = readAuditState(new URLSearchParams('range=all&action=suspend&outcome=failed&actor=u1&target=u2&extra=x'));
    expect(auditHref(filtered)).toBe('/admin/audit?range=all&action=suspend&outcome=failed&actor=u1&target=u2');
    expect(auditParams(filtered, now)).toEqual({ limit: 50, action: 'suspend', outcome: 'failed', actorId: 'u1', targetId: 'u2' });
    expect(readAuditState({ range: 'forever', outcome: 'maybe' })).toMatchObject({ range: '7d', outcome: null });
  });

  test('a record shows only the fields that changed', () => {
    expect(changes({ status: 'active', name: 'Ada' }, { status: 'suspended', name: 'Ada' }))
      .toEqual([{ key: 'status', before: 'active', after: 'suspended' }]);
    expect(changes({ role: null }, { role: 'admin' })).toEqual([{ key: 'role', before: null, after: 'admin' }]);
    expect(changes(null, null)).toEqual([]);
    expect(changes(null, { rows: 3 })).toEqual([{ key: '', before: null, after: { rows: 3 } }]);
  });
});
