import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AccountSessionResult } from '../src/account-operations';
import type { TransferAttempt } from '../src/operator-transfer';

// Mounted production-page presentation regressions. These are not native authority evidence.
// Reuse the installed DOM composition from turnstile-lifetime.test.tsx; no server or network.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({
  url: 'https://auth.test/operators/transfer',
  settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
});
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLFormElement: dom.HTMLFormElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Document: dom.Document,
  DocumentFragment: dom.DocumentFragment,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const original = new Map(
  [...Object.keys(globals), 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { OPERATOR_MANAGEMENT_PROFILE, storeTransferAttempt } = await import('../src/operator-transfer');
const { OPERATOR_TRANSFER_PAGE_PATH } = await import('../src/operator-transfer-page');
const { overwriteGetLocale, locales } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');

const session: AccountSessionResult = {
  kind: 'ready',
  accountId: '00000000-0000-7000-8000-000000000001',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: [...OPERATOR_MANAGEMENT_PROFILE.scope],
};
const source: TransferAttempt = {
  accountId: session.accountId,
  side: 'source',
  phase: 'approve',
  request: {
    version: 1,
    previous: {
      operatorAccountId: '00000000-0000-7000-8000-000000000002',
      subjectAccountId: '00000000-0000-7000-8000-000000000003',
      reservationId: '00000000-0000-7000-8000-000000000004',
    },
    expectedVersion: '12',
    operatorAccountId: '00000000-0000-7000-8000-000000000005',
    sourceOperationKey: 'original-source-key',
  },
};
const destinationSession = { ...session, accountId: source.request.operatorAccountId };
const destination = { ...source, accountId: destinationSession.accountId, side: 'destination' } as const;
let close: (() => Promise<void>) | undefined;
let calls: string[] = [];
let render: (initial: AccountSessionResult) => Promise<void>;
afterEach(async () => {
  await close?.();
  close = undefined;
  window.sessionStorage.clear();
  overwriteGetLocale(() => 'en');
});
afterAll(async () => {
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});
async function flush(action?: () => void) {
  await act(async () => {
    action?.();
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  });
}
function requestPath(input: RequestInfo | URL) {
  if (input instanceof URL) expect(input.origin).toBe('https://auth.test');
  return new URL(String(input), 'https://auth.test').pathname;
}
async function mount(initial: AccountSessionResult = session, attempt?: TransferAttempt) {
  calls = [];
  window.sessionStorage.clear();
  if (attempt) expect(storeTransferAttempt(structuredClone(attempt))).toBe(true);
  globalThis.fetch = (async (input, init) => {
    const path = requestPath(input);
    calls.push(path);
    if (path === '/session') {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('Cookie')).toBe('auth_session=original');
      if (initial.kind === 'signed-out') return new Response(null, { status: 401 });
      return Response.json(
        initial.kind === 'ready'
          ? { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes }
          : sessionBody,
      );
    }
    if (path === OPERATOR_TRANSFER_PAGE_PATH) {
      const body = JSON.parse(String(init?.body));
      if (body.kind === 'readiness') {
        if (initial.kind === 'signed-out')
          return Response.json({ viewer: { kind: 'signed-out' }, review: { kind: 'unavailable' } });
        if (
          initial.kind === 'ready' &&
          (initial.clientId !== OPERATOR_MANAGEMENT_PROFILE.client_id ||
            initial.scopes?.length !== 1 ||
            initial.scopes[0] !== OPERATOR_MANAGEMENT_PROFILE.scope[0])
        )
          return Response.json({
            viewer: { kind: 'authentication-required', continuation: 'operator-transfer' },
            review: { kind: 'unavailable' },
          });
        return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
      }
      if (body.kind === 'source' && attempt?.side === 'source') {
        expect(body.subjectAccountId).toBe(attempt.request.previous.subjectAccountId);
        return Response.json({
          viewer: { kind: 'ready' },
          review: {
            kind: 'source',
            relation: {
              previous: attempt.request.previous,
              expectedVersion: attempt.request.expectedVersion,
            },
            action: 'allowed',
          },
        });
      }
      if (body.kind === 'destination' && attempt?.side === 'destination') {
        expect(body.request).toEqual(attempt.request);
        return Response.json({
          viewer: { kind: 'ready' },
          review: {
            kind: 'destination',
            destinationAccountId: body.request.operatorAccountId,
            action:
              initial.kind === 'ready' && initial.accountId === body.request.operatorAccountId ? 'allowed' : 'denied',
          },
        });
      }
    }
    throw new Error(`Unexpected presentation request: ${input}`);
  }) as typeof fetch;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  render = (initial) => act(async () => root.render(<OperatorTransferPage initial={initial} />));
  close = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await flush(() => root.render(<OperatorTransferPage initial={initial} />));
  return host;
}
function guide(host: HTMLElement) {
  const summary = [...host.querySelectorAll('summary')].find(
    (element) => element.textContent === m.auth_transfer_guide_heading(),
  );
  expect(summary).toBeDefined();
  return summary!.parentElement as HTMLDetailsElement;
}
function before(first: Element, second: Element) {
  expect(Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
}
function visible(element: Element) {
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) return false;
  }
  return true;
}
function text(host: Element, value: string) {
  const element = [...host.querySelectorAll('p, dd')].find((entry) => entry.textContent === value);
  expect(element, value).toBeDefined();
  expect(visible(element!)).toBe(true);
  return element!;
}
function button(host: HTMLElement, label: string) {
  const element = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  expect(element, label).toBeDefined();
  return element!;
}
function semantics(host: HTMLElement) {
  const ids = [...host.querySelectorAll('[id]')].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const element of host.querySelectorAll('[aria-describedby], [aria-labelledby], [aria-controls]')) {
    for (const attribute of ['aria-describedby', 'aria-labelledby', 'aria-controls'])
      for (const id of element.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [])
        expect(host.querySelectorAll(`[id="${id}"]`).length).toBe(1);
  }
  for (const input of host.querySelectorAll('input, textarea')) {
    const label = host.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent?.trim()).toBeTruthy();
  }
  for (const control of host.querySelectorAll('button, summary, a')) {
    expect(control.getAttribute('aria-label') || control.textContent?.trim()).toBeTruthy();
    expect(control.querySelector('button, summary, input, textarea, a')).toBeNull();
  }
}
async function disclosure(host: HTMLElement) {
  const details = guide(host);
  expect(details.open).toBe(false);
  const summary = details.querySelector('summary')!;
  expect(summary.textContent).toBe(m.auth_transfer_guide_heading());
  const controls = [...host.querySelectorAll('input, textarea, button, a, summary')];
  const saved = window.sessionStorage.getItem('rezics.operator-transfer.attempt');
  const requests = [...calls];
  for (let repeat = 0; repeat < 3; repeat++) {
    await flush(() => summary.click());
    expect(details.open).toBe(true);
    expect(details.querySelector('ol')?.children.length).toBe(4);
    for (const label of [
      m.auth_transfer_handoff_explanation(),
      m.auth_transfer_handoff_step_request(),
      m.auth_transfer_handoff_step_accept(),
      m.auth_transfer_handoff_step_submit(),
      m.auth_transfer_handoff_step_readback(),
    ]) {
      expect(details.textContent).toContain(label);
    }
    await flush(() => summary.click());
    expect(details.open).toBe(false);
    expect([...host.querySelectorAll('input, textarea, button, a, summary')]).toEqual(controls);
    expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')).toBe(saved);
    expect(calls).toEqual(requests);
  }
  semantics(host);
}
function fileHelp(host: HTMLElement, kind: 'request' | 'acceptance') {
  const file = host.querySelector(`#transfer-${kind}-file`)!;
  expect(visible(file)).toBe(true);
  expect(file.getAttribute('aria-describedby')).toBe('transfer-file-help transfer-file-feedback');
  const help = host.querySelector('#transfer-file-help')!;
  expect(visible(help)).toBe(true);
  expect(help.parentElement).toBe(file.parentElement);
  expect(help.textContent).toContain(m.auth_transfer_handoff_file_help());
  expect(help.textContent).toContain(m.auth_transfer_guide_file_formats());
}
function identities(host: HTMLElement, attempt = source) {
  for (const [label, identity] of [
    [m.auth_transfer_handoff_subject(), attempt.request.previous.subjectAccountId],
    [m.auth_transfer_source(), attempt.request.previous.operatorAccountId],
    [m.auth_transfer_handoff_destination(), attempt.request.operatorAccountId],
  ]) {
    const value = [...host.querySelectorAll('dd')].find(
      (entry) => entry.previousElementSibling?.textContent === label && entry.textContent === identity,
    );
    expect(value, label).toBeDefined();
    expect(visible(value!)).toBe(true);
  }
  text(host, m.auth_transfer_handoff_consequences());
  text(host, m.auth_transfer_acting_as({ account: attempt.accountId }));
}

function privateTransferHidden(host: HTMLElement, attempt = source) {
  for (const value of [
    ...Object.values(attempt.request.previous),
    attempt.request.operatorAccountId,
    attempt.request.sourceOperationKey,
    attempt.acceptance,
    attempt.reference,
  ]) {
    if (value && value !== attempt.accountId) expect(host.textContent).not.toContain(value);
  }
  expect(
    host.querySelector('#transfer-request, #transfer-acceptance, #transfer-accepted, #transfer-confirm'),
  ).toBeNull();
}

async function reviewRecovery(host: HTMLElement, warning: string) {
  const review = button(host, m.auth_transfer_recovery_review());
  const recovery = host.querySelector('section[aria-labelledby="transfer-recovery-heading"]')!;
  expect(recovery.contains(review)).toBe(true);
  const notice = text(recovery, warning);
  before(notice, review);
  before(review, guide(host));
  const count = calls.length;
  await flush(() => review.click());
  expect(calls.slice(count)).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
}

test('independent preparation and receiving-file forms precede the optional complete walkthrough', async () => {
  const host = await mount();
  expect(host.querySelectorAll('form').length).toBe(2);
  for (const form of host.querySelectorAll('form')) {
    expect(visible(form)).toBe(true);
    before(form, guide(host));
  }
  expect(host.querySelector('#transfer-subject')?.closest('form')).not.toBe(
    host.querySelector('#transfer-request-file')?.closest('form'),
  );
  expect(host.querySelectorAll('#transfer-request-file').length).toBe(1);
  expect(host.querySelector('#transfer-request-input')?.closest('details')?.open).toBe(false);
  expect(button(host, m.auth_transfer_review()).disabled).toBe(true);
  fileHelp(host, 'request');
  await disclosure(host);
});

test('source request download and acceptance import keep identity, consequences and explicit consent visible', async () => {
  const host = await mount(session, source);
  identities(host);
  const download = button(host, m.auth_transfer_handoff_download_request());
  expect(text(host, m.auth_transfer_handoff_send_request()).nextElementSibling === download).toBe(true);
  before(download, guide(host));
  before(host.querySelector('#transfer-confirm')!, guide(host));
  expect(visible(host.querySelector('#transfer-confirm')!)).toBe(true);
  expect(host.querySelector('label[for="transfer-confirm"]')?.textContent).toContain(m.auth_transfer_confirm_source());
  expect(button(host, m.auth_transfer_submit()).disabled).toBe(true);
  fileHelp(host, 'acceptance');
  expect(host.querySelector('#transfer-acceptance')?.closest('details')?.open).toBe(false);
  await disclosure(host);
});

test('destination review keeps all three identities, responsibility and acceptance consent beside the action', async () => {
  const host = await mount(destinationSession, destination);
  identities(host, destination);
  before(text(host, m.auth_transfer_imported_request_provenance()), button(host, m.auth_transfer_accept()));
  expect(host.querySelector('label[for="transfer-confirm"]')?.textContent).toContain(
    m.auth_transfer_confirm_destination(),
  );
  expect(button(host, m.auth_transfer_accept()).disabled).toBe(true);
  before(button(host, m.auth_transfer_accept()), guide(host));
  expect(host.querySelector('input[type="file"]')).toBeNull();
  await disclosure(host);
});

test('accepted destination shows the incomplete-transfer warning and a single response download', async () => {
  const attempt = {
    ...destination,
    phase: 'accepted',
    reference: 'opaque-destination-acceptance',
  } as const;
  const host = await mount(destinationSession, attempt);
  privateTransferHidden(host, attempt);
  expect(calls).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
  await reviewRecovery(host, m.auth_transfer_recovery_destination());
  identities(host, attempt);
  expect(host.querySelector('#transfer-confirm')).toBeNull();
  const download = button(host, m.auth_transfer_handoff_download_acceptance());
  expect(text(host, m.auth_transfer_accepted()).nextElementSibling === download).toBe(true);
  before(download, guide(host));
  expect(host.querySelectorAll('#transfer-accepted').length).toBe(1);
  await disclosure(host);
});

test('uncertain restored execution retains warning, immutable file and fresh confirmation outside the guide', async () => {
  const attempt = {
    ...source,
    phase: 'execute',
    acceptance: 'opaque-acceptance',
    reference: 'original-approval',
  } as const;
  const host = await mount(session, attempt);
  privateTransferHidden(host, attempt);
  expect(calls).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
  await reviewRecovery(host, m.auth_transfer_recovery_source_unknown());
  identities(host, attempt);
  text(host, m.auth_transfer_reconfirm());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.auth_transfer_uncertain());
  expect(visible(host.querySelector('[role="alert"]')!)).toBe(true);
  expect(document.activeElement?.getAttribute('aria-live')).toBe('polite');
  text(host, m.auth_transfer_handoff_preserved());
  expect((host.querySelector('#transfer-acceptance-file') as HTMLInputElement).disabled).toBe(true);
  expect((host.querySelector('#transfer-confirm') as HTMLInputElement).checked).toBe(false);
  const retry = button(host, m.auth_transfer_recovery_retry_exact());
  expect(retry.disabled).toBe(true);
  before(text(host, m.auth_transfer_recovery_source_unknown()), retry);
  before(retry, guide(host));
  fileHelp(host, 'acceptance');
  await disclosure(host);
});

test('same-account step-up remains actionable before general help without enabling transfer', async () => {
  const host = await mount({ ...session, clientId: 'login', scopes: [] }, source);
  const form = host.querySelector('#transfer-email')!.closest('form')!;
  expect(form.textContent).toContain(m.auth_transfer_step_up());
  before(form, guide(host));
  privateTransferHidden(host);
  expect(host.textContent).not.toContain(source.accountId);
  expect(host.querySelector('#transfer-acceptance-file')).toBeNull();
  expect(calls).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
  await disclosure(host);
});

test('account mismatch remains a visible focused failure and disables retained actions', async () => {
  const host = await mount({ ...session, accountId: 'different-human' }, source);
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain(m.auth_transfer_account_changed());
  expect(visible(alert)).toBe(true);
  before(alert, guide(host));
  expect(host.querySelector('form')).toBeNull();
  privateTransferHidden(host);
  expect(host.textContent).not.toContain(source.accountId);
  expect(calls).toEqual([]);
  expect(document.activeElement?.getAttribute('aria-live')).toBe('polite');
  await disclosure(host);
});

for (const initial of [{ kind: 'signed-out' }, { kind: 'failure', message: 'Presentation-only failure' }] as const) {
  test(`${initial.kind} keeps recovery before optional instructions`, async () => {
    const host = await mount(initial);
    expect(host.querySelector('form')).toBeNull();
    const recovery =
      initial.kind === 'signed-out' ? host.querySelector('a[href="/login"]')! : host.querySelector('[role="alert"]')!;
    expect(visible(recovery)).toBe(true);
    before(recovery, guide(host));
    await disclosure(host);
  });
}

test('loading precedes the guide while session acquisition is pending', async () => {
  // Mount starts with a null session even with a supplied initial value; capture that commit
  // through a pending real session read instead of changing production state/effects.
  calls = [];
  window.sessionStorage.clear();
  const pendingHost = document.createElement('div');
  document.body.append(pendingHost);
  const root = createRoot(pendingHost);
  let resolve!: (response: Response) => void;
  globalThis.fetch = ((input) =>
    new Promise<Response>((done) => {
      const path = requestPath(input);
      calls.push(path);
      if (path === OPERATOR_TRANSFER_PAGE_PATH) {
        done(Response.json({ viewer: { kind: 'signed-out' }, review: { kind: 'unavailable' } }));
        return;
      }
      expect(path).toBe('/session');
      resolve = done;
    })) as typeof fetch;
  close = async () => {
    await act(async () => root.unmount());
    pendingHost.remove();
  };
  await act(async () => root.render(<OperatorTransferPage />));
  const status = text(pendingHost, m.auth_inventory_loading());
  expect(status.getAttribute('role')).toBe('status');
  expect(calls).toEqual(['/session']);
  before(status, guide(pendingHost));
  await disclosure(pendingHost);
  await flush(() => resolve(new Response(null, { status: 401 })));
  expect(pendingHost.querySelector('a[href="/login"]')).not.toBeNull();
});

for (const locale of locales) {
  test(`${locale} exact identities and translated disclosure labels preserve constant controls and zero protocol work`, async () => {
    overwriteGetLocale(() => locale);
    // Native relation IDs are UUIDs. Exercise wrapping with the opaque session
    // actor ID at the retained attempt's 128-character limit.
    const accountId = 'actor-' + 'a'.repeat(122);
    const attempt = { ...source, accountId };
    const host = await mount({ ...session, accountId }, attempt);
    identities(host, attempt);
    expect(host.querySelector('.wrap-anywhere')).not.toBeNull();
    await disclosure(host);
    expect(calls.some((path) => path.endsWith('/approve') || path.endsWith('/execute'))).toBe(false);
  });
}

test('source readback keeps current identity and the responsibility limit visible without inventing completion', async () => {
  const host = await mount(session, {
    ...source,
    phase: 'readback',
    acceptance: 'opaque-acceptance',
    reference: 'original-approval',
  });
  expect(calls).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH]);
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const path = requestPath(input);
    calls.push(path);
    if (path === '/session') return Response.json(sessionBody);
    if (path === OPERATOR_TRANSFER_PAGE_PATH) {
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: 'source',
        subjectAccountId: source.request.previous.subjectAccountId,
      });
      return Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          action: 'allowed',
          relation: {
            previous: {
              ...source.request.previous,
              operatorAccountId: source.request.operatorAccountId,
              reservationId: '00000000-0000-7000-8000-000000000006',
            },
            expectedVersion: '13',
          },
        },
      });
    }
    throw new Error(`Unexpected readback request: ${input}`);
  }) as typeof fetch;
  privateTransferHidden(host);
  await reviewRecovery(host, m.auth_transfer_recovery_acknowledged());
  text(host, m.auth_transfer_observed());
  const current = [...host.querySelectorAll('[role="status"]')].find(
    (status) => status.querySelector('h2')?.textContent === m.auth_transfer_current(),
  )!;
  expect(visible(current)).toBe(true);
  expect(current.querySelector('dd')?.textContent).toBe(source.request.operatorAccountId);
  expect(host.querySelector('#transfer-confirm')).toBeNull();
  expect(calls.some((path) => path.endsWith('/approve') || path.endsWith('/execute'))).toBe(false);
  await disclosure(host);
});

test('current refusal is focused and visible while response diagnostics remain an independent disclosure', async () => {
  const attempt = { ...source, acceptance: 'opaque-acceptance' };
  const host = await mount(session, attempt);
  calls = [];
  const read = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const path = requestPath(input);
    if (path === '/account-operations/approve') {
      calls.push(path);
      return Response.json(
        {
          error: 'account_operation_denied',
          effect_status: 'not_applied',
        },
        { status: 403 },
      );
    }
    return read(input, init);
  }) as typeof fetch;
  const submit = button(host, m.auth_transfer_submit());
  expect(submit.disabled).toBe(true);
  await flush(() => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  expect(submit.disabled).toBe(false);
  expect(calls).toEqual([]);
  await flush(() => submit.click());
  expect(calls).toEqual(['/session', '/session', OPERATOR_TRANSFER_PAGE_PATH, '/account-operations/approve']);
  const alert = host.querySelector('[role="alert"]')!;
  expect(visible(alert)).toBe(true);
  expect(alert.textContent).toContain(m.auth_transfer_denied());
  expect(document.activeElement?.getAttribute('aria-live')).toBe('polite');
  const diagnostics = alert.querySelector('details')!;
  expect(diagnostics.open).toBe(false);
  expect(diagnostics.querySelector('summary')?.textContent).toBe(m.auth_transfer_handoff_diagnostics());
  expect(guide(host).contains(diagnostics)).toBe(false);
  privateTransferHidden(host, attempt);
  await disclosure(host);
});

const unavailable = { kind: 'failure', message: 'Temporary read failure' } as const;
const sessionBody = {
  account_id: source.accountId,
  client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scope: OPERATOR_MANAGEMENT_PROFILE.scope,
};
for (const attempt of [
  undefined,
  source,
  destination,
  { ...destination, phase: 'accepted', reference: 'opaque-destination-acceptance' },
  { ...source, phase: 'execute', reference: 'original-approval', acceptance: 'opaque-acceptance' },
  { ...source, phase: 'readback', reference: 'original-approval', acceptance: 'opaque-acceptance' },
] satisfies (TransferAttempt | undefined)[]) {
  test(`failed session read recovers ${attempt?.side ?? 'new'} ${attempt?.phase ?? 'handoff'} without writing`, async () => {
    const host = await mount(unavailable, attempt);
    const saved = window.sessionStorage.getItem('rezics.operator-transfer.attempt');
    calls = [];
    globalThis.fetch = ((input, init) => {
      const path = requestPath(input);
      calls.push(path);
      if (path === '/session')
        return Promise.resolve(Response.json({ ...sessionBody, account_id: attempt?.accountId ?? session.accountId }));
      if (path === OPERATOR_TRANSFER_PAGE_PATH) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return Promise.resolve(
          Response.json(
            body.kind === 'readiness'
              ? { viewer: { kind: 'ready' }, review: { kind: 'readiness' } }
              : body.kind === 'source'
                ? {
                    viewer: { kind: 'ready' },
                    review: {
                      kind: 'source',
                      relation: {
                        previous: attempt?.request.previous,
                        expectedVersion: attempt?.request.expectedVersion,
                      },
                      action: 'allowed',
                    },
                  }
                : {
                    viewer: { kind: 'ready' },
                    review: {
                      kind: 'destination',
                      destinationAccountId: attempt?.request.operatorAccountId,
                      action: 'allowed',
                    },
                  },
          ),
        );
      }
      throw new Error(`Unexpected recovery write: ${path}`);
    }) as typeof fetch;
    if (attempt) privateTransferHidden(host, attempt);
    await flush(() => button(host, attempt ? m.auth_transfer_recovery_retry() : m.auth_account_delete_retry()).click());
    expect(calls).toEqual([
      '/session',
      '/session',
      OPERATOR_TRANSFER_PAGE_PATH,
      ...(attempt?.phase === 'approve' ? ['/session', OPERATOR_TRANSFER_PAGE_PATH] : []),
    ]);
    if (attempt && attempt.phase !== 'approve') {
      privateTransferHidden(host, attempt);
      await reviewRecovery(
        host,
        attempt.phase === 'accepted'
          ? m.auth_transfer_recovery_destination()
          : attempt.phase === 'execute'
            ? m.auth_transfer_recovery_source_unknown()
            : m.auth_transfer_recovery_acknowledged(),
      );
    }
    expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')).toBe(saved);
    expect(host.textContent).not.toContain(m.auth_transfer_account_changed());
    if (!attempt) expect(host.querySelector('#transfer-subject')).not.toBeNull();
    else {
      identities(host, attempt);
      expect(host.querySelector<HTMLTextAreaElement>('#transfer-request')!.value).toBe(JSON.stringify(attempt.request));
      const confirm = host.querySelector<HTMLInputElement>('#transfer-confirm');
      expect(confirm?.checked ?? false).toBe(false);
      if (attempt.phase === 'accepted') text(host, m.auth_transfer_accepted());
      if (attempt.phase === 'execute') expect(host.textContent).toContain(m.auth_transfer_uncertain());
      if (attempt.phase === 'readback') {
        text(host, m.auth_transfer_recovery_readback_changed());
        expect(host.textContent).not.toContain(m.auth_transfer_observed());
      }
    }
  });
}

for (const changed of [null, 'different-human']) {
  test(`read recovery rejects ${changed ?? 'signed-out'} ownership`, async () => {
    const host = await mount(unavailable, source);
    calls = [];
    globalThis.fetch = (async (input) => {
      const path = requestPath(input);
      calls.push(path);
      expect(path).toBe('/session');
      return changed ? Response.json({ ...sessionBody, account_id: changed }) : new Response(null, { status: 401 });
    }) as typeof fetch;
    await flush(() => button(host, m.auth_transfer_recovery_retry()).click());
    expect(host.querySelector('form, #transfer-request')).toBeNull();
    privateTransferHidden(host);
    expect(host.textContent).not.toContain(source.accountId);
    expect(host.textContent).toContain(m.auth_transfer_account_changed());
    expect(JSON.parse(window.sessionStorage.getItem('rezics.operator-transfer.attempt')!)).toEqual(source);
    expect(calls).toEqual(['/session']);
  });
}

test('a superseded view ignores a late recovered session', async () => {
  const host = await mount(unavailable, source);
  const sessions: ((response: Response) => void)[] = [];
  globalThis.fetch = ((input) => {
    if (requestPath(input) !== '/session') throw new Error(`Unexpected stale read: ${input}`);
    return new Promise<Response>((done) => sessions.push(done));
  }) as typeof fetch;
  await flush(() => button(host, m.auth_transfer_recovery_retry()).click());
  expect(sessions).toHaveLength(1);
  await render({ ...session, accountId: 'different-human' });
  await flush(() => sessions[0]!(Response.json(sessionBody)));
  expect(host.querySelector('form, #transfer-request')).toBeNull();
  privateTransferHidden(host);
  expect(host.textContent).not.toContain(source.accountId);
  expect(host.textContent).toContain(m.auth_transfer_account_changed());
});

test('relation read retry preserves uncertain execution and never resubmits it', async () => {
  const host = await mount(session, {
    ...source,
    phase: 'execute',
    reference: 'original-approval',
    acceptance: 'opaque-acceptance',
  });
  const saved = window.sessionStorage.getItem('rezics.operator-transfer.attempt');
  calls = [];
  let failed = true;
  globalThis.fetch = (async (input) => {
    const path = requestPath(input);
    calls.push(path);
    if (path === '/session') return Response.json(sessionBody);
    if (path === OPERATOR_TRANSFER_PAGE_PATH)
      return failed
        ? new Response(null, { status: 503 })
        : Response.json({
            viewer: { kind: 'ready' },
            review: {
              kind: 'source',
              relation: { previous: source.request.previous, expectedVersion: '12' },
              action: 'allowed',
            },
          });
    throw new Error(`Unexpected write: ${input}`);
  }) as typeof fetch;
  await reviewRecovery(host, m.auth_transfer_recovery_source_unknown());
  privateTransferHidden(host);
  failed = false;
  await flush(() => button(host, m.auth_transfer_recovery_retry()).click());
  expect([...host.querySelectorAll('h2')].some((heading) => heading.textContent === m.auth_transfer_current())).toBe(
    true,
  );
  expect(host.querySelector<HTMLInputElement>('#transfer-confirm')!.checked).toBe(false);
  text(host, m.auth_transfer_recovery_source_unknown());
  expect(host.textContent).not.toContain(m.auth_transfer_observed());
  expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')).toBe(saved);
  expect(calls).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH, '/session', OPERATOR_TRANSFER_PAGE_PATH]);
});
