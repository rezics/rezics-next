import { afterEach, expect, test } from 'bun:test';
import {
  OPERATOR_MANAGEMENT_PROFILE,
  parseTransferRequest,
  prepareTransfer,
  reauthenticateTransfer,
  submitTransferAttempt,
  type TransferAttempt,
  type TransferRequest,
} from '../src/operator-transfer';
import { OPERATOR_TRANSFER_PAGE_PATH } from '../src/operator-transfer-page';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request: TransferRequest = {
  version: 1,
  previous: {
    operatorAccountId: 'source-operator',
    subjectAccountId: 'operated-account',
    reservationId: 'source-reservation',
  },
  expectedVersion: '12',
  operatorAccountId: 'destination-operator',
  sourceOperationKey: 'source-key',
};
const destination = (): TransferAttempt => ({
  accountId: 'destination-human',
  request: structuredClone(request),
  side: 'destination',
  phase: 'approve',
});
const source = (): TransferAttempt => ({
  accountId: 'source-human',
  request: structuredClone(request),
  side: 'source',
  acceptance: 'opaque-native-acceptance',
  phase: 'approve',
});

// Page protocol evidence only. Native authority/DBOS and mounted production
// transport remain the original acceptance debt; these fixtures do not prove it.
test('Complete native destination acceptance and operator transfer journey preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  let person = 'destination-human';
  let changed = false;
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    if (path === '/session')
      return Response.json({
        account_id: person,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === OPERATOR_TRANSFER_PAGE_PATH) {
      const input = JSON.parse(String(init?.body));
      if (input.kind === 'destination')
        return Response.json({
          viewer: { kind: 'ready' },
          review: { kind: 'destination', destinationAccountId: request.operatorAccountId, action: 'allowed' },
        });
      return Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          relation: changed
            ? {
                previous: {
                  operatorAccountId: request.operatorAccountId,
                  subjectAccountId: request.previous.subjectAccountId,
                  reservationId: 'new-reservation',
                },
                expectedVersion: '13',
              }
            : { previous: request.previous, expectedVersion: request.expectedVersion },
          action: 'allowed',
        },
      });
    }
    if (path === '/account-operations/approve')
      return Response.json({
        reference: person === 'destination-human' ? 'opaque-native-acceptance' : 'source-approval',
        expiresAt: '2030-01-01T00:00:00Z',
      });
    if (path === '/account-operations/execute') {
      changed = true;
      return Response.json({ accountId: request.previous.subjectAccountId });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  const accept = destination();
  expect(await submitTransferAttempt(accept, () => true)).toEqual({
    kind: 'accepted',
    reference: 'opaque-native-acceptance',
  });
  expect(calls.some((call) => call.path.endsWith('/execute'))).toBe(false);
  expect(calls.find((call) => call.path.endsWith('/approve'))?.body).toEqual({
    operationKey: request.sourceOperationKey,
    operation: {
      kind: 'transfer-acceptance',
      previous: request.previous,
      expectedVersion: '12',
      operatorAccountId: request.operatorAccountId,
      sourceOperationKey: request.sourceOperationKey,
    },
  });
  person = 'source-human';
  const transfer = source();
  expect(await submitTransferAttempt(transfer, () => true)).toMatchObject({
    kind: 'acknowledged',
    readback: {
      kind: 'current',
      relation: {
        previous: {
          operatorAccountId: request.operatorAccountId,
          subjectAccountId: request.previous.subjectAccountId,
          reservationId: 'new-reservation',
        },
        expectedVersion: '13',
      },
    },
  });
  expect(calls.find((call) => call.path.endsWith('/execute'))?.body).toEqual({
    operationKey: request.sourceOperationKey,
    reference: 'source-approval',
    operation: {
      kind: 'transfer',
      previous: request.previous,
      expectedVersion: '12',
      operatorAccountId: request.operatorAccountId,
      acceptance: 'opaque-native-acceptance',
    },
  });
  expect(transfer.phase).toBe('readback');
  const count = calls.length;
  expect(await submitTransferAttempt(accept, () => true)).toEqual({ kind: 'failure', reason: 'account-changed' });
  expect(calls).toHaveLength(count);
});

test('lost execution response retains the exact key operation and approval; retry never approves again and acknowledgement needs readback', async () => {
  let approves = 0;
  let transferred = false;
  const executions: unknown[] = [];
  const attempt = source();
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === '/session')
      return Response.json({
        account_id: attempt.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (path === OPERATOR_TRANSFER_PAGE_PATH)
      return Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          relation: transferred
            ? {
                previous: {
                  ...request.previous,
                  operatorAccountId: request.operatorAccountId,
                  reservationId: 'new-reservation',
                },
                expectedVersion: '13',
              }
            : { previous: request.previous, expectedVersion: request.expectedVersion },
          action: 'allowed',
        },
      });
    if (path.endsWith('/approve')) {
      approves++;
      return Response.json({ reference: 'saved-reference', expiresAt: '2030-01-01T00:00:00Z' });
    }
    executions.push(JSON.parse(String(init?.body)));
    if (executions.length === 1) throw new TypeError('lost response');
    transferred = true;
    return Response.json({ accountId: request.previous.subjectAccountId });
  }) as typeof fetch;
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({ kind: 'failure', reason: 'uncertain' });
  expect(attempt).toMatchObject({ reference: 'saved-reference', phase: 'execute' });
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({
    kind: 'acknowledged',
    reference: 'saved-reference',
    readback: { kind: 'current' },
  });
  expect(approves).toBe(1);
  expect(executions[1]).toEqual(executions[0]);
});

test('stale step-up retains the account tuple key and opaque reference and requires another submit', async () => {
  const attempt = source();
  let fresh = false;
  let approvals = 0;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === '/session')
      return Response.json({
        account_id: attempt.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (path === OPERATOR_TRANSFER_PAGE_PATH)
      return Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          relation: { previous: request.previous, expectedVersion: request.expectedVersion },
          action: 'allowed',
        },
      });
    if (path === '/signin') {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'human@example.test',
        password: 'secret',
        ...OPERATOR_MANAGEMENT_PROFILE,
      });
      fresh = true;
      return Response.json({});
    }
    approvals++;
    return fresh
      ? Response.json({ reference: 'ref', expiresAt: '2030-01-01T00:00:00Z' })
      : Response.json({ error: 'step_up_required' }, { status: 401 });
  }) as typeof fetch;
  const original = structuredClone(attempt);
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({ reason: 'step-up' });
  expect(attempt).toEqual(original);
  expect(await reauthenticateTransfer(attempt.accountId, 'human@example.test', 'secret')).toBeNull();
  expect(approvals).toBe(1);
  expect(attempt).toEqual(original);
});

test('missing version unavailable reader and stale native conflict never create guessed authority', async () => {
  const attempt = source();
  let response = Response.json({
    viewer: { kind: 'ready' },
    review: { kind: 'source', relation: { previous: request.previous }, action: 'allowed' },
  });
  let mutations = 0;
  globalThis.fetch = (async (input) => {
    if (String(input) === '/session')
      return Response.json({
        account_id: attempt.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (String(input) === OPERATOR_TRANSFER_PAGE_PATH) return response.clone();
    mutations++;
    return Response.json({ error: 'account_operation_denied' }, { status: 409 });
  }) as typeof fetch;
  expect(
    await prepareTransfer(request.previous.subjectAccountId, request.operatorAccountId, attempt.accountId),
  ).toEqual({ kind: 'failure', reason: 'unavailable' });
  response = new Response(null, { status: 404 });
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({ reason: 'unavailable' });
  expect(mutations).toBe(0);
  response = Response.json({
    viewer: { kind: 'ready' },
    review: { kind: 'changed' },
  });
  expect(await submitTransferAttempt(attempt, () => true)).toEqual({ kind: 'failure', reason: 'conflict' });
  expect(mutations).toBe(0);
  response = Response.json({
    viewer: { kind: 'ready' },
    review: { kind: 'source', relation: { previous: request.previous, expectedVersion: '12' }, action: 'allowed' },
  });
  expect(await submitTransferAttempt(attempt, () => true)).toEqual({
    kind: 'failure',
    reason: 'conflict',
    status: 409,
    code: 'account_operation_denied',
  });
  expect(parseTransferRequest(JSON.stringify({ ...request, authorization: 'fake' }))).toBeNull();
  expect(parseTransferRequest(JSON.stringify({ ...request, returnTo: 'https://elsewhere.test' }))).toBeNull();
  expect(
    parseTransferRequest(JSON.stringify({ ...request, previous: { ...request.previous, actor: 'fake' } })),
  ).toBeNull();
});

// One default-page composition regression; the existing native assertions above
// remain separate. Reuse the canonical stories, shell and installed DOM support.
test('The default operator-transfer page supports request and acceptance file handoff with explicit current review and approval, preserving the original exact request, opaque reference and uncertain attempt', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
  );
  const window = new Window({ url: 'https://auth.test/operators/transfer', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    sessionStorage: window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const stories = await import('../src/stories/operator-transfer/transfer.stories');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { readTransferHandoff, downloadTransferHandoff } = await import('../src/operator-transfer-handoff');
  setLocale('en', { reload: false });
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  let root = createRoot(host);
  const downloads: { blob: Blob; filename?: string }[] = [];
  const revoked: string[] = [];
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    downloads.push({ blob: blob as Blob });
    return `blob:handoff-${downloads.length}`;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.at(-1)!.filename = this.download;
  };
  const mutations: { path: string; body: any }[] = [];
  let reads = 0;
  const saved = () => JSON.parse(window.sessionStorage.getItem('rezics.operator-transfer.attempt') ?? 'null');
  const button = (label: string) => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  async function mount(story: typeof stories.SourceRequest) {
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(story.render()));
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      if (path === OPERATOR_TRANSFER_PAGE_PATH && JSON.parse(String(init?.body)).kind !== 'readiness') reads++;
      if (path.startsWith('/account-operations/')) mutations.push({ path, body: JSON.parse(String(init?.body)) });
      return fixtureFetch(input, init);
    }) as typeof fetch;
  }
  const select = async (kind: 'request' | 'acceptance', files: unknown[]) => {
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>(`#transfer-${kind}-file`)!;
      Object.defineProperty(input, 'files', { configurable: true, value: files });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const confirm = async () => {
    await act(async () => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  };
  const raw = (id: string) => host.querySelector<HTMLTextAreaElement>(`#${id}`)!.value;
  let oversizedReads = 0;
  const tooLarge = {
    size: 4097,
    arrayBuffer: () => {
      oversizedReads++;
      throw new Error('Oversized files must never be read');
    },
  };
  const unreadable = {
    size: 1,
    arrayBuffer: async () => {
      throw new Error('Local read refused');
    },
  };
  try {
    await mount(stories.SourceRequest);
    const original = saved();
    await click(m.auth_transfer_handoff_download_request());
    const requestText = await downloads[0]!.blob.text();
    expect(JSON.parse(requestText)).toEqual(original.request);
    expect(downloads[0]!.filename).toBe('operator-transfer-request.json');
    expect(saved()).toEqual(original);
    expect(mutations).toHaveLength(0);

    await mount(stories.IndependentForms);
    expect(host.querySelector('ol')!.children).toHaveLength(4);
    expect(host.querySelector('a[href="/security"]')).not.toBeNull();
    expect(host.querySelector('#transfer-request-file')!.getAttribute('aria-describedby')).toContain(
      'transfer-file-feedback',
    );
    // File suffix and MIME never supply validity.
    await select('request', [new File([requestText], 'request.bin', { type: 'image/png' })]);
    expect(raw('transfer-request-input')).toBe(requestText);
    expect(saved()).toBeNull();
    expect(reads).toBe(0);
    await select('request', [new File(['{}'], 'request.json')]);
    await select('request', [tooLarge]);
    await select('request', [unreadable]);
    await select('request', [new File([requestText], 'a'), new File([requestText], 'b')]);
    expect(raw('transfer-request-input')).toBe(requestText);
    expect(mutations).toHaveLength(0);
    // A slow local read cannot replace a later reviewed attempt.
    let finishRead!: (bytes: ArrayBuffer) => void;
    await select('request', [
      {
        size: requestText.length,
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((resolve) => {
            finishRead = resolve;
          }),
      },
    ]);
    await click(m.auth_transfer_review());
    expect(reads).toBe(1);
    expect(saved()).toMatchObject({ side: 'destination', phase: 'approve', request: original.request });
    await act(async () => {
      finishRead(
        new TextEncoder().encode(JSON.stringify({ ...original.request, operatorAccountId: 'another-operator' })).buffer,
      );
    });
    expect(saved().request).toEqual(original.request);
    expect(button(m.auth_transfer_accept()).disabled).toBe(true);
    await click(m.auth_transfer_accept());
    expect(mutations).toHaveLength(0);
    await confirm();
    await click(m.auth_transfer_accept());
    expect(saved()).toMatchObject({ phase: 'accepted', request: original.request });
    expect(mutations.map((call) => call.path)).toEqual(['/account-operations/approve']);
    expect(mutations[0]!.body.operation).toEqual({
      kind: 'transfer-acceptance',
      previous: original.request.previous,
      expectedVersion: original.request.expectedVersion,
      operatorAccountId: original.request.operatorAccountId,
      sourceOperationKey: original.request.sourceOperationKey,
    });
    await click(m.auth_transfer_handoff_download_acceptance());
    const reference = saved().reference;
    expect(await downloads[1]!.blob.text()).toBe(reference);
    expect(downloads[1]!.filename).toBe('operator-transfer-acceptance.txt');

    await mount(stories.SourceRequest);
    const beforeImport = saved();
    const writesBeforeImport = mutations.length;
    await select('acceptance', [new File([reference], 'response.bin')]);
    expect(raw('transfer-acceptance')).toBe(reference);
    expect(saved()).toEqual(beforeImport);
    for (const file of [
      new File([requestText], 'wrong-kind.txt'),
      new File([reference + '\n'], 'response.txt'),
      tooLarge,
      unreadable,
    ])
      await select('acceptance', [file]);
    expect(raw('transfer-acceptance')).toBe(reference);
    expect(saved()).toEqual(beforeImport);
    expect(host.querySelector<HTMLInputElement>('#transfer-confirm')!.checked).toBe(false);
    expect(mutations).toHaveLength(writesBeforeImport);
    await confirm();
    await click(m.auth_transfer_submit());
    expect(mutations.at(-1)).toEqual({
      path: '/account-operations/execute',
      body: {
        operationKey: original.request.sourceOperationKey,
        reference: 'opaque-source-approval',
        operation: {
          kind: 'transfer',
          previous: original.request.previous,
          expectedVersion: original.request.expectedVersion,
          operatorAccountId: original.request.operatorAccountId,
          acceptance: reference,
        },
      },
    });
    expect(host.textContent).toContain(m.auth_transfer_observed());
    expect(saved().request).toEqual(original.request);
    expect(saved().phase).toBe('readback');

    await mount(stories.LostResponse);
    await confirm();
    await click(m.auth_transfer_submit());
    const uncertain = saved();
    const writesBeforeRefusal = mutations.length;
    expect(uncertain.phase).toBe('execute');
    expect(host.textContent).toContain(m.auth_transfer_uncertain());
    expect(host.querySelector<HTMLInputElement>('#transfer-acceptance-file')!.disabled).toBe(true);
    await select('acceptance', [new File(['replacement'], 'response.txt')]);
    expect(saved()).toEqual(uncertain);
    expect(raw('transfer-acceptance')).toBe(uncertain.acceptance);
    expect(mutations).toHaveLength(writesBeforeRefusal);
    // Preserve non-ASCII opaque bytes, including a BOM; do not silently strip it.
    const opaque = '\ufeffopaque-é';
    expect(await readTransferHandoff([new File([opaque], 'response')], 'acceptance')).toEqual({
      kind: 'acceptance',
      text: opaque,
    });
    expect(await readTransferHandoff([new File(['é'.repeat(2048)], 'response')], 'acceptance')).toEqual({
      kind: 'acceptance',
      text: 'é'.repeat(2048),
    });
    expect(await readTransferHandoff([new File(['é'.repeat(2049)], 'response')], 'acceptance')).toEqual({
      kind: 'failure',
      reason: 'too-large',
    });
    expect(downloadTransferHandoff('acceptance', '\ud800')).toBe(false);
    expect(oversizedReads).toBe(0);
    expect(revoked).toEqual(['blob:handoff-1', 'blob:handoff-2']);
  } finally {
    await act(async () => root.unmount());
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
