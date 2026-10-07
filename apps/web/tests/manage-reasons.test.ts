import { afterEach, describe, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { decideReport } from '../features/manage/commands.ts';
import { basisFor } from '../features/manage/fixtures.ts';
import { messages, type ManageMessages } from '../features/manage/messages.ts';
import { actionsFor, needsReason } from '../features/manage/queue-state.ts';
import { isReportAction, NOTE_LIMIT, reasonLabelOf, reasonMemoryKey, reasonsFor, reasonsOf, recallReason, rememberReason,
  reportReasons, type ReportAction, sharedRule, STATEMENT_LIMIT, statementFor } from '../features/manage/reason-presets.ts';
import type { MainClient, ModerationItem, PublishedRule } from '../features/manage/types.ts';
import { type UiLocale, uiLocales } from '../i18n/define.ts';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = (n: number) => iri(n).slice(-36);

const report = (kind: ModerationItem['kind'] = 'content_report', reasonCode: string | null = null): ModerationItem => ({
  id: uuid(1), kind, state: 'open', generation: '1', decisionHead: null, openedAt: '2026-09-28T01:00:00.000Z',
  authorAgent: iri(900), reasonCode, escalation: null, submission: null,
  target: { owner: 'graph', resource: iri(101), component: 'title' }, context: iri(1) });

const catalog = async (locale: UiLocale): Promise<ManageMessages> =>
  locale === 'en' ? messages : { ...messages, ...(await import(`../features/manage/messages/${locale}.ts`)).default };
const text = async (locale: UiLocale) => materializeData(await catalog(locale), { locale });

const actions: ReportAction[] = ['keep', 'remove', 'interim-restrict', 'final-restrict'];
const rule = (id: string, title: string): PublishedRule => ({ id, governanceRule: null,
  title: { value: title, language: 'en', direction: 'ltr', basis: 'requested' },
  body: { value: title, language: 'en', direction: 'ltr', basis: 'requested' } });

describe('which decisions need a reason', () => {
  test('keeping reported content is a decision with reasons; only approving a submission has none', () => {
    expect(needsReason('approve')).toBe(false);
    for (const action of ['keep', 'remove', 'interim-restrict', 'final-restrict', 'reject', 'request-changes', 'escalate'] as const) {
      expect(needsReason(action)).toBe(true);
    }
    expect(actions.every(isReportAction)).toBe(true);
    expect(isReportAction('reject')).toBe(false);
  });

  test('every decision a report allows has reasons to pick from, ending with the moderator\'s own', () => {
    for (const kind of ['content_report', 'rights_complaint'] as const) {
      for (const action of actionsFor(report(kind))) {
        if (action === 'escalate') continue;
        expect(isReportAction(action)).toBe(true);
        expect(reasonsFor(action as ReportAction).at(-1)).toBe('other');
        expect(reasonsFor(action as ReportAction).length).toBeGreaterThan(1);
      }
    }
  });

  test('a digit key can pick each offered reason', () => {
    for (const action of actions) expect(reasonsFor(action).length).toBeLessThanOrEqual(9);
  });
});

describe('the statement the affected person reads', () => {
  test('every reason says its facts, scope and duration in every interface language, within the contract\'s limits', async () => {
    for (const locale of uiLocales) {
      const t = await text(locale);
      const seen = new Set<string>();
      for (const action of actions) {
        for (const reason of reasonsFor(action)) {
          expect(reasonLabelOf(reason, t).trim()).not.toBe('');
          const statement = statementFor(action, reason, t, 'In my words', null);
          expect(statement).not.toBeNull();
          for (const part of [statement!.facts, statement!.scope, statement!.duration]) {
            expect(part.trim()).not.toBe('');
            expect(part.length).toBeLessThanOrEqual(STATEMENT_LIMIT);
          }
          if (reason !== 'other') seen.add(statement!.facts);
        }
      }
      // Each preset reason says something of its own.
      expect(seen.size).toBe(12);
    }
  });

  test('a non-English catalog is translated, not a copy of the English words', async () => {
    const english = await text('en');
    for (const locale of uiLocales.filter(entry => entry !== 'en')) {
      const t = await text(locale);
      for (const action of actions) {
        for (const reason of reasonsFor(action)) {
          expect(reasonLabelOf(reason, t)).not.toBe(reasonLabelOf(reason, english));
          if (reason === 'other') continue;
          expect(statementFor(action, reason, t, 'x', null)!.facts).not.toBe(statementFor(action, reason, english, 'x', null)!.facts);
        }
        expect(statementFor(action, reasonsFor(action)[0]!, t, '', null)!.scope)
          .not.toBe(statementFor(action, reasonsFor(action)[0]!, english, '', null)!.scope);
      }
    }
  });

  test('a reason that blames the content cites the Realm rule the report named; keeping never does', async () => {
    const t = await text('en');
    const cited = { number: 2, title: 'Name the edition' };
    expect(statementFor('remove', 'spam', t, '', cited)!.facts)
      .toBe('This content is spam or advertising that does not belong in this Realm. Rule 2: “Name the edition”.');
    expect(statementFor('keep', 'not-a-breach', t, '', cited)!.facts)
      .toBe('We reviewed the report and found that this content follows the Realm’s rules.');
    expect(statementFor('final-restrict', 'claim-upheld', t, '', cited)!.facts).toContain('Rule 2');
  });

  test('the moderator\'s own words are the facts, and an empty explanation cannot be sent', async () => {
    const t = await text('en');
    expect(statementFor('remove', 'other', t, '  ', null)).toBeNull();
    expect(statementFor('remove', 'other', t, '  Paid translation.  ', null)).toEqual({ facts: 'Paid translation.',
      scope: 'The reported part of the content is hidden from readers.',
      duration: 'Until the author fixes the content or a moderator restores it.' });
    expect(NOTE_LIMIT).toBeGreaterThan(STATEMENT_LIMIT);
  });

  test('the contract\'s reasons carry the language the statement is written in and no automation', async () => {
    const t = await text('de');
    const statement = statementFor('keep', 'already-handled', t, '', null)!;
    expect(reasonsOf(statement, 'de')).toEqual({ ...statement, automation: false, contentLanguage: 'de',
      appealRoute: '/v1/public-reports/{caseId}/correspondence' });
    expect(Object.keys(reportReasons).sort()).toEqual([...actions].sort());
  });
});

describe('the Realm rule a decision cites', () => {
  const rules = [rule('no-spoilers', 'Mark spoilers'), rule('credit-editions', 'Name the edition')];

  test('items that name the same rule cite it by its number', () => {
    expect(sharedRule([report('content_report', 'no-spoilers'), report('content_report', 'rule.no-spoilers')], rules))
      .toEqual({ number: 1, title: 'Mark spoilers' });
  });

  test('items that name different rules, or none, cite nothing', () => {
    expect(sharedRule([report('content_report', 'no-spoilers'), report('content_report', 'credit-editions')], rules)).toBeNull();
    expect(sharedRule([report('content_report', 'no-spoilers'), report('content_report', 'title_review')], rules)).toBeNull();
    expect(sharedRule([report('content_report', 'title_review')], rules)).toBeNull();
    expect(sharedRule([], rules)).toBeNull();
  });
});

describe('the reason picked last time', () => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const install = (storage: unknown) => Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  afterEach(() => {
    store.clear();
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('is remembered per Realm and decision, and never the moderator\'s own words', () => {
    install({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
    expect(recallReason('r1', 'remove')).toBeNull();
    rememberReason('r1', 'remove', 'harassment');
    rememberReason('r1', 'keep', 'other');
    expect(recallReason('r1', 'remove')).toBe('harassment');
    expect(recallReason('r2', 'remove')).toBeNull();
    expect(recallReason('r1', 'keep')).toBeNull();
    expect(store.get(reasonMemoryKey('r1', 'remove'))).toBe('harassment');
  });

  test('a remembered reason the decision no longer offers is ignored, and storage that throws is harmless', () => {
    install({ getItem: () => 'claim-upheld', setItem: () => { throw new Error('private mode'); } });
    expect(recallReason('r1', 'keep')).toBeNull();
    expect(recallReason('r1', 'final-restrict')).toBe('claim-upheld');
    expect(() => rememberReason('r1', 'keep', 'not-a-breach')).not.toThrow();
    install({ getItem: () => { throw new Error('private mode'); } });
    expect(recallReason('r1', 'keep')).toBeNull();
    expect(recallReason(undefined, 'keep')).toBeNull();
  });
});

describe('sending a report decision', () => {
  const item = report();
  const reasons = { facts: 'We reviewed the report and found that this content follows the Realm’s rules.',
    scope: 'Nothing was changed.', duration: 'Not applicable.', automation: false, contentLanguage: 'en',
    appealRoute: '/v1/public-reports/{caseId}/correspondence' as const };
  const mainFor = (calls: unknown[]) => ({ v1: { realms: () => ({ moderation: () => ({ get: async () =>
    ({ data: basisFor(item), error: null }) }) }), moderation: { decisions: { post: async (body: unknown, options: unknown) => {
    calls.push({ body, options });
    return { data: { saved: true }, error: null };
  } } } } }) as unknown as MainClient;

  test('the statement goes as `reasons` and the private note as the rationale, never the other way', async () => {
    const calls: unknown[] = [];
    expect(await decideReport(mainFor(calls), uuid(7), item, { action: 'keep', reason: reasons.facts,
      note: '  Reporter gave no edition.  ', reasons }, iri(11), 'keep-key')).toEqual({ ok: true, data: { saved: true } });
    expect(calls).toEqual([{ body: expect.objectContaining({ outcome: 'dismiss', reasons,
      rationale: 'Reporter gave no edition.', disclosure: 'parties' }), options: { headers: { 'idempotency-key': 'keep-key' } } }]);
  });

  test('without a note there is no rationale, and the facts are not copied into it', async () => {
    const calls: unknown[] = [];
    await decideReport(mainFor(calls), uuid(7), item, { action: 'keep', reason: reasons.facts, note: null, reasons },
      iri(11), 'keep-key');
    expect(calls).toEqual([{ body: expect.objectContaining({ rationale: null }), options: expect.anything() }]);
  });

  test('a decision without a statement is refused before anything is read or sent', async () => {
    const calls: unknown[] = [];
    expect(await decideReport(mainFor(calls), uuid(7), item, { action: 'remove', reason: 'x', note: null }, iri(11), 'k'))
      .toEqual({ ok: false, failure: 'invalid', code: 'statement_of_reasons_required' });
    expect(calls).toEqual([]);
  });
});
