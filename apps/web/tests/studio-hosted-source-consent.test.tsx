import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { fromPlainText } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import type { StudioResult } from '../src/studio/contract';
import type { HostedOwnedBook } from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedSourceConsentVisit, type SourceConsentTransport } from '../src/studio/hosted-source-consent';
import type { SourceConsentReceipt, SourceConsentRequest } from '../src/studio/hosted-source-consent-contract';
import { createSourceConsentTransport } from '../src/studio/hosted-source-consent-native';
import { hostedFailure } from '../src/studio/hosted-native';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { HostedPublicationPointVisit } = await import('../src/studio/hosted-publication-point');
const { HostedPublicationPointView } = await import('../src/studio/hosted-publication-point-view');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const target = { threadId: id(11), postId: id(12), revisionId: id(13), sha256: 'a'.repeat(64) };
const receipt: SourceConsentReceipt = {
  disclosureId: id(30),
  catalogueId: id(1),
  state: 'issued',
  reused: false,
  durableInitiator: 'b'.repeat(64),
};
const owner: HostedOwnedBook = {
  viewer: { accountId: id(10), authnEpoch: 2 },
  scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
  item: {
    catalogueId: id(1),
    threadId: id(2),
    postRevisionId: id(3),
    headRevisionId: id(4),
    publicationId: id(5),
    title: 'Field notes',
    postVisibility: 'published',
    createdAt: '2026-11-13T09:00:00Z',
  },
};
function session() {
  let observation: HistoricalReaderObservation = {
    sourceId: 'session-source',
    generation: 1,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: id(10),
    credentialMode: 'session',
    healthy: true,
    csrfReady: true,
  };
  const listeners = new Set<() => void>();
  const source: HistoricalReaderSource = {
    id: 'session-source',
    revision: () => observation.generation,
    read: () => observation,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return {
    source,
    change: (change: Partial<HistoricalReaderObservation>) => {
      observation = { ...observation, ...change };
      listeners.forEach((fn) => fn());
    },
  };
}
const answer: SourceConsentTransport = async (input) =>
  ok({ ...receipt, state: input.kind === 'issue' ? 'issued' : 'revoked' });

function consentFixture() {
  const s = session();
  const native = mock(answer);
  const visit = new HostedSourceConsentVisit({
    ...s,
    viewer: owner.viewer,
    csrfToken: 'original-csrf',
    isCurrent: () => true,
    native,
  });
  visit.select({ catalogueId: id(1), target });
  return { ...s, native, visit };
}

function pointFixture() {
  const s = session();
  const chapter = {
    occurrenceId: id(20),
    parentId: null,
    position: 0,
    kind: 'chapter' as const,
    availability: 'available' as const,
    title: 'A saved chapter',
    target,
  };
  const consent = mock(answer);
  const publish = mock(async () => hostedFailure('denied', 'Native Book admission denied.'));
  const visit = new HostedPublicationPointVisit({
    owner: { ...owner, item: { ...owner.item, title: undefined } },
    source: s.source,
    locale: 'en',
    csrfToken: 'original-csrf',
    consent,
    admit: async () => false,
    readVersion: async () =>
      ok({
        exact: target,
        title: chapter.title,
        body: fromPlainText('The exact saved bytes.', 'blocks'),
        savedAt: '2026-11-13T09:00:00Z',
        mediaIds: [],
      }),
    native: {
      readOwn: async () => ok(owner),
      readMetadata: async (input) =>
        ok({ catalogueId: id(1), revisionId: input.revisionId!, kind: input.kind, sourceRevisionId: id(4) }),
      readOutlineWindow: async ({ revision }) =>
        ok({ ...revision, items: revision.kind === 'structure' ? [chapter] : [], nextCursor: null }),
      writePublicationPoint: publish,
    },
  });
  return { ...s, visit, consent, publish, chapter };
}

// Mounted flow pins explicit user actions and leaves publication independently callable after source denial.
test('point review makes no consent request; issue and exact revoke never publish, and native denial leaves Book admission independent', async () => {
  const f = pointFixture();
  await f.visit.refresh();
  f.visit.observeDraft(f.chapter.occurrenceId);
  await f.visit.readVersion();
  f.visit.review();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<HostedPublicationPointView visit={f.visit} locale="en" />));
    expect(f.consent.mock.calls).toHaveLength(0);
    expect(host.textContent).toContain('The exact saved bytes.');
    expect(host.textContent).toContain('Book: Untitled');
    expect(host.textContent).toContain(target.sha256);
    expect(host.textContent).toContain('Permission state is unknown');
    expect(host.textContent).toContain('Already-public sources do not need this permission');
    expect(queryByRole(host, 'button', { name: 'Revoke permission for this version and Book' })).toBeNull();
    const publication = f.visit.snapshot();
    await act(async () => {
      getByRole(host, 'button', { name: 'Permit this version for this Book' }).click();
    });
    expect(f.consent.mock.calls[0]![0]).toMatchObject({
      kind: 'issue',
      body: { catalogueId: id(1), target },
      expectedViewer: owner.viewer,
    });
    expect(f.consent.mock.calls[0]![2]).toBe('original-csrf');
    expect(f.publish.mock.calls).toHaveLength(0);
    expect(f.visit.snapshot()).toBe(publication);
    expect(host.textContent).toContain('This action did not publish anything');
    expect(host.textContent).not.toContain(receipt.disclosureId);
    expect(host.innerHTML).not.toContain(receipt.durableInitiator!);
    await act(async () => {
      getByRole(host, 'button', { name: 'Revoke permission for this version and Book' }).click();
    });
    const revocation = f.consent.mock.calls[1]![0];
    expect(revocation).toMatchObject({
      kind: 'revoke',
      body: { disclosureId: receipt.disclosureId, catalogueId: id(1), target },
    });
    expect(revocation.idempotencyKey).not.toBe(f.consent.mock.calls[0]![0].idempotencyKey);
    expect(host.textContent).toContain('Permission was revoked for this saved version and this Book');
    expect(f.publish.mock.calls).toHaveLength(0);
    expect(f.visit.snapshot()).toBe(publication);
    f.consent.mockImplementationOnce(async () => hostedFailure('denied', 'Denied'));
    await act(async () => {
      getByRole(host, 'button', { name: 'Permit this version for this Book' }).click();
    });
    expect(host.textContent).toContain('source service denied this action');
    expect(host.textContent).not.toContain('consent is missing');
    await act(async () => f.visit.submit());
    expect(f.publish.mock.calls).toHaveLength(1);
    await act(async () => {
      f.visit.review();
    });
    expect(host.textContent).toContain('source service denied this action');
    await act(async () => {
      f.visit.cancelReview();
      f.visit.observeDraft(f.chapter.occurrenceId);
    });
    expect(f.visit.sourceConsent!.snapshot()).toEqual({ kind: 'inactive' });
    await act(async () => f.visit.readVersion());
    await act(async () => {
      f.visit.review();
    });
    expect(f.visit.sourceConsent!.snapshot()).toMatchObject({ phase: 'unknown' });
    expect(f.consent.mock.calls).toHaveLength(3);
    await act(async () => f.change({ generation: 2 }));
    expect(f.visit.sourceConsent!.snapshot()).toEqual({ kind: 'ended' });
    expect(queryByRole(host, 'button', { name: 'Permit this version for this Book' })).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    f.visit.dispose();
  }
});

test('lost issue/revoke replies preserve exact tuple, receipt, key and CSRF; retirement and denial cannot replay or restore an old approval', async () => {
  const f = consentFixture();
  try {
    f.native.mockImplementationOnce(async () => hostedFailure('uncertain', 'Lost issue reply'));
    await f.visit.issue();
    const issue = f.native.mock.calls[0]![0];
    await f.visit.issue();
    await f.visit.revoke();
    expect(f.native.mock.calls).toHaveLength(1);
    await f.visit.replay();
    expect(f.native.mock.calls[1]![0]).toBe(issue);
    expect(f.native.mock.calls[1]![2]).toBe('original-csrf');
    f.native.mockImplementationOnce(async () => hostedFailure('uncertain', 'Lost revoke reply'));
    await f.visit.revoke();
    const revoke = f.native.mock.calls[2]![0];
    expect(revoke).toMatchObject({
      kind: 'revoke',
      body: { catalogueId: id(1), target, disclosureId: receipt.disclosureId },
    });
    expect(revoke.idempotencyKey).not.toBe(issue.idempotencyKey);
    await f.visit.replay();
    expect(f.native.mock.calls[3]![0]).toBe(revoke);
    expect(f.visit.snapshot()).toMatchObject({ phase: 'revoked' });
    let finish!: (result: StudioResult<SourceConsentReceipt>) => void;
    f.native.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const pending = f.visit.issue();
    const signal = f.native.mock.calls[4]![1];
    f.visit.select({ catalogueId: id(1), target: { ...target, revisionId: id(14), sha256: 'c'.repeat(64) } });
    expect(signal.aborted).toBe(true);
    finish(ok(receipt));
    await pending;
    expect(f.visit.snapshot()).toMatchObject({ phase: 'unknown' });
    await f.visit.revoke();
    await f.visit.replay();
    expect(f.native.mock.calls).toHaveLength(5);
    f.native.mockImplementationOnce(async () => hostedFailure('denied', 'Denied'));
    await f.visit.issue();
    expect(f.visit.snapshot()).toMatchObject({ phase: 'denied' });
    await f.visit.revoke();
    await f.visit.replay();
    expect(f.native.mock.calls).toHaveLength(6);
    expect(JSON.stringify(f.visit.snapshot())).not.toContain(receipt.disclosureId);
    f.native.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const late = f.visit.issue();
    f.change({ generation: 2 }); // Same account with a replaced authorization/session generation.
    finish(ok(receipt));
    await late;
    expect(f.visit.snapshot()).toEqual({ kind: 'ended' });
    await f.visit.issue();
    await f.visit.replay();
    expect(f.native.mock.calls).toHaveLength(7);
  } finally {
    f.visit.dispose();
  }
  // Every source coordinate and the intended Book retire an unresolved revoke, even in the same account.
  for (const selected of [
    { catalogueId: id(2), target },
    { catalogueId: id(1), target: { ...target, threadId: id(15) } },
    { catalogueId: id(1), target: { ...target, postId: id(16) } },
    { catalogueId: id(1), target: { ...target, revisionId: id(17) } },
    { catalogueId: id(1), target: { ...target, sha256: 'c'.repeat(64) } },
  ]) {
    const g = consentFixture();
    await g.visit.issue();
    g.native.mockImplementationOnce(async () => hostedFailure('uncertain', 'Lost revoke reply'));
    await g.visit.revoke();
    g.visit.select(selected);
    await g.visit.replay();
    await g.visit.revoke();
    expect(g.native.mock.calls).toHaveLength(2);
    expect(g.visit.snapshot()).toMatchObject({ phase: 'unknown' });
    g.visit.dispose();
  }
});

test('generated Post transport binds paths, exact bodies and receipts, rejecting wrong Book, operation state and revoke identity', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  let result: unknown = receipt;
  let status = 200;
  const native = createSourceConsentTransport(
    createKernelClient('https://kernel.invalid', {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: new URL(String(input)), init });
        return Response.json(result, { status });
      }) as typeof fetch,
    }),
  );
  const issue: SourceConsentRequest = {
    kind: 'issue',
    body: { catalogueId: id(1), target },
    expectedViewer: owner.viewer,
    idempotencyKey: crypto.randomUUID(),
  };
  const revoke: SourceConsentRequest = {
    ...issue,
    kind: 'revoke',
    body: { ...issue.body, disclosureId: receipt.disclosureId },
    idempotencyKey: crypto.randomUUID(),
  };
  const signal = new AbortController().signal;
  expect(await native(issue, signal, '')).toEqual(ok(receipt));
  result = { ...receipt, state: 'revoked' };
  expect(await native(revoke, signal, '')).toEqual(ok(result));
  expect(calls.map((call) => call.url.pathname)).toEqual([
    `/v1/posts/${target.postId}:issueRevisionDisclosure`,
    `/v1/posts/${target.postId}:revokeRevisionDisclosure`,
  ]);
  expect(calls.map((call) => JSON.parse(String(call.init!.body)))).toEqual([issue.body, revoke.body]);
  expect(calls.every((call) => call.init?.cache === 'no-store' && call.init?.redirect === 'manual')).toBe(true);
  expect(JSON.parse(new Headers(calls[0]!.init!.headers).get('idempotency-key')!)).toBe(issue.idempotencyKey);
  for (const [request, response] of [
    [issue, { ...receipt, catalogueId: id(2) }],
    [issue, { ...receipt, state: 'revoked' }],
    [revoke, { ...receipt, state: 'issued' }],
    [revoke, { ...receipt, state: 'revoked', disclosureId: id(31) }],
    [issue, { ...receipt, durableInitiator: 'not-a-digest' }],
  ] as const) {
    result = response;
    expect(await native(request, signal, '')).toMatchObject({ ok: false, error: { kind: 'uncertain' } });
  }
  status = 403;
  result = { code: 'forbidden' };
  expect(await native(issue, signal, '')).toMatchObject({ ok: false, error: { kind: 'denied' } });
  status = 404;
  expect(await native(revoke, signal, '')).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
});
