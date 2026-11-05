import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PagePaths } from '../src/shell/head';
import type { ZoneSubjectRouteData } from '../src/zones/zone-shell';
import { locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { ZoneSubjectRoute } = await import('../src/zones/zone-shell');

const zoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

function data(outcome: ZoneSubjectRouteData['outcome']): ZoneSubjectRouteData {
  return {
    outcome,
    paths: Object.fromEntries(locales.map((locale) => [locale, `/subjects/${subjectId}`])) as PagePaths,
    view: 'overview',
  };
}

function render(outcome: ZoneSubjectRouteData['outcome']) {
  return renderToStaticMarkup(
    createElement(ZoneSubjectRoute, {
      data: data(outcome),
      id: zoneId,
      subjectId,
      locale: 'en',
      view: 'overview',
    }),
  );
}

test('a concealed Zone refusal does not become a Global Subject page', () => {
  const html = render({ kind: 'missing' });
  expect(html).toContain('data-route-state="missing"');
  expect(html).not.toContain('data-zone-shell');
  expect(html).not.toContain(subjectId);
});

test('temporary Zone unavailability has a distinct status and accessible retry action', () => {
  const html = render({ kind: 'unavailable', retryAfter: '1' });
  expect(html).toContain(m.zone_unavailable_heading());
  expect(html).toContain(m.zone_unavailable_message());
  expect(html).toContain(`<button`);
  expect(html).toContain(m.status_retry());
});
