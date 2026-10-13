import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import catalogue from '../../../../../scripts/qa/cases/outcomes/books/catalogue-browse-and-search-in-its-zone.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Page<T> = { items: T[]; nextCursor: string | null; matches: { value: number; kind: string } };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const works: Work[] = [];
const phrase = `Bookgarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Setup exceptions stay in beforeAll: a failed fixture is never an expected product failure.
beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner,
    actor = owner.actingSubject;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Catalogue editors', permissions: ['publication.adopt'] },
    {
      kind: 'assignment',
      roleId,
      member: actor,
      assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ]) {
    const roles = await answer<{ generation: string }>(
      owner.main('GET', `${root}/roles?${acting(owner)}`),
    );
    const command = {
      actingSubject: actor,
      expectedGeneration: roles.generation,
      reason: 'Publish the original Book fixture catalogue',
      change,
    };
    const preview = await answer<{ digest: string }>(
      owner.main('POST', `${root}/role-impact`, command),
    );
    await answer(
      owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }),
      201,
    );
  }
  for (let index = 0; index < 21; index++) {
    const work = await answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title: `${phrase} ${index}`,
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        authoring: 'own-work',
        actingSubject: actor,
      }),
      201,
    );
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `An original fixture story: gardener ${index} plants a seed and watches it grow.`,
        actingSubject: actor,
      }),
      201,
    );
    const publication = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: actor,
      }),
      201,
    );
    const selection = {
      work: work.work,
      contribution: draft.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      actingSubject: actor,
    };
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        ...selection,
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        selectionBasis: 'main-maintainer',
      }),
      201,
    );
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        ...selection,
        profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm },
        mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }),
      201,
    );
    works.push(work);
  }
}, 180_000);
afterAll(async () => {
  await sessions?.close();
});

async function browse(name: PersonaName) {
  const person = sessions[name];
  const root = `/v1/realms/${short(sessions.realm)}/modules`;
  const refused = await answer<{ code: string }>(
    person.main('GET', `${root}/browse?sort=relevance&limit=10&type=https%3A%2F%2Fschema.org%2FBook`),
    400,
  );
  expect(refused.code).toBe('unsupported_query_shape');
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'relevance' ? [phrase] : ['', phrase]) {
      const params = new URLSearchParams({
        sort,
        limit: '10',
        type: 'https://schema.org/Book',
        ...(q ? { q } : {}),
      });
      const seen: string[] = [];
      let page: Page<{ id: string }>;
      do {
        page = await answer<Page<{ id: string }>>(person.main('GET', `${root}/browse?${params}`));
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen.length).toBe(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual(works.map((work) => work.work).sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
    }
  }
  const first = await answer<Page<{ id: string }>>(
    person.main('GET', `${root}/new-adoptions?limit=20`),
  );
  expect(first.nextCursor).not.toBeNull();
  const second = await answer<Page<{ id: string }>>(
    person.main(
      'GET',
      `${root}/new-adoptions?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ),
  );
  expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
    works.map((work) => work.work).sort(),
  );
  expect(second.nextCursor).toBeNull();
}

outcomeTest(catalogue, 'visitor', () => browse('visitor'));
outcomeTest(catalogue, 'stranger', () => browse('stranger'));
outcomeTest(catalogue, 'member', () => browse('member'));
outcomeTest(catalogue, 'owner', () => browse('owner'));
outcomeTest(catalogue, 'moderator', () => browse('moderator'));
outcomeTest(catalogue, 'operator', () => browse('operator'));
