import { expect, mock, test } from 'bun:test';
import { fromPlainText, documentText, serializeDocument } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import { authoredFixture, authoredProperty } from '../src/kernel/fake/authored-field';
import {
  authoredStatement,
  readAuthoredBody,
  validateAuthored,
  type AuthoredCommand,
} from '../src/features/catalogue/authored-field';
import { candidateContext, candidateIsPublic } from '../src/subject/candidates';
import { dirname } from 'node:path';
import { m } from '../src/paraglide/messages.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAuthoredField, type AuthoredRead } from '../src/features/catalogue/authored-field';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { AuthoredField } = await import('../src/features/catalogue/authored-field-view');

// Resolve the actual label association: React's stable IDs may include colons.
async function associatedControl(html: string, name: string) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  window.document.body.innerHTML = html;
  const label = Array.from(window.document.querySelectorAll('label')).find(
    (label: any) => label.textContent === name,
  ) as any;
  const control = label ? window.document.getElementById(label.htmlFor) : null;
  await window.happyDOM.close();
  return control;
}

test('Write licensed original catalogue text and review its actual candidate through the declared native contract with truthful authority and failure states', async () => {
  const fixture = authoredFixture();
  const initial = await fixture.transport.read();
  if (!initial.ok) throw new Error('Expected current selected text');
  expect(initial.actions.context).toMatchObject({ state: 'available' });
  expect(
    initial.actions.context.state === 'available' &&
      initial.actions.context.actions.find((item) => item.action === 'statement:propose')?.operations,
  ).toContain('subject.propose');
  expect(fixture.calls.find((call) => call.path === '/v1/viewerActions')).toMatchObject({
    authorization: 'Bearer fixture',
    body: {
      resources: [
        { type: 'semantic.subject', id: fixture.id },
        { type: 'semantic.context', id: candidateContext },
      ],
    },
  });
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
  const posted = fixture.calls.find((call) => call.path === `/v1/subjects/${fixture.id}/candidates`);
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
    expect((await associatedControl(html, m.authored_language({}, { locale: 'en' })))?.tagName).toBe('INPUT');
    expect((await associatedControl(html, m.authored_licence({}, { locale: 'en' })))?.tagName).toBe('INPUT');
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
      expect(fixture.calls.find((call) => call.path === `/v1/subjects/${fixture.id}/candidates`)?.body).toEqual({
        statement,
      });
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
    expect(await associatedControl(html, m.authored_language({}, { locale: 'en' }))).toBeNull();
    expect(html).not.toContain('An aviator meets a young traveller in the desert.');
  }
});

test('an unavailable or denied current proposal observation keeps public text readable without enabling a new command', async () => {
  for (const [scenario, message] of [
    ['actions-unavailable', m.authored_actions_unavailable({}, { locale: 'en' })],
    ['actions-denied', m.authored_action_denied({}, { locale: 'en' })],
  ] as const) {
    const fixture = authoredFixture(scenario);
    const initial = await fixture.transport.read();
    if (!initial.ok || !initial.body?.ok) throw new Error('Expected independent public selected text');
    expect(documentText(initial.body.document.body!)).toContain('aviator');
    const html = renderToStaticMarkup(
      createElement(AuthoredField, { initial, locale: 'en', transport: fixture.transport, confirm: fixture.confirm }),
    );
    expect(html).toContain(message);
    expect(html).toContain('An aviator meets a young traveller in the desert.');
    expect(html).not.toContain(m.authored_submit_contribution({}, { locale: 'en' }));
    if (scenario === 'actions-unavailable') expect(html).toContain(m.authored_check_actions({}, { locale: 'en' }));
  }
});

const { authoredState, initialAuthoredState } = await import('../src/features/catalogue/authored-field-state');
const { CandidateValue } = await import('../src/features/pages/data');

test('a native stale rejection retains frozen draft and recovery while exact readable document references reuse authorized current preview and unreadable values stay truthful', async () => {
  const fixture = authoredFixture('stale');
  const initial = await fixture.transport.read();
  if (!initial.ok || !initial.selected || !initial.body?.ok) throw new Error('Expected readable current text');
  const citation = 'https://example.org/original-notes';
  const draft = {
    document: fromPlainText('A private original draft retained after rejection.'),
    language: 'en',
    licence: 'CC-BY-4.0',
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: citation } }],
      },
    ],
    original: true,
  };
  let state = authoredState(initialAuthoredState(initial), { type: 'edit', property: authoredProperty, change: draft });
  const command: AuthoredCommand = {
    id: fixture.id,
    key: crypto.randomUUID(),
    statement: authoredStatement(authoredProperty, draft.document, draft.language, draft.licence, draft.references),
    session: initial.session,
  };
  state = authoredState(state, { type: 'submit', command });
  const frozen = JSON.stringify(state.command);
  const rejected = await fixture.transport.propose(state.command!);
  expect(rejected).toEqual({ ok: false, reason: 'stale' });
  state = authoredState(state, { type: 'result', result: rejected });
  // A delayed editor emission or successful metadata refetch cannot clear a native rejection or its request.
  state = authoredState(state, { type: 'edit', property: authoredProperty, change: { language: 'ja' } });
  const refreshed = await fixture.transport.read();
  state = authoredState(state, { type: 'read', read: refreshed, reviewDraft: false });
  state = authoredState(state, { type: 'submit', command: { ...command, key: crypto.randomUUID() } });
  expect(state.failure).toBe('stale');
  expect(state.proposed).toBeUndefined();
  expect(state.drafts[authoredProperty]).toEqual(draft);
  expect(JSON.stringify(state.command)).toBe(frozen);
  // An unsuccessful explicit recovery retains the stale recovery action, rather than turning it into a retry.
  state = authoredState(state, { type: 'read', read: { ok: false, reason: 'unavailable' }, reviewDraft: true });
  expect(state.failure).toBe('stale');
  expect(JSON.stringify(state.command)).toBe(frozen);
  const preview = (documents?: unknown) =>
    renderToStaticMarkup(
      createElement(CandidateValue, {
        snak: initial.selected!,
        related: initial.public.related,
        locale: 'en',
        subject: fixture.id,
        documents,
      }),
    );
  expect(preview({ [initial.selected.id]: initial.body.document })).toContain('An aviator meets a young traveller');
  expect(preview()).toContain('This value has no readable preview.');
  expect(preview({ [initial.selected.id]: draft })).toContain('This value has no readable preview.');
  // A successful explicit review unlocks the same draft; a deliberate resubmission makes a new intent.
  state = authoredState(state, { type: 'read', read: refreshed, reviewDraft: true });
  expect(state.command).toBeNull();
  expect(state.failure).toBeUndefined();
  expect(state.drafts[authoredProperty]).toEqual(draft);
  const next = { ...command, key: crypto.randomUUID() };
  state = authoredState(state, { type: 'submit', command: next });
  state = authoredState(state, { type: 'result', result: await fixture.transport.propose(state.command!) });
  expect(state.failure).toBe('stale');
  expect(state.command?.key).toBe(next.key);
  expect(
    fixture.calls.filter((call) => call.path === `/v1/subjects/${fixture.id}/candidates`).map((call) => call.key),
  ).toEqual([command.key, next.key]);
});

test('current, proposed and selected native document values use exact authorized readback without row hydration or draft substitution', async () => {
  const fixture = authoredFixture();
  const proposal = await fixture.transport.propose({
    id: fixture.id,
    key: crypto.randomUUID(),
    statement: authoredStatement(
      authoredProperty,
      fromPlainText('An independently read original replacement.'),
      'en',
      'CC-BY-4.0',
      'https://example.org/original-notes',
    ),
  });
  if (!proposal.ok) throw new Error('Expected a proposal');
  const review = await fixture.transport.review(authoredProperty, proposal.candidate);
  const current = review.current;
  if (!review.comparison.ok || !review.body?.ok || !current?.selected || !current.body?.ok)
    throw new Error('Expected independent public and private document reads');
  const candidate = review.comparison.page!.candidates.find((item) => item.id === proposal.candidate)!;
  const render = (snak: typeof candidate.statement, documents?: unknown, subject = fixture.id) =>
    renderToStaticMarkup(createElement(CandidateValue, { snak, related: {}, locale: 'en', subject, documents }));
  const publicDocuments = { [current.selected.id]: current.body.document };
  const candidateDocuments = { ...publicDocuments, [candidate.id]: review.body.document };
  const requests = fixture.calls.length;
  expect(render(current.selected, publicDocuments)).toContain('An aviator meets a young traveller');
  expect(render(candidate.statement, candidateDocuments)).toContain('An independently read original replacement.');
  // Private readability does not authorize a public preview.
  expect(render(candidate.statement, publicDocuments)).not.toContain('original replacement');
  expect(fixture.calls.length).toBe(requests);
  await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: candidate.id,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: candidate.id,
    operation: 'adopt',
    head: 1,
    key: crypto.randomUUID(),
    selection: [{ candidate: candidate.id, rank: 'normal' }],
  });
  const selected = await fixture.transport.read();
  if (!selected.ok || !selected.selected || !selected.body?.ok) throw new Error('Expected current public readback');
  const document = selected.body.document;
  const readable = { [candidate.id]: document };
  // Public readback and the reviewed candidate retain their native references while sharing the authorized body.
  for (const statement of [selected.selected, candidate.statement])
    expect(render(statement, readable)).toContain('An independently read original replacement.');
  for (const changed of [
    { id: fixture.old.id },
    { subjectId: fixture.old.id },
    { candidateId: fixture.old.id },
    { digest: 'd'.repeat(64) },
    { language: 'ja' },
    { availability: 'withheld' },
    { availability: 'erased' },
    { body: null },
  ])
    expect(render(selected.selected, { [candidate.id]: { ...document, ...changed } })).not.toContain(
      'original replacement',
    );
  for (const unreadable of [undefined, {}, { [document.id]: document }, { [candidate.id]: proposal }])
    expect(render(selected.selected, unreadable)).not.toContain('original replacement');
  expect(render(selected.selected, readable, fixture.old.id)).not.toContain('original replacement');
  expect(render({ ...selected.selected, value: { type: 'value', content: document.id } }, readable)).not.toContain(
    document.id,
  );
  // Revocation uses the new read, with no fallback to the readable proposal or an earlier public body.
  fixture.documents.delete(document.id);
  const revoked = await fixture.transport.read();
  expect(revoked.ok && revoked.body?.ok).toBe(false);
  expect(
    render(selected.selected, revoked.ok && revoked.body?.ok ? { [candidate.id]: revoked.body.document } : {}),
  ).not.toContain('original replacement');
});
