import { expect, test } from 'bun:test';
import {
  creationFixture,
  approval,
  button,
  dom,
  fill,
  flush,
  leave,
  open,
  send,
  session,
} from './creation-page-fixture';
import { NewOrganizationPage } from '../src/routes/organizations.new';
import {
  readPendingAccountOperationStepUp,
  storePendingAccountOperationStepUp,
} from '../src/account-operation-step-up';
import { readPendingOrganizationHandle, storePendingOrganizationHandle } from '../src/account-operations';
creationFixture();
const initial = session('organization');
const body = { account_id: initial.accountId, client_id: initial.clientId, scope: initial.scopes };
const createdId = '20000000-0000-7000-8000-000000000002';
const acknowledged = 'received the native acknowledgement';
const unknown = 'creation result is still unknown';

async function begin() {
  const page = await open(<NewOrganizationPage initial={initial} />, body);
  const fetch = globalThis.fetch;
  const reads: ((response: Response) => void)[] = [];
  let count = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/session' && ++count > 1) {
      const held = Promise.withResolvers<Response>();
      reads.push(held.resolve);
      return held.promise;
    }
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const input = page.host.querySelector<HTMLInputElement>('input')!;
  await flush(() => fill(input, 'private-team'));
  await flush(() => send(page.host));
  await flush(() => page.calls[0]!.resolve(approval()));
  return { ...page, reads, input, original: readPendingAccountOperationStepUp()! };
}
const acknowledge = (page: Awaited<ReturnType<typeof begin>>) =>
  flush(() => page.calls[1]!.resolve(Response.json({ accountId: createdId })));
function privateGone(host: HTMLElement) {
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('a[href^="/organizations/members?"]')).toBeNull();
  expect(host.outerHTML).not.toContain('private-team');
  expect(host.outerHTML).not.toContain(createdId);
  expect(button(host, 'Create organization')).toBeUndefined();
  expect(button(host, 'Retry this creation')).toBeUndefined();
}
const restore = () => {
  const event = new dom.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  window.dispatchEvent(event as unknown as Event);
};

test('acknowledgement precedes final advice; read recovery, dismissal and cached return never reopen creation', async () => {
  const page = await begin();
  await acknowledge(page);
  expect(page.reads).toHaveLength(1);
  expect(page.host.textContent).toContain(acknowledged);
  expect(page.host.textContent).toContain('Checking current organization creation advice');
  expect(page.host.textContent).not.toContain(unknown);
  privateGone(page.host);
  expect(page.input.value).toBe('');
  expect(readPendingAccountOperationStepUp()).toBeNull();
  expect(readPendingOrganizationHandle()).toBe('');
  await flush(() => page.reads[0]!(Response.json({}, { status: 503 })));
  expect(page.host.textContent).toContain(acknowledged);
  expect(button(page.host, 'Check current advice')).toBeDefined();
  expect(document.activeElement).toBe(page.host.querySelector('[data-organization-create-return]'));
  await flush(() => button(page.host, 'Check current advice')!.click());
  privateGone(page.host);
  expect(page.reads).toHaveLength(2);
  await flush(() => page.reads[1]!(Response.json(body)));
  expect(page.host.textContent).toContain('Current session advice is available again');
  privateGone(page.host);
  await flush(() => button(page.host, 'Hide explanation')!.click());
  expect(page.host.textContent).not.toContain(acknowledged);
  await flush(() => {
    leave();
    restore();
    restore();
  });
  await flush(() => page.reads.slice(2).forEach((resolve) => resolve(Response.json(body))));
  privateGone(page.host);
  expect(page.host.textContent).not.toContain(unknown);
  expect(page.host.textContent).not.toContain(acknowledged);
  expect(page.calls).toHaveLength(2);
});

for (const [name, response] of [
  ['signed out', () => Response.json({}, { status: 401 })],
  ['another account', () => Response.json({ ...body, account_id: 'replacement' })],
  ['another client', () => Response.json({ ...body, client_id: 'replacement' })],
  ['another scope profile', () => Response.json({ ...body, scope: [] })],
] as const)
  test(`acknowledgement survives ${name} without private result disclosure`, async () => {
    const page = await begin();
    await acknowledge(page);
    await flush(() => page.reads[0]!(response()));
    expect(page.host.textContent).toContain(acknowledged);
    expect(page.host.textContent).not.toContain(unknown);
    privateGone(page.host);
    expect(page.host.querySelector(`a[href="${name === 'signed out' ? '/login' : '/security'}"]`)).not.toBeNull();
    expect(page.calls).toHaveLength(2);
  });

test('only the intact final proof publishes native success and its membership destination', async () => {
  const page = await begin();
  await acknowledge(page);
  privateGone(page.host);
  await flush(() => page.reads[0]!(Response.json(body)));
  expect(page.host.textContent).toContain('@private-team');
  expect(page.host.querySelector('a[href^="/organizations/members?"]')?.getAttribute('href')).toBe(
    `/organizations/members?organizationId=${createdId}`,
  );
  await flush(() => {
    leave();
    privateGone(page.host);
    restore();
  });
  await flush(() => page.reads[1]!(Response.json(body)));
  privateGone(page.host);
  expect(page.host.textContent).toContain(acknowledged);
  expect(page.calls).toHaveLength(2);
});

for (const adopted of [false, true])
  test(`pagehide ${adopted ? 'after' : 'before'} adoption retires callbacks and preserves replacement recovery`, async () => {
    const page = await begin();
    if (adopted) await acknowledge(page);
    await flush(() => {
      leave();
      privateGone(page.host);
    });
    storePendingOrganizationHandle('replacement-draft');
    storePendingAccountOperationStepUp({
      ...page.original,
      accountId: 'replacement-account',
      operation: { kind: 'organization', handle: 'replacement-team' },
    });
    if (adopted) await flush(() => page.reads[0]!(Response.json(body)));
    else await acknowledge(page);
    await flush(restore);
    await flush(() => page.reads.at(-1)!(Response.json(body)));
    expect(page.host.textContent).toContain(adopted ? acknowledged : unknown);
    expect(page.host.textContent).not.toContain(adopted ? unknown : acknowledged);
    privateGone(page.host);
    expect(readPendingOrganizationHandle()).toBe('replacement-draft');
    expect(readPendingAccountOperationStepUp()?.accountId).toBe('replacement-account');
    expect(page.calls).toHaveLength(2);
  });

test('replacement during final advice cannot consume another descriptor or draft', async () => {
  const page = await begin();
  await acknowledge(page);
  storePendingOrganizationHandle('replacement-draft');
  storePendingAccountOperationStepUp({ ...page.original, accountId: 'replacement-account' });
  const replacement = window.sessionStorage.getItem('rezics.account-operation.step-up');
  await flush(() => page.reads[0]!(Response.json(body)));
  privateGone(page.host);
  expect(page.host.textContent).toContain(acknowledged);
  expect(page.host.textContent).not.toContain(unknown);
  expect(readPendingOrganizationHandle()).toBe('replacement-draft');
  expect(window.sessionStorage.getItem('rezics.account-operation.step-up')).toBe(replacement);
  expect(page.calls).toHaveLength(2);
});
