import { afterAll, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { OpeningInput, OpeningRead } from '../src/operator-session-opening';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/automated/open' });
const globals = Object.assign(
  Object.fromEntries(
    'document navigator HTMLElement HTMLInputElement Element Node Event'
      .split(' ')
      .map((key) => [key, dom[key as keyof typeof dom]]),
  ),
  { window: dom, scrollTo: dom.scrollTo.bind(dom), IS_REACT_ACT_ENVIRONMENT: true, fetch: globalThis.fetch },
);
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { createBrowserHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { Route } = await import('../src/routes/automated.open');
const opening = await import('../src/operator-session-opening');
const pending = await import('../src/management-operation-step-up');
const managementOperations = await import('../src/management-operations');
const { managementOperationProfile } = managementOperations;
const { button, fill } = await import('../src/stories/accounts-operations/story');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
const human = '11111111-1111-4111-8111-111111111111';
const operator = '22222222-2222-4222-8222-222222222222';
const subject = '33333333-3333-4333-8333-333333333333';
const operation = { kind: 'opening', operatorAccountId: operator, subjectAccountId: subject };
const proof = (automated = false) => ({
  account_id: automated ? subject : human,
  client_id: managementOperationProfile('opening').client_id,
  scope: ['account:manage'],
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 0,
  amr: [automated ? 'operator' : 'pwd'],
});
const metadata = {
  kind: 'ready' as const,
  metadata: {
    viewer: { accountId: human, publicLabel: null },
    subject: { id: subject, kind: 'actor' as const, publicLabel: null },
    operator: { id: operator, kind: 'organization' as const, publicLabel: null },
    relation: { reservationId: '44444444-4444-4444-8444-444444444444', version: '7' },
  },
};
const currentHumanSession = {
  kind: 'ready' as const,
  accountId: human,
  clientId: managementOperationProfile('opening').client_id,
  scopes: managementOperationProfile('opening').scope,
  authTime: Math.floor(Date.now() / 1000),
  authnEpoch: 0,
  amr: ['pwd'] as ('pwd' | 'pop')[],
};
const flush = (action: () => unknown) =>
  act(async () => {
    await action();
  });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
async function open(
  initialSession: Awaited<ReturnType<typeof managementOperations.loadManagementSession>> = currentHumanSession,
) {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/automated/open');
  const requests: { path: string; body: OpeningInput; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((path, init) => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    requests.push({ path: String(path), body: JSON.parse(String(init?.body ?? '{}')), resolve });
    return promise;
  }) as typeof fetch;
  const read = spyOn(opening, 'loadOpeningMetadata').mockResolvedValue(metadata);
  const session = spyOn(managementOperations, 'loadManagementSession').mockResolvedValue(initialSession);
  const approve = spyOn(managementOperations, 'approveManagementOperation').mockImplementation(async (input) => ({
    kind: 'approved', input, reference: 'approval-reference', expiresAt: new Date(Date.now() + 60000).toISOString(),
  }));
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host);
  const parent = createRootRoute();
  const route = Route.update({ id: '/automated/open', path: '/automated/open', getParentRoute: () => parent } as never);
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: parent.addChildren([route]) });
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
  const respond = (index: number, response = Response.json(proof())) => flush(() => requests[index]!.resolve(response));
  const click = (label: string) => flush(() => button(host, label)!.click());
  const submit = () =>
    flush(() =>
      host
        .querySelector('form')!
        .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
    );
  return Object.assign(
    { host, requests, read, respond, click, submit },
    {
      async review() {
        await flush(() => {
          fill(host.querySelector('#opening-subject')!, subject);
          fill(host.querySelector('#opening-operator')!, operator);
        });
        await submit();
        await flush(() => Promise.resolve());
      },
      confirm: () => flush(() => host.querySelector<HTMLInputElement>('#opening-confirm')!.click()),
      boundary: (cached: boolean) =>
        flush(() => {
          if (!cached) return history.replace('/automated/open');
          window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
          window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event);
        }),
      async close() {
        await flush(() => root.unmount());
        history.destroy();
        host.remove();
        read.mockRestore();
        session.mockRestore();
        approve.mockRestore();
      },
    },
    { session, approve },
  );
}

test('failed initial and review reads recover the exact identity and key through confirmation and uncertain readback', async () => {
  const p = await open({ kind: 'unavailable' });
  try {
    expect(p.host.querySelector('a[href="https://rezics.com/en/accounts"]')).not.toBeNull();
    p.session.mockResolvedValue(currentHumanSession);
    await p.click('Retry account identity');
    await flush(() => Promise.resolve());
    p.read.mockResolvedValueOnce({ kind: 'unavailable' });
    await p.review();
    const selected = p.read.mock.calls[0]![0];
    await p.click('Retry account identity');
    await flush(() => Promise.resolve());
    expect(p.read.mock.calls[1]![0]).toEqual(selected);
    expect(selected).toMatchObject({ accountId: human, operation });
    expect(p.host.textContent).toContain(subject);
    expect(p.host.textContent).toContain(operator);
    expect(p.host.textContent).toContain(human);
    expect(p.host.textContent).toContain('Public identity label not disclosed');
    expect(p.host.textContent).toContain('Organization');
    expect(p.host.textContent).toContain('What this opening changes');
    expect(button(p.host, 'Approve and open session')!.disabled).toBe(true);
    await p.confirm();
    await p.submit();
    await flush(() => Promise.resolve());
    expect(p.requests[0]!.path).toBe('/operator-sessions/open');
    expect(p.requests[0]!.body).toMatchObject(selected);
    await p.respond(0, new Response(null, { status: 503 }));
    expect(pending.readPendingManagementOperationStepUp()).toMatchObject({ ...selected, phase: 'submitted' });
    await p.click('Check current session');
    await p.respond(1, Response.json(proof(true)));
    expect(p.host.querySelector('[role=status]')!.textContent).toContain(subject);
    expect(p.host.querySelector('a[href="https://rezics.com/en/"]')).not.toBeNull();
    expect(p.requests.filter((r) => r.path === '/operator-sessions/open')).toHaveLength(1);
  } finally {
    await p.close();
  }
});

test('a changed installed relation retires the confirmed review before approval', async () => {
  const p = await open();
  try {
    await p.review();
    await p.confirm();
    p.read.mockResolvedValueOnce({
      kind: 'ready',
      metadata: {
        ...metadata.metadata,
        relation: { reservationId: metadata.metadata.relation.reservationId, version: '8' },
      },
    });
    await p.submit();
    expect(p.host.querySelector('#opening-confirm')).toBeNull();
    expect(p.host.textContent).toContain('Opening refused');
    expect(
      p.requests.some((request) => request.path.includes('/approve') || request.path === '/operator-sessions/open'),
    ).toBe(false);
    expect(p.approve).not.toHaveBeenCalled();
  } finally {
    await p.close();
  }
});

for (const stage of ['review', 'approval', 'issuance', 'readback'] as const)
  test(`page replacement retires ${stage} without replaying or losing submitted identity`, async () => {
    const p = await open();
    try {
      const late = Promise.withResolvers<OpeningRead>();
      const lateApproval = Promise.withResolvers<Awaited<ReturnType<typeof managementOperations.approveManagementOperation>>>();
      if (stage === 'review') p.read.mockReturnValueOnce(late.promise);
      await p.review();
      if (stage !== 'review') {
        await p.confirm();
        if (stage === 'approval') p.approve.mockReturnValueOnce(lateApproval.promise);
        await p.submit();
        await flush(() => Promise.resolve());
      }
      if (stage === 'readback') {
        await p.respond(0, new Response(null, { status: 503 }));
        await p.click('Check current session');
      }
      const saved = pending.readPendingManagementOperationStepUp();
      const old = p.requests.length - 1;
      await p.boundary(stage !== 'approval');
      const count = p.requests.length;
      if (stage === 'review') await flush(() => late.resolve(metadata));
      else if (stage === 'approval') {
        lateApproval.resolve({
          kind: 'approved', input: p.approve.mock.calls.at(-1)![0], reference: 'approval-reference',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      }
      else
        await p.respond(
          old,
          Response.json(proof(stage === 'issuance' || stage === 'readback')),
        );
      expect(p.requests).toHaveLength(count);
      expect(p.host.querySelector('#opening-confirm')).toBeNull();
      expect(p.host.querySelector('[role=status]')).toBeNull();
      expect(pending.readPendingManagementOperationStepUp()).toEqual(saved);
      if (stage === 'issuance' || stage === 'readback')
        await p.respond(count - 1, Response.json(proof(stage === 'issuance' || stage === 'readback')));
      expect(p.host.querySelector('[role=status]') !== null).toBe(stage === 'issuance' || stage === 'readback');
    } finally {
      await p.close();
    }
  });
