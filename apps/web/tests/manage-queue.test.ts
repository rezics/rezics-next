import { describe, expect, test } from 'bun:test';
import { commandFailure } from '../features/manage/commands.ts';
import { impactLines, removesOwnRoleManagement, sortPermissions } from '../features/manage/permissions.ts';
import { actionsFor, commonActions, initialTriage, targetIds, triage, type TriageState, UNDO_WINDOW_MS,
  visibleIds } from '../features/manage/queue-state.ts';
import { forget, parseRemembered, remember, serializeRemembered } from '../features/manage/remembered.ts';
import { logHref, parseLogView, parseQueueView, queueHref } from '../features/manage/routes.ts';
import type { ModerationItem } from '../features/manage/types.ts';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = (n: number) => iri(n).slice(-36);

function submission(n: number, overrides: Partial<ModerationItem> = {}): ModerationItem {
  return { id: uuid(n), kind: 'contribution_submission', state: 'open', generation: '1', decisionHead: null,
    openedAt: '2026-09-28T01:00:00.000Z', authorAgent: iri(900), reasonCode: null, escalation: null,
    target: { owner: 'graph', resource: iri(100 + n), component: iri(200 + n) }, context: iri(1),
    submission: { revision: uuid(300 + n), state: 'pending', contribution: iri(200 + n), publicationDecision: iri(400 + n),
      selectedDraft: iri(500 + n), correctionOf: null }, ...overrides };
}

function report(n: number, overrides: Partial<ModerationItem> = {}): ModerationItem {
  return { ...submission(n), kind: 'content_report', reasonCode: 'title_review', submission: null,
    target: { owner: 'graph', resource: iri(100 + n), component: 'title' }, ...overrides };
}

const escalation = { id: uuid(700), reason: 'Owners should check', actingSubject: iri(901),
  escalatedAt: '2026-09-28T02:00:00.000Z', target: 'owners' as const };

describe('what a moderator can decide', () => {
  test('pending submissions allow every decision; reports only escalate until Main returns their basis', () => {
    expect([...actionsFor(submission(1))]).toEqual(['approve', 'reject', 'request-changes', 'escalate']);
    expect([...actionsFor(report(2))]).toEqual(['escalate']);
    expect([...actionsFor(report(3, { escalation }))]).toEqual([]);
    expect([...actionsFor(submission(4, { escalation }))]).toEqual(['approve', 'reject', 'request-changes']);
  });

  test('closed items and submissions being applied allow nothing', () => {
    expect(actionsFor(submission(1, { state: 'closed' })).size).toBe(0);
    const deciding = submission(2);
    deciding.submission = { ...deciding.submission!, state: 'deciding' };
    expect(actionsFor(deciding).size).toBe(0);
  });

  test('a bulk decision offers only what every selected item allows', () => {
    let state = initialTriage([submission(1), submission(2), report(3)]);
    expect([...commonActions(state, [uuid(1), uuid(2)])]).toEqual(['approve', 'reject', 'request-changes', 'escalate']);
    expect([...commonActions(state, [uuid(1), uuid(3)])]).toEqual(['escalate']);
    state = triage(state, { type: 'toggle', id: uuid(1) });
    state = triage(state, { type: 'toggle', id: uuid(3) });
    expect(targetIds(state)).toEqual([uuid(1), uuid(3)]);
  });
});

describe('keyboard triage', () => {
  const start = () => initialTriage([submission(1), submission(2), submission(3)]);

  test('j and k move within the waiting items and stop at the ends', () => {
    let state = start();
    expect(state.current).toBe(uuid(1));
    state = triage(state, { type: 'move', delta: -1 });
    expect(state.current).toBe(uuid(1));
    state = triage(triage(state, { type: 'move', delta: 1 }), { type: 'move', delta: 1 });
    expect(state.current).toBe(uuid(3));
    state = triage(state, { type: 'move', delta: 1 });
    expect(state.current).toBe(uuid(3));
  });

  test('a decision hides the item and moves to the next one, then to the previous at the end', () => {
    let state = triage(start(), { type: 'focus', id: uuid(2) });
    const decision = { action: 'approve' as const, reason: null, note: null };
    state = triage(state, { type: 'decide', key: 'k1', ids: [uuid(2)], decision, now: 1_000 });
    expect(visibleIds(state)).toEqual([uuid(1), uuid(3)]);
    expect(state.current).toBe(uuid(3));
    expect(state.pending[0]!.deadline).toBe(1_000 + UNDO_WINDOW_MS);
    state = triage(state, { type: 'decide', key: 'k2', ids: [uuid(3)], decision, now: 2_000 });
    expect(state.current).toBe(uuid(1));
  });

  test('undo restores the last decision and returns to its item before anything is sent', () => {
    let state = start();
    const decision = { action: 'reject' as const, reason: 'Needs sources', note: null };
    state = triage(state, { type: 'decide', key: 'k1', ids: [uuid(1)], decision, now: 0 });
    state = triage(state, { type: 'decide', key: 'k2', ids: [uuid(2)], decision, now: 0 });
    state = triage(state, { type: 'undo' });
    expect(state.pending.map(entry => entry.key)).toEqual(['k1']);
    expect(visibleIds(state)).toEqual([uuid(2), uuid(3)]);
    expect(state.current).toBe(uuid(2));
    // A committed decision can no longer be undone.
    state = triage(state, { type: 'commit', key: 'k1' });
    expect(triage(state, { type: 'undo' })).toBe(state);
    expect(state.committing).toEqual([uuid(1)]);
  });

  test('a bulk decision takes the selection, not the current item', () => {
    let state = start();
    state = triage(triage(state, { type: 'toggle', id: uuid(2) }), { type: 'toggle', id: uuid(3) });
    const ids = targetIds(state);
    state = triage(state, { type: 'decide', key: 'bulk', ids, now: 0,
      decision: { action: 'escalate', reason: 'Spam wave', note: null } });
    expect(state.selected).toEqual([]);
    expect(visibleIds(state)).toEqual([uuid(1)]);
    expect(state.current).toBe(uuid(1));
  });

  test('select all takes only waiting items; decided or held items cannot be selected', () => {
    let state = triage(start(), { type: 'decide', key: 'k', ids: [uuid(1)], now: 0,
      decision: { action: 'approve', reason: null, note: null } });
    state = triage(state, { type: 'select-all' });
    expect(state.selected).toEqual([uuid(2), uuid(3)]);
    expect(triage(state, { type: 'toggle', id: uuid(1) })).toBe(state);
  });
});

describe('stale and conflicting decisions', () => {
  function committed(): TriageState {
    let state = initialTriage([submission(1), submission(2)]);
    state = triage(state, { type: 'decide', key: 'k', ids: [uuid(1)], now: 0,
      decision: { action: 'approve', reason: null, note: null } });
    return triage(state, { type: 'commit', key: 'k' });
  }

  test('a saved decision leaves the list for good', () => {
    const state = triage(committed(), { type: 'settle', id: uuid(1), outcome: { kind: 'done' } });
    expect(visibleIds(state)).toEqual([uuid(2)]);
    expect(state.committing).toEqual([]);
  });

  test('another moderator got there first: the item returns flagged, then is reported gone after a refresh', () => {
    let state = triage(committed(), { type: 'settle', id: uuid(1), outcome: { kind: 'stale' } });
    expect(visibleIds(state)).toEqual([uuid(1), uuid(2)]);
    expect(state.settled[uuid(1)]).toEqual({ kind: 'stale' });
    state = triage(state, { type: 'load', items: [submission(2)] });
    expect(state.settled[uuid(1)]).toEqual({ kind: 'gone' });
    expect(visibleIds(state)).toEqual([uuid(2)]);
    state = triage(state, { type: 'dismiss', id: uuid(1) });
    expect(state.settled).toEqual({});
  });

  test('an item that changed but is still open stays flagged for another look', () => {
    let state = triage(committed(), { type: 'settle', id: uuid(1), outcome: { kind: 'stale' } });
    state = triage(state, { type: 'load', items: [submission(1, { generation: '2' }), submission(2)] });
    expect(state.settled[uuid(1)]).toEqual({ kind: 'stale' });
    expect(state.items[uuid(1)]!.generation).toBe('2');
    // Deciding again clears the flag.
    state = triage(state, { type: 'decide', key: 'again', ids: [uuid(1)], now: 0,
      decision: { action: 'approve', reason: null, note: null } });
    expect(state.settled[uuid(1)]).toBeUndefined();
  });

  test('a refresh keeps decisions still in their undo window', () => {
    let state = initialTriage([submission(1), submission(2)]);
    state = triage(state, { type: 'decide', key: 'k', ids: [uuid(1)], now: 0,
      decision: { action: 'approve', reason: null, note: null } });
    state = triage(state, { type: 'load', items: [submission(2), submission(3)] });
    expect(state.pending[0]!.ids).toEqual([uuid(1)]);
    expect(state.items[uuid(1)]).toBeDefined();
    expect(visibleIds(state)).toEqual([uuid(2), uuid(3)]);
  });

  test('Main problems map to the states people see', () => {
    expect(commandFailure(409, 'submission_stale')).toBe('stale');
    expect(commandFailure(409, 'stale_realm_management_basis')).toBe('stale');
    expect(commandFailure(409, 'idempotency_conflict')).toBe('conflict');
    expect(commandFailure(403, 'realm_management_denied')).toBe('denied');
    expect(commandFailure(503, 'submission_pending')).toBe('pending');
    expect(commandFailure(503, 'realm_management_unavailable')).toBe('unavailable');
  });
});

describe('role impact in plain words', () => {
  const impact = { changes: [
    { member: iri(1), gained: ['realm.members.manage' as const], lost: [] },
    { member: iri(2), gained: ['realm.members.manage' as const, 'governance.moderate' as const], lost: [] },
    { member: iri(3), gained: [], lost: ['realm.roles.manage' as const] },
  ] };

  test('groups members by permission, gains before losses, in permission order', () => {
    expect(impactLines(impact)).toEqual([
      { permission: 'governance.moderate', direction: 'gain', members: [iri(2)] },
      { permission: 'realm.members.manage', direction: 'gain', members: [iri(1), iri(2)] },
      { permission: 'realm.roles.manage', direction: 'lose', members: [iri(3)] },
    ]);
    expect(impactLines({ changes: [] })).toEqual([]);
  });

  test('warns when the person editing would lose role management', () => {
    expect(removesOwnRoleManagement(impact, iri(3))).toBe(true);
    expect(removesOwnRoleManagement(impact, iri(1))).toBe(false);
  });

  test('permissions list in a stable order whatever order Main returns', () => {
    expect(sortPermissions(['realm.roles.manage', 'governance.moderate'])).toEqual(['governance.moderate', 'realm.roles.manage']);
  });
});

describe('addresses and remembered Realms', () => {
  test('queue filters parse strictly and round-trip', () => {
    const realm = uuid(1);
    expect(parseQueueView({})).toEqual({ state: 'open', type: null });
    expect(parseQueueView({ state: 'closed', type: 'content_report' })).toEqual({ state: 'closed', type: 'content_report' });
    expect(parseQueueView({ state: 'all', type: 'spam' })).toEqual({ state: 'open', type: null });
    expect(queueHref(realm, { state: 'closed', type: 'correction_submission' }))
      .toBe(`/manage/r/${realm}?state=closed&type=correction_submission`);
    expect(queueHref(realm, { state: 'open', type: null })).toBe(`/manage/r/${realm}`);
    expect(parseLogView({ view: 'public', kind: 'realm_management' })).toEqual({ view: 'public', kind: null });
    expect(logHref(realm, { view: 'audit', kind: 'realm_management' })).toBe(`/manage/r/${realm}/log?kind=realm_management`);
  });

  test('the device list holds valid Realm IDs only, newest first and bounded', () => {
    expect(parseRemembered(`${uuid(1)}.not-a-realm.${uuid(2)}.${uuid(1)}`)).toEqual([uuid(1), uuid(2)]);
    expect(parseRemembered('%E0%A4%A')).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => uuid(index + 1));
    expect(parseRemembered(serializeRemembered(many))).toHaveLength(12);
    expect(remember([uuid(1), uuid(2)], uuid(2))).toEqual([uuid(2), uuid(1)]);
    expect(forget([uuid(1), uuid(2)], uuid(1))).toEqual([uuid(2)]);
  });
});
