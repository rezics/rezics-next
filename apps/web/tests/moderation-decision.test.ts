import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import type { ModerationDecision } from '../src/moderation/decision-read';
import { m } from '../src/paraglide/messages.js';
import * as localStart from '../.storybook/react-start';

const start = await import('@tanstack/react-start');
const startServer = await import('@tanstack/react-start/server');
const environment: Record<string, unknown> = {};
let currentRequest = new Request('https://site.test/moderation/decisions/decision-1');
let requestViewer = 'author-1';
let requestEpoch = 'AAAAAAAAAAAAAAAAAAAAAA';
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env: environment }));
// Run the actual BFF handlers locally, selecting the real browser session hook only in the DOM.
mock.module('@tanstack/react-start', () => ({
  ...start,
  ...localStart,
  createServerFn(options: { method: string }) {
    const bridge = localStart.createServerFn();
    const chain = {
      validator(validate: (input: unknown) => unknown) {
        bridge.validator(validate);
        return chain;
      },
      handler(handler: (...args: never[]) => unknown) {
        const invoke = bridge.handler(handler);
        return (input?: { data?: unknown; headers?: HeadersInit }) => {
          const headers = new Headers(input?.headers);
          headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          currentRequest = new Request('https://site.test/moderation/decisions/decision-1', {
            method: options.method,
            headers,
          });
          return invoke(input as never);
        };
      },
    };
    return chain;
  },
  createIsomorphicFn() {
    let server: Function;
    return {
      server(handler: Function) {
        server = handler;
        return {
          client:
            (client: Function) =>
            (...args: unknown[]) =>
              (typeof window === 'undefined' ? server : client)(...args),
        };
      },
    };
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...startServer,
  getRequest: () => currentRequest,
  setResponseHeader: (key: string, value: string) => responseHeaders.set(key, value),
}));
const { loadDecisionPage, decisionReadAdapters } = await import('../src/moderation/decision-read');
const { submitDecisionAppeal } = await import('../src/moderation/appeal');
const { DecisionPageView } = await import('../src/moderation/decision-page');

const decidedAt = '2026-01-01T12:00:00.000Z';
const decision: ModerationDecision = {
  id: 'decision-1',
  targetKind: 'post' as const,
  targetId: 'post-1',
  action: 'takedown' as const,
  statement: 'This post violates the board rules.',
  decidedAt,
  appealDeadline: '2026-07-03T12:00:00.000Z',
  appeal: null,
};
const decisionWithProvenance = (change: Partial<ModerationDecision> = {}) =>
  Object.assign(
    { ...decision, ...change },
    {
      provenance: {
        actorId: 'author-1',
        session: { clientId: 'client-1', authnEpoch: 7 },
        source: { partition: 3, epoch: 9, position: '12' },
      },
    },
  );

test('the composed decision reader uses one native response and does not hydrate a target', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage(
    'decision-1',
    {
      decision: async (id) => {
        calls.push(`decision:${id}`);
        return decisionWithProvenance();
      },
    },
    'author-1',
  );

  expect(page).toMatchObject({ decision, viewerId: 'author-1', nativeSourceFingerprint: expect.any(String) });
  expect(calls).toEqual(['decision:decision-1']);
});

test('a composed response without generated provenance stays on the typed unavailable seam', async () => {
  await expect(loadDecisionPage('decision-1', { decision: async () => decision })).rejects.toThrow(
    'Decision read unavailable',
  );
});

test('native provenance is complete before the decision source can be bound', async () => {
  for (const provenance of [
    { actorId: 'author-1' },
    {
      actorId: 'another-author',
      session: { clientId: 'client-1', authnEpoch: 7 },
      source: { partition: 3, epoch: 9, position: '12' },
    },
  ]) {
    const response = Object.assign({}, decision, { provenance });
    await expect(loadDecisionPage('decision-1', { decision: async () => response }, 'author-1')).rejects.toThrow(
      'Decision read unavailable',
    );
  }
});

test('decision reads retain supplied text while staying independent of unrelated fixture history', async () => {
  const history = new Proxy(
    Array.from({ length: 1000 }, (_, index) => index),
    {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('Unrelated history must not be enumerated');
        return Reflect.get(target, property, receiver);
      },
    },
  );
  for (const size of [1, 8000]) {
    const response = Object.assign(decisionWithProvenance({ statement: 'r'.repeat(size) }), {
      unrelatedHistory: history,
    });
    let calls = 0;
    const page = await loadDecisionPage(
      'decision-1',
      {
        decision: async () => {
          calls++;
          return response;
        },
      },
      'author-1',
    );
    expect(page?.decision.statement).toHaveLength(size);
    expect(calls).toBe(1);
  }
});

test('command acknowledgement and the separate current decision readback remain distinct', async () => {
  const calls: string[] = [];
  const pending = decisionWithProvenance({
    appeal: { id: 'appeal-1', outcome: null, statement: 'I disagree.', resolvedAt: null },
  });
  const result = await submitDecisionAppeal('decision-1', 'I disagree.', {
    appeal: async (id, statement) => {
      calls.push(`appeal:${id}:${statement}`);
      return { status: 201 };
    },
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return pending;
    },
  });

  expect(result).toMatchObject({
    state: 'acknowledged',
    readback: { state: 'available', decision: pending, nativeSourceFingerprint: expect.any(String) },
  });
  expect(calls).toEqual(['appeal:decision-1:I disagree.', 'decision:decision-1']);
});

test('a 422 length error preserves the draft while late and duplicate appeals use the next decision state', async () => {
  const draft = 'x'.repeat(2001);
  let next = decisionWithProvenance();
  const reader = { decision: async () => next };
  const tooLong = await submitDecisionAppeal('decision-1', draft, {
    appeal: async () => ({ status: 422 }),
    ...reader,
  });
  expect(tooLong).toMatchObject({ state: 'invalid', text: draft });

  next = decisionWithProvenance({
    appeal: { id: 'appeal-1', outcome: null, statement: 'Earlier appeal', resolvedAt: null },
  });
  for (const status of [409, 422]) {
    const refreshed = await submitDecisionAppeal('decision-1', 'My reason', {
      appeal: async () => ({ status }),
      ...reader,
    });
    expect(refreshed).toMatchObject({ state: 'conflict', readback: { state: 'available', decision: next } });
  }
});

test('decision route is signed-in, noindex and private, and refused reads become not found', async () => {
  const route = await readFile(new URL('../src/routes/moderation/decisions.$id.tsx', import.meta.url), 'utf8');
  const read = await readFile(new URL('../src/moderation/decision-read.ts', import.meta.url), 'utf8');
  expect(route).toMatch(/beforeLoad:\s*requireSignedIn/);
  expect(route).toMatch(/noindex, nofollow/);
  expect(read).toMatch(/notFound\(/);
});

test('decision presentation shows the receipt while generated appeal advice and target context are unavailable', () => {
  const page = {
    decision: decisionWithProvenance(),
    nativeSourceFingerprint: 'presenter-source',
    viewerId: 'author-1',
  };
  const open = renderToStaticMarkup(createElement(DecisionPageView, { page, now: Date.parse(decidedAt) }));
  expect(open).toContain(decision.statement);
  expect(open).toContain(m.decision_target_context_unavailable());
  expect(open).toContain('dateTime="' + decidedAt + '"');
  expect(open).toContain('dateTime="' + decision.appealDeadline + '"');
  expect(open).toContain(m.decision_appeal_advice_unavailable());
  expect(open).not.toContain('appeal-statement');
  expect(open).not.toContain(`/threads/${decision.targetId}`);

  const late = renderToStaticMarkup(
    createElement(DecisionPageView, { page, now: Date.parse(decision.appealDeadline) + 1 }),
  );
  expect(late).toContain(m.decision_appeal_advice_unavailable());
  expect(late).not.toContain('appeal-statement');
  const otherReader = renderToStaticMarkup(
    createElement(DecisionPageView, {
      page: {
        ...page,
        viewerId: 'another-author',
      },
      now: Date.parse(decidedAt),
    }),
  );
  expect(otherReader).not.toContain('appeal-statement');
});

test('a private decision remains readable without generated context, including after its appeal deadline', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage(
    decision.id,
    {
      decision: async (id) => {
        calls.push(`decision:${id}`);
        return decisionWithProvenance();
      },
    },
    'author-1',
  );
  expect(calls).toEqual(['decision:decision-1']);
  if (!page) throw new Error('The authorized decision must remain readable');
  for (const now of [Date.parse(decidedAt), Date.parse(decision.appealDeadline) + 1]) {
    const markup = renderToStaticMarkup(
      createElement(DecisionPageView, { page: { ...page, viewerId: 'author-1' }, now }),
    );
    expect(markup).toContain(decision.statement);
    expect(markup).toContain(m.decision_target_context_unavailable());
    expect(markup).not.toContain('appeal-statement');
  }
});

test('Moderation decision receipt keeps one main and renders the current appeal outcome', async () => {
  const { SidebarInset } = await import('@rezics/ui/shadcn/sidebar');
  for (const outcome of [null, 'reversed', 'upheld'] as const) {
    const appeal = {
      id: 'appeal-1',
      outcome,
      statement: outcome ? 'Independent review statement.' : null,
      resolvedAt: outcome ? decidedAt : null,
    };
    const markup = renderToStaticMarkup(
      createElement(
        SidebarInset,
        null,
        createElement(DecisionPageView, {
          page: {
            decision: decisionWithProvenance({ appeal }),
            viewerId: 'author-1',
            nativeSourceFingerprint: 'presenter-source',
          },
          now: Date.parse(decidedAt),
        }),
      ),
    );
    expect(markup.match(/<main\b/g)).toHaveLength(1);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toContain('Original decision');
    expect(markup).toContain(decision.statement);
    expect(markup).toContain('Current content availability');
    expect(markup).toContain(m.decision_target_context_unavailable());
    expect(markup).toContain(decision.id);
    expect(markup).not.toContain(decision.targetId);
    expect(markup).not.toContain('/threads/');
    expect(markup).not.toContain('appeal-statement');
    expect(markup).toContain(
      outcome === null
        ? 'Appeal awaiting review'
        : outcome === 'reversed'
          ? 'The decision was reversed.'
          : 'The decision was upheld.',
    );
    if (outcome) expect(markup).toContain('Independent review statement.');
  }
});

test('decision adapter uses only the composed exact endpoint and preserves native denial', async () => {
  let denied = false;
  const calls: string[] = [];
  const reads = decisionReadAdapters(
    {
      'moderation-decisions': ({ id }) => ({
        get: async () => {
          calls.push(`decision:${id}`);
          return denied
            ? { data: null, error: { status: 404 }, status: 404 }
            : { data: decision, error: null, status: 200 };
        },
      }),
    },
    'Bearer author',
  );
  expect(await reads.decision(decision.id)).toEqual(decision);
  denied = true;
  expect(await reads.decision(decision.id)).toBeNull();
  expect(calls).toEqual(['decision:decision-1', 'decision:decision-1']);
});

test('appeal denial, known conflict and uncertain confirmation stay distinct without optimistic native state', async () => {
  const { createModerationIntent } = await import('../src/moderation/command-intent');
  const intent = createModerationIntent();
  const command = { id: decision.id, statement: 'Keep this exact statement.' };
  const originalKey = intent.keyFor(command);
  for (const status of [401, 403, 404]) {
    expect(
      await submitDecisionAppeal(decision.id, command.statement, {
        appeal: async () => ({ status }),
        decision: async () => {
          throw new Error('Denied writes must not become success through a read');
        },
      }),
    ).toEqual({ state: 'denied' });
  }
  for (const status of [409, 422]) {
    expect(
      await submitDecisionAppeal(decision.id, command.statement, {
        appeal: async () => ({ status }),
        decision: async () => {
          throw new Error('Read unavailable');
        },
      }),
    ).toEqual({ state: 'conflict', readback: { state: 'unavailable' } });
  }
  expect(
    await submitDecisionAppeal(decision.id, command.statement, {
      appeal: async () => ({ status: 201 }),
      decision: async () => null,
    }),
  ).toEqual({ state: 'acknowledged', readback: { state: 'unavailable' } });
  expect(
    await submitDecisionAppeal(decision.id, command.statement, {
      appeal: async () => ({ status: 503 }),
      decision: async () => decision,
    }),
  ).toEqual({ state: 'failed' });
  expect(intent.keyFor(command)).toBe(originalKey);
});

test('the default decision presenter keeps native composition unavailable until generated fields arrive', () => {
  const page = { decision, nativeSourceFingerprint: 'presenter-source', viewerId: 'author-1' };
  const markup = renderToStaticMarkup(createElement(DecisionPageView, { page, now: Date.parse(decidedAt) }));
  expect(markup).toContain(decision.statement);
  expect(markup).toContain(m.decision_target_context_unavailable());
  expect(markup).toContain(m.decision_appeal_advice_unavailable());
  expect(markup).not.toContain('appeal-statement');
  expect(markup).not.toContain(`/threads/${decision.targetId}`);
});
