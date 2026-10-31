import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderQueue } from '../src/features/import-review/provider-queue-view';
import type { QueueState } from '../src/features/import-review/provider-queue';
import { providerQueueFixture } from '../src/kernel/fake/provider-review-queue';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import { languageName } from '../src/subject/language';

test('The default provider queue identifies and compares an exact suggestion before confirming it', async () => {
  // The canonical queue's Decision play supplies the checkbox/dialog interaction assertions.
  // This harness renders the same ProviderQueue, using real reads through the generated HTTP client.
  const fixture = providerQueueFixture('comparison');
  const previousLocale = getLocale();
  function render(initial: QueueState) {
    return renderToStaticMarkup(
      createElement(ProviderQueue, {
        transport: fixture.transport,
        initial,
        initialScope: fixture.scope,
      }),
    );
  }
  try {
    setLocale('en', { reload: false });
    const read = await fixture.transport.read(fixture.scope, undefined, 'before-queue');
    if (read.state !== 'ready') throw new Error('Expected a current queue page');
    expect(read.page.candidates).toHaveLength(2);
    expect(read.readings).toHaveLength(1);
    expect(read.names[fixture.native.id]).toBeUndefined(); // These names are definitions, not subject labels.
    const html = render(read);
    expect(html).toContain('The Little Prince');
    expect(html).toContain(`/subjects/${fixture.native.id}/`);
    expect(html).toContain(m.context_selected_values());
    expect(html).toContain(m.candidate_proposed());
    expect(html).toContain('publication date');
    expect(html).toContain('1943');
    expect(html).toContain('1946');
    for (const code of ['fr', 'en', 'de']) expect(html).toContain(languageName(code, 'en')!);
    expect(html).toContain('Antoine de Saint-Exupéry'); // Current related label in the proposal qualifier.
    expect(html).toContain('https://www.wikidata.org/wiki/Q25338');
    for (const value of ['wikidata', 'Q25338', '2026-10-30', '2026-10-31', 'wikidata-1', 'wikidata-2'])
      expect(html).toContain(value);
    for (const suggestion of fixture.suggestions) expect(html).toContain(suggestion.id);
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain('role="alertdialog"'); // No automatic decision or selection.
    expect(fixture.calls.every((call) => call.method === 'GET' && call.key === null)).toBe(true);
    const pageReads = fixture.calls.filter((call) => call.path.startsWith('/v1/review-candidates?'));
    expect(pageReads).toHaveLength(1);
    expect(new URL(pageReads[0]!.path, 'https://queue.test').searchParams.get('limit')).toBe('20');
    expect(pageReads[0]!.session).toBe('before-queue');
    const subjectReads = fixture.calls.filter((call) => call.path.startsWith(`/v1/subjects/${fixture.native.id}?`));
    expect(subjectReads).toHaveLength(1); // Two properties on one subject share the exact Context read.
    expect(new URL(subjectReads[0]!.path, 'https://queue.test').searchParams.get('context')).toBe(
      fixture.scope.context,
    );
    expect(subjectReads[0]!.authorization).toBe('Bearer fixture');
    expect(subjectReads[0]!.session).toBe('queue-session');
    expect(fixture.calls).toHaveLength(3); // Queue, Context definitions, subject; no field reads or scans.

    setLocale('fr', { reload: false });
    expect(render(read)).toContain('Le Petit Prince');
    setLocale('en', { reload: false });

    // A readable property without a selected statement is distinct from a failed comparison read.
    delete fixture.native.publicRead.subject.statements['schema:datePublished'];
    const noSelection = await fixture.transport.read(fixture.scope);
    const emptyField = render(noSelection);
    expect(emptyField).toContain(m.context_no_values());
    expect(emptyField).not.toContain(m.prq_comparison_unavailable());
    expect(emptyField).toContain('1946');
    expect(emptyField).not.toContain('1943');

    fixture.setReadingStatus(503);
    const unavailable = await fixture.transport.read(fixture.scope);
    const unavailableHtml = render(unavailable);
    expect(unavailableHtml).toContain(m.prq_comparison_unavailable());
    expect(unavailableHtml).not.toContain(m.context_no_values());
    expect(unavailableHtml).not.toContain('The Little Prince');
    expect(unavailableHtml).not.toContain('1943');
    expect(unavailableHtml).not.toContain(languageName('fr', 'en')!);
    expect(unavailableHtml).toContain('1946'); // The queue proposal is still readable, never a cached current value.

    for (const status of [403, 404]) {
      fixture.setReadingStatus(status);
      const denied = await fixture.transport.read(fixture.scope);
      if (denied.state !== 'ready') throw new Error('Expected independently readable queue metadata');
      expect(denied.readings).toEqual([
        { subject: fixture.native.id, result: { ok: false, reason: status === 403 ? 'denied' : 'missing' } },
      ]);
      const deniedHtml = render(denied);
      expect(deniedHtml).toContain(m.provider_missing());
      for (const concealed of ['The Little Prince', '1943', '1946', 'Q25338', '2026-10-31', 'Antoine de Saint-Exupéry'])
        expect(deniedHtml).not.toContain(concealed);
      expect(deniedHtml).not.toContain('role="checkbox"');
    }

    fixture.calls.length = 0;
    fixture.setScenario('empty');
    const empty = await fixture.transport.read(fixture.scope);
    const emptyHtml = render(empty);
    expect(emptyHtml).toContain(m.prq_empty());
    expect(emptyHtml).toContain(m.prq_refresh());
    expect(emptyHtml).toContain('wikidata');
    expect(emptyHtml).toContain(m.prq_global());
    expect(emptyHtml).not.toContain(m.provider_selection());
    expect(emptyHtml).not.toContain(m.provider_visible_only({ limit: 20 }));
    expect(emptyHtml).not.toContain(m.prq_selection_help());
    expect(emptyHtml).not.toContain(m.candidate_accept());
    expect(emptyHtml).not.toContain(m.candidate_reject());
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});
