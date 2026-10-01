import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { orderCases, parseSafetyView, offersFor, queueQuery, safetyHref, span, stepDue, stepsOf,
  deadlineOf, claimOf, mergeCases, restricts } from '../features/manage/safety-state.ts';
import { clearAttempt, loadAttempt, refusedForGood, saveAttempt, settleDecision } from '../features/manage/safety-pending.ts';
import { planTargets, decideLabelKey } from '../features/manage/safety-decision-dialog.tsx';
import type { SafetyItem } from '../features/manage/safety-types.ts';
import { messages } from '../features/manage/messages.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ME = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const hours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const item = (n: number, over: Partial<SafetyItem> = {}): SafetyItem => ({ caseId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'content_report', urgent: false, generation: '1', decisionHead: null, openedAt: hours(-n), target: { owner: 'content',
    resource: 'https://rezics.com/id/r', component: 'body' }, category: 'harassment', contentLanguage: 'en', dueAt: null,
  claimedBy: null, restricted: false, ...over });

test('G-821 the queue shows urgent first, then overdue, then by nearest deadline and age', () => {
  const routineOld = item(9);
  const routineNew = item(2);
  const dueSoon = item(3, { dueAt: hours(5) });
  const dueLater = item(4, { dueAt: hours(30) });
  const overdueLong = item(5, { dueAt: hours(-30) });
  const overdueShort = item(6, { dueAt: hours(-1) });
  const urgent = item(7, { urgent: true, category: 'ncii', dueAt: hours(40) });
  const order = orderCases([routineNew, dueLater, routineOld, overdueShort, urgent, dueSoon, overdueLong], NOW)
    .map(entry => entry.caseId.slice(-1));
  expect(order).toEqual(['7', '5', '6', '3', '4', '9', '2']);
});

test('G-821 deadlines are read from Main’s timestamps, never from status words', () => {
  expect(deadlineOf(null, NOW)).toEqual({ kind: 'none' });
  expect(deadlineOf(hours(2), NOW)).toEqual({ kind: 'left', ms: 2 * 3_600_000 });
  expect(deadlineOf(hours(-3), NOW)).toEqual({ kind: 'overdue', ms: 3 * 3_600_000 });
  expect(span(20 * 3_600_000, 'en')).toBe('20h');
  expect(span(51 * 3_600_000, 'en')).toBe('2d 3h');
  expect(span(90 * 60_000, 'en')).toBe('1h 30m');
  expect(span(10_000, 'en')).toBe('1m');
});

test('G-821 filters live in the address and a malformed value falls back to no filter', () => {
  const view = parseSafetyView({ urgency: 'urgent', category: 'ncii', language: 'zh-Hans', due: 'day' });
  expect(view).toEqual({ urgent: true, category: 'ncii', language: 'zh-Hans', due: 'day' });
  expect(safetyHref(view)).toBe('/manage/site?urgency=urgent&category=ncii&language=zh-Hans&due=day');
  expect(parseSafetyView({ urgency: 'routine' }).urgent).toBe(false);
  expect(parseSafetyView({ category: 'NCII; drop', language: '<x>', due: 'forever', urgency: 'x' }))
    .toEqual({ urgent: null, category: null, language: null, due: null });
  expect(safetyHref(parseSafetyView({}))).toBe('/manage/site');
  expect(queueQuery(view, NOW)).toEqual({ urgent: true, category: 'ncii', contentLanguage: 'zh-Hans',
    dueBefore: new Date(NOW + 86_400_000).toISOString() });
  expect(queueQuery(parseSafetyView({ due: 'overdue' }), NOW)).toEqual({ dueBefore: new Date(NOW).toISOString() });
});

test('G-821 claims come from Main’s claimedBy, and loaded pages merge by case', () => {
  expect(claimOf(item(1), ME)).toBe('free');
  expect(claimOf(item(1, { claimedBy: ME }), ME)).toBe('mine');
  expect(claimOf(item(1, { claimedBy: 'https://rezics.com/id/other' }), ME)).toBe('other');
  const merged = mergeCases([item(1), item(2)], [item(2, { claimedBy: ME }), item(3)]);
  expect(merged.map(entry => entry.caseId.slice(-1))).toEqual(['1', '2', '3']);
  expect(merged[1]!.claimedBy).toBe(ME);
});

const offered = (input: Parameters<typeof offersFor>[0]) => offersFor(input).map(offer =>
  offer.blocked ? `${offer.outcome}:${offer.blocked}` : offer.outcome);
const decided = (outcome: string, operationStatus = 'completed') => ({ outcome, operationStatus });
const base = { steps: [], now: NOW };

test('G-821 the decisions offered follow the case’s state, as Main’s decide accepts them', () => {
  const report = item(1);
  const rights = item(1, { kind: 'rights_complaint' });
  // No decision, or a head that is not restricting (a dismissal, a release), is decided afresh.
  expect(offered({ ...base, item: report, decision: null })).toEqual(['restrict', 'dismiss']);
  expect(offered({ ...base, item: report, decision: decided('dismiss') })).toEqual(['restrict', 'dismiss']);
  expect(offered({ ...base, item: report, decision: decided('reverse') })).toEqual(['restrict', 'dismiss']);
  expect(offered({ ...base, item: rights, decision: null })).toEqual(['interim_restrict', 'final_restrict', 'dismiss']);
  expect(offered({ ...base, item: rights, decision: decided('restore') })).toEqual(['interim_restrict', 'final_restrict', 'dismiss']);
  // A restricting head is reversed; a report's restoration needs no step.
  expect(offered({ ...base, item: report, decision: decided('restrict') })).toEqual(['reverse', 'restore']);
  // After an interim restriction the final one is offered; a rights restoration needs a step of an accepted kind.
  expect(offered({ ...base, item: rights, decision: decided('interim_restrict') }))
    .toEqual(['final_restrict', 'reverse', 'restore:step']);
  expect(offered({ ...base, item: rights, decision: decided('final_restrict') })).toEqual(['reverse', 'restore:step']);
  const counter = { stepId: 'c1', kind: 'counter_notice' };
  const offer = offersFor({ ...base, item: rights, decision: decided('final_restrict'), steps: [counter] });
  expect(offer.find(entry => entry.outcome === 'restore')).toEqual({ outcome: 'restore', blocked: null, step: counter });
  // A restoration date or a due step is never an accepted kind.
  expect(offered({ ...base, item: rights, decision: decided('final_restrict'),
    steps: [{ stepId: 'x', kind: 'restoration_not_before' }] })).toEqual(['reverse', 'restore:step']);
});

test('G-821 NCII is only reversed on an upheld appeal, never restored, and never without its step', () => {
  const ncii = item(1, { category: 'ncii', urgent: true });
  expect(offered({ ...base, item: ncii, decision: decided('restrict') })).toEqual(['reverse:step']);
  expect(offered({ ...base, item: ncii, decision: decided('restrict'), steps: [{ stepId: 'a', kind: 'counter_notice' }] }))
    .toEqual(['reverse:step']);
  const appeal = { stepId: 'a1', kind: 'appeal' };
  expect(offersFor({ ...base, item: ncii, decision: decided('restrict'), steps: [appeal] }))
    .toEqual([{ outcome: 'reverse', blocked: null, step: appeal }]);
});

test('G-821 copyright releases wait for the earliest restoration date; unconfirmed effects block everything', () => {
  const copyright = (dueAt: string | null) => item(1, { category: 'copyright', dueAt });
  expect(offered({ ...base, item: copyright(null), decision: decided('restrict') })).toEqual(['reverse:window', 'restore:window']);
  expect(offered({ ...base, item: copyright(hours(2)), decision: decided('restrict') })).toEqual(['reverse:window', 'restore:window']);
  expect(offered({ ...base, item: copyright(hours(-2)), decision: decided('restrict') })).toEqual(['reverse', 'restore']);
  expect(offered({ ...base, item: item(1), decision: decided('restrict', 'accepted') })).toEqual(['reverse:pending', 'restore:pending']);
  for (const outcome of ['restrict', 'interim_restrict', 'final_restrict'] as const) expect(restricts(outcome)).toBe(true);
  for (const outcome of ['dismiss', 'restore', 'reverse'] as const) expect(restricts(outcome)).toBe(false);
  for (const outcome of ['restrict', 'interim_restrict', 'final_restrict', 'dismiss', 'restore', 'reverse'] as const) {
    expect(messages[decideLabelKey[outcome]]).toBeString();
  }
});

test('G-821 steps come from the staff read', () => {
  const step = (id: string, kind: string, dueAt: string | null) => ({ id, kind, dueAt }) as never;
  const detail = { steps: [step('a', 'appeal', null), step('b', 'restoration_not_before', hours(2))] };
  expect(stepsOf(detail)).toEqual([{ stepId: 'a', kind: 'appeal' }, { stepId: 'b', kind: 'restoration_not_before' }]);
  expect(stepDue(detail, 'restoration_not_before')).toBe(hours(2));
  expect(stepDue(detail, 'appeal')).toBeNull();
  expect(stepDue({ steps: [] }, 'removal_deadline')).toBeNull();
});

const result = (status: 'completed' | 'accepted') => ({ ok: true as const, data: { operation: { status } } as never });
const noWait = { sleep: async () => undefined };
const request = { caseId: 'c1', idempotencyKey: 'k1' } as never;

test('G-821 a 202 decision is replayed with the same request until the API reports it applied', async () => {
  const sent: unknown[] = [];
  const settled = await settleDecision(async input => { sent.push(input); return result(sent.length < 3 ? 'accepted' : 'completed'); },
    request, noWait);
  expect(settled.kind).toBe('completed');
  expect(sent).toHaveLength(3);
  expect(new Set(sent).size).toBe(1);
});

test('G-821 a decision that never completes stays pending after a bounded number of replays', async () => {
  let calls = 0;
  const settled = await settleDecision(async () => { calls += 1; return result('accepted'); }, request, { ...noWait, tries: 4 });
  expect(settled.kind).toBe('pending');
  expect(calls).toBe(4);
});

test('G-821 a failure after the API answered keeps the request; a refusal before it lets it go', async () => {
  let calls = 0;
  const lost = await settleDecision(async () => { calls += 1; return calls === 1 ? result('accepted') : { ok: false as const, failure: 'unavailable' as const }; },
    request, noWait);
  expect(lost).toEqual({ kind: 'failed', failure: 'unavailable', recorded: true });
  const refused = await settleDecision(async () => ({ ok: false as const, failure: 'invalid' as const }), request, noWait);
  expect(refused).toEqual({ kind: 'failed', failure: 'invalid', recorded: false });
  expect(refusedForGood('invalid') && refusedForGood('stale') && refusedForGood('denied')).toBe(true);
  expect(refusedForGood('unavailable') || refusedForGood('sign-in') || refusedForGood('pending')).toBe(false);
});

test('G-821 the kept request is stored per case and survives a reload', () => {
  const data = new Map<string, string>();
  const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key) };
  const attempt = { caseId: 'c1', input: { caseId: 'c1', idempotencyKey: 'k1' } as never, reasons: { facts: 'F' } as never };
  saveAttempt(attempt, store);
  expect(loadAttempt('c1', store)).toEqual(attempt);
  expect(loadAttempt('c2', store)).toBeNull();
  data.set('rezics:manage:safety-attempt:c3', '{"caseId":"c9"}');
  expect(loadAttempt('c3', store)).toBeNull();
  clearAttempt('c1', store);
  expect(loadAttempt('c1', store)).toBeNull();
});

test('G-821 a decision plans the retained evidence, and a reversal repeats the decision it releases', () => {
  const evidence = { profile: 'governance-report-v1', reportId: 'r', caseId: 'c', caseGeneration: '1', evidenceDigest: 'd',
    replayed: false, evidence: [
      { ordinal: 1, owner: 'content', resource: 'https://rezics.com/id/a', component: 'body', revision: 'rev1', revisionDigest: 'x',
        state: 'available' },
      { ordinal: 2, owner: 'content', resource: 'https://rezics.com/id/b', component: 'body', revision: 'rev2', revisionDigest: null,
        state: 'erased' }] };
  const targets = planTargets('restrict', item(1), { targets: [] }, evidence, 'search', '2026-11-01T00:00:00.000Z');
  expect(targets).toEqual([{ owner: 'content', resource: 'https://rezics.com/id/a', component: 'body', locator: null,
    scopeKind: 'exact_revision', revision: 'rev1', expectedHead: 'rev1', effect: 'search', expiresAt: '2026-11-01T00:00:00.000Z' }]);
  // Without readable evidence the queue's own target is restricted at component scope.
  expect(planTargets('restrict', item(1), { targets: [] }, null, 'disclosure', null)).toEqual([{ owner: 'content',
    resource: 'https://rezics.com/id/r', component: 'body', locator: null, scopeKind: 'component', revision: null,
    expectedHead: null, effect: 'disclosure' }]);
  expect(planTargets('dismiss', item(1), { targets: [] }, evidence, 'disclosure', null)).toEqual([]);
  const decided = [{ owner: 'content' as const, resource: 'https://rezics.com/id/a', component: 'body' as const, locator: null,
    scopeKind: 'exact_revision' as const, revision: 'rev1', expectedHead: 'rev1', effect: 'disclosure' as const, expiresAt: null }];
  expect(planTargets('reverse', item(1), { targets: decided }, evidence, 'search', null)).toEqual(decided);
});

// API parity: the staff UI calls Main's G-565 routes (and the existing evidence and rule reads) and nothing else.
test('G-821 the staff UI only calls the safety routes, and every write carries an idempotency key', () => {
  const api = source('../features/manage/safety-api.ts');
  const paths = [...api.matchAll(/\.v1(\[[^\]]+\]|\.[a-z]+)/g)].map(match => match[1]);
  expect(new Set(paths)).toEqual(new Set(["['safety-cases']", '.reports', '.governance']));
  expect(api).not.toMatch(/\bfetch\(/);
  expect(api).toMatch(/claim\.post\([^)]*idempotencyKey: key[^)]*\{ headers: \{ 'idempotency-key': key \} \}/s);
  expect(api).toMatch(/decisions\.post\(input,\s*\{ headers: \{ 'idempotency-key': input\.idempotencyKey \} \}\)/);
  expect(api).not.toContain('moderation.decisions');
});

test('G-821 no undo, bulk moderation or locally derived status in the safety surface', () => {
  const dir = new URL('../features/manage/', import.meta.url);
  const files = readdirSync(dir).filter(name => /^(safety-|site-)/.test(name) && !name.includes('stories'));
  expect(files.length).toBeGreaterThan(4);
  for (const name of files) {
    const text = source(`../features/manage/${name}`);
    expect(text, name).not.toMatch(/undo|bulk/i);
  }
});

test('G-821 the safety strings have words in every locale', () => {
  const keys = Object.keys(messages).filter(key => /^(site|safety|decision|claim|restricted|evidence|preview|rule|effect|outcome|operation|decide)/.test(key));
  expect(keys.length).toBeGreaterThan(60);
  for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const text = source(`../features/manage/messages/${locale}.ts`);
    for (const key of ['siteTitle', 'decisionTitle', 'previewHeading', 'restrictedTitle', 'dmcaEarliest', 'claimTaken']) {
      expect(text, `${locale} ${key}`).toContain(`${key}:`);
    }
  }
});
