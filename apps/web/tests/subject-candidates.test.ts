import { expect, test } from 'bun:test';
import { candidateFixture, candidateProperty } from '../src/kernel/fake/subject-candidates';
import {
  candidateContext,
  candidateIsPublic,
  readCandidates,
  selectCandidate,
  type CandidateCommand,
} from '../src/subject/candidates';

function command(
  fixture: ReturnType<typeof candidateFixture>,
  operation: 'accept' | 'adopt',
  head: number | null,
): CandidateCommand {
  return {
    id: fixture.id,
    property: candidateProperty,
    candidate: fixture.candidate.id,
    operation,
    head,
    key: crypto.randomUUID(),
  };
}

test('an authorized person reviews an actual imported subject candidate accepts or adopts through the existing native APIs and sees the selected public subject result with honest conflict denial and pending outcomes', async () => {
  const fixture = candidateFixture();
  const read = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, candidateProperty);
  expect(read.ok).toBe(true);
  if (!read.ok || !read.page) throw new Error('Expected candidate page');
  expect(read.page.candidates[0]?.source).toMatchObject({ source: 'wikidata', external_id: 'Q25338' });
  expect(read.page.candidates[0]?.statement.value).not.toEqual(
    read.public.subject.statements[candidateProperty]?.[0]?.value,
  );
  expect(fixture.calls[0]?.authorization).toBeNull();
  expect(fixture.calls[1]?.authorization).toBe('Bearer reviewer');

  const accept = command(fixture, 'accept', read.page.candidates[0]!.head);
  const accepted = await selectCandidate(fixture.client, 'Bearer reviewer', accept);
  expect(accepted.ok && accepted.kind).toBe('accepted');
  expect(candidateIsPublic(fixture.publicRead, candidateProperty, fixture.candidate.id)).toBe(false);
  const next = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, candidateProperty);
  if (!next.ok || !next.page) throw new Error('Expected accepted candidate');
  expect(next.page.candidates[0]?.decision).toBe('accepted');
  const adopt = command(fixture, 'adopt', next.page.adoption!.head);
  const selected = await selectCandidate(fixture.client, 'Bearer reviewer', adopt);
  expect(selected.ok && selected.kind).toBe('selected');
  if (!selected.ok || !selected.public) throw new Error('Expected current public read');
  expect(candidateIsPublic(selected.public, candidateProperty, fixture.candidate.id)).toBe(true);
  expect(
    fixture.calls.filter((call) => call.method === 'POST').map(({ path, key, body }) => ({ path, key, body })),
  ).toEqual([
    {
      path: `/v1/subjects/${fixture.id}/candidates/${fixture.candidate.id}:accept`,
      key: accept.key,
      body: { context: candidateContext, expected_head: null },
    },
    {
      path: `/v1/subjects/${fixture.id}:adopt`,
      key: adopt.key,
      body: {
        context: candidateContext,
        property: candidateProperty,
        mode: 'replace',
        selection: [{ candidate: fixture.candidate.id, rank: 'normal' }],
        expected_head: 1,
      },
    },
  ]);
  expect(fixture.calls.at(-1)).toMatchObject({
    method: 'GET',
    path: `/v1/subjects/${fixture.id}`,
    authorization: null,
    session: 'candidate-session',
  });
  expect(await selectCandidate(fixture.client, 'Bearer reviewer', adopt)).toMatchObject({ ok: true, kind: 'selected' });
});

test('refusal and a stale head do not publish or fall through to another native write', async () => {
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['stale', 'stale'],
  ] as const) {
    const fixture = candidateFixture(scenario);
    expect(await selectCandidate(fixture.client, 'Bearer reviewer', command(fixture, 'accept', null))).toEqual({
      ok: false,
      reason,
    });
    expect(fixture.calls.length).toBe(1);
    expect(candidateIsPublic(fixture.publicRead, candidateProperty, fixture.candidate.id)).toBe(false);
  }
});

test('a submitted selection remains pending until the public reader actually includes it', async () => {
  const fixture = candidateFixture('pending');
  await selectCandidate(fixture.client, 'Bearer reviewer', command(fixture, 'accept', null));
  const result = await selectCandidate(fixture.client, 'Bearer reviewer', command(fixture, 'adopt', 1));
  expect(result.ok && result.kind).toBe('pending');
  if (!result.ok || !result.public) throw new Error('Expected unchanged public reader');
  expect(candidateIsPublic(result.public, candidateProperty, fixture.candidate.id)).toBe(false);
  expect(fixture.calls.filter((call) => call.method === 'GET').length).toBe(2);
});
