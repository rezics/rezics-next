import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ActionRequest, controlsFor, decisionOf } from '../features/proposals/actions.ts';
import { blockerKey, blockerOf } from '../features/proposals/blockers.ts';
import { changed, evidenceOf, fieldsOf, headerCandidate, rebaseFields, startLanguage, webHref } from '../features/proposals/candidate.ts';
import { act, type Correction, createProposal, reviseProposal, send } from '../features/proposals/commands.ts';
import { leaves } from '../features/proposals/diff.ts';
import { agents, basis, headerAfter, headerBefore, headerNow, ids, now, proposalApi, target, views } from '../features/proposals/fixtures.ts';
import { headerComponent } from '../features/proposals/basis.ts';
import { kindLabel, stateKey } from '../features/proposals/labels.ts';
import { messages } from '../features/proposals/messages.ts';
import { ProposalPage, reviseSeed } from '../features/proposals/proposal-page.tsx';
import { blockerText } from '../features/proposals/parts.tsx';
import { metadataComponent, checkedMetadataState } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { materializeData } from 'native-i18n';
import type { AllowedAction, MainClient } from '../features/proposals/types.ts';

const allActions: AllowedAction[] = ['revise', 'review', 'apply', 'approve-and-apply', 'reject', 'withdraw', 'revert',
  'recover'];

/** A Main client that records the one HTTP operation a call reaches, by its path and verb. */
function recorder(answer: unknown = { proposal: ids.proposal, revision: 1, outcome: 'created', replayed: false }) {
  const calls: { path: string; verb: string; body: unknown; options: unknown }[] = [];
  const node = (path: string): unknown => new Proxy(() => undefined, {
    get: (_target, key) => typeof key === 'symbol' ? undefined
      : ['get', 'post', 'put'].includes(key) ? (body?: unknown, options?: unknown) => {
        calls.push({ path, verb: key, body, options });
        return Promise.resolve({ data: answer, error: null });
      } : node(`${path}/${key}`),
    apply: (_target, _this, args: unknown[]) => node(`${path}/{${String((args[0] as Record<string, string>)[
      Object.keys(args[0] as object)[0]!])}}`),
  });
  return { main: node('') as MainClient, calls };
}

describe('API parity', () => {
  test('a control exists only for an allowed action, for every combination of allowed actions', () => {
    for (let mask = 0; mask < 1 << allActions.length; mask += 1) {
      const allowed = allActions.filter((_, bit) => mask & (1 << bit));
      const offered = controlsFor(allowed).map(control => control.action);
      expect(offered.every(action => allowed.includes(action))).toBe(true);
      // Every allowed action gets a control: the page neither hides nor invents one.
      expect([...offered].sort()).toEqual([...allowed].sort());
    }
  });

  test('the rendered page offers exactly the allowed actions', () => {
    for (const [name, view] of Object.entries(views)) {
      const html = renderToStaticMarkup(createElement(ProposalPage, { initial: view, target, agents,
        actingSubject: ids.steward, now, locale: 'en', messages, api: proposalApi(view) }));
      const offered = [...html.matchAll(/data-action="([a-z-]+)"/g)].map(match => match[1]);
      // `revise` also needs an editor for the candidate; the fixtures' header corrections have one.
      expect({ name, offered: offered.sort() }).toEqual({ name, offered: [...view.allowedActions].sort() });
    }
  });

  test('each control sends one G-865 operation, and only its own', async () => {
    const requests: { request: ActionRequest; path: string; verb: string }[] = [
      { request: { kind: 'review', revision: 2, outcome: 'request_changes', message: 'Cite it' },
        path: '/v1/editorial/proposals/{x}/reviews', verb: 'post' },
      { request: { kind: 'decide', revision: 2, outcome: 'applied', approve: true, message: '' },
        path: '/v1/editorial/proposals/{x}/decisions', verb: 'post' },
      { request: { kind: 'withdraw', revision: 2 }, path: '/v1/editorial/proposals/{x}/withdrawal', verb: 'post' },
      { request: { kind: 'revert', evidence: [] }, path: '/v1/editorial/proposals/{x}/reversal', verb: 'post' },
      { request: { kind: 'recover' }, path: '/v1/editorial/proposals/{x}/recovery', verb: 'post' },
    ];
    for (const { request, path, verb } of requests) {
      const { main, calls } = recorder();
      const outcome = await act(main, 'x', request, ids.steward, 'key-1');
      expect(outcome.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect({ path: calls[0]!.path, verb: calls[0]!.verb }).toEqual({ path, verb });
    }
  });

  test('a write carries its idempotency key, and create and revise are single operations too', async () => {
    const correction: Correction = { kind: 'component-correction', target: basis.target, candidate: {},
      baseHeads: basis.baseHeads, evidence: [] };
    const created = recorder();
    await createProposal(created.main, correction, ids.member, 'k-create');
    expect(created.calls).toHaveLength(1);
    expect(created.calls[0]!.path).toBe('/v1/editorial/proposals');
    expect(created.calls[0]!.options).toEqual({ headers: { 'idempotency-key': 'k-create' } });
    const revised = recorder();
    await reviseProposal(revised.main, 'x', 2, { candidate: {}, baseHeads: basis.baseHeads, evidence: [] }, ids.member, 'k-rev');
    expect(revised.calls).toHaveLength(1);
    expect(revised.calls[0]!.path).toBe('/v1/editorial/proposals/{x}/revisions');
    expect((revised.calls[0]!.body as { revision: number }).revision).toBe(2);
  });

  test('decisions map to Main’s decide body', () => {
    expect(decisionOf('apply')).toEqual({ outcome: 'applied', approve: false });
    expect(decisionOf('approve-and-apply')).toEqual({ outcome: 'applied', approve: true });
    expect(decisionOf('reject')).toEqual({ outcome: 'rejected', approve: false });
  });
});

describe('refusals keep Main’s typed blocker', () => {
  test('a 409 stale_base problem carries its blocker and maps to stale', async () => {
    const blocker = { code: 'stale_base' as const, expectedHeads: [], actualHeads: [{ component: 'c', head: 'h' }] };
    const outcome = await send(() => Promise.resolve({ data: null, error: { status: 409, value: { code: 'editorial_stale_base', blocker } } }));
    expect(outcome).toEqual({ ok: false, failure: 'stale', code: 'editorial_stale_base', blocker });
  });

  test('a 403 self_review maps to denied and an unknown blocker is ignored', () => {
    expect(blockerOf({ blocker: { code: 'self_review' } })).toEqual({ code: 'self_review' });
    expect(blockerOf({ blocker: { code: 'something_new' } })).toBeUndefined();
    expect(blockerOf(null)).toBeUndefined();
  });

  test('every blocker code has a message key in the catalog', () => {
    for (const key of Object.values(blockerKey)) expect(messages).toHaveProperty(key);
    for (const key of Object.values(stateKey)) expect(messages).toHaveProperty(key);
  });
});

describe('the change list', () => {
  test('a synopsis edit reads as that language’s description from one text to another', () => {
    const rows = leaves([{ path: 'localized', before: headerBefore.localized, after: headerAfter.localized }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: ['localized', 'description'], language: 'zh-Hant',
      before: '一間只在下雨時開門的書店。', after: '一間只在雨夜開門的書店，店主收集人們沒寄出的信。' });
  });

  test('added and removed facts show as unset on one side, and scalars compare whole', () => {
    const rows = leaves([{ path: 'completionStatus', before: 'ongoing', after: 'completed' },
      { path: 'localized', before: [], after: [{ language: 'ja', title: '雨夜の本屋', description: null }] }]);
    expect(rows.map(row => [row.path.join('.'), row.before, row.after])).toEqual([
      ['completionStatus', 'ongoing', 'completed'], ['localized.title', null, '雨夜の本屋']]);
  });

  test('an unknown kind’s preview still renders as its changed leaves', () => {
    const rows = leaves([{ path: 'members', before: [{ id: 1 }], after: [{ id: 1 }, { id: 2 }] }]);
    expect(rows.map(row => row.path.join('.'))).toEqual(['members.2.id']);
  });
});

describe('the correction form', () => {
  test('a candidate replaces one language and carries the rest of the header', () => {
    const fields = { ...fieldsOf(headerBefore, 'zh-Hant'), description: '新的簡介' };
    expect(changed(headerBefore, 'zh-Hant', fields)).toBe(true);
    const { command, state } = headerCandidate(headerBefore, 'zh-Hant', fields);
    expect(command).toBe('work-metadata');
    expect(state.localized.map(row => [row.language, row.description])).toEqual([
      ['en', 'A bookshop opens only when it rains.'], ['zh-Hant', '新的簡介']]);
    expect(state.originalTitle).toEqual(headerBefore.originalTitle);
  });

  test('nothing changed, line breaks and cleared languages', () => {
    const same = fieldsOf(headerBefore, 'en');
    expect(changed(headerBefore, 'en', same)).toBe(false);
    expect(changed(headerBefore, 'en', { ...same, description: `${same.description}\n` })).toBe(false);
    const multi = headerCandidate(headerBefore, 'en', { ...same, description: 'One.\n\nTwo.' });
    expect(multi.state.localized[0]!.description).toBe('One. Two.');
    const cleared = headerCandidate(headerBefore, 'en', { title: '', description: '', tagline: '' });
    expect(cleared.state.localized.map(row => row.language)).toEqual(['zh-Hant']);
  });

  test('the editor starts in the reader’s language, then the Work’s first', () => {
    expect(startLanguage(headerBefore, ['zh-Hant', 'en'], 'en')).toBe('zh-Hant');
    expect(startLanguage(headerBefore, ['ko'], 'en')).toBe('en');
    expect(startLanguage({ ...headerBefore, localized: [] }, ['ko'], 'zh-Hans')).toBe('zh-Hans');
  });

  test('sources become evidence with the day they were read', () => {
    expect(evidenceOf([{ source: ' https://a.test/x ', locator: ' p. 4 ' }, { source: '  ', locator: 'ignored' }], '2026-10-01'))
      .toEqual([{ resource: 'https://a.test/x', revision: 'retrieved:2026-10-01', locator: 'p. 4' }]);
    expect(webHref('https://a.test/x')).toBe('https://a.test/x');
    expect(webHref('javascript:alert(1)')).toBeNull();
    expect(webHref('https://rezics.com/id/x y')).toBeNull();
  });

  test('the header component is the one Main names for the Work’s header', () => {
    const header = checkedMetadataState({ kind: 'header', originalTitle: null, localized: [] });
    expect(headerComponent(ids.work)).toBe(metadataComponent(ids.work, header));
    // Header content never changes which component it is.
    const edited = checkedMetadataState({ kind: 'header', originalTitle: { value: 'X', language: 'en' },
      localized: [{ language: 'en', title: 'T', description: null, mainVersionLabel: null }] });
    expect(headerComponent(ids.work)).toBe(metadataComponent(ids.work, edited));
    expect(headerComponent(ids.work)).not.toBe(headerComponent(ids.workRevision));
  });
});

describe('revising', () => {
  test('a header correction seeds the editor and other candidates do not', () => {
    const seed = reviseSeed(views.proposer)!;
    expect(seed.language).toBe('zh-Hant');
    expect(seed.fields.description).toContain('雨夜');
    expect(seed.sources[0]!.source).toBe('https://example.com/books/rainy-night');
    const other = { ...views.proposer, revision: { ...views.proposer.revision, candidate: { command: 'merge' } } };
    expect(reviseSeed(other)).toBeNull();
  });

  test('a refused revision rebases only the fields the proposer changed onto the current header', () => {
    const written = fieldsOf(headerAfter, 'zh-Hant');
    const rebased = rebaseFields(headerNow, headerBefore, 'zh-Hant', written);
    // Their synopsis stands; the title someone else changed is kept.
    expect(rebased.description).toBe(written.description);
    expect(rebased.title).toBe('雨夜書店（修訂版）');
    const { state } = headerCandidate(headerNow, 'zh-Hant', rebased);
    // Other languages are the current ones, not the proposer's older copy.
    expect(state.localized.find(row => row.language === 'en')!.description).toBe('A bookshop that opens only on rainy nights.');
  });

  test('an edit that changes nothing leaves the current header as it is', () => {
    const rebased = rebaseFields(headerNow, headerBefore, 'zh-Hant', fieldsOf(headerBefore, 'zh-Hant'));
    expect(rebased).toEqual(fieldsOf(headerNow, 'zh-Hant'));
  });
});

describe('labels', () => {
  test('an unknown kind reads as its own words', () => {
    expect(kindLabel('component-correction', messages)).toBe('Correction');
    expect(kindLabel('wiki-bundle', messages)).toBe('Wiki bundle');
  });
});

describe('counts read as plurals', () => {
  const t = materializeData(messages, { locale: 'en' });
  test('approvals and stale approvals use the singular for one', () => {
    expect(t.staleApprovals(1)).toBe('1 earlier approval no longer counts because the correction was revised.');
    expect(t.staleApprovals(3)).toContain('3 earlier approvals no longer count');
    expect(t.staleApprovalsAtLeast(50)).toContain('At least 50 earlier approvals');
    expect(blockerText({ code: 'required_approvals', required: 1, received: 0 }, t)).toBe('This revision needs 1 approval. It has 0 so far.');
    expect(blockerText({ code: 'required_approvals', required: 2, received: 1 }, t)).toBe('This revision needs 2 approvals. It has 1 so far.');
  });

  test('no user-facing string names the internal service, in any locale', async () => {
    for (const locale of ['zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      const { default: catalog } = await import(`../features/proposals/messages/${locale}.ts`);
      expect({ locale, found: /\bMain\b/.test(JSON.stringify(catalog)) }).toEqual({ locale, found: false });
    }
    expect(JSON.stringify(messages)).not.toMatch(/\bMain\b/);
  });
});
