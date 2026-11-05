import { expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { personalRead } from '../src/kernel/query';
import { m } from '../src/paraglide/messages.js';
import { getServerAsyncLocalStorage, locales, overwriteServerAsyncLocalStorage } from '../src/paraglide/runtime.js';
import { readVerification, unwrapVerificationRead, VerificationReadError } from '../src/settings/verification-core';
import type { AgentVerificationRequest } from '../src/settings/verification-core';
import {
  canRequestVerification,
  observeVerificationRead,
  VerificationRecovery,
  verificationQueryKey,
  type VerificationSnapshot,
} from '../src/settings/verification-recovery';

mock.module('@tanstack/react-start', () => start);
let setupFault: unknown = new Error('Unexpected native read');
mock.module('@tanstack/react-start/server', () => ({
  getRequest() {
    if (setupFault !== undefined) throw setupFault;
    return new Request('https://site.example.test/en/settings');
  },
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { VerificationCard } = await import('../src/settings/verification');
const { readVerificationState, requestVerificationAction, withdrawVerificationAction } =
  await import('../src/settings/verification-actions');
const { MediaProblem } = await import('../src/media/kernel');

const empty: VerificationSnapshot = {
  accountId: 'alice',
  verificationRequest: null,
  viewerActions: [{ action: 'account:update', operations: ['account.request_verification'] }],
  subjectTitle: null,
};
const requestRecord = (id: string, createdAt: string, statement: string): AgentVerificationRequest => ({
  id,
  accountId: 'alice',
  accountKind: 'actor',
  requestedBy: 'alice',
  catalogueSubjectId: 'subject-1',
  statement,
  links: [],
  state: 'pending',
  reason: null,
  problem: null,
  decisionReceiptId: null,
  decidedBy: null,
  createdAt,
  updatedAt: createdAt,
});
const noCommand = async (): Promise<never> => {
  throw new Error('Unexpected verification command');
};

test('Keep verification status observation separate from its private read preserving original native privacy and request bounds', async () => {
  const client = new QueryClient();
  const calls: Request[] = [];
  const native = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toBe('/v1/accounts/alice/verification');
      expect(request.headers.get('authorization')).toBe('Bearer alice-only');
      return Response.json({
        verificationRequest: null,
        viewerActions: [{ action: 'account:update', operations: ['account.request_verification'] }],
      });
    }) as typeof fetch,
  });
  let notifications = 0;
  const stop = observeVerificationRead(client, 'alice', () => notifications++);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(calls).toHaveLength(0);
  const options = {
    ...personalRead,
    queryKey: verificationQueryKey('alice'),
    retry: false as const,
    queryFn: async () =>
      unwrapVerificationRead({
        ok: true,
        value: {
          ...empty,
          ...(await readVerification(native, 'alice', 'Bearer alice-only')),
        },
      }),
  };
  try {
    await client.fetchQuery(options);
    expect(notifications).toBeGreaterThan(0);
    const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    expect(query.options.queryFn).toBe(options.queryFn);
    expect(query.getObserversCount()).toBe(0);
    expect(calls).toHaveLength(1);
    const before = notifications;
    client.setQueryData([...options.queryKey, 'other-surface'], 'unrelated');
    client.setQueryData(verificationQueryKey('bob'), { ...empty, accountId: 'bob' });
    expect(notifications).toBe(before);
    stop();
    const closed = new Error('rezics-platform-closed');
    await expect(
      client.fetchQuery({
        ...options,
        queryFn: async () => {
          throw closed;
        },
      }),
    ).rejects.toBe(closed);
    // Switching the observation to Bob cannot retain Alice's closure or respond to her later completion.
    let bobChanges = 0;
    const stopBob = observeVerificationRead(client, 'bob', () => bobChanges++);
    const stopAnonymous = observeVerificationRead(client, null, () => {
      throw new Error('No viewer');
    });
    expect(client.getQueryState(verificationQueryKey('bob'))?.error).toBeNull();
    expect(client.getQueryState(verificationQueryKey(null))).toBeUndefined();
    await client.fetchQuery(options);
    expect(bobChanges).toBe(0);
    expect(notifications).toBe(before);
    expect(query.options.queryFn).toBe(options.queryFn);
    expect(calls).toHaveLength(2);
    stopBob();
    stopAnonymous();
  } finally {
    stop();
    client.clear();
  }
});

test('the current card announces loading, native read failure and explicit empty recovery in every launch locale', async () => {
  const previous = getServerAsyncLocalStorage();
  const storage = new AsyncLocalStorage<{ locale: (typeof locales)[number] }>();
  overwriteServerAsyncLocalStorage(storage);
  const client = new QueryClient();
  let reads = 0;
  let finish!: (value: VerificationSnapshot) => void;
  const failure = {
    status: 503,
    code: 'dependency_unavailable',
    message: 'Native status unavailable',
    requestId: 'read-1',
    retryAfter: 'private header text',
  };
  const controller = new VerificationRecovery('alice', {
    read: async () => {
      if (++reads === 1)
        return new Promise<VerificationSnapshot>((resolve) => {
          finish = resolve;
        });
      if (reads === 2) throw new VerificationReadError(failure);
      return empty;
    },
    request: noCommand,
    withdraw: noCommand,
  });
  const markup = () =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(VerificationCard, { controller, csrfToken: 'current-csrf' }),
      ),
    );
  try {
    const loading = controller.reload();
    await controller.reload();
    expect(reads).toBe(1);
    for (const locale of locales)
      storage.run({ locale }, () => {
        expect(markup()).toContain(
          `<div role="status" aria-live="polite" aria-atomic="true"><p>${m.settings_verification_loading()}</p>`,
        );
        expect(markup()).not.toContain(m.settings_verification_read_empty());
      });
    finish(empty);
    await loading;
    await controller.reload();
    expect(controller.snapshot()).toMatchObject({ readStatus: 'error', current: null, failure });
    for (const locale of locales)
      storage.run({ locale }, () => {
        const html = markup();
        expect(html).toContain('role="alert" data-response-status="503"');
        expect(html).toContain('data-request-id="read-1"');
        expect(html).toContain(m.settings_verification_load_failed());
        expect(html).toContain(m.settings_verification_read_error({ status: 503, message: failure.message }));
        expect(html).toContain(m.settings_verification_read_current());
        expect(html).not.toContain(m.settings_verification_read_empty());
        expect(html).not.toContain(failure.retryAfter);
        expect(html).not.toContain(failure.message);
      });
    expect(reads).toBe(2); // Rendering and subscriptions never repeat private IO.
    Object.assign(failure, { code: 'private diagnostic text', requestId: 'private request text' });
    storage.run({ locale: 'en' }, () => {
      expect(markup()).not.toContain(failure.code);
      expect(markup()).not.toContain(failure.requestId);
    });
    await controller.reload();
    expect(controller.snapshot()).toMatchObject({ readStatus: 'success', current: empty, attempt: null });
    expect(canRequestVerification(controller.snapshot().current)).toBe(true);
    for (const locale of locales)
      storage.run({ locale }, () => {
        const html = markup();
        expect(html).toContain(
          `<div role="status" aria-live="polite" aria-atomic="true"><p>${m.settings_verification_read_empty()}</p>`,
        );
        expect(html).not.toContain(m.settings_verification_load_failed());
        expect(html).not.toContain(m.settings_verification_sent());
        expect(html).not.toContain(m.settings_verification_verified());
        // A successful empty read does not select a subject or enable a request without that prerequisite.
        expect(html).toMatch(
          new RegExp(`<button[^>]*type="submit"[^>]*disabled=""[^>]*>${m.settings_verification_submit()}</button>`),
        );
      });
    expect(reads).toBe(3);
  } finally {
    controller.deactivate();
    client.clear();
    overwriteServerAsyncLocalStorage(previous);
  }
});

test('readable status with no admitted command never unlocks Request', async () => {
  const denied: VerificationSnapshot = { ...empty, viewerActions: [] };
  const controller = new VerificationRecovery('alice', {
    read: async () => denied,
    request: noCommand,
    withdraw: noCommand,
  });
  await controller.reload();
  expect(canRequestVerification(controller.snapshot().current)).toBe(false);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(VerificationCard, { controller, csrfToken: 'current-csrf' }),
    ),
  );
  expect(html).toContain(m.settings_verification_read_empty());
  expect(html).not.toContain(`>${m.settings_verification_submit()}<`);
  controller.deactivate();
});

test('an unacknowledged lookalike stays uncertain and retired readers cannot publish a late result', async () => {
  let reads = 0;
  let finish!: (value: VerificationSnapshot) => void;
  const sent: unknown[] = [];
  const lookalike: VerificationSnapshot = {
    ...empty,
    verificationRequest: requestRecord('lookalike', '2026-10-30T08:00:00.000Z', 'Original statement'),
  };
  const controller = new VerificationRecovery('alice', {
    read: async () => {
      reads++;
      if (reads === 2) throw new Error('Read connection lost');
      if (reads === 5)
        return new Promise<VerificationSnapshot>((resolve) => {
          finish = resolve;
        });
      return reads === 3 ? lookalike : empty;
    },
    request: async (_, input) => {
      sent.push(input);
      throw new Error('Command response lost');
    },
    withdraw: noCommand,
  });
  await controller.reload();
  await controller.submit({ subject: 'subject-1', statement: 'Original statement', links: [] });
  const original = controller.snapshot().attempt;
  const originalInput = original!.input;
  const originalEvidence = JSON.stringify(originalInput);
  const capturedRetry = () => controller.retry();
  expect(controller.snapshot().readStatus).toBe('idle');
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ readStatus: 'error', phase: 'uncertain', current: null });
  expect(controller.snapshot().attempt).toBe(original);
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ readStatus: 'success', phase: 'uncertain', current: lookalike });
  expect(controller.snapshot().attempt).toBe(original);
  await controller.retry();
  await capturedRetry();
  expect(sent).toEqual([originalInput, originalInput]);
  expect(sent[1]).toBe(sent[0]);
  expect(original!.input).toBe(originalInput);
  expect(JSON.stringify(original!.input)).toBe(originalEvidence);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(VerificationCard, {
        controller,
        csrfToken: 'current-csrf',
        initialDraft: {
          selected: { id: 'later-subject', title: 'Later subject', type: 'agent' },
          statement: 'Later draft',
          links: [{ label: 'Later link', url: 'https://example.test/later' }],
        },
      }),
    ),
  );
  expect(html).toContain('Original statement');
  expect(html).toContain('Later draft');
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const originalRetry = buttons.find((button) => button.includes(m.settings_verification_retry_original()));
  const currentRead = buttons.find((button) => button.includes(m.settings_verification_read_current()));
  expect(originalRetry).toContain('disabled=""');
  expect(currentRead).toBeDefined();
  expect(currentRead).not.toContain('disabled=""');
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ readStatus: 'success', phase: 'uncertain', current: empty });
  expect(controller.snapshot().attempt).toBe(original);
  await capturedRetry();
  expect(sent).toEqual([originalInput, originalInput, originalInput]);
  expect(sent[2]).toBe(sent[0]);
  const late = controller.reload();
  const retired = controller.snapshot();
  controller.deactivate();
  finish(empty);
  await late;
  await controller.reload();
  expect(controller.snapshot()).toBe(retired);
  expect(reads).toBe(5);
});

test('a validated receipt survives a failed read, then yields to the newer current request', async () => {
  const receipt = requestRecord('old-request', '2026-10-30T08:00:00.000Z', 'Original statement');
  const newer = requestRecord('new-request', '2026-10-30T09:00:00.000Z', 'Current request statement');
  const current: VerificationSnapshot = {
    ...empty,
    verificationRequest: newer,
    viewerActions: [
      { action: 'account:update', operations: ['account.request_verification', 'account.withdraw_verification'] },
    ],
  };
  const sent: unknown[] = [];
  let reads = 0;
  let controller!: VerificationRecovery;
  let withdrawalTarget: string | null = null;
  controller = new VerificationRecovery('alice', {
    read: async () => {
      if (++reads === 1) return empty;
      if (reads === 2) throw new Error('Read after receipt failed');
      return current;
    },
    request: async (_accountId, input) => {
      sent.push(input);
      return { ok: true, verificationRequest: receipt };
    },
    withdraw: async () => {
      withdrawalTarget = controller.snapshot().attempt?.requestId ?? null;
      return { ok: false, outcome: 'refused', status: 403, message: 'Not admitted' };
    },
  });
  await controller.reload();
  await controller.submit({ subject: 'subject-1', statement: 'Original statement', links: [] });
  expect(controller.snapshot()).toMatchObject({ phase: 'uncertain', readStatus: 'error', attempt: { receipt } });
  await controller.retry();
  const received = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(VerificationCard, {
        controller,
        csrfToken: 'current-csrf',
        initialDraft: {
          selected: { id: 'later-subject', title: 'Later subject', type: 'agent' },
          statement: 'Later draft',
          links: [{ label: 'Later link', url: 'https://example.test/later' }],
        },
      }),
    ),
  );
  expect(sent).toHaveLength(1);
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ phase: 'review', readStatus: 'success', current, attempt: null });
  expect(received).not.toContain(m.settings_verification_uncertain_request());
  expect(received).toContain(m.settings_verification_request_received());
  expect(received).toContain(m.settings_verification_check_guidance());
  expect(received).toContain(m.settings_verification_read_current());
  expect(received).not.toContain(m.settings_verification_retry_original());
  expect(received).not.toContain(m.settings_verification_retry_request_guidance());
  expect(received).toContain('Later draft');
  expect(canRequestVerification(controller.snapshot().current)).toBe(true);
  await controller.withdraw(true);
  expect(withdrawalTarget).toBe(newer.id);
});

test('read-only Verification recovery cannot mint request or withdrawal attempts', async () => {
  let reads = 0;
  const controller = new VerificationRecovery(
    'alice',
    {
      read: async () => {
        reads++;
        return empty;
      },
      request: noCommand,
      withdraw: noCommand,
    },
    () => true,
    () => false,
  );
  await controller.reload();
  const before = controller.snapshot();
  await controller.submit({ subject: 'agent', statement: 'Evidence', links: [] });
  await controller.withdraw(true);
  await controller.retry();
  expect(controller.snapshot()).toBe(before);
  expect(controller.snapshot().current).toEqual(empty);
  expect(controller.snapshot().attempt).toBeNull();
  expect(reads).toBe(1);
});

const commandDraft = {
  accountId: 'alice',
  subject: 'subject-1',
  statement: 'Official domain challenge supplied for independent review.',
  links: [{ label: 'Official site', url: 'https://example.org' }],
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
};

test('setup, transport and body faults return the private current-read and command envelopes without leaking the cause', async () => {
  const leaked = 'Unexpected native read';
  const previous = setupFault;
  try {
    setupFault = new Error(leaked);
    const read = await readVerificationState({ data: { accountId: 'alice' } });
    expect(read).toEqual({
      ok: false,
      failure: { status: 0, message: m.settings_verification_load_failed() },
    });
    expect(JSON.stringify(read)).not.toContain(leaked);
    const requested = await requestVerificationAction({ data: commandDraft });
    expect(requested).toEqual({ ok: false, status: 0, message: m.settings_verification_request_failed() });
    expect(JSON.stringify(requested)).not.toContain(leaked);
    const withdrawn = await withdrawVerificationAction({
      data: { accountId: 'alice', idempotencyKey: commandDraft.idempotencyKey },
    });
    expect(withdrawn).toEqual({ ok: false, status: 0, message: m.settings_verification_request_failed() });
    setupFault = new MediaProblem(
      {
        type: 'https://example.test/problems/overloaded',
        title: 'private response body',
        status: 503,
        code: 'overloaded',
      },
      { 'Retry-After': '12' },
    );
    Object.defineProperty((setupFault as MediaProblem).problem, 'retryable', { value: true });
    Object.defineProperty((setupFault as MediaProblem).problem, 'request_id', { value: 'native-request-id' });
    const nativeRead = await readVerificationState({ data: { accountId: 'alice' } });
    expect(nativeRead).toEqual({
      ok: false,
      failure: {
        status: 503,
        message: m.settings_verification_request_failed(),
        code: 'overloaded',
        retryable: true,
        requestId: 'native-request-id',
        retryAfter: '12',
      },
    });
    expect(JSON.stringify(nativeRead)).not.toContain('private response body');
    const overloadedCommand = await requestVerificationAction({ data: commandDraft });
    expect(overloadedCommand).toMatchObject({ ok: false, status: 503, retryAfter: '12', code: 'overloaded' });
    expect(JSON.stringify(overloadedCommand)).not.toContain('private response body');
    setupFault = new DOMException('Verification request timed out', 'TimeoutError');
    const timeoutRead = await readVerificationState({ data: { accountId: 'alice' } });
    expect(timeoutRead).toEqual({
      ok: false,
      failure: { status: 0, message: m.settings_verification_load_failed() },
    });
    expect(JSON.stringify(timeoutRead)).not.toContain('timed out');
    const timeoutCommand = await requestVerificationAction({ data: commandDraft });
    expect(timeoutCommand).toEqual({ ok: false, status: 0, message: m.settings_verification_request_failed() });
  } finally {
    setupFault = previous;
  }
});
