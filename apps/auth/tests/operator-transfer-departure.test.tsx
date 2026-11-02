import { expect, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { creationFixture, approval, button, dom, fill, flush, open } from './creation-page-fixture';
import { OperatorTransferPage } from '../src/routes/operators.transfer';
import { OPERATOR_MANAGEMENT_PROFILE, restoreTransferAttempt, storeTransferAttempt, type TransferAttempt } from '../src/operator-transfer';
creationFixture();
const initial = { kind: 'ready', accountId: 'human', clientId: OPERATOR_MANAGEMENT_PROFILE.client_id, scopes: ['account:manage'] } as const;
const session = { account_id: initial.accountId, client_id: initial.clientId, scope: [...initial.scopes] };
const source: TransferAttempt = { accountId: 'human', side: 'source', phase: 'approve', request: {
  version: 1, previous: { operatorAccountId: 'old', subjectAccountId: 'subject', reservationId: 'reservation' },
  expectedVersion: '12', operatorAccountId: 'new', sourceOperationKey: 'original-key',
} };
async function setup(saved?: TransferAttempt) {
  if (saved) storeTransferAttempt(structuredClone(saved));
  const root = createRootRoute();
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/operators/transfer'] }), routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/operators/transfer' }),
    createRoute({ getParentRoute: () => root, path: '/security' }),
  ]) });
  const view = () => <RouterContextProvider router={router}><OperatorTransferPage initial={{ ...initial, scopes: [...initial.scopes] }} /></RouterContextProvider>;
  const page = await open(view(), session);
  const choose = (label: string) => flush(() => button(page.host, label)!.click());
  const navigate = () => flush(() => { void router.navigate({ to: '/security' }); });
  const input = (id: string) => page.host.querySelector<HTMLInputElement>(`#transfer-${id}`)!;
  const edit = (id: string, value: string) => flush(() => {
    const field = input(id);
    if (field instanceof dom.HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
    } else fill(field, value);
  });
  const submit = (id: string) => flush(() => input(id).closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event));
  const importText = (kind: string, text: string) => flush(() => {
    const field = input(`${kind}-file`);
    const bytes = new TextEncoder().encode(text);
    Object.defineProperty(field, 'files', { configurable: true, value: [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
    field.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
  });
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  return { ...page, router, view, choose, navigate, input, edit, submit, importText, unload };
}
test('changed draft and validation survive Stay with usable focus; deliberate Leave discards unsent input', async () => {
  const page = await setup();
  page.input('subject').focus();
  expect(page.unload()).toBe(false);
  await page.edit('subject', 'subject');
  await page.edit('destination', 'new');
  await page.edit('request-input', '  invalid request\n');
  await page.submit('request-input');
  const error = page.host.querySelector('[role="alert"]')!.textContent;
  page.input('request-input').focus();
  await page.navigate();
  await page.choose('Stay');
  expect(page.input('request-input').value).toBe('  invalid request\n');
  expect(page.input('subject').value).toBe('subject');
  expect(page.input('destination').value).toBe('new');
  expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(error);
  expect(document.activeElement).toBe(page.input('request-input'));
  await page.edit('destination', 'replacement');
  expect(page.input('destination').value).toBe('replacement');
  await page.navigate();
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/security');
  expect(page.unload()).toBe(false);
  expect(page.input('request-input').value).toBe('');
});
test('imported request and exact reviewed transfer survive Stay; Leave discards only the unsent review', async () => {
  const page = await setup();
  const text = `\n${JSON.stringify(source.request, null, 2)}\n`;
  await page.importText('request', text);
  await page.navigate();
  await page.choose('Stay');
  expect(page.input('request-input').value).toBe(text);
  await page.submit('request-input');
  await flush(() => page.calls[0]!.resolve(Response.json({ previous: source.request.previous, expectedVersion: '12' })));
  const attempt = restoreTransferAttempt();
  await flush(() => page.input('confirm').click());
  await page.navigate();
  await page.choose('Stay');
  expect(restoreTransferAttempt()).toEqual(attempt);
  expect(page.input('confirm').checked).toBe(true);
  await page.navigate();
  await page.choose('Leave');
  expect(restoreTransferAttempt()).toBeNull();
});
test('acceptance and unresolved command survive Stay; Leave retires late approval without erasing recovery', async () => {
  const page = await setup(source);
  await page.importText('acceptance', 'opaque-acceptance');
  await page.navigate();
  await page.choose('Stay');
  expect(page.input('acceptance').value).toBe('opaque-acceptance');
  await flush(() => page.input('confirm').click());
  await page.submit('confirm');
  await flush(() => page.calls[0]!.resolve(Response.json({ previous: source.request.previous, expectedVersion: '12' })));
  const original = restoreTransferAttempt();
  await page.navigate();
  await page.choose('Stay');
  expect(restoreTransferAttempt()).toEqual(original);
  await page.navigate();
  await page.choose('Leave');
  await page.render(page.view());
  await flush(() => page.calls[1]!.resolve(approval()));
  expect(restoreTransferAttempt()).toEqual(original);
  expect(page.calls).toHaveLength(2);
  expect(page.input('confirm').checked).toBe(false);
});
test('reconciled results leave normally and permission loss revokes a draft without prompting', async () => {
  const page = await setup({ ...source, phase: 'readback', reference: 'approval', acceptance: 'acceptance' });
  await flush(() => page.input('confirm').click());
  await page.submit('confirm');
  await flush(() => page.calls[0]!.resolve(Response.json({ previous: { ...source.request.previous, operatorAccountId: 'new', reservationId: 'next' }, expectedVersion: '13' })));
  expect(page.unload()).toBe(false);
  await page.navigate();
  expect(page.router.history.location.pathname).toBe('/security');
  window.sessionStorage.clear();
  await page.render(page.view());
  await page.edit('subject', 'subject');
  globalThis.fetch = (() => Promise.resolve(Response.json({ ...session, scope: [] }))) as typeof fetch;
  await page.navigate();
  expect(page.host.querySelector('dialog')).toBeNull();
  expect(page.unload()).toBe(false);
});
