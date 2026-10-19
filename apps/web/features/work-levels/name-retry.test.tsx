import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { ReleaseView } from './release-page.tsx';
import type { NameSummary } from './types.ts';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };

test('Release retains one section retry for failed coverage and nested credits', () => {
  if (!fixture.releases.ok || !fixture.realizations.ok) throw new Error('Expected successful release fixtures');
  const release = fixture.releases.data.items[0]!;
  const realization = fixture.realizations.data.items[1]!;
  const names = new Map<string, NameSummary>(fixture.names);
  for (const reference of [release.coverage[0]!.mainVersion, ...realization.translators, ...realization.publishers]) {
    names.set(reference, { reference, status: 'unavailable-read' });
  }
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    <ReleaseView release={release} realizations={new Map([[realization.id, { ok: true, data: realization }]])}
      sources={[]} names={names} locale="en" t={copyOf('en')} />));
  expect(html.match(/>Retry<\/button>/g)).toHaveLength(1);
  expect(html.match(/data-name-state="unavailable"/g)).toHaveLength(3);
  expect(html).toContain(release.revision);
  expect(html).toContain(realization.revision);
  expect(html).toContain(realization.evidence!);
  expect(html).toContain(copyOf('en').translators);
  expect(html).toContain(copyOf('en').publishers);
});
