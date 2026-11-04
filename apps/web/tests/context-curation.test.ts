import { describe, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { contextFixture } from '../src/kernel/fake/context-curation';
import { contextOutcome, readContextCuration } from '../src/features/catalogue/context-curation';
import {
  candidateContext,
  nativeOperationAvailability,
  selectCandidate,
  type CandidateCommand,
} from '../src/subject/candidates';

function command(
  fixture: ReturnType<typeof contextFixture>,
  changes: Partial<CandidateCommand> = {},
): CandidateCommand {
  return {
    id: fixture.id,
    context: fixture.context.id,
    property: fixture.property,
    candidate: fixture.candidate.id,
    operation: 'adopt',
    head: 7,
    key: crypto.randomUUID(),
    mode: 'replace',
    selection: [{ candidate: fixture.candidate.id, rank: 'preferred' }],
    ...changes,
  };
}

describe('Context curation through the generated native request seam', () => {
  test('Review one actual community Context inheritance and selection through the declared native contract with truthful authority and failure states', async () => {
    const fixture = contextFixture();
    const before = await fixture.transport.read(fixture.property);
    expect(before.ok).toBe(true);
    if (!before.ok || !before.contextReview) throw new Error('Context comparison missing');
    expect(before.contextReview.context.labels.en).toBe('Readers’ edition');
    expect(contextOutcome(before.contextReview, fixture.property, before.page?.adoption?.mode)).toBe('inherited');
    expect(nativeOperationAvailability(before.actions?.context, 'context:accept', 'subject.accept_candidate')).toBe(
      'allowed',
    );
    expect(nativeOperationAvailability(before.actions?.context, 'context:adopt', 'subject.adopt')).toBe('allowed');
    expect(before.actions?.subject.state).toBe('available');
    const concealed = await contextFixture('concealed').transport.read('schema:inLanguage');
    expect(concealed.ok && concealed.page?.candidates).toEqual([]);
    expect(before.public.subject.context).toBe(candidateContext);
    expect(before.contextReview.reading.subject.context).toBe(fixture.context.id);
    const saved = await fixture.transport.confirm(command(fixture));
    expect(saved.ok).toBe(true);
    if (!saved.ok || !saved.contextReview) throw new Error('Current Context reading missing');
    expect(saved.kind).toBe('pending'); // Local adoption never claims public selection/publication.
    expect(saved.contextReview.selected.map((statement) => [statement.id, statement.rank])).toEqual([
      [fixture.candidate.id, 'preferred'],
    ]);
    expect(contextOutcome(saved.contextReview, fixture.property, saved.contextReview.adoption?.mode)).toBe('replaced');
    expect(
      saved.public?.subject.statements[fixture.property]?.some((statement) => statement.id === fixture.candidate.id),
    ).toBe(false);
    const native = fixture.calls.find((call) => call.path.endsWith(':adopt'))!;
    expect(native.body).toEqual({
      context: fixture.context.id,
      property: fixture.property,
      mode: 'replace',
      selection: [{ candidate: fixture.candidate.id, rank: 'preferred' }],
      expected_head: 7,
    });
    expect(native.headers.get('authorization')).toBe('Bearer fixture');
    const publicReads = fixture.calls.filter((call) => call.path === `/v1/subjects/${fixture.id}` && !call.query);
    expect(publicReads.every((call) => !call.headers.has('authorization'))).toBe(true);
    expect(
      fixture.calls.some(
        (call) =>
          call.query.includes(`context=${fixture.context.id}`) &&
          call.headers.get('rezics-session-token') === 'context-session',
      ),
    ).toBe(true);
  });

  test('native suppressed and genuinely unresolved readings stay distinct; non-replace and Global modes validate before transport', async () => {
    for (const state of ['suppressed', 'unresolved'] as const) {
      const fixture = contextFixture(state);
      const read = await fixture.transport.read(fixture.property);
      if (!read.ok || !read.contextReview) throw new Error('Context comparison missing');
      expect(contextOutcome(read.contextReview, fixture.property, read.page?.adoption?.mode)).toBe(state);
      expect(read.contextReview.selected).toEqual([]);
    }
    const fixture = contextFixture();
    for (const mode of ['inherit', 'suppress'] as const) {
      expect(await selectCandidate(fixture.client, 'Bearer fixture', command(fixture, { mode }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(
        await selectCandidate(
          fixture.client,
          'Bearer fixture',
          command(fixture, { context: candidateContext, mode, selection: [] }),
        ),
      ).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(fixture.calls).toHaveLength(0);
    const saved = await fixture.transport.confirm(command(fixture, { mode: 'suppress', selection: [] }));
    expect(saved.ok && saved.contextReview?.reading.subject.resolution[fixture.property]).toBe('suppressed');
  });

  test('decision and adoption heads and current denials are independent', async () => {
    const fixture = contextFixture('adopt-denied');
    const decision = await fixture.transport.confirm(
      command(fixture, { operation: 'reject', head: 4, selection: undefined }),
    );
    expect(decision.ok && decision.kind).toBe('rejected');
    const adoption = await fixture.transport.confirm(command(fixture));
    expect(adoption).toEqual({ ok: false, reason: 'denied' });
    expect(
      fixture.calls
        .filter((call) => call.method === 'POST' && /:(?:accept|reject|adopt)$/.test(call.path))
        .map((call) => call.body?.expected_head),
    ).toEqual([4, 7]);
    expect(
      fixture.calls.filter((call) => call.method === 'POST').every((call) => call.body?.context === fixture.context.id),
    ).toBe(true);
  });

  test('409 reload supplies the actual new slot head; an uncertain retry preserves payload and key', async () => {
    const fixture = contextFixture('conflict');
    const draft = command(fixture);
    expect(await fixture.transport.confirm(draft)).toEqual({ ok: false, reason: 'stale' });
    const fresh = await fixture.transport.read(fixture.property);
    if (!fresh.ok) throw new Error('Reload failed');
    expect(fresh.page?.adoption?.head).toBe(8);
    expect((await fixture.transport.confirm({ ...draft, head: 8, key: crypto.randomUUID() })).ok).toBe(true);
    const uncertain = contextFixture('uncertain');
    const retry = command(uncertain);
    expect(await uncertain.transport.confirm(retry)).toEqual({ ok: false, reason: 'unavailable' });
    expect((await uncertain.transport.confirm(retry)).ok).toBe(true);
    const posts = uncertain.calls.filter((call) => call.method === 'POST');
    expect(posts[0]!.body).toEqual(posts[1]!.body);
    expect(posts[0]!.headers.get('idempotency-key')).toBe(posts[1]!.headers.get('idempotency-key'));
  });

  test('exact relation addressing and missing/hidden/unserved ports never become empty success', async () => {
    const fixture = contextFixture();
    for (const status of [404, 503]) {
      const calls: URL[] = [];
      const client = createKernelClient('https://unserved.test', {
        fetch: (async (input) => {
          calls.push(new URL(String(input)));
          return new Response(JSON.stringify({ code: status === 404 ? 'not_found' : 'overloaded' }), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      });
      const slot = { target: fixture.id, key: fixture.context.id };
      expect(
        await readContextCuration(
          client,
          'Bearer fixture',
          { ...fixture.address, property: 'wdt:P725', slot },
          fixture.release,
          'en',
        ),
      ).toEqual({ ok: false, reason: 'unavailable' });
      const query = calls.find((url) => url.pathname.endsWith('/candidates'))!.searchParams;
      expect(query.get('target')).toBe(slot.target);
      expect(query.get('key')).toBe(slot.key);
      expect(query.get('context')).toBe(fixture.context.id);
      expect(query.get('property')).toBe('wdt:P725');
    }
  });
});
