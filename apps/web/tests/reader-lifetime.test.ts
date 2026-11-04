import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
import { addressLease, readLease, operationLease } from '../src/session';

test('read, address and operation admission remain independent and retired addresses never revive', () => {
  let addressCurrent = true;
  let allowed = true;
  let credential: string | null = null;
  const address = addressLease(() => addressCurrent);
  const read = readLease('A', address, () => allowed);
  const command = operationLease(
    read,
    'copy.update',
    () => allowed,
    () => credential,
  );
  expect(read.current()).toBe(true);
  expect(command.credential()).toBeNull();
  credential = 'replacement';
  expect(command.credential()).toBe('replacement');
  allowed = false;
  expect(command.current()).toBe(false);
  allowed = true;
  addressCurrent = false;
  expect(read.current()).toBe(false);
  addressCurrent = true;
  expect(read.current()).toBe(false);
  expect(command.credential()).toBeNull();
});

test('the mounted Subject reader shares one session listener and retires each successful incarnation', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/work' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.entries(globals).map(([key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return [key, descriptor] as const;
  });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { useSubjectPersonalReader } = await import('../src/features/pages/subject-personal-reader');
  const { useSession } = await import('../src/session/query');
  const { personalRead } = await import('../src/kernel/query');
  const previousEnabled = personalRead.enabled;
  Object.assign(personalRead, { enabled: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { state: 'signed-in', subject: 'reader-a', csrfToken: null } as const;
  client.setQueryData(['session'], session);
  let active = 0;
  let peak = 0;
  const cache = client.getQueryCache();
  const subscribe = cache.subscribe.bind(cache);
  cache.subscribe = (listener) => {
    peak = Math.max(peak, ++active);
    const stop = subscribe(listener);
    return () => {
      active--;
      stop();
    };
  };
  let lease: ReturnType<typeof useSubjectPersonalReader>['binding'];
  function Page() {
    lease = useSubjectPersonalReader({
      subjectId: 'work',
      locale: 'en',
      view: 'overview',
      session: useSession(),
      transport: {
        readReader: async () => ({ reader: 'reader-a', preferences: { spoilerLevel: 0, suitability: 'blur' } }),
        readOwnRating: async () => ({ reader: 'reader-a', kind: 'ready', units: null }),
      },
    }).binding;
    return null;
  }
  const host = window.document.createElement('main');
  const root = createRoot(host as unknown as HTMLElement);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Page)));
      await settle();
    });
    expect(lease?.isCurrent()).toBe(true);
    expect(peak).toBe(1);
    for (const replace of [
      () => client.setQueryData(['session'], { ...session }),
      () => {
        client.removeQueries({ queryKey: ['session'], exact: true });
        client.setQueryData(['session'], session);
      },
      () => {
        client.setQueryData(['session'], { ...session, subject: 'reader-b' });
        client.setQueryData(['session'], session);
      },
    ]) {
      const old = lease!;
      await act(async () => {
        replace();
        expect(old.isCurrent()).toBe(false);
        await settle();
      });
      expect(lease?.isCurrent()).toBe(true);
      expect(lease?.key).not.toBe(old.key);
      expect(old.beginRatingWrite(undefined, { reader: 'reader-a', kind: 'ready', units: 10 })).toBeNull();
    }
  } finally {
    const old = lease;
    await act(async () => root.unmount());
    if (old) expect(old.isCurrent()).toBe(false);
    expect(active).toBe(0);
    expect(peak).toBe(1);
    client.clear();
    Object.assign(personalRead, { enabled: previousEnabled });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
