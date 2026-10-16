import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactNode } from 'react';
import { answerPersonas, type AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/realm/closure-threads-and-replies.json';
import type { ThreadRead, ThreadsPage } from '../feed/thread.ts';
import { RealmNotFound } from './states.tsx';
import { RealmRankingPage } from './ranking-page.tsx';
import { RealmThreadContent } from './thread-content.tsx';
import { closureThreadsReplay, threadsSample, type ClosureEntry } from './realm-closure-threads-recorded-page.tsx';

const record = fixture as AnswerRecord;
function propsOf<T>(node: ReactNode, component: unknown): T | null {
  if (Array.isArray(node)) return node.map(child => propsOf<T>(child, component)).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === component ? node.props as T : propsOf(node.props.children, component);
}
for (const persona of answerPersonas) {
  test(`${persona}: closed list, opener, descendant and absent route stop before counts or hydrated text`, async () => {
    for (const entry of ['closed-list', 'closed-thread', 'closed-descendant', 'absent-list'] as const) {
      const replay = closureThreadsReplay(record, persona, entry);
      try {
        const page = await replay.read();
        expect(isValidElement(page) && page.type).toBe(RealmNotFound);
        expect(replay.requests.some(request => /\/(threads|replies|reply-roots|about-thread|zone|joining|ban)(?:\/|\?|$)/.test(request.url))).toBe(false);
        expect(replay.requests.filter(request => request.url.includes('/session-agent')).length).toBe(persona === 'visitor' ? 0 : 1);
        expect(replay.requests.filter(request => !request.url.includes('/me/')).every(request => request.credentials === 'omit' || request.url.includes('actingSubject='))).toBe(true);
      } finally { replay.dispose(); }
    }
  });
  test(`${persona}: every recorded closure refusal preserves its absent status, code and title`, () => {
    const pairs = record.personas[persona].filter(item => item.label.startsWith('closed-') && !/^closed-(list|thread|descendant)-\d+(?:@ja)?$/.test(item.label));
    expect(pairs).toHaveLength(20);
    for (const closed of pairs) {
      const absent = threadsSample(record, persona, closed.label.replace(/^closed-/, 'absent-'));
      expect(closed.status).toBe(absent.status);
      expect(closed.answer).toEqual(absent.answer);
      const authenticatedProbe = /proof-[67]$/.test(closed.label);
      const status = authenticatedProbe && persona === 'visitor' ? 401 : /proof-7$/.test(closed.label) ? 403 : 404;
      expect(closed.status).toBe(status);
      expect(closed.answer).toMatchObject({ status, code: expect.any(String), title: expect.any(String) });
    }
  });
  for (const entry of ['live-list', 'live-thread'] as const satisfies readonly ClosureEntry[]) {
    test(`${persona}: ${entry} maps the production read without changing member authorship`, async () => {
      const replay = closureThreadsReplay(record, persona, entry);
      try {
        const page = await replay.read();
        const captured = replay.samples.find(item => /\/threads(?:\/[^/?]+)?\?/.test(item.path))!;
        expect(captured.status).toBe(200);
        if (entry === 'live-list') {
          const shown = propsOf<Parameters<typeof RealmRankingPage>[0]>(page, RealmRankingPage)!;
          expect(shown.page).toMatchObject({ ok: true, data: captured.answer as ThreadsPage });
        } else {
          const shown = propsOf<Parameters<typeof RealmThreadContent>[0]>(page, RealmThreadContent)!;
          const thread = captured.answer as ThreadRead;
          expect(shown.read).toMatchObject({ ok: true, data: thread });
          expect(thread.items[0]?.title).toBe('Independent live member opener');
          expect(thread.items[0]?.body).toBe('The control Realm remains open.');
          expect(thread.items[0]?.author?.id).toBeTruthy();
          expect(shown.replyMode).toBe(persona === 'visitor' ? 'sign-in' : 'open');
        }
        const content = replay.requests.find(request => /\/threads(?:\/[^/?]+)?\?/.test(request.url))!;
        expect(content.credentials).toBe(persona === 'visitor' ? 'omit' : 'same-origin');
        expect(new URL(content.url).searchParams.has('actingSubject')).toBe(persona !== 'visitor');
      } finally { replay.dispose(); }
    });
  }
}
