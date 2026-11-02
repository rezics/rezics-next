import { afterAll, afterEach, beforeAll } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
const { Window } = require(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`))),
);
export const dom = new Window({ url: 'https://auth.test/organizations/new' });
const previous = new Map<string, PropertyDescriptor | undefined>();
const globals = Object.fromEntries(
  ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'HTMLInputElement', 'Element', 'Node'].map((key) => [
    key,
    (dom as unknown as Record<string, unknown>)[key],
  ]),
);
Object.assign(globals, { IS_REACT_ACT_ENVIRONMENT: true, fetch: globalThis.fetch });
for (const [key, value] of Object.entries(globals)) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// Load DOM-aware UI modules only after installing the browser fixture.
export const { fill, button, session } = await import('../src/stories/accounts-operations/story');
const { createRoot } = await import('react-dom/client');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
export const flush = (action: () => void) => act(async () => action());
let close: (() => Promise<void>) | undefined;
export function creationFixture() {
  beforeAll(() => {
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
    document.body.replaceChildren();
    window.sessionStorage.clear();
  });
  afterAll(async () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}
export async function open(page: ReactNode, sessionBody: object) {
  const calls: { path: string; body: any; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((path, init) => {
    if (String(path) === '/session') return Promise.resolve(Response.json(sessionBody));
    const request = Promise.withResolvers<Response>();
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)), resolve: request.resolve });
    return request.promise;
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = (next: ReactNode) => flush(() => root.render(next));
  close = () => flush(() => root.unmount());
  await render(page);
  return { host, calls, render };
}
export const send = (host: HTMLElement) => host.querySelector<HTMLFormElement>('form')!.requestSubmit();
export const leave = () => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
export const approval = () =>
  Response.json({ reference: 'native-approval', expiresAt: new Date(Date.now() + 60000).toISOString() });
