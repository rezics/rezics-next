import type { CanonicalAddress } from '@rezics/model/address';
import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { RelationRows } from './connections.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import { NameLink, namedWorkHref, SummaryLink, summaryWorkHref } from './names.tsx';
import { PartsSection } from './parts.tsx';
import { relationRows } from './relation-rows.ts';
import { messages as pageMessages } from '../work-page/messages.ts';
import { resourceHref } from '../address/path.ts';
import type { AvailableSummary } from './types.ts';

const router: AppRouterInstance = {
  bfcacheId: '',
  refresh() {},
  push() {},
  replace() {},
  back() {},
  forward() {},
  prefetch() {},
};
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
const labels = { unavailable: 'Unavailable', unnamed: 'Unnamed' };
const summary = fixture.summary(fixture.iri('200'), 'Related Work');
if (summary.status !== 'available') throw new Error('The fixture must disclose its Work');
const available: AvailableSummary = summary;

describe('Work links use the canonical destination Main supplies', () => {
  // ast-grep-ignore: web-links-use-address-tsx -- CanonicalAddress prefixes are protocol fixture inputs, not authored link destinations.
  for (const prefix of ['/w/', '/z/anime/w/', '/z/manga/w/', '/z/vn/w/'] as const) {
    test(`a named Work preserves its ${prefix} address rather than deriving an identity link`, () => {
      const target = {
        ...available,
        address: { prefix, key: 'related-work', suffixSource: 'Related Work' },
      };
      const names = new Map([[target.reference, target]]);
      const href = `${prefix}related-work`;
      expect(summaryWorkHref(target)).toBe(href);
      expect(namedWorkHref(target.reference, names)).toBe(href);
      expect(render(<NameLink reference={target.reference} names={names} {...labels} />)).toContain(
        `href="/en${href}"`,
      );
    });
  }

  test('relation rows, parts and wholes keep canonical suffixes', () => {
    const relations = render(
      <RelationRows rows={relationRows(fixture.relationEntries)} locale="en" t={copyOf('en')} />,
    );
    for (const entry of fixture.relationEntries) {
      for (const target of entry.counterparts) {
        if (target.status === 'available' && target.type === 'work') {
          expect(relations).toContain(
            `href="/en${resourceHref('/w/', target.address as CanonicalAddress)}"`,
          );
        }
      }
    }
    const parts = render(
      <PartsSection
        parts={fixture.parts}
        wholes={fixture.wholes}
        names={fixture.names}
        workRef={fixture.workRef}
        query={{ grain: 'series' }}
        locale="en"
        t={copyOf('en')}
        pageMessages={pageMessages.en}
      />,
    );
    for (const reference of [fixture.iri('101'), fixture.iri('200')]) {
      const target = fixture.names.get(reference);
      if (target?.status !== 'available') throw new Error('Expected a disclosed part or whole');
      expect(parts).toContain(
        `href="/en${resourceHref('/w/', target.address as CanonicalAddress)}"`,
      );
    }
  });

  test('the route owner can override or suppress a destination', () => {
    expect(
      render(<SummaryLink summary={available} {...labels} hrefFor={() => '/discover'} />),
    ).toContain('href="/en/discover"');
    expect(
      render(<SummaryLink summary={available} {...labels} hrefFor={() => null} />),
    ).not.toContain('<a');
  });

  test('an unavailable or non-Work summary does not acquire a Work link', () => {
    expect(summaryWorkHref({ ...available, type: 'resource' })).toBeNull();
    expect(render(<SummaryLink summary={null} {...labels} />)).not.toContain('<a');
    expect(
      render(
        <SummaryLink
          summary={{ reference: available.reference, status: 'unavailable' }}
          {...labels}
        />,
      ),
    ).not.toContain('<a');
  });
});
