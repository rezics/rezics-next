import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { statementFixture } from '../src/kernel/fake/catalogue-statements';
import { candidateContext, candidateIsPublic } from '../src/subject/candidates';
import {
  correctionInspectionAvailability,
  correctionProposalAvailability,
  readCorrectionActions,
  statementInput,
  validateStatement,
  correctionProperty,
  readStatementEditor,
} from '../src/features/catalogue/statement-editor';

test('Read correction operations once for the exact Subject and Global Context and keep unavailable separate from denied', async () => {
  const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
  const requests: { path: string; body: unknown; authorization: string | null }[] = [];
  let hiddenContext = false;
  const client = createKernelClient('https://actions.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input.clone() : new Request(String(input), init);
      const body = await request.json();
      requests.push({
        path: new URL(request.url).pathname,
        body,
        authorization: request.headers.get('authorization'),
      });
      return new Response(
        JSON.stringify({
          resources: [
            {
              type: 'semantic.subject',
              id,
              viewerActions: [{ action: 'subject:read', operations: ['subject.list_candidates'] }],
            },
            hiddenContext
              ? { type: 'semantic.context', id: candidateContext, error: 'not_found' }
              : { type: 'semantic.context', id: candidateContext, viewerActions: [] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });

  const denied = await readCorrectionActions(client, 'Bearer fixture', id);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    path: '/v1/viewerActions',
    body: {
      resources: [
        { type: 'semantic.subject', id },
        { type: 'semantic.context', id: candidateContext },
      ],
    },
    authorization: 'Bearer fixture',
  });
  expect(correctionInspectionAvailability(denied)).toBe('allowed');
  expect(correctionProposalAvailability(denied)).toBe('denied');

  hiddenContext = true;
  const unavailable = await readCorrectionActions(client, 'Bearer fixture', id);
  expect(requests).toHaveLength(2);
  expect(correctionInspectionAvailability(unavailable)).toBe('allowed');
  expect(correctionProposalAvailability(unavailable)).toBe('unavailable');
  expect(await readCorrectionActions(client, undefined, id)).toEqual({
    subject: { state: 'not-requested' },
    context: { state: 'not-requested' },
  });
  expect(requests).toHaveLength(2);
});

// The integration command exercises this same typed transport; these focused cases need no database.
test('Propose a cited correction from the real subject page through the existing API and reader with honest failure states', async () => {
  const fixture = statementFixture();
  const read = await fixture.editor.read();
  expect(read.ok).toBe(true);
  if (!read.ok || !read.source) throw new Error('Expected a selected public statement');
  expect(read.public.subject.id).toBe(fixture.id);
  const old = structuredClone(read.source);
  const statement = statementInput(read.source);
  statement.value = {
    type: 'value',
    content: { time: '+1946-04-06T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
  };
  statement.references.push({
    parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/publication' } }],
  });
  expect(validateStatement(statement, read.release)).toEqual([]);
  const result = await fixture.editor.propose({ id: fixture.id, statement, key: crypto.randomUUID() });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected proposal');
  expect(result.kind).toBe('proposed-awaiting-review');
  expect(result.candidate).toBe(fixture.candidate.id);
  expect(fixture.publicRead.subject.statements[fixture.address.property]![0]).toEqual(old);
  expect(fixture.candidate.decision).toBeNull();
  const write = fixture.calls.find((call) => call.method === 'POST')!;
  expect(write.path).toBe(`/v1/subjects/${fixture.id}/candidates`);
  expect(Object.keys(write.body as object)).toEqual(['statement']);
  expect(write.body).toEqual({ statement });
  expect(write.authorization).toBe('Bearer fixture');
  expect(write.key).toBeTruthy();
  const review = await fixture.review.read(fixture.address.property);
  if (!review.ok) throw new Error('Expected review');
  const exact = review.page!.candidates.find((item) => item.id === result.candidate)!;
  expect(exact.statement.references).toHaveLength(statement.references.length);
  expect(candidateIsPublic(review.public, fixture.address.property, result.candidate)).toBe(false);
  const accepted = await fixture.review.confirm({
    id: fixture.id,
    property: fixture.address.property,
    candidate: exact.id,
    head: exact.head,
    operation: 'accept',
    key: crypto.randomUUID(),
  });
  expect(accepted.ok && accepted.kind).toBe('accepted');
  const refreshed = await fixture.review.read(fixture.address.property);
  if (!refreshed.ok) throw new Error('Expected refreshed review');
  const adopted = await fixture.review.confirm({
    id: fixture.id,
    property: fixture.address.property,
    candidate: result.candidate,
    head: refreshed.page!.adoption!.head,
    operation: 'adopt',
    key: crypto.randomUUID(),
  });
  expect(adopted.ok && adopted.kind).toBe('selected');
  expect(
    adopted.ok && adopted.public && candidateIsPublic(adopted.public, fixture.address.property, result.candidate),
  ).toBe(true);
  expect(
    fixture.calls
      .filter((call) => call.path === `/v1/subjects/${fixture.id}` && call.method === 'GET')
      .every((call) => call.authorization === null),
  ).toBe(true);
  expect(fixture.calls.some((call) => call.session === 'statement-session')).toBe(true);
});

test('preserves native unknown/no-value, every qualifier and citation part without reader or ingestion metadata', () => {
  const fixture = statementFixture();
  const source = structuredClone(fixture.source);
  source.qualifiers.push({
    property: { id: 'schema:author', data_type: 'wikibase-item' },
    value: { type: 'somevalue' },
  });
  source.references[0]!.parts.push({
    property: { id: 'schema:genre', data_type: 'wikibase-item' },
    value: { type: 'novalue' },
  });
  for (const value of [{ type: 'somevalue' }, { type: 'novalue' }] as const) {
    source.value = value;
    const input = statementInput(source);
    expect(input.value).toEqual(value);
    expect(input.qualifiers![0]).toEqual({ property: { id: 'schema:author' }, value: { type: 'somevalue' } });
    expect(input.references[0]!.parts.at(-1)!.value).toEqual({ type: 'novalue' });
    expect(JSON.stringify(input)).not.toContain('data_type');
    expect(JSON.stringify(input)).not.toContain('hash');
    expect(Object.keys(input)).toEqual(['property', 'value', 'qualifiers', 'references', 'rank']);
  }
  source.property = { id: 'schema:height', data_type: 'quantity' };
  source.value = {
    type: 'value',
    content: {
      amount: '+1.75',
      unit: 'http://www.wikidata.org/entity/Q11573',
      lowerBound: '+1.74',
      upperBound: '+1.76',
    },
  };
  expect(statementInput(source).value).toEqual(source.value);
  source.property = { id: 'schema:name', data_type: 'monolingualtext' };
  source.value = { type: 'value', content: { text: '原文', language: 'zh-Hant' } };
  expect(statementInput(source).value).toEqual(source.value);
  expect(correctionProperty(fixture.release, 'schema:Book', 'schema:name')).toBe(false);
  expect(correctionProperty(fixture.release, 'schema:Book', 'schema:author')).toBe(false);
  expect(
    validateStatement({ ...statementInput(fixture.source), source: { source: 'wikidata' } }).length,
  ).toBeGreaterThan(0);
});

test('keeps a native draft intact for invalid, denied, stale and unavailable outcomes; uncertain retries reuse the receipt', async () => {
  for (const reason of ['invalid', 'denied', 'stale', 'unavailable'] as const) {
    const fixture = statementFixture(reason);
    const statement = statementInput(fixture.source);
    const command = { id: fixture.id, statement, key: crypto.randomUUID() };
    const before = structuredClone(command);
    expect(await fixture.editor.propose(command)).toMatchObject({ ok: false, reason });
    expect(command).toEqual(before);
    expect(fixture.candidate.decision).toBeNull();
  }
  const fixture = statementFixture('lost-response');
  const command = { id: fixture.id, statement: statementInput(fixture.source), key: crypto.randomUUID() };
  expect(await fixture.editor.propose(command)).toEqual({ ok: false, reason: 'unavailable' });
  const retried = await fixture.editor.propose(command);
  expect(retried.ok && retried.candidate).toBe(fixture.candidate.id);
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  const hidden = createKernelClient('https://hidden.test', {
    fetch: (async () =>
      new Response('{"code":"not_found"}', {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      })) as typeof fetch,
  });
  expect(await readStatementEditor(hidden, fixture.address)).toEqual({ ok: false, reason: 'unavailable' });
});
