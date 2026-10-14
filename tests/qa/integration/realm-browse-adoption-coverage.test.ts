import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Position = { dataEpoch: string; sequence: string };
type Page = { items: { id: string; primaryCredits: { role: string; participantKind: string; agent: string | null }[] }[];
  matches: { value: number; kind: string }; window: { complete: boolean }; nextCursor: string | null;
  sourcePosition: Position };
let sessions: PersonaSessions;
let work: Work;
let selection: { work: string; contribution: string; publicationDecision: string; expectedSelectionHead: null };
const roleId = randomUUID();
const title = `Adoptioncoverage${randomUUID().replaceAll('-', '')} published but not adopted`;
const evidence: unknown[] = [];
const save = () => Bun.write(`.temp/realm-browse-adoption-coverage-${Bun.env.REZICS_QA_RUN_ID}.json`,
  JSON.stringify({ inventory: work ? [work.work] : [], evidence }, null, 2));
const short = (iri: string) => iri.slice(-36);

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
async function role(change: object) {
  const owner = sessions.owner;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const current = await answer<{ generation: string }>(owner.main('GET',
    `${root}/roles?actingSubject=${encodeURIComponent(owner.actingSubject!)}`));
  const command = { actingSubject: owner.actingSubject, expectedGeneration: current.generation,
    reason: 'Exercise explicit publication adoption authority for an original Work', change };
  const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
  await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
}

beforeAll(async () => {
  const started = Date.now();
  try {
    sessions = await personaSessions('public', { observeMain: async event => {
      evidence.push({ phase: 'command', ...event, caller: event.caller.accountId });
    } });
    const owner = sessions.owner;
    work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/VideoGame'],
      authoring: 'own-work', actingSubject: owner.actingSubject,
    }), 201);
    const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'Original synthetic game: plant lights and visit their garden.', actingSubject: owner.actingSubject,
    }), 201);
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject,
    }), 201);
    selection = { work: work.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null };
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection,
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
    }), 201);
    await role({ kind: 'role', roleId, name: 'Original Work catalogue editors', permissions: ['publication.adopt'] });
  } finally {
    evidence.push({ phase: 'preparation-end', elapsedMs: Date.now() - started });
    await save();
  }
  expect(Date.now() - started).toBeLessThan(600_000);
}, 180_000);
afterAll(async () => { try { await save(); } finally { await sessions?.close(); } });

test('explicit adoption is covered truthfully by both public Realm browse adapters', async () => {
  const moderator = sessions.moderator;
  const command = { ...selection, profile: 'realm-local-selection-v1',
    context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
    selectionBasis: 'realm-manager-review', actingSubject: moderator.actingSubject };
  // Joined moderation supplies no publication.adopt mandate.
  await answer(moderator.main('POST', '/v1/publication-selections', command), 403);
  await role({ kind: 'assignment', roleId, member: moderator.actingSubject, assigned: true,
    validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  const adopted = await answer<{ work: string; realm: string; sourcePosition: Position }>(
    moderator.main('POST', '/v1/publication-selections', command), 201);
  expect(adopted.work).toBe(work.work);
  expect(adopted.realm).toBe(sessions.realm);
  await save();
  const filter = { all: [{ facet: 'type', any: ['https://schema.org/VideoGame'] }] };
  const browse = `/v1/realms/${short(sessions.realm)}/modules/browse?${new URLSearchParams({
    q: title, type: 'https://schema.org/VideoGame', language: 'en', limit: '20',
  })}`;
  for (const request of [
    { method: 'GET', path: browse, body: undefined },
    { method: 'POST', path: '/v1/query', body: { profile: 'filter-document-v2', context: { realm: sessions.realm },
      scope: { kind: 'realm', realm: sessions.realm }, filter, text: { phrase: title }, sort: 'relevance', page: { size: 20 } } },
  ]) {
    const started = Date.now();
    // Each adapter gets one actual anonymous request. No helper retries or
    // projection/readiness probes precede or follow its answer.
    const response = await fetch(`http://127.0.0.1:${Bun.env.MAIN_PORT}${request.path}`, {
      method: request.method, signal: AbortSignal.timeout(30_000),
      ...(request.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) } : {}),
    });
    const raw = await response.text();
    evidence.push({ phase: 'read', request, status: response.status, answer: raw,
      elapsedMs: Date.now() - started, adoptionPosition: adopted.sourcePosition });
    await save();
    if (response.status === 503) {
      const problem = JSON.parse(raw) as Record<string, unknown>;
      expect(problem.code).toBe('work_read_unavailable');
      for (const field of ['items', 'matches', 'window', 'nextCursor', 'result']) expect(problem).not.toHaveProperty(field);
      continue;
    }
    expect(response.status, raw).toBe(200);
    const parsed = JSON.parse(raw) as Page & { result?: Page };
    const page = request.method === 'POST' ? parsed.result! : parsed;
    expect(page.sourcePosition.dataEpoch).toBe(adopted.sourcePosition.dataEpoch);
    expect(BigInt(page.sourcePosition.sequence)).toBeGreaterThanOrEqual(BigInt(adopted.sourcePosition.sequence));
    if (!page.window.complete) {
      expect(page.matches).toEqual({ value: page.items.length, kind: 'lower-bound' });
      expect(page.items.every(item => item.id === work.work)).toBe(true);
      expect(page.nextCursor).toBeNull();
      continue;
    }
    expect(page.window.complete).toBe(true);
    expect(page.matches).toEqual({ value: 1, kind: 'exact' });
    expect(page.items.map(item => item.id)).toEqual([work.work]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]!.primaryCredits).toContainEqual(expect.objectContaining({ role: 'author',
      participantKind: 'agent', agent: sessions.owner.actingSubject }));
  }
}, 60_000);
