import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { identifierFields, identifierProperties } from '../src/features/catalogue/identifiers-profile';
import { reconcileFactSource, SubjectFacts } from '../src/features/catalogue/subject-facts-view';
import {
  factChanged,
  factLocked,
  sealFacts,
  sendFacts,
  stageFact,
  type FactDraft,
} from '../src/features/catalogue/subject-facts';
import { validateStatement } from '../src/features/catalogue/statement-editor';
import { candidateContext } from '../src/subject/candidates';
import {
  identifiersProfileFixture,
  identifiersSubject,
  identifiersStatement,
  identifiersCandidate,
  identifiersCompetingCandidate,
  identifiersCitation,
} from '../src/kernel/fake/catalogue-identifiers-profile';

const correctedIsbn = '978-4-00-000001-7';

test('refreshed fact sources follow current statements and preserve a surviving choice', () => {
  expect(reconcileFactSource(identifiersStatement, [])).toBe('');
  expect(reconcileFactSource(identifiersStatement, [{ id: 'replacement' }])).toBe('');
  expect(reconcileFactSource('', [{ id: 'replacement' }])).toBe('');
  expect(reconcileFactSource(identifiersStatement, [{ id: identifiersStatement }])).toBe(identifiersStatement);
});

async function isbnDraft(fixture: ReturnType<typeof identifiersProfileFixture>) {
  const read = await fixture.transport.read();
  if (!read.ok) throw new Error('Expected a current native read');
  const draft = stageFact(read, 'schema:isbn', identifiersStatement)!;
  draft.statement.value = { type: 'value', content: correctedIsbn };
  return { read, draft, sealed: sealFacts(identifiersSubject, read.release, [draft]) };
}

test('Ordinary identifier evidence editor uses current admitted native fields and actual candidate-reader semantics', async () => {
  const fixture = identifiersProfileFixture();
  const { read, draft, sealed } = await isbnDraft(fixture);
  expect(identifierProperties(read.release, 'schema:Book')).not.toContain('schema:isbn');
  expect(identifierFields(read)).toEqual([
    'schema:inLanguage',
    'schema:isbn',
    'schema:sameAs',
    'schema:url',
    'wdt:P648',
  ]);
  expect(identifierFields(read)).not.toContain('schema:numberOfPages');
  expect(factChanged(stageFact(read, 'schema:isbn', identifiersStatement)!)).toBe(false);
  expect(draft.statement.references).toEqual(draft.baseline!.references);
  expect(draft.statement.qualifiers).toEqual(draft.baseline!.qualifiers);
  expect(validateStatement(draft.statement, read.release)).toEqual([]);
  const html = renderToStaticMarkup(
    createElement(SubjectFacts, {
      initial: read,
      locale: 'en',
      transport: fixture.transport,
      review: fixture.review,
      profile: {
        properties: identifierFields,
        title: 'Identifier evidence',
        intro: 'Cited facts',
        empty: 'No fields',
        path: 'identifiers',
      },
    }),
  );
  expect(html).toContain('ISBN-13');
  expect(html).toContain('A%2Fb&amp;lang=ja#original');
  expect(html).toContain('lang="ja"');
  expect(html).not.toContain('aria-label="number of pages"');
  const results: FactDraft[] = [];
  await sendFacts(sealed, fixture.transport.propose, (_, result) => results.push({ ...sealed[0]!, result }));
  expect(results[0]?.result).toMatchObject({
    ok: true,
    kind: 'proposed-awaiting-review',
    candidate: identifiersCandidate,
  });
  expect(fixture.publicRead.subject.statements['schema:isbn']![0]!.id).toBe(identifiersStatement);
  expect(fixture.candidates[0]?.source).toBeNull();
  const post = fixture.calls.find((call) => call.method === 'POST')!;
  expect(post.path).toBe(`/v1/subjects/${identifiersSubject}/candidates`);
  expect(post.body).toEqual({ statement: draft.statement });
  expect(post.key).toBe(sealed[0]!.command!.key);
  expect(post.body).not.toHaveProperty('source');
  expect(post.body).not.toHaveProperty('external_claim');
  expect(fixture.calls.filter((call) => call.path === '/v1/subjects')).toHaveLength(0);

  const review = fixture.review('schema:isbn', 'identifier-session');
  const competition = await review.read('schema:isbn');
  expect(competition.ok && competition.page?.candidates[0]?.id).toBe(identifiersCandidate);
  expect(
    competition.ok && competition.page?.candidates.some((candidate) => candidate.id === identifiersCompetingCandidate),
  ).toBe(true);
  expect(fixture.calls.at(-1)?.query).toContain(`context=${candidateContext}`);
  expect(fixture.calls.at(-1)?.session).toBe('identifier-session');
  const command = {
    id: identifiersSubject,
    property: 'schema:isbn',
    candidate: identifiersCandidate,
    operation: 'accept' as const,
    head: null,
    key: crypto.randomUUID(),
  };
  expect(await review.confirm(command)).toMatchObject({ ok: true, kind: 'accepted' });
  expect(fixture.publicRead.subject.statements['schema:isbn']![0]!.id).toBe(identifiersStatement);
  const selected = await review.confirm({
    ...command,
    operation: 'adopt',
    head: 1,
    key: crypto.randomUUID(),
    selection: [{ candidate: identifiersCandidate, rank: 'preferred' }],
  });
  expect(selected).toMatchObject({ ok: true, kind: 'selected' });
  expect(selected.ok && selected.public?.subject.statements['schema:isbn']![0]).toMatchObject({
    id: identifiersCandidate,
    rank: 'preferred',
    value: { type: 'value', content: correctedIsbn },
    qualifiers: draft.statement.qualifiers,
    references: draft.statement.references,
  });
  expect(selected.ok && selected.public?.subject.statements['schema:isbn']?.length).toBe(1);
  expect(fixture.calls.find((call) => call.path.endsWith(':adopt'))?.body).toEqual({
    context: candidateContext,
    property: 'schema:isbn',
    mode: 'replace',
    selection: [{ candidate: identifiersCandidate, rank: 'preferred' }],
    expected_head: 1,
  });
  expect(fixture.calls.at(-1)?.path).toBe(`/v1/subjects/${identifiersSubject}`);
});

test('invalid patterns, independent denial and uncertain delivery preserve raw drafts and exact keys', async () => {
  const fixture = identifiersProfileFixture('partial');
  const { read, draft } = await isbnDraft(fixture);
  const invalid = structuredClone(draft);
  invalid.statement.value = { type: 'value', content: 'OL123M' };
  const invalidSet = sealFacts(identifiersSubject, read.release, [invalid]);
  expect(invalidSet[0]?.result).toMatchObject({ ok: false, reason: 'invalid' });
  expect(invalidSet[0]?.command).toBeUndefined();
  const url = stageFact(read, 'schema:url', null)!;
  url.statement.value = { type: 'value', content: identifiersCitation };
  const sealed = sealFacts(identifiersSubject, read.release, [draft, url]);
  await sendFacts(sealed, fixture.transport.propose, (property, result) => {
    sealed.find((entry) => entry.property === property)!.result = result;
  });
  expect(sealed[0]?.result).toMatchObject({ ok: true });
  expect(sealed[1]?.result).toEqual({ ok: false, reason: 'denied' });
  expect(sealed[1]?.statement.value).toEqual({ type: 'value', content: identifiersCitation });
  const successes = fixture.calls.filter(
    (call) =>
      call.method === 'POST' &&
      (call.body as { statement?: { property: { id: string } } })?.statement?.property.id === 'schema:isbn',
  ).length;
  await sendFacts(sealed, fixture.transport.propose, () => {});
  expect(
    fixture.calls.filter(
      (call) =>
        call.method === 'POST' &&
        (call.body as { statement?: { property: { id: string } } })?.statement?.property.id === 'schema:isbn',
    ),
  ).toHaveLength(successes);
  const lost = identifiersProfileFixture('uncertain');
  const uncertain = (await isbnDraft(lost)).sealed;
  await sendFacts(uncertain, lost.transport.propose, (_, result) => {
    uncertain[0]!.result = result;
  });
  expect(uncertain[0]?.result).toEqual({ ok: false, reason: 'uncertain' });
  expect(factLocked(uncertain[0]!)).toBe(true);
  const retry = sealFacts(identifiersSubject, lost.release, uncertain);
  expect(retry[0]?.command).toEqual(uncertain[0]?.command);
  await sendFacts(retry, lost.transport.propose, (_, result) => {
    retry[0]!.result = result;
  });
  expect(retry[0]?.result).toMatchObject({ ok: true, candidate: identifiersCandidate });
  expect(lost.candidates).toHaveLength(1);
  const writes = lost.calls.filter((call) => call.method === 'POST');
  expect(writes[0]?.body).toEqual(writes[1]?.body);
  expect(writes[0]?.key).toBe(writes[1]?.key);
});

test('exact candidate continuation and current reader readiness never become inferred publication', async () => {
  for (const scenario of ['continued', 'pending', 'reader-unavailable'] as const) {
    const fixture = identifiersProfileFixture(scenario);
    const { sealed } = await isbnDraft(fixture);
    await sendFacts(sealed, fixture.transport.propose, () => {});
    const review = fixture.review('schema:isbn', 'identifier-session');
    let page = await review.read('schema:isbn');
    if (scenario === 'continued') {
      expect(page.ok && page.page?.candidates).toEqual([]);
      expect(page.ok && page.page?.next).toBe('exact-native-page');
      page = await review.read('schema:isbn', page.ok ? (page.page?.next ?? undefined) : undefined);
    }
    expect(page.ok && page.page?.candidates.find((candidate) => candidate.id === identifiersCandidate)?.id).toBe(
      identifiersCandidate,
    );
    const command = {
      id: identifiersSubject,
      property: 'schema:isbn',
      candidate: identifiersCandidate,
      operation: 'accept' as const,
      head: null,
      key: crypto.randomUUID(),
    };
    expect(await review.confirm(command)).toMatchObject({ ok: true, kind: 'accepted' });
    const result = await review.confirm({ ...command, operation: 'adopt', head: 1, key: crypto.randomUUID() });
    expect(result).toMatchObject({ ok: true, kind: scenario === 'continued' ? 'selected' : 'pending' });
    if (scenario === 'reader-unavailable') expect(result.ok && result.public).toBeNull();
    if (scenario === 'pending')
      expect(fixture.publicRead.subject.statements['schema:isbn']![0]?.id).toBe(identifiersStatement);
    expect(fixture.calls.every((call) => !call.path.includes('/claims') && !call.path.includes('/imports'))).toBe(true);
  }
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['unavailable', 'unavailable'],
    ['stale', 'unavailable'],
  ] as const) {
    expect(await identifiersProfileFixture(scenario).transport.read()).toEqual({ ok: false, reason });
  }
});
