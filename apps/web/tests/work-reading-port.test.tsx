import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('work reading throws until page composition binds the port', async () => {
  const { useWorkReading } = await import('../src/features/catalogue/work-reading-port');
  function Probe() {
    useWorkReading();
    return null;
  }
  expect(() => renderToStaticMarkup(createElement(Probe))).toThrow('Work reading port is not composed');
});

test('page composition binds the live CandidateValue surface', async () => {
  const { createPageWorkReadingPort } = await import('../src/features/pages/work-reading-binding');
  const { CandidateValue } = await import('../src/features/pages/data');
  const { PlainLink } = await import('../src/features/pages/shared');
  const snak = {
    property: { id: 'schema:gamePlatform', data_type: 'wikibase-item' },
    value: { type: 'somevalue' },
  };
  const related = {};
  const bound = createPageWorkReadingPort().renderValue({ snak, related, locale: 'en', link: PlainLink });
  const live = createElement(CandidateValue, { snak, related, locale: 'en', link: PlainLink });
  expect(renderToStaticMarkup(bound)).toBe(renderToStaticMarkup(live));
});
