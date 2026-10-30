import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageContinuation,
  type PresentationProfile,
  type SelectedContext,
  type View,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import release from '../../../../../packages/definitions/release/rezics.json';
import recording from '../recorded/subject.json';
import type { SubjectPageData } from '../../features/pages/subject';
import type { FakeRoute } from '../fake-modules';

const profile = profileJson as PresentationProfile;
export const traversalSubjects = {
  edition: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000910', type: 'bf:Instance', label: 'The harbour, first edition' },
  work: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000911', type: 'schema:Book', label: 'The harbour' },
  creator: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000912', type: 'schema:Person', label: 'Ada Harbour' },
  hidden: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000913',
    type: 'bf:Instance',
    label: 'An edition with an unresolved work',
  },
  unavailable: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000914',
    type: 'bf:Instance',
    label: 'An edition awaiting its source',
  },
  conflict: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000915', type: 'schema:Person', label: 'Ada Harbour' },
} as const;
export type TraversalScenario = keyof typeof traversalSubjects;
export const traversalRealm = '0192f3a0-6c1e-7b2a-9d4e-000000000920';
export const traversalContext = '0192f3a0-6c1e-7b2a-9d4e-000000000921';
const rowId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
export const traversalRelease = release;

function summary(id: string, label: string, type: string) {
  const types = release.types as Record<string, { bases: string[] }>;
  return {
    id,
    type,
    types: [type, ...(types[type]?.bases ?? [])],
    label: { value: label, language: 'en' },
    cover: recording.summary?.cover ?? null,
  };
}
function statement(id: string, property: string, target: string) {
  return {
    id,
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    rank: 'normal',
    qualifiers: [],
    references: [],
  };
}

/** Illustrative transport fixtures, using the current shipped templates and released properties. */
export function traversalPage(
  scenario: TraversalScenario,
  view: View = 'overview',
  options: {
    realm?: string | undefined;
    continuation?: PageContinuation | undefined;
    count?: 'exact' | 'lower' | 'unavailable';
    failure?: number;
  } = {},
): SubjectPageData {
  const subject = traversalSubjects[scenario];
  const types = release.types as Record<string, { bases: string[] }>;
  const target = { type: subject.type, bases: types[subject.type]!.bases };
  const resolved = resolveView(profile, target, view)!;
  const context: SelectedContext = options.realm
    ? { id: traversalContext, population: { kind: 'realm', id: options.realm, title: 'Harbour readers' } }
    : { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: subject.id,
    context,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') {
      reads[key] = {
        status: 200,
        body: {
          subject: {
            ...recording.subject,
            id: subject.id,
            type: subject.type,
            context: context.id,
            labels: { en: subject.label },
            descriptions: {},
            aliases: {},
            statements: {},
            relationCounts: {},
          },
          summary: summary(subject.id, subject.label, subject.type),
          related: {},
        },
      };
      continue;
    }
    if (read.kind !== 'links' && read.kind !== 'relations') {
      reads[key] = { status: 200, body: { links: [], collections: [], threads: [], next: null } };
      continue;
    }
    const node = Object.keys(plan.nodes).find((id) => plan.nodes[id] === key)!;
    if (options.continuation && node !== options.continuation.node) {
      reads[key] = { status: 204, body: null };
      continue;
    }
    if (options.failure || (scenario === 'unavailable' && node === 'edition-work')) {
      reads[key] = { status: options.failure ?? 503, body: options.failure ? {} : { code: 'dependency_unavailable' } };
      continue;
    }
    if (scenario === 'conflict' && options.continuation?.node === 'author') {
      // Semantic maps a refused/stale property cursor to invalid_request, at this leaf only.
      reads[key] = { status: 400, body: { code: 'invalid_request' } };
      continue;
    }
    const total =
      read.property === 'schema:exampleOfWork'
        ? read.kind === 'relations'
          ? scenario === 'work'
            ? 0
            : 1
          : scenario === 'work'
            ? 15
            : 0
        : read.property === 'schema:author'
          ? 15
          : read.property === 'schema:illustrator'
            ? 14
            : 0;
    const offset = read.cursor ? 12 : 0;
    const rows = Array.from({ length: Math.min(read.limit, Math.max(total - offset, 0)) }, (_, n) => {
      const index = n + offset;
      const isWork = read.kind === 'relations';
      const first =
        index === 0
          ? node === 'editions'
            ? traversalSubjects.edition
            : node === 'author'
              ? traversalSubjects.work
              : undefined
          : undefined;
      const id = isWork
        ? traversalSubjects.work.id
        : (first?.id ?? rowId(2000 + index + (node === 'illustrator' ? 100 : 0)));
      const label = isWork
        ? traversalSubjects.work.label
        : (first?.label ?? `${node === 'editions' ? 'Edition' : node} ${index + 1}`);
      const type = node === 'editions' ? 'bf:Instance' : 'schema:Book';
      const projected = summary(id, label, type);
      const assertion = statement(rowId(4000 + index), read.property, isWork ? id : subject.id);
      return isWork
        ? {
            target: scenario === 'hidden' ? null : id,
            external: null,
            statement: assertion,
            ...(scenario === 'hidden' ? {} : { label, type }),
            summary: scenario === 'hidden' ? null : projected,
          }
        : { subject: id, property: read.property, statement: assertion.id, assertion, label, type, summary: projected };
    });
    const count = options.count ?? (node === 'illustrator' ? 'unavailable' : 'exact');
    reads[key] = {
      status: 200,
      body: {
        [read.kind === 'links' ? 'links' : 'relations']: rows,
        ...(count === 'unavailable' ? {} : { count: { value: total, exact: count === 'exact' } }),
        freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
        next: offset + rows.length < total ? `fixture-${node}-next` : null,
      },
    };
  }
  return {
    subject: subject.id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views: definedViews(profile, target),
    reads,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const input = (await request.json()) as {
        target?: { subject?: string; view?: View; realm?: string };
        continuation?: PageContinuation;
      };
      const scenario = (Object.keys(traversalSubjects) as TraversalScenario[]).find(
        (key) => traversalSubjects[key].id === input.target?.subject,
      );
      if (!scenario) return;
      return {
        status: 200,
        ...traversalPage(scenario, input.target?.view, {
          realm: input.target?.realm,
          continuation: input.continuation,
        }),
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([0-9a-f-]+)$/,
    story: ({ match }) => {
      const scenario = (Object.keys(traversalSubjects) as TraversalScenario[]).find(
        (key) => traversalSubjects[key].id === match?.[1],
      );
      if (!scenario) return;
      const page = traversalPage(scenario);
      const read = Object.values(page.reads).find((r) => (r.body as { subject?: unknown })?.subject);
      return { status: 200, __responseBody: read!.body };
    },
  },
];
