import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarInset } from '@rezics/ui/shadcn/sidebar';
import { m } from '../src/paraglide/messages.js';
import { PendingPage } from '../src/shell/pending';

function loadingRegion(markup: string): string | undefined {
  return /<section\b[^>]*\brole="region"[^>]*>/.exec(markup)?.[0];
}

test('router pending content keeps the AppShell main and a named busy region, with an accessible standalone render', async () => {
  const router = await Bun.file(join(import.meta.dir, '../src/router.tsx')).text();
  const pending = await Bun.file(join(import.meta.dir, '../src/shell/pending.tsx')).text();
  expect(router).toContain('defaultPendingComponent: PendingPage');

  const shellMarkup = renderToStaticMarkup(createElement(SidebarInset, null, createElement(PendingPage)));
  expect(shellMarkup.match(/<main\b/g) ?? []).toHaveLength(1);
  const shellRegion = loadingRegion(shellMarkup);
  expect(shellRegion).toContain('aria-busy="true"');
  expect(shellRegion).toContain(`aria-label="${m.route_loading_page()}"`);

  const standaloneMarkup = renderToStaticMarkup(createElement(PendingPage));
  const standaloneRegion = loadingRegion(standaloneMarkup);
  expect(standaloneRegion).toContain('aria-busy="true"');
  expect(standaloneRegion).toContain(`aria-label="${m.route_loading_page()}"`);
  expect(pending).toContain('role="region"');
  expect(standaloneMarkup).toContain('motion-reduce:animate-none');
});
