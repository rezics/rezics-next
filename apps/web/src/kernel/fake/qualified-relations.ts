import {
  PAGE_GLOBAL_CONTEXT,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type PageContinuation,
  type SelectedContext,
} from '@rezics/composition';
import type { SubjectPageData } from '../../features/pages/subject';
import type { Stmt } from '../../features/pages/shared';
import type { FakeRoute } from '../fake-modules';
import fixtures from '../fixtures.json';
import active from '../recorded/definitions-active.json';

export const qualifiedSubject = { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e92', label: 'A qualified cast' };
export const qualifiedRealm = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e93';
const person = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e94';
const character = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e95';
const role = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e96';
const release = active.digest;
const snak = (id: string, data_type: string, content: unknown) => ({
  property: { id, data_type },
  value: { type: 'value' as const, content },
});
const summary = (id: string, label: string, type = 'schema:Person') => ({
  id,
  type,
  types: [type],
  label: { value: label, language: 'en' },
  creativeWork: false,
  cover: null,
});
export function qualifiedStatement(id: string, property: string, target: string, qualifiers: unknown[] = []): Stmt {
  return {
    id,
    rank: 'normal',
    ...snak(property, 'wikibase-item', target),
    qualifiers,
    references: [],
    rezics: { release, revision: 1 },
  } as unknown as Stmt;
}
const cast = qualifiedStatement('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e97', 'wdt:P725', person, [
  snak('wdt:P1932', 'string', 'A. Player'),
  snak('schema:position', 'string', '1'),
  snak('wdt:P3831', 'wikibase-item', role),
  snak('wdt:P453', 'wikibase-item', character),
]);
const related = {
  [person]: summary(person, 'Ada Player'),
  [role]: summary(role, 'Voice', 'skos:Concept'),
  [character]: summary(character, 'The Traveller', 'wd:Q95074'),
};

/** A current native page response: no per-row subject fetch or private response cache. */
export function qualifiedRelationsPage(
  options: {
    continuation?: PageContinuation | undefined;
    realm?: string | undefined;
    error?: number | undefined;
    retryCastOnce?: boolean | undefined;
  } = {},
): SubjectPageData {
  const context: SelectedContext = options.realm
    ? { id: options.realm, population: { kind: 'realm', id: options.realm, title: 'Cast community' } }
    : { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
  const document: CompositionDocument = {
    root: { props: {} },
    content: [
      { type: 'SubjectHeader', props: { id: 'header' } },
      {
        type: 'Credits',
        props: { id: 'cast', property: 'wdt:P725', direction: 'forward', title: 'Cast', limit: 24, paged: true },
      },
      {
        type: 'Appearances',
        props: { id: 'characters', property: 'schema:character', direction: 'forward', limit: 12 },
      },
      {
        type: 'OutgoingRelations',
        props: { id: 'editions', title: 'Editions', property: 'schema:workExample', limit: 24, paged: true },
      },
      {
        type: 'RelationGroups',
        props: { id: 'adaptations', property: 'schema:exampleOfWork', limit: 24, paged: true },
      },
    ],
  };
  const plan = planReads(platformRegistry, document, {
    subject: qualifiedSubject.id,
    context,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  });
  const reads: SubjectPageData['reads'] = {};
  for (const [node, key] of Object.entries(plan.nodes)) {
    const read = plan.reads[key]!;
    if (read.kind === 'subject') {
      reads[key] = {
        status: 200,
        body: {
          subject: {
            ...fixtures.subjects[0],
            id: qualifiedSubject.id,
            labels: { en: qualifiedSubject.label },
            statements: {},
          },
          related: {},
          summary: null,
        },
      };
      continue;
    }
    if (read.kind !== 'links' && read.kind !== 'relations') continue;
    if (options.continuation && options.continuation.node !== node) {
      reads[key] = { status: 204, body: {} };
      continue;
    }
    if (options.error && options.continuation) {
      reads[key] = { status: options.error, body: {} };
      continue;
    }
    const later = !!options.continuation;
    const rows =
      node === 'cast'
        ? [
            {
              statement: cast,
              target: person,
              label: 'Ada Player',
              type: 'schema:Person',
              summary: related[person],
              related,
            },
          ]
        : node === 'characters'
          ? [
              {
                statement: qualifiedStatement('character-appearance', 'schema:character', character, [
                  snak('wdt:P3831', 'wikibase-item', role),
                ]),
                target: character,
                label: 'The Traveller',
                summary: related[character],
                related,
              },
            ]
          : Array.from({ length: later ? 2 : 12 }, (_, index) => {
              const id = `0192f3a0-6c1e-7b2a-9d4e-${String(index + (later ? 200 : 100)).padStart(12, '0')}`;
              const label = `${later ? 'Later' : 'First'} ${node} ${index + 1}`;
              return read.kind === 'links'
                ? {
                    subject: id,
                    property: read.property,
                    statement: `statement-${id}`,
                    label,
                    summary: summary(id, label, 'schema:Book'),
                  }
                : {
                    statement: qualifiedStatement(`statement-${id}`, read.property, id),
                    target: id,
                    label,
                    summary: summary(id, label, 'schema:Book'),
                  };
            });
    reads[key] = {
      status: 200,
      body: {
        [read.kind === 'links' ? 'links' : 'relations']: rows,
        next: node === 'characters' || later ? null : node === 'cast' && options.retryCastOnce ? 'retry-cast-once' : `${node}-next`,
        freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
      },
    };
  }
  return {
    subject: qualifiedSubject.id,
    context,
    ...(options.continuation ? { continuation: options.continuation } : {}),
    profile: 'qualified-cast',
    template: { scope: 'type', key: 'schema:Book' },
    document,
    reads,
  } as SubjectPageData;
}
async function page({ request }: { request: Request }) {
  const body = (await request.json()) as {
    target?: { subject?: string; realm?: string };
    continuation?: PageContinuation;
  };
  if (body.target?.subject !== qualifiedSubject.id) return;
  const retryCast = body.target.realm === qualifiedRealm;
  if (!body.continuation && retryCast) retryCastAttempted = false;
  if (retryCast && body.continuation?.cursor === 'retry-cast-once' && !retryCastAttempted) {
    retryCastAttempted = true;
    throw new TypeError('Network connection lost');
  }
  return {
    status: 200,
    ...qualifiedRelationsPage({
      continuation: body.continuation,
      realm: body.target.realm,
      retryCastOnce: retryCast,
      error: body.continuation?.cursor === 'refuse' ? 409 : undefined,
    }),
  };
}
let retryCastAttempted = false;
export const routes: FakeRoute[] = [{ method: 'POST', path: '/v1/pages:read', story: page, fixture: page }];
