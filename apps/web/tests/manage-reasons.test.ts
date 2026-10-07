import { afterEach, describe, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { decideReport } from '../features/manage/commands.ts';
import { basisFor } from '../features/manage/fixtures.ts';
import { messages, type ManageMessages } from '../features/manage/messages.ts';
import { actionsFor, needsReason } from '../features/manage/queue-state.ts';
import { automationOf, combineAutomation, isReportAction, needsDetails, NOTE_LIMIT, reasonLabelOf, reasonMemoryKey, reasonsFor, reasonsOf, recallReason, rememberReason,
  reportReasons, type ReportAction, sharedRule, sharedRules, STATEMENT_LIMIT, statementFor } from '../features/manage/reason-presets.ts';
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
      duration: 'Until an authorized moderator changes or reverses this decision.' });
    expect(NOTE_LIMIT).toBeGreaterThan(STATEMENT_LIMIT);
  });

  test('case-specific details follow a preset in the public statement, and a generic reason requires them', async () => {
    const t = await text('en');
    expect(statementFor('remove', 'spam', t, '  The second link sells accounts.  ', null)!.facts)
      .toBe('This content is spam or advertising that does not belong in this Realm. The second link sells accounts.');
    expect(statementFor('remove', 'spam', t, '', null)!.facts)
      .toBe('This content is spam or advertising that does not belong in this Realm.');
    // The rule the report named comes before the moderator's words.
    expect(statementFor('remove', 'rule-breach', t, 'Paragraph 3 copies a paid translation.', { number: 2, title: 'Name the edition' })!.facts)
      .toBe('This content breaks one of the Realm’s rules. Rule 2: “Name the edition”. Paragraph 3 copies a paid translation.');
    for (const reason of reasonsFor('remove')) expect(needsDetails(reason)).toBe(reason === 'rule-breach' || reason === 'other');
    expect(statementFor('remove', 'rule-breach', t, '   ', { number: 2, title: 'Name the edition' })).toBeNull();
    for (const action of actions) for (const reason of reasonsFor(action)) {
      if (!needsDetails(reason)) expect(statementFor(action, reason, t, '', null)).not.toBeNull();
    }
  });

  test('no duration or scope promises a release that no authorized decision makes', async () => {
    for (const locale of uiLocales) {
      const t = await text(locale);
      const [remove, interim, final] = (['remove', 'interim-restrict', 'final-restrict'] as const)
        .map(action => statementFor(action, reasonsFor(action)[0]!, t, '', null)!);
      // Only a later decision by an authorized moderator releases an enforced restriction, whatever its reason.
      expect(interim!.duration).toBe(remove!.duration);
      expect(final!.duration).toBe(remove!.duration);
    }
    const t = await text('en');
    const promises = /fixes|withdrawn|until it is answered|until the complaint is decided/i;
    for (const action of actions) for (const reason of reasonsFor(action)) {
      const statement = statementFor(action, reason, t, 'x', null)!;
      expect(`${statement.facts} ${statement.scope} ${statement.duration}`).not.toMatch(promises);
    }
    expect(statementFor('remove', 'spam', t, '', null)!.duration)
      .toBe('Until an authorized moderator changes or reverses this decision.');
  });

  test('the contract\'s reasons carry the language the statement is written in and the automation the evidence records', async () => {
    const t = await text('de');
    const statement = statementFor('keep', 'already-handled', t, '', null)!;
    expect(reasonsOf(statement, 'de', false)).toEqual({ ...statement, automation: false, contentLanguage: 'de',
      appealRoute: '/v1/public-reports/{caseId}/correspondence' });
    expect(reasonsOf(statement, 'de', true).automation).toBe(true);
    expect(Object.keys(reportReasons).sort()).toEqual([...actions].sort());
  });
});

describe('automation in the evidence', () => {
  const evidence = (provenance: Record<string, string>) => ({ ordinal: 1, owner: 'graph', resource: iri(101), component: 'title',
    revision: 'r1', locator: null, state: 'available', representation: null, revisionDigest: null, expectedHead: 'r1', provenance });
  const read = (provenances: Array<Record<string, string>>, nextCursor: string | null = null) => ({
    reports: provenances.map(provenance => ({ id: uuid(2), actingSubject: null, reasonCode: 'spam', statement: null,
      evidenceDigest: 'a'.repeat(64), receivedAt: '2026-09-28T01:00:00.000Z', evidence: [evidence(provenance)] })), nextCursor });

  test('an `automation` entry in any evidence item\'s provenance is automation, as Main decides', () => {
    expect(automationOf(read([{ capturedBy: 'reporter' }, { automation: 'local-image-screen', reason: 'likely-explicit' }]))).toBe(true);
    expect(automationOf(read([{ capturedBy: 'reporter' }]))).toBe(false);
    expect(automationOf(read([]))).toBe(false);
  });

  test('more reports than were read leave it unknown unless one already shows automation', () => {
    expect(automationOf(read([{}], 'next'))).toBeNull();
    expect(automationOf(read([{ automation: 'x' }], 'next'))).toBe(true);
  });

  test('several cases are stated only when they agree: a mixed or unread batch is unknown, never "involved"', () => {
    expect(combineAutomation([true, true])).toBe(true);
    expect(combineAutomation([false, false])).toBe(false);
    expect(combineAutomation([false, true])).toBeNull();
    expect(combineAutomation([true, null])).toBeNull();
    expect(combineAutomation([null])).toBeNull();
    expect(combineAutomation([])).toBeNull();
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

describe('the published rules a decision cites', () => {
  const read = (ref: string, revision: string) => ({ ok: true as const, data: { ...basisFor(report()), ruleBasis: { ref, revision,
    digest: 'a'.repeat(64), document: {} } } });

  test('cases read under the same published rules show their reference and revision', () => {
    expect(sharedRules([read('urn:rules:1', '3'), read('urn:rules:1', '3')])).toEqual({ ref: 'urn:rules:1', revision: '3' });
  });

  test('another revision, an unread case or a Realm without rules shows none', () => {
    expect(sharedRules([read('urn:rules:1', '3'), read('urn:rules:1', '4')])).toBeNull();
    expect(sharedRules([read('urn:rules:1', '3'), undefined])).toBeNull();
    expect(sharedRules([{ ok: true, data: basisFor(report(), false) }])).toBeNull();
    expect(sharedRules([])).toBeNull();
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

  test('the statement goes as `reasons`; a private note is not the rationale the parties read', async () => {
    const calls: unknown[] = [];
    const note = 'Reporter gave no edition.';
    expect(await decideReport(mainFor(calls), uuid(7), item, { action: 'keep', reason: reasons.facts,
      note: `  ${note}  `, reasons }, iri(11), 'keep-key')).toEqual({ ok: true, data: { saved: true } });
    expect(calls).toEqual([{ body: expect.objectContaining({ outcome: 'dismiss', reasons,
      rationale: null, disclosure: 'parties' }), options: { headers: { 'idempotency-key': 'keep-key' } } }]);
    expect(JSON.stringify((calls[0] as { body: unknown }).body)).not.toContain(note);
  });

  test('details for the affected people may be the rationale, and a private note beside them still is not', async () => {
    const calls: unknown[] = [];
    const details = 'The 1894 text is a recognised edition.';
    const note = 'Check the scan quality later.';
    const facts = `${reasons.facts} ${details}`;
    expect(await decideReport(mainFor(calls), uuid(7), item, { action: 'keep', reason: facts, note, details,
      reasons: { ...reasons, facts } }, iri(11), 'keep-key')).toEqual({ ok: true, data: { saved: true } });
    const body = (calls[0] as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ rationale: details, disclosure: 'parties', reasons: { ...reasons, facts } });
    expect(JSON.stringify(body)).not.toContain(note);
  });

  test('the decision cites the published rules and the reported revision it acts on, so the notice is tied to both', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    await decideReport(mainFor(calls), uuid(7), item, { action: 'remove', reason: reasons.facts, note: null, reasons },
      iri(11), 'remove-key');
    const basis = basisFor(item);
    expect(calls[0]!.body).toMatchObject({ rule: { ref: basis.ruleBasis!.ref, revision: basis.ruleBasis!.revision,
      digest: basis.ruleBasis!.digest }, evidenceDigest: basis.reports[0]!.evidenceDigest, caseId: item.id,
    targets: [{ owner: 'graph', resource: item.target.resource, component: 'title', scopeKind: 'exact_revision',
      revision: basis.reports[0]!.evidence[0]!.revision, expectedHead: basis.reports[0]!.evidence[0]!.expectedHead }] });
  });

  const automatedBasis = (overrides: Partial<ReturnType<typeof basisFor>> = {}) => {
    const basis = basisFor(item);
    return { ...basis, ...overrides, reports: basis.reports.map(entry => ({ ...entry,
      evidence: entry.evidence.map(found => ({ ...found, provenance: { automation: 'local-image-screen' } })) })) };
  };
  const keepDecision = (automation: boolean) => ({ action: 'keep' as const, reason: reasons.facts, note: null,
    reasons: { ...reasons, automation } });
  /** A Main whose basis comes page by page: each read gives the next page, and records the cursor it asked with. */
  const paged = (pages: Array<ReturnType<typeof basisFor>>, posted: Array<Record<string, unknown>>, cursors: Array<string | undefined>) =>
    ({ v1: { realms: () => ({ moderation: () => ({ get: async ({ query }: { query: { cursor?: string } }) => {
      cursors.push(query.cursor);
      const index = query.cursor ? Number(query.cursor) : 0;
      return { data: { ...pages[index]!, nextCursor: index + 1 < pages.length ? String(index + 1) : null }, error: null };
    } }) }), moderation: { decisions: { post: async (body: Record<string, unknown>) => {
      posted.push(body);
      return { data: {}, error: null };
    } } } } }) as unknown as MainClient;

  test('the statement says automation was involved when this case\'s evidence records it, whatever the screen showed', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const main = { v1: { realms: () => ({ moderation: () => ({ get: async () => ({ data: automatedBasis(), error: null }) }) }),
      moderation: { decisions: { post: async (body: Record<string, unknown>) => { calls.push({ body }); return { data: {}, error: null }; } } } } } as unknown as MainClient;
    await decideReport(main, uuid(7), item, keepDecision(false), iri(11), 'k');
    expect(calls[0]!.body.reasons).toEqual({ ...reasons, automation: true });
  });

  test('a manual case in a batch is not told automation was involved because another case in it was', async () => {
    // The dialog's one statement is shared by the whole batch; here it came from an automated sibling.
    const manual: unknown[] = [];
    await decideReport(mainFor(manual), uuid(7), item, keepDecision(true), iri(11), 'k');
    expect(manual).toEqual([{ body: expect.objectContaining({ reasons: { ...reasons, automation: false } }), options: expect.anything() }]);
  });

  test('automation recorded on a later page of reports is found before the statement denies it', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const cursors: Array<string | undefined> = [];
    const later = { ...basisFor(item), reports: automatedBasis().reports };
    const main = paged([basisFor(item), basisFor(item), later], posted, cursors);
    expect(await decideReport(main, uuid(7), item, keepDecision(false), iri(11), 'k')).toEqual({ ok: true, data: {} });
    expect(cursors).toEqual([undefined, '1', '2']);
    expect(posted[0]!.reasons).toEqual({ ...reasons, automation: true });
  });

  test('every page without automation still sends a manual statement, and a case that moved between pages is stale', async () => {
    const posted: Array<Record<string, unknown>> = [];
    expect(await decideReport(paged([basisFor(item), basisFor(item)], posted, []), uuid(7), item, keepDecision(true), iri(11), 'k'))
      .toEqual({ ok: true, data: {} });
    expect(posted[0]!.reasons).toEqual({ ...reasons, automation: false });
    const moved: Array<Record<string, unknown>> = [];
    expect(await decideReport(paged([basisFor(item), { ...basisFor(item), generation: '9' }], moved, []), uuid(7), item,
      keepDecision(false), iri(11), 'k')).toEqual({ ok: false, failure: 'stale' });
    expect(moved).toEqual([]);
  });

  test('a case with more than 200 reports is still decided, including automation recorded after the fiftieth page', async () => {
    // Four reports a page: fifty pages are 200 reports, and Main allows another page after that.
    const manual = Array.from({ length: 51 }, () => basisFor(item));
    const posted: Array<Record<string, unknown>> = [];
    const cursors: Array<string | undefined> = [];
    expect(await decideReport(paged(manual, posted, cursors), uuid(7), item, keepDecision(true), iri(11), 'k'))
      .toEqual({ ok: true, data: {} });
    expect(cursors).toHaveLength(51);
    expect(posted[0]!.reasons).toEqual({ ...reasons, automation: false });
    const later = manual.map((page, index) => index === 50
      ? { ...page, reports: automatedBasis().reports } : page);
    const found: Array<Record<string, unknown>> = [];
    expect(await decideReport(paged(later, found, []), uuid(7), item, keepDecision(false), iri(11), 'k'))
      .toEqual({ ok: true, data: {} });
    expect(found[0]!.reasons).toEqual({ ...reasons, automation: true });
  });

  test('a report page that does not advance is not stated as manual', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const cursors: Array<string | undefined> = [];
    const stuck = { v1: { realms: () => ({ moderation: () => ({ get: async ({ query }: { query: { cursor?: string } }) => {
      cursors.push(query.cursor);
      return { data: { ...basisFor(item), nextCursor: 'more' }, error: null };
    } }) }), moderation: { decisions: { post: async (body: Record<string, unknown>) => { posted.push(body); return { data: {}, error: null }; } } } } } as unknown as MainClient;
    expect(await decideReport(stuck, uuid(7), item, keepDecision(false), iri(11), 'k')).toEqual({ ok: false, failure: 'unavailable' });
    expect(cursors.length).toBeLessThan(50);
    expect(posted).toEqual([]);
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
