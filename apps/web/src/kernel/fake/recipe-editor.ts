import { createKernelClient, type KernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import {
  createRecipe,
  proposeRecipe,
  readRecipeEditor,
  type RecipeItem,
  type RecipeTransport,
} from '../../features/catalogue/recipe-editor';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import type { StatementInput } from '../../features/catalogue/statement-editor';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';
import recording from '../recorded/subject.json';

type DocumentView = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['documents']>['get']>>['data']>['document'];

export const recipeId = '00000000-0000-4000-8000-00000000f001';
export const ingredientId = '00000000-0000-4000-8000-00000000f002';
export const dietId = '00000000-0000-4000-8000-00000000f003';
export type RecipeScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'unavailable'
  | 'uncertain'
  | 'concealed'
  | 'reader-unavailable';
/** Declared examples for isolated stories and request tests. No application route uses these mutations. */
export function recipeFixture(scenario: RecipeScenario = 'ready', locale = 'en') {
  const release = structuredClone(definitions.release) as Release;
  const publicRead = structuredClone(recording) as unknown as SubjectRead;
  Object.assign(publicRead.subject, {
    id: recipeId,
    type: 'schema:Recipe',
    labels: { en: 'Lentil soup' },
    descriptions: {},
    aliases: {},
    statements: {},
    relationCounts: {},
    resolution: {},
  });
  publicRead.related = {
    [ingredientId]: { labels: { en: 'Lentils' }, type: 'wd:Q2095' },
    [dietId]: { labels: { en: 'Vegetarian diet' }, type: 'skos:Concept' },
  };
  const calls: {
    method: string;
    path: string;
    body: unknown;
    key: string | null;
    authorization: string | null;
    session: string | null;
  }[] = [];
  const receipts = new Map<string, unknown>();
  const candidates = new Map<string, Candidate>();
  const documents = new Map<string, DocumentView>();
  const adoptions = new Map<string, { head: number; mode: 'replace' }>();
  let active = scenario;
  let lost = false;
  let revision = 1;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'recipe-session' },
    });
  function selected(input: StatementInput): SubjectRead['subject']['statements'][string][number] {
    const id = crypto.randomUUID();
    let value = structuredClone(input.value);
    if (input.property.id === 'schema:recipeInstructions' && value.type === 'value') {
      const body = value.content as {
        document: Extract<DocumentView, { origin: 'account' }>['body'];
        language: string;
        licence: string;
      };
      const document = crypto.randomUUID();
      documents.set(document, {
        id: document,
        body: body.document,
        language: body.language,
        licence: body.licence,
        revision,
        origin: 'account',
        author: '00000000-0000-4000-8000-00000000f004',
        subjectId: recipeId,
        candidateId: id,
        availability: 'available',
        digest: 'd'.repeat(64),
      });
      value = { type: 'value', content: { document, language: body.language, digest: 'd'.repeat(64) } };
    }
    const snak = (part: StatementInput) => ({
      property: { ...part.property, data_type: release.properties[part.property.id]!.datatype },
      value: part.value,
    });
    return {
      ...snak(input),
      value,
      id,
      rank: 'normal',
      qualifiers: (input.qualifiers ?? []).map((part) => snak({ ...part, references: [] })),
      references: input.references.map((reference) => ({
        hash: 'citation',
        parts: reference.parts.map((part) => snak({ ...part, references: [] })),
      })),
      rezics: { release: definitions.digest, revision },
    };
  }
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const body: unknown = request.method === 'POST' ? await request.json() : null;
      const key = request.headers.get('idempotency-key');
      calls.push({
        method: request.method,
        path,
        body,
        key,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (path === '/v1/definitions/active') {
        if (active === 'loading') return new Promise<Response>(() => {});
        if (active === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
        return json({ digest: definitions.digest });
      }
      if (path === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`)
        return json({ digest: definitions.digest, release });
      if (path.startsWith('/v1/documents/'))
        return documents.has(path.split('/').at(-1)!)
          ? json({ document: documents.get(path.split('/').at(-1)!) })
          : json({ code: 'not_found' }, 404);
      if (path === `/v1/subjects/${recipeId}` && request.method === 'GET') {
        if (active === 'concealed') return json({ code: 'not_found' }, 404);
        if (active === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
        return json(publicRead);
      }
      if (request.method === 'POST') {
        if (active === 'denied') return json({ code: 'forbidden' }, 403);
        if (active === 'conflict') return json({ code: 'idempotency_conflict' }, 422);
        if (active === 'invalid')
          return json(
            { code: 'invalid_request', errors: [{ pointer: '/statement/value/content', code: 'invalid_format' }] },
            400,
          );
        if (receipts.has(key!)) return json(receipts.get(key!), 201);
        if (path === '/v1/subjects') {
          const item = body as RecipeItem;
          Object.assign(publicRead.subject, {
            labels: item.labels,
            descriptions: item.descriptions ?? {},
            aliases: item.aliases ?? {},
            statements: Object.fromEntries(
              Object.entries(item.statements).map(([id, entries]) => [id, entries.map(selected)]),
            ),
          });
          receipts.set(key!, { subject: structuredClone(publicRead.subject) });
        } else if (path === `/v1/subjects/${recipeId}/candidates`) {
          const statement = selected((body as { statement: StatementInput }).statement);
          revision++;
          candidates.set(statement.id, {
            id: statement.id,
            statement,
            revision,
            release: definitions.digest,
            source: null,
            retracted: null,
            retraction: null,
            decision: null,
            head: null,
            rank: null,
          });
          receipts.set(key!, { candidate: statement.id, revision });
        } else if (path.endsWith(':accept') || path.endsWith(':reject')) {
          const candidate = candidates.get(path.split('/').at(-1)!.split(':')[0]!)!;
          const decision = path.endsWith(':accept') ? 'accept' : 'reject';
          candidate.decision = decision === 'accept' ? 'accepted' : 'rejected';
          candidate.head = ++revision;
          return json({
            acceptance: { context: candidateContext, candidate: candidate.id, decision, head: revision },
            revision,
          });
        } else if (path.endsWith(':adopt')) {
          const selection = body as {
            property: string;
            selection: { candidate: string; rank: 'normal' | 'preferred' }[];
          };
          publicRead.subject.statements[selection.property] = selection.selection.map((entry) => ({
            ...candidates.get(entry.candidate)!.statement,
            rank: entry.rank,
          }));
          ++revision;
          adoptions.set(selection.property, { head: revision, mode: 'replace' });
          return json({
            adoption: {
              context: candidateContext,
              property: selection.property,
              mode: 'replace',
              selection: selection.selection,
              head: revision,
            },
            revision,
          });
        } else return json({ code: 'not_found' }, 404);
        if (active === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json(receipts.get(key!), 201);
      }
      if (path.endsWith('/candidates')) {
        const query = new URL(request.url).searchParams;
        const property = query.get('property')!;
        return json({
          candidates: [...candidates.values()].filter(
            (candidate) =>
              candidate.statement.property.id === property &&
              (!query.get('target') ||
                (candidate.statement.value.type === 'value' &&
                  candidate.statement.value.content === query.get('target'))),
          ),
          next: null,
          adoption: adoptions.get(property) ?? null,
        });
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  if (scenario === 'empty') delete release.types['schema:Recipe'];
  const transport: RecipeTransport = {
    load: () => readRecipeEditor(client, locale),
    create: (command, replay) =>
      createRecipe(
        client,
        new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command,
        locale,
        undefined,
        replay,
      ),
    propose: (command, replay) => proposeRecipe(client, 'Bearer fixture', command, locale, replay),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  const review = (property: string): CandidateTransport => ({
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: async (_property, cursor, session) => {
      const read = await readCandidates(client, 'Bearer fixture', recipeId, property, cursor, undefined, session);
      return read.ok
        ? {
            ...read,
            fields: [{ id: property, label: pickText(release.properties[property]!.labels, locale).text }],
            names: Object.fromEntries(
              Object.entries(release.properties).map(([id, property]) => [id, property.labels]),
            ),
          }
        : read;
    },
    confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
  });
  return {
    client,
    transport,
    review,
    release,
    publicRead,
    calls,
    receipts,
    candidates,
    documents,
    setScenario: (next: RecipeScenario) => {
      active = next;
    },
    corrections: { ...transport, load: () => readRecipeEditor(client, locale, recipeId) },
  };
}
export function recipeExample(): RecipeItem {
  const value = (property: string, content: unknown): StatementInput => ({
    property: { id: property },
    value: { type: 'value', content },
    qualifiers: [],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cook.example/my-lentil-soup' } },
        ],
      },
    ],
    rank: 'normal',
  });
  return {
    type: 'schema:Recipe',
    labels: { en: 'Lentil soup' },
    descriptions: {},
    aliases: {},
    statements: {
      'schema:recipeIngredient': [value('schema:recipeIngredient', { language: 'en', text: '200 g lentils' })],
      'wdt:P186': [value('wdt:P186', ingredientId)],
      'schema:cookTime': [value('schema:cookTime', { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' })],
      'schema:recipeYield': [value('schema:recipeYield', { amount: '+2', unit: '1' })],
      'schema:suitableForDiet': [value('schema:suitableForDiet', dietId)],
      'schema:recipeInstructions': [
        value('schema:recipeInstructions', {
          language: 'en',
          licence: 'CC-BY-4.0',
          document: fromPlainText('Simmer my lentils gently, then serve the soup.'),
        }),
      ],
    },
  };
}
export const routes: FakeRoute[] = [];
