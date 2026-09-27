import { describe, expect, test } from 'bun:test';
import { commandFailure, reportDecision } from '../features/manage/commands.ts';
import { basisFor } from '../features/manage/fixtures.ts';
import { auditRuns, shortcutActions } from '../features/manage/labels.ts';
import { impactLines, positionOf, removesOwnRoleManagement, sortPermissions } from '../features/manage/permissions.ts';
import { actionsFor, authorityFrom, commonActions, initialTriage, needsReason, targetIds, triage, type TriageState,
  UNDO_WINDOW_MS, visibleIds } from '../features/manage/queue-state.ts';
import { logHref, parseLogView, parseQueueView, queueHref, realmHref } from '../features/manage/routes.ts';
import type { AuditItem, ModerationItem } from '../features/manage/types.ts';

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
  test('pending submissions allow every decision; reports are kept or removed, and stay decidable once escalated', () => {
    expect([...actionsFor(submission(1))]).toEqual(['approve', 'reject', 'request-changes', 'escalate']);
    expect([...actionsFor(report(2))]).toEqual(['keep', 'remove', 'escalate']);
    expect([...actionsFor(report(3, { escalation }))]).toEqual(['keep', 'remove']);
    expect([...actionsFor(submission(4, { escalation }))]).toEqual(['approve', 'reject', 'request-changes']);
    // Main's decision route does not take a rights complaint's restrictions yet.
    expect([...actionsFor(report(5, { kind: 'rights_complaint' }))]).toEqual(['escalate']);
    expect(needsReason('keep')).toBe(false);
    expect(needsReason('remove')).toBe(true);
  });

  test('G330 the owner is who escalations reach, so an owner is never offered Escalate', () => {
    const owner = authorityFrom(['governance.moderate', 'realm.owner', 'realm.roles.manage']);
    expect(owner).toEqual({ decideReports: true, escalate: false });
    expect([...actionsFor(report(1), owner)]).toEqual(['keep', 'remove']);
    expect([...actionsFor(submission(2), owner)]).toEqual(['approve', 'reject', 'request-changes']);
    expect(actionsFor(report(3, { kind: 'rights_complaint' }), owner).size).toBe(0);
    // A reviewer without the moderation permission can only hand reports on.
    expect([...actionsFor(report(4), authorityFrom(['review.decide']))]).toEqual(['escalate']);
    // When Main could not say, every choice shows and Main refuses what the Agent may not do.
    expect(authorityFrom(null)).toEqual({ decideReports: true, escalate: true });
  });

  test('A says yes and R says no, whichever kind of item is current', () => {
    expect(shortcutActions('a')).toEqual(['approve', 'keep']);
    expect(shortcutActions('r')).toEqual(['reject', 'remove']);
    expect(shortcutActions('e')).toEqual(['escalate']);
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

describe('addresses', () => {
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

  test('G330 an official Zone\'s segment addresses a Realm in Manage as it does on /r', () => {
    expect(realmHref('fiction')).toBe('/manage/r/fiction');
    expect(queueHref('fiction', { state: 'closed', type: null })).toBe('/manage/r/fiction?state=closed');
    expect(realmHref('fiction', 'members')).toBe('/manage/r/fiction/members');
  });
});

describe('G330 keep or remove reported content', () => {
  const item = report(1);

  test('keeping closes the case against its basis and changes nothing', () => {
    const basis = basisFor(item);
    expect(reportDecision(basis, 'keep', null, iri(11), 'key-1')).toEqual({ profile: 'moderation-decision-v1',
      caseId: item.id, expectedGeneration: '1', actingSubject: iri(11), outcome: 'dismiss', targets: [],
      rule: { ref: basis.ruleBasis!.ref, revision: '3', digest: 'a'.repeat(64) }, evidenceDigest: '0'.repeat(64),
      reversesDecisionId: null, answersStepId: null, rationale: null, disclosure: 'parties', idempotencyKey: 'key-1' });
  });

  test('removing hides exactly the reported revision, against the head the basis read', () => {
    const decision = reportDecision(basisFor(item), 'remove', '  Rule 1: no spoilers in titles. ', iri(11), 'key-2')!;
    expect(decision.outcome).toBe('restrict');
    expect(decision.rationale).toBe('Rule 1: no spoilers in titles.');
    expect(decision.targets).toEqual([{ owner: 'graph', resource: item.target.resource, component: 'title', locator: null,
      scopeKind: 'exact_revision', revision: `${item.target.resource}-revision-1`,
      expectedHead: `${item.target.resource}-revision-1`, effect: 'disclosure' }]);
  });

  test('two reports of the same revision make one target; hidden evidence and unknown parts are left out', () => {
    const basis = basisFor(item);
    const twice = { ...basis, reports: [basis.reports[0]!, { ...basis.reports[0]!, id: uuid(9) }] };
    expect(reportDecision(twice, 'remove', 'x', iri(11), 'k')!.targets).toHaveLength(1);
    const evidence = basis.reports[0]!.evidence[0]!;
    const gone = { ...basis, reports: [{ ...basis.reports[0]!, evidence: [{ ...evidence, state: 'restricted' },
      { ...evidence, component: 'something_new' }] }] };
    expect(reportDecision(gone, 'remove', 'x', iri(11), 'k')).toBeNull();
    expect(reportDecision(gone, 'keep', null, iri(11), 'k')?.targets).toEqual([]);
  });

  test('without published rules or a retained report there is nothing to cite', () => {
    expect(reportDecision(basisFor(item, false), 'keep', null, iri(11), 'k')).toBeNull();
    expect(reportDecision({ ...basisFor(item), reports: [] }, 'keep', null, iri(11), 'k')).toBeNull();
  });
});

describe('G330 Manage landing and log', () => {
  test('a person\'s place in a Realm, in one word', () => {
    expect(positionOf(['governance.moderate', 'realm.owner'])).toBe('owner');
    expect(positionOf(['realm.members.manage', 'governance.moderate'])).toBe('moderator');
    expect(positionOf(['review.decide'])).toBe('reviewer');
    expect(positionOf(['realm.settings.manage'])).toBe('manager');
  });

  const entry = (n: number, minutes: number, overrides: Partial<AuditItem> = {}): AuditItem => ({ id: uuid(n), caseId: null,
    kind: 'realm_management', outcome: 'realm.roles.manage', reason: 'Set up the Fiction moderation team',
    actingSubject: iri(11), decidedAt: new Date(Date.UTC(2026, 8, 27, 21, minutes)).toISOString(), caseSequence: null,
    ...overrides });

  test('one act recorded as several management entries reads as one line with a count', () => {
    const runs = auditRuns([entry(1, 0, { outcome: 'realm.initialize', reason: 'Initialize Realm management' }),
      entry(2, 1), entry(3, 1), entry(4, 2), entry(5, 30),
      entry(6, 31, { kind: 'content_moderation', outcome: 'dismiss', reason: null }),
      entry(7, 31, { kind: 'content_moderation', outcome: 'dismiss', reason: null })]);
    expect(runs.map(run => [run.item.id, run.count])).toEqual([[uuid(1), 1], [uuid(2), 3], [uuid(5), 1], [uuid(6), 1],
      [uuid(7), 1]]);
    expect(runs[1]!.latest).toBe(entry(4, 2).decidedAt);
  });
});
