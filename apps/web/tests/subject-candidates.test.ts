import { expect, test } from 'bun:test';
import { editCandidateDraft, refreshCandidateDraft } from '../src/subject/candidate-draft';
import { candidateFixture, candidateProperty } from '../src/kernel/fake/subject-candidates';
import {
  candidateContext,
  candidateIsPublic,
  candidateViewerActionsFor,
  nativeOperationAvailability,
  publicCandidateSelection,
  readCandidates,
  readCandidateAuthority,
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

test('candidate action hydration keeps exact resources and separates denial from unavailable', async () => {
  const allowedFixture = candidateFixture();
  const allowed = await readCandidateAuthority(allowedFixture.client, 'Bearer reviewer', candidateContext, [
    allowedFixture.id,
  ]);
  const allowedActions = candidateViewerActionsFor(allowed, allowedFixture.id);
  expect(allowedFixture.calls[0]?.body).toEqual({
    resources: [
      { type: 'semantic.context', id: candidateContext },
      { type: 'semantic.subject', id: allowedFixture.id },
    ],
  });
  expect(nativeOperationAvailability(allowedActions.context, 'context:accept', 'subject.accept_candidate')).toBe(
    'allowed',
  );
  expect(nativeOperationAvailability(allowedActions.context, 'context:adopt', 'subject.adopt')).toBe('allowed');

  const deniedFixture = candidateFixture('actions-denied');
  const denied = await readCandidateAuthority(deniedFixture.client, 'Bearer reviewer', candidateContext, [
    deniedFixture.id,
  ]);
  const deniedActions = candidateViewerActionsFor(denied, deniedFixture.id).context;
  expect(deniedActions.state).toBe('available');
  expect(nativeOperationAvailability(deniedActions, 'context:adopt', 'subject.adopt')).toBe('denied');

  const unavailableFixture = candidateFixture('actions-unavailable');
  const unavailable = await readCandidateAuthority(
    unavailableFixture.client,
    'Bearer reviewer',
    candidateContext,
    [unavailableFixture.id],
  );
  const unavailableActions = candidateViewerActionsFor(unavailable, unavailableFixture.id).context;
  expect(unavailableActions).toEqual({ state: 'unavailable', reason: 'unavailable' });
  expect(nativeOperationAvailability(unavailableActions, 'context:adopt', 'subject.adopt')).toBe(
    'unavailable',
  );

  const concealedFixture = candidateFixture('concealed');
  const concealed = await readCandidateAuthority(
    concealedFixture.client,
    'Bearer reviewer',
    candidateContext,
    [concealedFixture.id],
  );
  expect(concealed.disclosure).toBe('unreadable');
  expect(candidateViewerActionsFor(concealed, concealedFixture.id).subject).toEqual({
    state: 'unavailable',
    reason: 'not-found',
  });
});

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

test('a reviewer rejects a candidate without deleting its assertion or inventing public selection', async () => {
  const fixture = candidateFixture();
  const rejected = await selectCandidate(fixture.client, 'Bearer reviewer', {
    ...command(fixture, 'accept', null),
    operation: 'reject',
  });
  expect(rejected.ok && rejected.kind).toBe('rejected');
  const comparison = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, candidateProperty);
  if (!comparison.ok || !comparison.page) throw new Error('Expected retained assertion');
  expect(comparison.page.candidates[0]).toMatchObject({
    id: fixture.candidate.id,
    decision: 'rejected',
    head: 1,
    retracted: null,
  });
  expect(candidateIsPublic(comparison.public, candidateProperty, fixture.candidate.id)).toBe(false);
  expect(fixture.calls.filter((call) => call.method === 'POST')).toMatchObject([
    {
      path: `/v1/subjects/${fixture.id}/candidates/${fixture.candidate.id}:reject`,
      body: { context: candidateContext, expected_head: null },
    },
  ]);
  expect(fixture.calls[1]).toMatchObject({ authorization: null, session: 'candidate-session' });
});

test('a reviewer explicitly selects valid values and ranks through existing APIs and observes the actual public reading across candidate pages', async () => {
  const fixture = candidateFixture('multiple');
  const first = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, fixture.property);
  if (!first.ok || !first.page?.next) throw new Error('Expected continued comparison');
  let draft = refreshCandidateDraft(undefined, publicCandidateSelection(first.public, fixture.property));
  expect(draft.selection).toHaveLength(2);
  // The second current value is absent from this candidate page and must still be retained.
  expect(first.page.candidates.some((item) => item.id === draft.selection[1]!.candidate)).toBe(false);
  draft = editCandidateDraft(draft, fixture.candidate.id, 'preferred');
  const next = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, fixture.property, first.page.next);
  if (!next.ok || !next.page) throw new Error('Expected next page');
  draft = refreshCandidateDraft(draft, publicCandidateSelection(next.public, fixture.property));
  expect(draft.selection).toHaveLength(3);
  const input: CandidateCommand = {
    ...command(fixture, 'adopt', first.page.adoption!.head),
    property: fixture.property,
    selection: draft.selection,
  };
  const selected = await selectCandidate(fixture.client, 'Bearer reviewer', input);
  if (!selected.ok || !selected.public) throw new Error('Expected ordinary public result');
  expect(selected.kind).toBe('selected');
  expect(publicCandidateSelection(selected.public, fixture.property)).toEqual(draft.selection);
  expect(fixture.calls.filter((call) => call.method === 'POST')).toMatchObject([
    {
      path: `/v1/subjects/${fixture.id}:adopt`,
      body: {
        context: candidateContext,
        mode: 'replace',
        property: fixture.property,
        selection: draft.selection,
        expected_head: 1,
      },
    },
  ]);
  expect(fixture.calls.at(-1)).toMatchObject({ authorization: null, session: 'candidate-session' });
  // Native rank/cardinality limits cannot become successful selections.
  const posts = fixture.calls.filter((call) => call.method === 'POST').length;
  expect(
    await selectCandidate(fixture.client, 'Bearer reviewer', {
      ...input,
      selection: [{ candidate: fixture.candidate.id, rank: 'deprecated' as 'normal' }],
    }),
  ).toMatchObject({ ok: false, reason: 'invalid' });
  expect(
    await selectCandidate(fixture.client, 'Bearer reviewer', {
      ...input,
      selection: Array.from({ length: 33 }, () => ({ candidate: fixture.candidate.id, rank: 'normal' as const })),
    }),
  ).toMatchObject({ ok: false, reason: 'invalid' });
  expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(posts);
});

test('an opposite native adoption acknowledgment remains unavailable instead of confirming selection', async () => {
  const fixture = candidateFixture('malformed-ack');
  const initial = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, candidateProperty);
  if (!initial.ok || !initial.page) throw new Error('Expected exact imported candidate');
  const candidate = initial.page.candidates[0]!;
  const accepted = await selectCandidate(
    fixture.client,
    'Bearer reviewer',
    command(fixture, 'accept', candidate.head),
  );
  expect(accepted).toMatchObject({ ok: true, kind: 'accepted' });
  const current = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, candidateProperty);
  if (!current.ok || !current.page) throw new Error('Expected accepted candidate');

  const outcome = await selectCandidate(
    fixture.client,
    'Bearer reviewer',
    command(fixture, 'adopt', current.page.adoption!.head),
  );
  expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(fixture.calls.filter((call) => call.path.endsWith(':adopt'))).toHaveLength(1);
});

test('a reviewer preserves a stale ranked selection draft and reloads comparison before an explicit new confirmation and key', async () => {
  const fixture = candidateFixture('stale-selection');
  const read = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, fixture.property);
  if (!read.ok || !read.page) throw new Error('Expected comparison');
  let draft = refreshCandidateDraft(undefined, publicCandidateSelection(read.public, fixture.property));
  const removed = draft.selection[0]!.candidate;
  draft = editCandidateDraft(draft, removed, null);
  draft = editCandidateDraft(draft, fixture.candidate.id, 'preferred');
  const original = structuredClone(draft);
  const old: CandidateCommand = {
    ...command(fixture, 'adopt', read.page.adoption!.head),
    property: fixture.property,
    selection: draft.selection,
  };
  expect(await selectCandidate(fixture.client, 'Bearer reviewer', old)).toMatchObject({ ok: false, reason: 'stale' });
  expect(draft).toEqual(original);
  expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(candidateIsPublic(fixture.publicRead, fixture.property, fixture.candidate.id)).toBe(false);
  const fresh = await readCandidates(fixture.client, 'Bearer reviewer', fixture.id, fixture.property);
  if (!fresh.ok || !fresh.page) throw new Error('Expected fresh comparison');
  draft = refreshCandidateDraft(draft, publicCandidateSelection(fresh.public, fixture.property));
  expect(draft).toEqual(original);
  const confirmed = { ...old, head: fresh.page.adoption!.head, key: crypto.randomUUID(), selection: draft.selection };
  expect(confirmed.key).not.toBe(old.key);
  const result = await selectCandidate(fixture.client, 'Bearer reviewer', confirmed);
  if (!result.ok || !result.public) throw new Error('Expected actual public reading');
  expect(result.kind).toBe('selected');
  expect(publicCandidateSelection(result.public, fixture.property)).toEqual(original.selection);
  expect(candidateIsPublic(result.public, fixture.property, removed)).toBe(false);
});
