import { expect, test } from 'bun:test';
import { fromPlainText, documentText, serializeDocument } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import { authoredFixture, authoredProperty } from '../src/kernel/fake/authored-field';
import {
  authoredStatement,
  readAuthoredBody,
  validateAuthored,
  type AuthoredCommand,
} from '../src/features/catalogue/authored-field';
import { candidateIsPublic } from '../src/subject/candidates';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthoredField } from '../src/features/catalogue/authored-field-view';
import { readAuthoredField, type AuthoredRead } from '../src/features/catalogue/authored-field';

test('Write licensed original catalogue text and review its actual candidate through the declared native contract with truthful authority and failure states', async () => {
  const fixture = authoredFixture();
  const initial = await fixture.transport.read();
  if (!initial.ok) throw new Error('Expected current selected text');
  expect(
    initial.body?.ok && initial.body.document.availability === 'available' && documentText(initial.body.document.body!),
  ).toContain('aviator');
  const document = fromPlainText('My original account of this book.\nA second paragraph.');
  const statement = authoredStatement(authoredProperty, document, 'en', 'CC-BY-SA-4.0', 'https://example.org/notes');
  expect(validateAuthored(statement, fixture.release)).toEqual([]);
  const command: AuthoredCommand = { id: fixture.id, key: crypto.randomUUID(), statement, session: initial.session };
  const result = await fixture.transport.propose(command);
  if (!result.ok) throw new Error('Expected proposal');
  expect(result.kind).toBe('proposed-awaiting-review');
  expect(candidateIsPublic(fixture.publicRead, authoredProperty, result.candidate)).toBe(false);
  const posted = fixture.calls.find((call) => call.method === 'POST');
  expect(posted).toMatchObject({
    path: `/v1/subjects/${fixture.id}/candidates`,
    key: command.key,
    authorization: 'Bearer fixture',
    session: initial.session,
    body: { statement },
  });
  const review = await fixture.transport.review(authoredProperty, result.candidate, undefined, result.session);
  if (!review.comparison.ok || !review.body?.ok) throw new Error('Expected native candidate and document');
  expect(review.comparison.page?.candidates[0]?.id).toBe(result.candidate);
  expect(review.body.document).toMatchObject({
    candidateId: result.candidate,
    origin: 'account',
    licence: 'CC-BY-SA-4.0',
    language: 'en',
  });
  expect(serializeDocument(review.body.document.body!)).toBe(serializeDocument(document));
  expect(fixture.calls.filter((call) => call.path.startsWith('/v1/documents/')).at(-1)).toMatchObject({
    authorization: 'Bearer fixture',
    session: 'candidate-session',
  });
  const decision = await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: result.candidate,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
    session: result.session,
  });
  expect(decision.ok && decision.kind).toBe('accepted');
  expect(candidateIsPublic(fixture.publicRead, authoredProperty, result.candidate)).toBe(false);
  await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: result.candidate,
    operation: 'adopt',
    head: 1,
    key: crypto.randomUUID(),
    selection: [{ candidate: result.candidate, rank: 'normal' }],
    session: result.session,
  });
  const selected = await fixture.transport.read(authoredProperty, result.session);
  if (!selected.ok || !selected.body?.ok) throw new Error('Expected selected public document');
  expect(selected.selected?.id).toBe(result.candidate);
  expect(serializeDocument(selected.body.document.body!)).toBe(serializeDocument(document));
  expect(fixture.calls.filter((call) => call.path.startsWith('/v1/documents/')).at(-1)?.authorization).toBeNull();
  // A body belonging to another candidate never becomes the selected work, even when the shape is valid.
  const selectedDocument = selected.body.document;
  const mismatched = createKernelClient('https://mismatch.test', {
    fetch: (async () =>
      new Response(JSON.stringify({ document: { ...selectedDocument, candidateId: fixture.old.id } }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  expect((await readAuthoredBody(mismatched, fixture.id, selected.selected!)).ok).toBe(false);
  const hidden = authoredFixture('body-unavailable');
  const unavailable = await hidden.transport.read();
  expect(unavailable.ok && unavailable.body?.ok).toBe(false);
});

test('authored envelope validation and failed submissions preserve the exact request without claiming publication', async () => {
  const fixture = authoredFixture('lost-response');
  const document = fromPlainText('Original text.');
  const statement = authoredStatement(authoredProperty, document, 'en', 'CC-BY-4.0', 'https://example.org/notes');
  for (const [language, licence] of [
    ['not_a_language', 'CC-BY-4.0'],
    ['en', 'Unknown-Licence'],
  ])
    expect(
      validateAuthored(
        authoredStatement(authoredProperty, document, language!, licence!, 'https://example.org/notes'),
        fixture.release,
      ).length,
    ).toBeGreaterThan(0);
  expect(
    validateAuthored(
      authoredStatement(authoredProperty, fromPlainText(''), 'en', 'CC0-1.0', 'https://example.org'),
      fixture.release,
    ).length,
  ).toBeGreaterThan(0);
  expect(
    validateAuthored(
      authoredStatement(
        authoredProperty,
        fromPlainText('x'.repeat(2 * 1024 * 1024)),
        'en',
        'CC0-1.0',
        'https://example.org',
      ),
      fixture.release,
    ).length,
  ).toBeGreaterThan(0);
  const command: AuthoredCommand = { id: fixture.id, key: crypto.randomUUID(), statement };
  const frozen = JSON.stringify(command);
  expect(await fixture.transport.propose(command)).toEqual({ ok: false, reason: 'unavailable' });
  const retry = await fixture.transport.propose(command);
  expect(retry.ok).toBe(true);
  expect(JSON.stringify(command)).toBe(frozen);
  expect(
    fixture.calls.filter((call) => call.method === 'POST').map((call) => ({ key: call.key, body: call.body })),
  ).toEqual([
    { key: command.key, body: { statement } },
    { key: command.key, body: { statement } },
  ]);
  expect(candidateIsPublic(fixture.publicRead, authoredProperty, fixture.candidate.id)).toBe(false);
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['invalid', 'invalid'],
    ['stale', 'stale'],
    ['unavailable', 'unavailable'],
  ] as const) {
    const failed = authoredFixture(scenario);
    expect(await failed.transport.propose({ ...command, id: failed.id })).toEqual({ ok: false, reason });
    expect(candidateIsPublic(failed.publicRead, authoredProperty, failed.candidate.id)).toBe(false);
  }
});

test('authorized authored ready and conflict states show the real form while selected shows actual readback and denied or unbound production remains truthful', async () => {
  for (const scenario of ['ready', 'stale'] as const) {
    const fixture = authoredFixture(scenario);
    const initial = await fixture.transport.read();
    if (!initial.ok) throw new Error('Expected an admitted document field');
    expect(initial.property).toBe(authoredProperty);
    const html = renderToStaticMarkup(
      createElement(AuthoredField, { initial, locale: 'en', transport: fixture.transport, confirm: fixture.confirm }),
    );
    expect(html).toContain('<form');
    expect(html).toContain('id="authored-language"');
    expect(html).toContain('id="authored-licence"');
    expect(html).toContain('An aviator meets a young traveller in the desert.');
    const statement = authoredStatement(
      authoredProperty,
      fromPlainText('An original replacement with a meaningful typed draft.'),
      'en',
      'CC-BY-4.0',
      'https://example.org/original-notes',
    );
    const command: AuthoredCommand = { id: fixture.id, key: crypto.randomUUID(), statement };
    const result = await fixture.transport.propose(command);
    if (scenario === 'stale') {
      expect(result).toEqual({ ok: false, reason: 'stale' });
      expect(fixture.calls.find((call) => call.method === 'POST')?.body).toEqual({ statement });
    } else {
      expect(result.ok && result.kind).toBe('proposed-awaiting-review');
    }
    const selected = await fixture.transport.read();
    expect(selected.ok && selected.selected?.id).toBe(fixture.old.id);
    expect(selected.ok && selected.body?.ok && documentText(selected.body.document.body!)).toContain('aviator');
  }
});

test('a denied new proposal does not suppress or reconstruct the independently authorized selected document', async () => {
  const fixture = authoredFixture('denied');
  const initial = await fixture.transport.read();
  if (!initial.ok || !initial.body?.ok) throw new Error('Expected a public selected document');
  fixture.publicRead.subject.sourceRecords = [];
  expect(
    await fixture.transport.propose({
      id: fixture.id,
      key: crypto.randomUUID(),
      statement: authoredStatement(
        authoredProperty,
        fromPlainText('A rejected private draft.'),
        'en',
        'CC0-1.0',
        'https://example.org/notes',
      ),
    }),
  ).toEqual({ ok: false, reason: 'denied' });
  const selected = await fixture.transport.read();
  if (!selected.ok || !selected.body?.ok) throw new Error('Expected independent public readback');
  expect(selected.public.subject.sourceRecords).toEqual([]);
  expect(selected.body.document).toMatchObject({ candidateId: fixture.old.id, licence: 'CC-BY-4.0' });
  const html = renderToStaticMarkup(
    createElement(AuthoredField, {
      initial: selected,
      locale: 'en',
      transport: fixture.transport,
      confirm: fixture.confirm,
    }),
  );
  expect(html).toContain('An aviator meets a young traveller in the desert.');
  expect(html).not.toContain('A rejected private draft.');
  expect(fixture.calls.filter((call) => call.path.startsWith('/v1/documents/')).at(-1)?.authorization).toBeNull();
  // Losing current document disclosure never falls back to the previous body or the rejected draft.
  fixture.documents.delete(initial.body.document.id);
  const hidden = await fixture.transport.read();
  expect(hidden.ok && hidden.body?.ok).toBe(false);
  const hiddenHtml = renderToStaticMarkup(
    createElement(AuthoredField, {
      initial: hidden,
      locale: 'en',
      transport: fixture.transport,
      confirm: fixture.confirm,
    }),
  );
  expect(hiddenHtml).not.toContain('An aviator meets a young traveller in the desert.');
  expect(hiddenHtml).not.toContain('A rejected private draft.');
});

test('unsupported metadata, denied reads and an unbound production transport never supply an authored form or body', async () => {
  const fixture = authoredFixture('empty');
  const unsupported = await fixture.transport.read();
  expect(unsupported.ok && unsupported.property).toBe('');
  const deniedClient = createKernelClient('https://denied.test', {
    fetch: (async () => new Response('{}', { status: 403 })) as typeof fetch,
  });
  const unboundClient = createKernelClient('https://unbound.test', {
    fetch: (async () => {
      throw new Error('KERNEL_ORIGIN is unavailable');
    }) as typeof fetch,
  });
  const denied = await readAuthoredField(deniedClient, { id: fixture.id }, 'en');
  const unbound = await readAuthoredField(unboundClient, { id: fixture.id }, 'en');
  expect(denied).toEqual({ ok: false, reason: 'denied' });
  expect(unbound).toEqual({ ok: false, reason: 'unavailable' });
  for (const initial of [unsupported, denied, unbound] satisfies AuthoredRead[]) {
    const html = renderToStaticMarkup(
      createElement(AuthoredField, { initial, locale: 'en', transport: fixture.transport, confirm: fixture.confirm }),
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('id="authored-language"');
    expect(html).not.toContain('An aviator meets a young traveller in the desert.');
  }
});
