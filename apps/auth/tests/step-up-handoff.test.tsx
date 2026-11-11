import { afterEach, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { join } from 'node:path';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { creationFixture, dom, flush } from './creation-page-fixture';

creationFixture();
const { createBrowserHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { hydrateRoot } = await import('react-dom/client');
const { Route: rootRoute } = await import('../src/routes/__root');
const { Route } = await import('../src/routes/step-up');

type DocumentElementState = { attributes: [string, string][]; html: string };
function documentElementState(element: Element): DocumentElementState {
  return {
    attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    html: element.innerHTML,
  };
}
// Replaces the shared happy-dom <html> element, so each test starts from the document it received.
function installDocumentElement(state: DocumentElementState) {
  const root = document.documentElement;
  for (const attribute of [...root.attributes]) root.removeAttribute(attribute.name);
  for (const [name, value] of state.attributes) root.setAttribute(name, value);
  root.innerHTML = state.html;
}
const original = documentElementState(document.documentElement);
afterEach(() => installDocumentElement(original));

// Only the step-up advice read matters here; other reads fail closed so their presentation stays out of the way.
function advice(gate: Promise<void>) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'https://auth.test').pathname;
    if (path !== '/recovery/page') return new Response('unavailable', { status: 503 });
    await gate;
    return Response.json(
      recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
    );
  }) as typeof fetch);
}

// Installs the server document as the browser receives it, then hydrates the whole document through the real root.
async function handoff() {
  window.history.replaceState(null, '', '/step-up?return_to=%2Fsecurity');
  const route = Route.update({ id: '/step-up', path: '/step-up', getParentRoute: () => rootRoute } as never);
  const history = createBrowserHistory({ window: dom as unknown as Window });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history });
  const errors: string[] = [];
  let root: { unmount(): void } | undefined;
  const close = async () => {
    try {
      await flush(() => root?.unmount());
    } finally {
      history.destroy();
    }
  };
  try {
    // Render in the server realm, independent of this file's browser globals and module doubles.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'server-render-fixture.tsx'), 'step-up'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const server = JSON.parse(stdout) as { window: string; html: string };
    expect(server.window).toBe('undefined');
    expect(server.html).not.toContain('<!--$!-->');
    await flush(() => router.load());
    const serverDocument = new dom.DOMParser().parseFromString(server.html, 'text/html').documentElement;
    installDocumentElement(documentElementState(serverDocument));
    await flush(() => {
      root = hydrateRoot(document, createElement(RouterProvider, { router }), {
        onRecoverableError: (error: unknown) => errors.push(String((error as Error)?.message ?? error)),
      });
    });
    return { errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('step-up confirmation stays unusable until the server advice is read after hydration', async () => {
  let release = () => {};
  const fetches = advice(new Promise<void>((resolve) => (release = resolve)));
  let mounted: Awaited<ReturnType<typeof handoff>> | undefined;
  try {
    mounted = await handoff();
    const submit = () => document.querySelector<HTMLButtonElement>('button[type=submit]');
    expect(submit()?.disabled).toBe(true);
    await flush(() => release());
    for (let attempt = 0; attempt < 20 && submit()?.disabled; attempt++)
      await flush(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    expect(submit()?.disabled).toBe(false);
    expect(mounted.errors).toEqual([]);
  } finally {
    try {
      await mounted?.close();
    } finally {
      fetches.mockRestore();
    }
  }
});
