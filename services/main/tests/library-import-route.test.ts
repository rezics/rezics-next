import { expect, test } from 'bun:test';
import { libraryRoutes } from '../src/routes/library.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ReaderImportBudgetExceeded } from '../src/modules/library-import/reader-import.ts';

const agent = 'https://rezics.com/id/0194f314-9280-767f-89a6-000000000099';
const iri = (suffix: string) => `https://rezics.com/id/0194f314-9280-767f-89a6-${suffix}`;

test('G428: Open Library search denies another reader before contacting the source', async () => {
  let fetched = 0;
  const app = libraryRoutes({
    account: { verify: async () => ({ issuer: 'test', subject: 'reader' }) },
    access: { canReadAsBaselineMember: async () => false },
    openLibraryFetch: (async () => { fetched++; return Response.json({ docs: [] }); }) as unknown as typeof fetch,
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request(`http://main.local/v1/me/library-import/open-library?actingSubject=${
    encodeURIComponent(agent)}&title=Frankenstein`, { headers: { authorization: 'Bearer other' } }));
  expect(response.status).toBe(403);
  expect(fetched).toBe(0);
});

test('G428: Main searches a fixed Open Library URL and keeps the answer private', async () => {
  let requested = '';
  const app = libraryRoutes({
    account: { verify: async () => ({ issuer: 'test', subject: 'reader' }) },
    access: { canReadAsBaselineMember: async () => true },
    libraryImport: { takeBudget: async () => {} },
    openLibraryFetch: (async (url: string) => { requested = url;
      return Response.json({ docs: [{ key: '/works/OL45804W', title: 'Frankenstein',
        author_name: ['Mary Shelley'] }] }); }) as typeof fetch,
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request(`http://main.local/v1/me/library-import/open-library?actingSubject=${
    encodeURIComponent(agent)}&title=Frankenstein&author=Mary%20Shelley`,
  { headers: { authorization: 'Bearer reader' } }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(requested).toStartWith('https://openlibrary.org/search.json?');
  expect(await response.json()).toEqual({ items: [{ workId: 'OL45804W', title: 'Frankenstein',
    authors: ['Mary Shelley'], coverId: null }] });
});

test('G428: exhausted reader search budget is a typed refusal before source contact', async () => {
  let fetched = 0;
  const app = libraryRoutes({
    account: { verify: async () => ({ issuer: 'test', subject: 'reader' }) },
    access: { canReadAsBaselineMember: async () => true },
    libraryImport: { takeBudget: async () => { throw new ReaderImportBudgetExceeded('search'); } },
    openLibraryFetch: (async () => { fetched++; return Response.json({ docs: [] }); }) as unknown as typeof fetch,
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request(`http://main.local/v1/me/library-import/open-library?actingSubject=${
    encodeURIComponent(agent)}&title=Frankenstein`, { headers: { authorization: 'Bearer reader' } }));
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ code: 'reader_import_search_budget' });
  expect(fetched).toBe(0);
});

test('G428: exhausted reader adoption budget refuses before acquisition', async () => {
  let fetched = 0;
  const app = libraryRoutes({
    account: { verify: async () => ({ issuer: 'test', subject: 'reader' }) },
    access: { canReadAsBaselineMember: async () => true, activePrincipalId: async () => 'reader' },
    libraryImport: { withOpenLibraryWork: async (_id: string, action: () => Promise<unknown>) => action(),
      adoptedOpenLibraryWork: async () => null,
      takeBudget: async () => { throw new ReaderImportBudgetExceeded('acquisition'); } },
    sourceIntake: { replay: async () => null }, sourceConversions: {}, sourceGraph: {},
    sourceProposals: {}, sourceAdoptions: {},
    openLibraryFetch: (async () => { fetched++; return Response.json({}); }) as unknown as typeof fetch,
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.local/v1/me/library-import/open-library/adoptions', {
    method: 'POST', headers: { authorization: 'Bearer reader', 'idempotency-key': 'goodreads-budget',
      'content-type': 'application/json' },
    body: JSON.stringify({ actingSubject: agent, workId: 'OL45804W' }),
  }));
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ code: 'reader_import_adoption_budget' });
  expect(fetched).toBe(0);
});

test('G428: adoption reuses source intent and returns the adopted native Work', async () => {
  let acquired = 0, converted = 0, projected = 0, proposed = 0, adopted = 0;
  const observation = { observation: iri('000000000001'), provider: 'open-library',
    namespace: 'work', externalId: 'OL45804W', capture: { profile: 'open-library-work-acquisition-v1' } };
  const app = libraryRoutes({
    account: { verify: async (_request: Request, required: string[]) => {
      expect(required).toEqual(['work:read', 'work:create']); return { issuer: 'test', subject: 'reader' };
    } },
    access: { canReadAsBaselineMember: async () => true, activePrincipalId: async () =>
      '0194f314-9280-767f-89a6-000000000099' },
    libraryImport: { withOpenLibraryWork: async (_id: string, action: () => Promise<unknown>) => action(),
      adoptedOpenLibraryWork: async () => null, takeBudget: async () => {} },
    sourceIntake: { replay: async () => observation, reserveOpenLibrarySlot: async () => { acquired++; },
      submit: async () => { acquired++; return { observation }; } },
    sourceConversions: { convert: async () => { converted++;
      return { conversion: { conversion: iri('000000000002') } }; } },
    sourceGraph: { project: async () => { projected++; } },
    sourceProposals: { propose: async () => { proposed++;
      return { proposal: { proposal: iri('000000000003'), candidateTitle: 'Frankenstein' } }; } },
    sourceAdoptions: { adopt: async () => { adopted++;
      return { adoption: { work: iri('000000000004') }, replayed: true }; } },
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.local/v1/me/library-import/open-library/adoptions', {
    method: 'POST', headers: { authorization: 'Bearer reader', 'idempotency-key': 'goodreads-1',
      'content-type': 'application/json' },
    body: JSON.stringify({ actingSubject: agent, workId: 'OL45804W', titleLanguage: 'en' }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ work: iri('000000000004'), replayed: true });
  expect([acquired, converted, projected, proposed, adopted]).toEqual([0, 1, 1, 1, 1]);
});

test('G428: first adoption captures Open Library through Main and a retry does not fetch twice', async () => {
  let captured = 0;
  let stored = false;
  const observation = { observation: iri('000000000001'), provider: 'open-library', namespace: 'work',
    externalId: 'OL45804W', capture: { profile: 'open-library-work-acquisition-v1' } };
  const app = libraryRoutes({
    account: { verify: async () => ({ issuer: 'test', subject: 'reader' }) },
    access: { canReadAsBaselineMember: async () => true, activePrincipalId: async () =>
      '0194f314-9280-767f-89a6-000000000099' },
    libraryImport: { withOpenLibraryWork: async (_id: string, action: () => Promise<unknown>) => action(),
      adoptedOpenLibraryWork: async () => null, takeBudget: async () => {} },
    openLibraryFetch: (async (url: string) => { captured++;
      expect(url).toBe('https://openlibrary.org/works/OL45804W.json');
      return Response.json({ key: '/works/OL45804W', type: { key: '/type/work' }, title: 'Frankenstein' });
    }) as typeof fetch,
    sourceIntake: { replay: async () => stored ? observation : null,
      reserveOpenLibrarySlot: async () => {},
      submit: async (_principal: string, _key: string, input: { externalId: string }) => {
        expect(input.externalId).toBe('OL45804W'); stored = true; return { observation };
      } },
    sourceConversions: { convert: async () => ({ conversion: { conversion: iri('000000000002') } }) },
    sourceGraph: { project: async () => {} },
    sourceProposals: { propose: async () => ({ proposal: { proposal: iri('000000000003'),
      candidateTitle: 'Frankenstein' } }) },
    sourceAdoptions: { adopt: async () => ({ adoption: { work: iri('000000000004') }, replayed: stored }) },
  } as unknown as MainWorkDependencies);
  const request = () => new Request('http://main.local/v1/me/library-import/open-library/adoptions', {
    method: 'POST', headers: { authorization: 'Bearer reader', 'idempotency-key': 'goodreads-1',
      'content-type': 'application/json' },
    body: JSON.stringify({ actingSubject: agent, workId: 'OL45804W', titleLanguage: 'en' }),
  });
  expect((await app.handle(request())).status).toBe(200);
  expect((await app.handle(request())).status).toBe(200);
  expect(captured).toBe(1);
});
