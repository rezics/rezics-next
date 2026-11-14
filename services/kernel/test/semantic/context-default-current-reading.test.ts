import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createDeletionFixture } from './support/deletion-fixture.ts';

const f = await createDeletionFixture();
f.actions.push('moderation:hide');
beforeAll(f.setup);
afterAll(f.close);

test('persisted Context defaults agree across correction readings and rebuilt relation layers', async () => {
  const property = 'schema:author';
  async function request(
    method: string,
    path: string,
    body?: unknown,
    persona: 'owner' | 'platform' = 'owner',
  ) {
    const answer = await f.call(method, path, persona, body);
    expect([200, 201], JSON.stringify(answer.body)).toContain(answer.status);
    return answer.body;
  }
  for (const action of [
    'definitions:publish',
    'definitions:activate',
    'gate:definition_publication',
    'context:accept',
    'context:adopt',
  ])
    await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', action);
  await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'platform', 'moderation:hide');

  async function activateDefaults(mode: 'inherit' | 'suppress') {
    const active = await request('GET', '/v1/definitions/active');
    const release = structuredClone(bundledRelease) as Release;
    release.contexts = { readers: { labels: { en: 'Readers' }, defaults: { [property]: mode } } };
    const published = await request('POST', '/v1/definitions/releases', { release });
    await request('POST', `/v1/definitions/releases/${published.digest}:activate`, { expected_head: active.head });
    return published.digest as string;
  }
  const createContext = async () =>
    (await request('POST', '/v1/contexts', { labels: { en: 'Readers' }, settings: 'readers' })).context;
  const originalRelease = await activateDefaults('suppress');
  const suppressed = await createContext();
  const overridden = await createContext();
  const nextRelease = await activateDefaults('inherit');
  const inherited = await createContext();
  expect(nextRelease).not.toBe(originalRelease);
  expect((await request('GET', `/v1/contexts/${suppressed.id}`)).context).toEqual(suppressed);
  expect(suppressed).toMatchObject({ settings: { release: originalRelease }, defaults: { [property]: 'suppress' } });
  expect(inherited).toMatchObject({ settings: { release: nextRelease }, defaults: { [property]: 'inherit' } });

  const target = await f.person();
  const subject = (await request('POST', '/v1/subjects', { type: 'schema:Book', labels: { en: 'Correction' } }))
    .subject.id as string;
  const candidatePath = `/v1/subjects/${subject}/candidates`;
  const propose = async (evidence: string) => {
    const result = await request('POST', candidatePath, {
      statement: {
        ...f.snak(property, target),
        references: [{ parts: [f.snak('schema:url', evidence)] }],
      },
    });
    return result.candidate as string;
  };
  const candidates = (context: string) =>
    request('GET', `${candidatePath}?${new URLSearchParams({ property, target, context })}`);
  const accept = (candidate: string, context: string) =>
    request('POST', `${candidatePath}/${candidate}:accept`, { context, expected_head: null });
  async function select(
    context: string,
    mode: 'inherit' | 'replace' | 'suppress',
    candidate?: string,
    rank: 'normal' | 'preferred' = 'normal',
  ) {
    const page = await candidates(context);
    return request('POST', `/v1/subjects/${subject}:adopt`, {
      context,
      property,
      target,
      mode,
      expected_head: page.adoption?.head ?? null,
      selection: candidate ? [{ candidate, rank }] : [],
    });
  }
  const original = await propose('https://example.test/original');
  await accept(original, GLOBAL_CONTEXT);
  await select(GLOBAL_CONTEXT, 'replace', original);
  const revisions = new Map<string, number>();
  for (const { id } of [suppressed, inherited, overridden]) {
    await accept(original, id);
    revisions.set(id, (await f.revisions(subject)).at(-1)!.revision);
    expect((await candidates(id)).adoption).toBeNull();
  }
  async function reading(context: string, rank: 'normal' | 'preferred' | null) {
    const page = await candidates(context);
    expect(page.candidates.find((row: { id: string }) => row.id === original)).toMatchObject({
      rank,
      decision: 'accepted',
    });
    const detail = await request('GET', `/v1/subjects/${subject}/revisions/${revisions.get(context)!}`);
    expect(detail.change).toMatchObject({
      kind: 'decision',
      candidate: original,
      context,
      reading: { decision: { verdict: 'accept' }, selected: rank !== null, rank },
    });
  }
  await reading(suppressed.id, null);
  await reading(inherited.id, 'normal');
  await reading(overridden.id, null);
  await select(overridden.id, 'inherit');
  await reading(overridden.id, 'normal');
  await select(overridden.id, 'replace', original, 'preferred');
  await reading(overridden.id, 'preferred');
  await select(inherited.id, 'suppress');
  await reading(inherited.id, null);
  await select(inherited.id, 'inherit');

  const replacement = await propose('https://example.test/replacement');
  await accept(replacement, GLOBAL_CONTEXT);
  await select(GLOBAL_CONTEXT, 'replace', replacement);
  await reading(suppressed.id, null);
  await reading(inherited.id, null);
  await reading(overridden.id, 'preferred');

  // Public readers recheck defaults. Inspect the sparse layer as well, so that rechecking cannot mask a bad delta.
  async function layer(expected: { context: string; candidate: string; suppressed: boolean }[]) {
    await f.caughtUp(subject);
    await f.caughtUp(target);
    const { rows } = await f.admin.query(
      `SELECT context_id AS context, statement_id AS candidate, suppressed
         FROM semantic.outbound_link
        WHERE route=$1 AND subject_id=$2 AND property=$3 AND context_id=ANY($4::uuid[]) AND present`,
      [routeOf(subject), subject, property, [suppressed.id, inherited.id, overridden.id]],
    );
    expect(rows).toHaveLength(expected.length);
    expect(rows).toEqual(expect.arrayContaining(expected));
  }
  const local = { context: overridden.id, candidate: original, suppressed: false };
  const selectedLayer = [
    local,
    { context: suppressed.id, candidate: replacement, suppressed: true },
    { context: overridden.id, candidate: replacement, suppressed: true },
  ];
  await layer(selectedLayer);
  await request('DELETE', `${candidatePath}/${replacement}`);
  await layer([local]);
  await request('POST', `${candidatePath}/${replacement}:restoreDeleted`, {});
  await layer(selectedLayer);

  const notice = { notice: { complaint: 'Contribution review', received_at: f.clock().toISOString(), scope: '/' } };
  for (const path of [`${candidatePath}/${replacement}`, `/v1/subjects/${subject}`]) {
    await request('POST', `${path}:takedown`, notice, 'platform');
    await f.caughtUp(subject);
    await request('POST', `${path}:restore`, { reason: 'Review completed' }, 'platform');
    await layer(selectedLayer);
  }
  for (const [context, expected] of [
    [suppressed.id, []],
    [inherited.id, [replacement]],
    [overridden.id, [original]],
  ] as [string, string[]][]) {
    const query = new URLSearchParams({ property, context });
    const forward = await request('GET', `/v1/subjects/${subject}/relations?${query}`);
    expect(forward.relations.map((row: { statement: { id: string } }) => row.statement.id)).toEqual(expected);
    const inverse = await request('GET', `/v1/subjects/${target}/links?${query}`);
    expect(
      inverse.links.filter((row: { subject: string }) => row.subject === subject)
        .map((row: { statement: string }) => row.statement),
    ).toEqual(expected);
  }
  await reading(suppressed.id, null);
  await reading(inherited.id, null);
  await reading(overridden.id, 'preferred');
}, 60_000);
