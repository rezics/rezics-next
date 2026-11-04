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
  accountId: 'initiating-human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const source: TransferAttempt = {
  accountId: 'initiating-human',
  side: 'source',
  phase: 'approve',
  request: {
    version: 1,
    previous: {
      operatorAccountId: 'current-operator',
      subjectAccountId: 'managed-account',
      reservationId: 'original-reservation',
    },
    expectedVersion: '12',
    operatorAccountId: 'proposed-operator',
    sourceOperationKey: 'original-source-key',
  },
};
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
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  });
}
async function mount(initial: AccountSessionResult | undefined = session, attempt?: TransferAttempt) {
  calls = [];
  window.sessionStorage.clear();
  if (attempt) expect(storeTransferAttempt(structuredClone(attempt))).toBe(true);
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    calls.push(path);
    if (path === '/session')
      return Response.json(
        initial?.kind === 'ready'
          ? { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes }
          : sessionBody,
      );
    if (path === OPERATOR_TRANSFER_PAGE_PATH) {
      const body = JSON.parse(String(init?.body));
      if (body.kind === 'readiness')
        return Response.json({
          viewer:
            initial?.kind === 'ready' &&
            (initial.clientId !== OPERATOR_MANAGEMENT_PROFILE.client_id || !initial.scopes?.includes('account:manage'))
              ? { kind: 'authentication-required', continuation: 'operator-transfer' }
              : { kind: 'ready' },
          review: { kind: 'readiness' },
        });
      if (body.kind === 'source')
        return Response.json({
          viewer: { kind: 'ready' },
          review: {
            kind: 'source',
            relation: {
              previous: { ...source.request.previous, subjectAccountId: body.subjectAccountId },
              expectedVersion: source.request.expectedVersion,
            },
            action: 'allowed',
          },
        });
      if (body.kind === 'destination')
        return Response.json({
          viewer: { kind: 'ready' },
          review: { kind: 'destination', destinationAccountId: body.request.operatorAccountId, action: 'allowed' },
        });
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
  await act(async () => {
    root.render(<OperatorTransferPage initial={initial} />);
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  });
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
function text(host: HTMLElement, value: string) {
  const element = [...host.querySelectorAll('p, dd')].find((entry) => entry.textContent === value);
  expect(element).toBeDefined();
  expect(visible(element!)).toBe(true);
  return element!;
}
function button(host: HTMLElement, label: string) {
  const element = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  expect(element).toBeDefined();
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
  for (const identity of [
    attempt.request.previous.subjectAccountId,
    attempt.request.previous.operatorAccountId,
    attempt.request.operatorAccountId,
  ]) {
    text(host, identity);
  }
  text(host, m.auth_transfer_handoff_consequences());
  text(host, m.auth_transfer_acting_as({ account: attempt.accountId }));
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
  text(host, m.auth_transfer_handoff_send_request());
  before(button(host, m.auth_transfer_handoff_download_request()), guide(host));
  before(host.querySelector('#transfer-confirm')!, guide(host));
  expect(visible(host.querySelector('#transfer-confirm')!)).toBe(true);
  expect(host.querySelector('label[for="transfer-confirm"]')?.textContent).toContain(m.auth_transfer_confirm_source());
  expect(button(host, m.auth_transfer_submit()).disabled).toBe(true);
  fileHelp(host, 'acceptance');
  expect(host.querySelector('#transfer-acceptance')?.closest('details')?.open).toBe(false);
  await disclosure(host);
});

test('destination review keeps all three identities, responsibility and acceptance consent beside the action', async () => {
  const host = await mount(session, { ...source, side: 'destination' });
  identities(host);
  expect(host.querySelector('label[for="transfer-confirm"]')?.textContent).toContain(
    m.auth_transfer_confirm_destination(),
  );
  expect(button(host, m.auth_transfer_accept()).disabled).toBe(true);
  before(button(host, m.auth_transfer_accept()), guide(host));
  expect(host.querySelector('input[type="file"]')).toBeNull();
  await disclosure(host);
});

test('accepted destination shows the incomplete-transfer warning and a single response download', async () => {
  const host = await mount(session, {
    ...source,
    side: 'destination',
    phase: 'accepted',
    reference: 'opaque-destination-acceptance',
  });
  identities(host);
  text(host, m.auth_transfer_accepted());
  expect(host.querySelector('#transfer-confirm')).toBeNull();
  before(button(host, m.auth_transfer_handoff_download_acceptance()), guide(host));
  expect(host.querySelectorAll('#transfer-accepted').length).toBe(1);
  await disclosure(host);
});

test('uncertain restored execution retains warning, immutable file and fresh confirmation outside the guide', async () => {
  const host = await mount(session, {
    ...source,
    phase: 'execute',
    acceptance: 'opaque-acceptance',
    reference: 'original-approval',
  });
  identities(host);
  text(host, m.auth_transfer_reconfirm());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.auth_transfer_uncertain());
  expect(visible(host.querySelector('[role="alert"]')!)).toBe(true);
  expect(document.activeElement?.getAttribute('aria-live')).toBe('polite');
  text(host, m.auth_transfer_handoff_preserved());
  expect((host.querySelector('#transfer-acceptance-file') as HTMLInputElement).disabled).toBe(true);
  expect((host.querySelector('#transfer-confirm') as HTMLInputElement).checked).toBe(false);
  before(button(host, m.auth_transfer_submit()), guide(host));
  fileHelp(host, 'acceptance');
  await disclosure(host);
});

test('same-account step-up remains actionable before general help without enabling transfer', async () => {
  const host = await mount({ ...session, clientId: 'login', scopes: [] }, source);
  text(host, m.auth_transfer_step_up());
  identities(host);
  before(host.querySelector('#transfer-email')!.closest('form')!, guide(host));
  expect(button(host, m.auth_transfer_submit()).disabled).toBe(true);
  expect((host.querySelector('#transfer-confirm') as HTMLInputElement).disabled).toBe(true);
  expect((host.querySelector('#transfer-acceptance-file') as HTMLInputElement).disabled).toBe(true);
  await disclosure(host);
});

test('account mismatch remains a visible focused failure and disables retained actions', async () => {
  const host = await mount({ ...session, accountId: 'different-human' }, source);
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain(m.auth_transfer_account_changed());
  expect(visible(alert)).toBe(true);
  before(alert, guide(host));
  expect(host.querySelector('form')).toBeNull();
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
  globalThis.fetch = (() =>
    new Promise<Response>((done) => {
      resolve = done;
    })) as typeof fetch;
  close = async () => {
    await act(async () => root.unmount());
    pendingHost.remove();
  };
  await act(async () => root.render(<OperatorTransferPage />));
  const status = pendingHost.querySelector('[role="status"]')!;
  expect(status.textContent).toBe(m.auth_inventory_loading());
  before(status, guide(pendingHost));
  await disclosure(pendingHost);
  await flush(() => resolve(new Response(null, { status: 401 })));
  expect(pendingHost.querySelector('a[href="/login"]')).not.toBeNull();
});

for (const locale of locales) {
  test(`${locale} long identities and translated disclosure labels preserve constant controls and zero protocol work`, async () => {
    overwriteGetLocale(() => locale);
    const attempt = structuredClone(source);
    attempt.request.previous.subjectAccountId = 'subject-' + 'a'.repeat(120);
    attempt.request.previous.operatorAccountId = 'source-' + 'b'.repeat(120);
    attempt.request.operatorAccountId = 'destination-' + 'c'.repeat(116);
    const host = await mount(session, attempt);
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
  calls = [];
  globalThis.fetch = (async (input, init) => {
    calls.push(String(input));
    if (String(input) === '/session')
      return Response.json({
        account_id: source.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (String(input) === OPERATOR_TRANSFER_PAGE_PATH) {
      const body = JSON.parse(String(init?.body));
      if (body.kind === 'readiness') return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
      return Response.json({
        viewer: { kind: 'ready' },
        review: {
          kind: 'source',
          action: 'allowed',
          relation: {
            previous: {
              ...source.request.previous,
              operatorAccountId: source.request.operatorAccountId,
              reservationId: 'new-reservation',
            },
            expectedVersion: '13',
          },
        },
      });
    }
    throw new Error(`Unexpected readback request: ${input}`);
  }) as typeof fetch;
  await flush(() => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  const form = host.querySelector('#transfer-confirm')!.closest('form')!;
  await flush(() => {
    form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  });
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
  const host = await mount(session, { ...source, acceptance: 'opaque-acceptance' });
  calls = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (String(input) === '/session')
      return Response.json({
        account_id: source.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    return Response.json({ error: 'account_operation_denied' }, { status: 403 });
  }) as typeof fetch;
  await flush(() => host.querySelector<HTMLInputElement>('#transfer-confirm')!.click());
  const form = host.querySelector('#transfer-confirm')!.closest('form')!;
  await flush(() => {
    form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  });
  const alert = host.querySelector('[role="alert"]')!;
  expect(visible(alert)).toBe(true);
  expect(alert.textContent).toContain(m.auth_transfer_denied());
  expect(document.activeElement?.getAttribute('aria-live')).toBe('polite');
  const diagnostics = alert.querySelector('details')!;
  expect(diagnostics.open).toBe(false);
  expect(diagnostics.querySelector('summary')?.textContent).toBe(m.auth_transfer_handoff_diagnostics());
  expect(guide(host).contains(diagnostics)).toBe(false);
  expect(host.querySelector('#transfer-confirm')).toBeNull();
  await disclosure(host);
});

const unavailable = { kind: 'failure', message: 'Temporary read failure' } as const;
const sessionBody = {
  account_id: source.accountId,
  client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scope: ['account:manage'],
};
for (const attempt of [
  undefined,
  source,
  { ...source, side: 'destination' },
  { ...source, side: 'destination', phase: 'accepted', reference: 'acceptance' },
  { ...source, phase: 'execute', reference: 'approval', acceptance: 'acceptance' },
  { ...source, phase: 'readback', reference: 'approval', acceptance: 'acceptance' },
] satisfies (TransferAttempt | undefined)[]) {
  test(`failed session read recovers ${attempt?.side ?? 'new'} ${attempt?.phase ?? 'handoff'} without writing`, async () => {
    const host = await mount(unavailable, attempt);
    const saved = window.sessionStorage.getItem('rezics.operator-transfer.attempt');
    calls = [];
    globalThis.fetch = ((input, init) => {
      const path = String(input);
      calls.push(path);
      if (path === '/session') return Promise.resolve(Response.json(sessionBody));
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
    await flush(() => button(host, m.auth_account_delete_retry()).click());
    await flush(() => {});
    expect(calls).toEqual([
      '/session',
      '/session',
      OPERATOR_TRANSFER_PAGE_PATH,
      ...(attempt?.phase === 'approve' ? ['/session', OPERATOR_TRANSFER_PAGE_PATH] : []),
    ]);
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
    }
  });
}

for (const changed of [null, 'different-human']) {
  test(`read recovery rejects ${changed ?? 'signed-out'} ownership`, async () => {
    const host = await mount(unavailable, source);
    calls = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return changed ? Response.json({ ...sessionBody, account_id: changed }) : new Response(null, { status: 401 });
    }) as typeof fetch;
    await flush(() => button(host, m.auth_account_delete_retry()).click());
    expect(host.querySelector('form, #transfer-request')).toBeNull();
    expect(host.textContent).toContain(m.auth_transfer_account_changed());
    expect(JSON.parse(window.sessionStorage.getItem('rezics.operator-transfer.attempt')!)).toEqual(source);
    expect(calls).toEqual(['/session']);
  });
}

test('a superseded view ignores a late recovered session', async () => {
  const host = await mount(unavailable, source);
  const sessions: ((response: Response) => void)[] = [];
  globalThis.fetch = ((input) => {
    if (String(input) !== '/session') throw new Error(`Unexpected stale read: ${input}`);
    return new Promise<Response>((done) => sessions.push(done));
  }) as typeof fetch;
  await flush(() => button(host, m.auth_account_delete_retry()).click());
  expect(sessions).toHaveLength(1);
  await render({ ...session, accountId: 'different-human' });
  await flush(() => sessions[0]!(Response.json(sessionBody)));
  expect(host.querySelector('form, #transfer-request')).toBeNull();
  expect(host.textContent).toContain(m.auth_transfer_account_changed());
});

test('relation read retry preserves uncertain execution and never resubmits it', async () => {
  const host = await mount(session, { ...source, phase: 'execute', reference: 'approval', acceptance: 'acceptance' });
  const saved = window.sessionStorage.getItem('rezics.operator-transfer.attempt');
  calls = [];
  let failed = true;
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (String(input) === '/session') return Response.json(sessionBody);
    if (String(input) === OPERATOR_TRANSFER_PAGE_PATH)
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
  await flush(() => button(host, m.auth_transfer_readback()).click());
  failed = false;
  await flush(() => button(host, m.auth_account_delete_retry()).click());
  expect([...host.querySelectorAll('h2')].some((heading) => heading.textContent === m.auth_transfer_current())).toBe(
    true,
  );
  expect(host.querySelector<HTMLInputElement>('#transfer-confirm')!.checked).toBe(false);
  expect(window.sessionStorage.getItem('rezics.operator-transfer.attempt')).toBe(saved);
  expect(calls).toEqual(['/session', OPERATOR_TRANSFER_PAGE_PATH, '/session', OPERATOR_TRANSFER_PAGE_PATH]);
});
