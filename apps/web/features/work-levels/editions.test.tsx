import { describe, expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { messages as pageMessages } from '../work-page/messages.ts';
import { EditionsSection, RealizationRow } from './editions.tsx';
import * as fixture from './fixtures.ts';
import { copyOf } from './messages.ts';
import type { SelectedRealizationRead } from './read.ts';
import type { Realization } from './types.ts';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const render = (element: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
if (!fixture.realizations.ok || !fixture.releases.ok) throw new Error('Expected edition fixtures');
const realizationPage = fixture.realizations.data;
const releasePage = fixture.releases.data;
const source: Realization = { ...realizationPage.items[0]!, id: iri(1), revision: iri(11), language: 'ja' };
const translation: Realization = { ...source, id: iri(2), language: 'en', source: {
  kind: 'realization', work: source.work, realization: source.id, revision: source.revision,
} };
const t = copyOf('en');
const row = (realization: Realization, sourceReads: SelectedRealizationRead[] = [], all: Realization[] = []) =>
  render(<ul><RealizationRow realization={realization} all={all} sourceReads={sourceReads} releases={[]}
    names={fixture.names} locale="en" t={t} /></ul>);

describe('Editions exact source presentation', () => {
  test('missing, denied and unavailable pins retain their selection and distinct state beside the listed text', () => {
    const failed = (failure: 'missing' | 'identity' | 'unavailable'): SelectedRealizationRead => ({
      id: source.id, work: source.work, revision: source.revision, read: { ok: false, failure },
    });
    const failureCopies = { missing: pageMessages.en.regionMissing,
      identity: pageMessages.en.regionDenied, unavailable: pageMessages.en.regionUnavailable };
    for (const failure of ['missing', 'identity', 'unavailable'] as const) {
      const html = render(<EditionsSection realizations={{ ok: true, data: {
        ...realizationPage, items: [translation], nextCursor: 'opaque-text-+/=',
      } }} sources={[{ ...source, revision: iri(12), language: 'de' }]} sourceReads={[failed(failure)]}
        releases={{ ok: true, data: { ...releasePage, nextCursor: 'opaque-release-+/=' } }}
        names={fixture.names} workRef={fixture.workRef} query={{}} locale="en" t={t} pageMessages={pageMessages.en} />);
      expect(html).toContain('data-source-refusal');
      expect(html).toContain(source.id);
      expect(html).toContain(source.revision);
      expect(html).toContain(failureCopies[failure]);
      for (const [other, copy] of Object.entries(failureCopies)) if (other !== failure) expect(html).not.toContain(copy);
      expect(html).not.toContain(t.continuityOther);
      expect(html).toContain('realizationsAfter=opaque-text-%2B%2F%3D');
      expect(html).toContain('releasesAfter=opaque-release-%2B%2F%3D');
      expect(html).toContain(`realization-${translation.id.slice(-12)}`);
    }
  });

  test('an exact readable pin supplies its language and an unrelated refusal cannot replace it', () => {
    const unrelated: SelectedRealizationRead = { id: source.id, work: source.work, revision: iri(12),
      read: { ok: false, failure: 'unavailable' } };
    const html = row(translation, [unrelated], [{ ...source, revision: iri(12), language: 'de' }, source]);
    expect(html).toContain('Japanese');
    expect(html).not.toContain('German');
    expect(html).not.toContain('data-source-refusal');
    expect(html).not.toContain(pageMessages.en.regionUnavailable);
    expect(row({ ...translation, source: { kind: 'unresolved', work: source.work } })).toContain(t.continuityUnresolved);
  });
});

describe('default realization evidence', () => {
  test('native references stay visible without a manufactured href and safe external sources remain links', () => {
    const native = iri(20);
    const html = row({ ...source, evidence: native });
    expect(html).toContain(`>${native}</span>`);
    expect(html).not.toContain(`href="${native}"`);
    for (const evidence of ['https://example.test/source/1', 'http://example.test/source/2']) {
      expect(row({ ...source, evidence })).toContain(`href="${evidence}"`);
    }
    for (const evidence of ['javascript:alert(1)', 'https://user:secret@example.test/source']) {
      const unsafe = row({ ...source, evidence });
      expect(unsafe).toContain(evidence);
      expect(unsafe).not.toContain(`href="${evidence}"`);
    }
    expect(row({ ...source, evidence: null })).not.toContain(`<dt class="text-muted-foreground text-xs">${t.evidence}</dt>`);
    const collected = render(<ul><RealizationRow realization={{ ...source, evidence: native }} all={[]} releases={[]}
      names={fixture.names} locale="en" t={t} showEvidence={false} /></ul>);
    expect(collected).not.toContain(native);
  });
});
