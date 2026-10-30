import { expect, test } from 'bun:test';
import { documentText, fromPlainText } from '@rezics/document';
import { authoredFixture, authoredProperty } from '../src/kernel/fake/authored-field';
import { authoredStatement, validateAuthored, type AuthoredCommand } from '../src/features/catalogue/authored-field';
import { authoredState, initialAuthoredState } from '../src/features/catalogue/authored-field-state';
import { candidateContext } from '../src/subject/candidates';

test('the selected play payload adopts the actual authored slot and leaves unrelated public fields intact', async () => {
  const fixture = authoredFixture();
  const unrelated = structuredClone(fixture.publicRead.subject.statements['schema:datePublished']);
  const initial = await fixture.transport.read();
  if (!initial.ok) throw new Error('Expected authored metadata');
  const statement = authoredStatement(
    authoredProperty,
    fromPlainText('A quiet story about friendship.'),
    'en',
    'CC-BY-4.0',
    'https://example.org/original-notes',
  );
  expect(validateAuthored(statement, initial.release)).toEqual([]);
  const key = crypto.randomUUID();
  const proposed = await fixture.transport.propose({ id: fixture.id, key, statement, session: initial.session });
  if (!proposed.ok) throw new Error('Expected actual proposal receipt');
  expect(fixture.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: `/v1/subjects/${fixture.id}/candidates`,
    authorization: 'Bearer fixture',
    key,
    body: { statement },
  });
  const review = await fixture.transport.review(authoredProperty, proposed.candidate, undefined, proposed.session);
  if (!review.comparison.ok || !review.body?.ok) throw new Error('Expected actual proposed document');
  expect(documentText(review.body.document.body!)).toBe('A quiet story about friendship.');
  const accepted = await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: proposed.candidate,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
    session: review.comparison.session,
  });
  expect(accepted.ok && accepted.kind).toBe('accepted');
  const reloaded = await fixture.transport.review(
    authoredProperty,
    proposed.candidate,
    undefined,
    accepted.ok ? accepted.session : undefined,
  );
  if (!reloaded.comparison.ok || !reloaded.body?.ok) throw new Error('Expected comparison after acceptance');
  const selection = [{ candidate: proposed.candidate, rank: 'normal' as const }];
  const adopted = await fixture.client.subjects({ id: fixture.id }).$adopt.post(
    {
      context: candidateContext,
      property: authoredProperty,
      mode: 'replace',
      expected_head: reloaded.comparison.page!.adoption!.head,
      selection,
    },
    { headers: { authorization: 'Bearer fixture', 'idempotency-key': crypto.randomUUID() } },
  );
  expect(adopted.status).toBe(200);
  expect(adopted.data?.adoption).toMatchObject({ property: authoredProperty, selection });
  expect(fixture.publicRead.subject.statements['schema:datePublished']).toEqual(unrelated);
  // Selection comes from the public Subject and document endpoints after the native receipt.
  for (let reload = 0; reload < 2; reload++) {
    const current = await fixture.transport.read(authoredProperty);
    const comparison = await fixture.transport.review(authoredProperty, proposed.candidate);
    if (!current.ok || !current.body?.ok || !comparison.comparison.ok || !comparison.body?.ok)
      throw new Error('Expected separately authorized public and candidate readbacks');
    expect(current.selected?.id).toBe(proposed.candidate);
    expect(current.body.document).toEqual(comparison.body.document);
    expect(documentText(current.body.document.body!)).toBe('A quiet story about friendship.');
  }
});

test('the authored fixture uses emitted multivalue metadata and the authored current selection for native adoption', async () => {
  const fixture = authoredFixture();
  const proposed = await fixture.transport.propose({
    id: fixture.id,
    key: crypto.randomUUID(),
    statement: authoredStatement(
      authoredProperty,
      fromPlainText('Another reading.'),
      'en',
      'CC-BY-4.0',
      'https://example.org/notes',
    ),
  });
  if (!proposed.ok) throw new Error('Expected proposal');
  const review = await fixture.transport.review(authoredProperty, proposed.candidate);
  expect(review.comparison.ok && review.comparison.fields[0]?.multivalued).toBe(true);
  await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: proposed.candidate,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  const selected = await fixture.confirm({
    id: fixture.id,
    property: authoredProperty,
    candidate: proposed.candidate,
    operation: 'adopt',
    head: 1,
    key: crypto.randomUUID(),
    selection: [
      { candidate: fixture.old.id, rank: 'normal' },
      { candidate: proposed.candidate, rank: 'preferred' },
    ],
  });
  expect(selected.ok && selected.kind).toBe('selected');
  expect(selected.ok && selected.public?.subject.statements[authoredProperty]?.map((value) => value.id)).toEqual([
    fixture.old.id,
    proposed.candidate,
  ]);
});

test('both real conflict submissions retain the frozen draft across metadata refresh and explicit recovery', async () => {
  const fixture = authoredFixture('stale');
  const initial = await fixture.transport.read();
  if (!initial.ok) throw new Error('Expected authored metadata');
  const draft = {
    document: fromPlainText('A quiet story about friendship.'),
    language: 'en',
    licence: 'CC-BY-4.0',
    citation: 'https://example.org/original-notes',
    original: true,
  };
  let state = authoredState(initialAuthoredState(initial), { type: 'edit', property: authoredProperty, change: draft });
  for (let attempt = 0; attempt < 2; attempt++) {
    const command: AuthoredCommand = {
      id: fixture.id,
      key: crypto.randomUUID(),
      statement: authoredStatement(authoredProperty, draft.document, draft.language, draft.licence, draft.citation),
      session: initial.session,
    };
    state = authoredState(state, { type: 'submit', command });
    const result = await fixture.transport.propose(command);
    expect(result).toEqual({ ok: false, reason: 'stale' });
    state = authoredState(state, { type: 'result', result });
    const refreshed = await fixture.transport.read();
    state = authoredState(state, { type: 'read', read: refreshed, reviewDraft: false });
    state = authoredState(state, { type: 'edit', property: authoredProperty, change: { language: 'ja' } });
    expect(state.failure).toBe('stale');
    expect(state.command).toEqual(command);
    expect(state.drafts[authoredProperty]).toEqual(draft);
    if (attempt === 0) {
      state = authoredState(state, { type: 'read', read: refreshed, reviewDraft: true });
      expect(state.command).toBeNull();
      expect(state.failure).toBeUndefined();
    }
  }
});
