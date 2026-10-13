import { afterAll, beforeAll, expect, test, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../scripts/load/launch-corpus.ts';
import { personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
type Work = { work: string; mainVersion: string };
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function grant(person: PersonaSession, scope: string, action: string) {
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1 AND active', [person.accountId]);
    expect(principal.rows).toHaveLength(1);
    await grantLaunchRecipeAuthority(pool, principal.rows[0]!.id, person.actingSubject!, scope, action);
  } finally { await pool.end(); }
}
async function publish(title: string): Promise<Work & { contribution: string; publicationDecision: string }> {
  const owner = sessions.owner;
  const work = await answer<Work>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body: `Original fixture animation script by Outcome owner: ${title}.`,
      actingSubject: owner.actingSubject }), 201);
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return { ...work, contribution: draft.contribution, publicationDecision: publication.publicationDecision };
}
const originalFetch = globalThis.fetch;
afterAll(async () => { globalThis.fetch = originalFetch; await sessions?.close(); });

import { acceptClassifiedStatement, discloseClassificationConcept, shareClassificationContext,
  type ClassificationPost } from '../../../scripts/dev/seed/classified-statement.ts';
type Page = { items: { id: string; primaryCredits: { role: string; agent: string | null }[] }[]; nextCursor: string | null;
  matches: { value: number; kind: string }; query: { appliedSort: string } };
const works: Work[] = [], tvWorks: Work[] = [];
const phrase = `Realmavailability${randomUUID().replaceAll('-', '')}`;
const adoptionOrder = new Map<string, bigint>();
let tv: string;
const evidence: unknown[] = [];
const preparationAnswers: unknown[] = [];
let evidenceWrites = Promise.resolve();
function saveEvidence() {
  const serialized = JSON.stringify(evidence, null, 2);
  evidenceWrites = evidenceWrites.then(async () => {
    await Bun.write(`.temp/realm-browse-availability-${Bun.env.REZICS_QA_RUN_ID}.json`, serialized);
  });
  return evidenceWrites;
}
beforeAll(async () => {
  const started = Date.now();
  try {
  sessions = await personaSessions();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name], main = person.main;
    person.main = async (method, path, body, key, options) => {
      key ??= ['GET', 'HEAD'].includes(method) ? undefined : randomUUID();
      const response = await main(method, path, body, key, options);
      if (!['GET', 'HEAD'].includes(method) || response.status >= 400) preparationAnswers.push({
        persona: name, request: { method, path, body, key }, status: response.status,
        answer: await response.clone().text(),
      });
      return response;
    };
  }
  const owner = sessions.owner, actor = owner.actingSubject!;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Original animation publishers', permissions: ['publication.adopt'] },
    { kind: 'assignment', roleId, member: actor, assigned: true, validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = { actingSubject: actor, expectedGeneration: roles.generation,
      reason: 'Publish the original animation fixture catalogue', change };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (const [scope, action] of [
    ['classification:define:global', 'classification.proposition.define'],
    ['classification:decide:global', 'statement.decide'],
    ['context:create:root', 'context.create'],
    [`statement:speak:${actor}`, 'statement.record'],
    ['semantic:create:root', 'semantic.change'],
  ]) await grant(owner, scope!, action!);
  const post: ClassificationPost = async <T,>(path: string, body: unknown, _token: string, key: string) => {
    const response = await owner.main('POST', path, body, key);
    expect([200, 201]).toContain(response.status);
    return answer<T>(Promise.resolve(response), response.status);
  };
  const terms = [];
  for (const name of ['Fixture TV animation', 'Fixture film animation']) {
    terms.push(await post<{ concept: string; definitionRevision: string }>('/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: name }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
    }, '', randomUUID()));
  }
  tv = terms[0]!.concept; const movie = terms[1]!.concept;
  const context = await shareClassificationContext(post, '', actor, terms, randomUUID());
  for (const term of terms) await discloseClassificationConcept(post, '', actor, term.concept, randomUUID());

  const prepare = async (index: number) => {
    const work = await publish(`${phrase} original animation ${index}`);
    const adoption = await answer<{ sourcePosition: { sequence: string } }>(owner.main('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: sessions.realm },
      work: work.work, mainVersion: work.mainVersion, contribution: work.contribution,
      publicationDecision: work.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: actor,
    }), 201);
    adoptionOrder.set(work.work, BigInt(adoption.sourcePosition.sequence));
    works[index] = work;
    if (index < 12) {
      await acceptClassifiedStatement(post, '', actor, work, index < 11 ? tv : movie, context,
        { kind: 'global' }, { state: 'none', source: 'global', decision: null },
        { statement: randomUUID(), decision: randomUUID() });
      if (index < 11) tvWorks.push(work);
    }
  };
  for (let index = 0; index < 12; index++) await prepare(index);
  for (let first = 12; first < 65; first += 4) {
    await Promise.all(Array.from({ length: Math.min(4, 65 - first) }, (_, offset) => prepare(first + offset)));
  }
  evidence.push({ preparationMs: Date.now() - started, inventory: works.map(work => work.work),
    conditionInventory: tvWorks.map(work => work.work) });
  await saveEvidence();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let bearerExpiresAt: number | null = null;
    const bearer = requestHeaders.get('authorization')?.replace(/^Bearer /, '');
    if (bearer) {
      try {
        const payload = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()) as { exp?: number };
        if (typeof payload.exp === 'number') bearerExpiresAt = payload.exp * 1000;
      } catch { /* The actual HTTP verifier remains the authority. */ }
    }
    const response = await originalFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const persona = requestHeaders.get('x-qa-realm-browse-persona');
    if (persona && url.origin === `http://127.0.0.1:${Bun.env.MAIN_PORT}`
      && url.pathname === `/v1/realms/${short(sessions.realm)}/modules/browse`) {
      evidence.push({ persona, request: `GET ${url.pathname}${url.search}`, status: response.status,
        observedAt: Date.now(), bearerExpiresAt,
        answer: await response.clone().text() });
      await saveEvidence();
    }
    return response;
  }, { preconnect: originalFetch.preconnect });
  expect(Date.now() - started).toBeLessThan(600_000);
  } finally {
    await Bun.write(`.temp/realm-browse-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ preparationMs: Date.now() - started, preparationAnswers }, null, 2));
  }
}, 360_000);

for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test.concurrent(`Realm Condition browse admits the complete Anime inventory for ${name}`, async () => {
    const person = sessions[name];
    // Inventory comes from successful command receipts, independently of browse.
    const traverse = async (condition: string | null, expected: Work[]) => {
      const params = new URLSearchParams({ sort: 'newest', limit: '5', ...(condition ? { concept: condition } : {}) });
      const seen: string[] = [], cursors = new Set<string>();
      do {
        const path = `/v1/realms/${short(sessions.realm)}/modules/browse?${params}`;
        const response = await person.main('GET', path, undefined, undefined,
          { headers: { 'x-qa-realm-browse-persona': name } });
        const page = await answer<Page>(Promise.resolve(response));
        expect(page.items.length).toBeLessThanOrEqual(5);
        expect(page.items.every(item => item.primaryCredits.some(credit => credit.role === 'author'
          && credit.agent === sessions.owner.actingSubject))).toBe(true);
        expect(page.query.appliedSort).toBe('newest');
        seen.push(...page.items.map(item => item.id));
        expect(page.matches.value).toBe(seen.length);
        if (!page.nextCursor) { expect(page.matches.kind).toBe('exact'); break; }
        expect(cursors.has(page.nextCursor)).toBe(false);
        cursors.add(page.nextCursor);
        params.set('cursor', page.nextCursor);
      } while (true);
      expect(new Set(seen).size).toBe(expected.length);
      expect(seen.slice().sort()).toEqual(expected.map(work => work.work).sort());
      expect(seen).toEqual(expected.map(work => work.work).sort((a, b) =>
        adoptionOrder.get(a)! > adoptionOrder.get(b)! ? -1 : adoptionOrder.get(a)! < adoptionOrder.get(b)! ? 1
          : b.localeCompare(a)));
    };
    const traversals = await Promise.allSettled([traverse(tv, tvWorks), traverse(null, works)]);
    for (const traversal of traversals) if (traversal.status === 'rejected') throw traversal.reason;
  });
}
