import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { OperatorSessionOpeningPage } from '../src/routes/automated.open';
import * as opening from '../src/operator-session-opening';
import { managementOperationProfile } from '../src/management-operations';

creationFixture();
const human = '11111111-1111-4111-8111-111111111111';
const operator = '22222222-2222-4222-8222-222222222222';
const subject = '33333333-3333-4333-8333-333333333333';
const metadata = {
  kind: 'ready' as const,
  metadata: {
    viewer: { accountId: human, publicLabel: null },
    subject: { id: subject, kind: 'actor' as const, publicLabel: null },
    operator: { id: operator, kind: 'organization' as const, publicLabel: null },
    relation: { reservationId: '44444444-4444-4444-8444-444444444444', version: '7' },
  },
};
let read: ReturnType<typeof spyOn<typeof opening, 'loadOpeningMetadata'>> | undefined;
let browser: ReturnType<typeof createBrowserHistory> | undefined;
afterEach(() => {
  read?.mockRestore();
  browser?.destroy();
});

async function setup() {
  const pending: { signal: AbortSignal; resolve: (value: opening.OpeningRead) => void }[] = [];
  read = spyOn(opening, 'loadOpeningMetadata').mockImplementation((_input, signal) => {
    const result = Promise.withResolvers<opening.OpeningRead>();
    pending.push({ signal: signal!, resolve: result.resolve });
    return result.promise;
  });
  const session = {
    account_id: human,
    client_id: managementOperationProfile('opening').client_id,
    scope: ['account:manage'],
    auth_time: Math.floor(Date.now() / 1000),
    authn_epoch: 0,
    amr: ['pwd'],
  };
  const root = createRootRoute();
  const routeTree = root.addChildren(
    ['/automated/open', '/security'].map((path) => createRoute({ getParentRoute: () => root, path })),
  );
  window.history.replaceState(null, '', '/automated/open');
  browser = createBrowserHistory({ window: dom });
  const router = createRouter({ routeTree, history: browser });
  const page = await open(
    <RouterContextProvider router={router}>
      <OperatorSessionOpeningPage />
    </RouterContextProvider>,
    session,
  );
  const review = async () => {
    await flush(() => {
      fill(page.host.querySelector<HTMLInputElement>('#opening-subject')!, subject);
      fill(page.host.querySelector<HTMLInputElement>('#opening-operator')!, operator);
    });
    await flush(() => send(page.host));
  };
  const click = (label: string) => flush(() => button(document.body, label)!.click());
  const navigate = (to: '/automated/open' | '/security') =>
    flush(() => {
      router.history.push(to);
    });
  return { ...page, pending, review, click, navigate };
}

function transition(name: 'pagehide' | 'pageshow') {
  const event = new dom.Event(name);
  if (name === 'pageshow') Object.assign(event, { persisted: true });
  window.dispatchEvent(event as unknown as Event);
}

test('cache return, departure and unmount retire read ownership before late metadata can advance review', async () => {
  const page = await setup();
  await page.review();
  expect(page.pending).toHaveLength(1);
  await page.navigate('/automated/open');
  expect(page.pending[0]!.signal.aborted).toBe(true);
  await flush(() => page.pending[0]!.resolve(metadata));
  expect(page.host.querySelector('#opening-confirmation')).toBeNull();

  await page.review();
  expect(page.pending).toHaveLength(2);
  transition('pagehide');
  expect(page.pending[1]!.signal.aborted).toBe(true);
  await flush(() => page.pending[1]!.resolve(metadata));
  expect(page.host.querySelector('#opening-confirmation')).toBeNull();

  transition('pageshow');
  await page.review();
  expect(page.pending).toHaveLength(3);
  await page.navigate('/security');
  await page.click('Leave');
  expect(page.pending[2]!.signal.aborted).toBe(true);
  await flush(() => page.pending[2]!.resolve(metadata));
  expect(page.calls).toHaveLength(0);
  expect(page.host.querySelector('#opening-confirmation')).toBeNull();

  await page.navigate('/automated/open');
  await page.review();
  expect(page.pending).toHaveLength(4);
  await page.render(null);
  expect(page.pending[3]!.signal.aborted).toBe(true);
  await flush(() => page.pending[3]!.resolve(metadata));
  expect(page.host.querySelector('#opening-confirmation')).toBeNull();
});
