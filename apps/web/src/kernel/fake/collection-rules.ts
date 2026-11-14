import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';
import active from '../recorded/definitions-active.json';
import { storyViewerId } from './identities';

export const savedRuleUnavailableId = 'saved-rule-unavailable';
export const savedRuleReadyId = 'saved-rule-ready';
export const savedRuleConflictId = 'saved-rule-conflict';
export const savedQueryManagedId = 'saved-query-managed';
export const savedQueryDirectoryCursor = 'saved queries / second page +== 雪';

/** Delivered GET schema and the recorded release; no invented rule-execution success. */
const savedRule = {
  filter: { and: [{ owner: { presence: true } }, { type: { in: ['schema:Book'] } }] },
  sort: 'id' as const,
  releaseDigest: active.digest,
  revision: 1,
  collectionRevision: 1,
  sourceGeneration: '1',
};

const unavailable = () => ({ status: 503, code: 'dependency_unavailable' });
const conflict = () => ({ status: 409, code: 'conflict' });
const metadata = () => ({
  id: savedQueryManagedId,
  curatorAccountId: storyViewerId,
  title: 'Weekend reading',
  description: 'Books to return to on quiet weekends.' as string | null,
  visibility: 'private' as const,
  revision: 3,
  membershipKind: 'dynamic' as const,
});
let managed = metadata();
let deleted = false;
let conflictReads = 0;
const receipts = new Map<string, KernelRecording>();

/** Only the explicitly named metadata/delete story illustrates command success. */
export function resetSavedQueryStory() {
  managed = metadata();
  deleted = false;
  conflictReads = 0;
  receipts.clear();
}

function ruleMetadata(id: string) {
  return {
    id,
    curatorAccountId: storyViewerId,
    title: 'Private saved definition',
    description: null,
    visibility: 'private',
    revision: 1,
    membershipKind: 'dynamic',
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/collections/${savedRuleReadyId}/rule`,
    story: () => ({ status: 200, rule: savedRule }),
  },
  {
    method: 'GET',
    path: `/v1/collections/${savedRuleReadyId}`,
    story: () => ({ status: 200, collection: ruleMetadata(savedRuleReadyId) }),
  },
  { method: 'PUT', path: `/v1/collections/${savedRuleReadyId}/rule`, story: unavailable },
  { method: 'GET', path: `/v1/collections/${savedRuleUnavailableId}/rule`, story: unavailable },
  { method: 'PUT', path: `/v1/collections/${savedRuleUnavailableId}/rule`, story: unavailable },
  {
    method: 'GET',
    path: `/v1/collections/${savedRuleConflictId}/rule`,
    story: () => ({ status: 200, rule: { ...savedRule, revision: ++conflictReads } }),
  },
  {
    method: 'GET',
    path: `/v1/collections/${savedRuleConflictId}`,
    story: () => ({ status: 200, collection: ruleMetadata(savedRuleConflictId) }),
  },
  { method: 'PUT', path: `/v1/collections/${savedRuleConflictId}/rule`, story: conflict },
  {
    method: 'GET',
    path: `/v1/collections/${savedQueryManagedId}`,
    story: () => (deleted ? { status: 404, code: 'not_found' } : { status: 200, collection: { ...managed } }),
  },
  {
    method: 'GET',
    path: `/v1/collections/${savedQueryManagedId}/rule`,
    story: () => ({ status: 200, rule: { ...savedRule, collectionRevision: managed.revision } }),
  },
  {
    method: 'GET',
    path: `/v1/collections/${savedQueryManagedId}/members`,
    story: unavailable,
  },
  {
    method: 'GET',
    path: '/v1/collections',
    story: ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('cursor') !== savedQueryDirectoryCursor) return;
      return { status: 200, collections: deleted ? [] : [{ ...managed }], next: null };
    },
  },
  {
    method: 'PATCH',
    path: `/v1/collections/${savedQueryManagedId}`,
    story: async ({ request }) => {
      const key = request.headers.get('idempotency-key')!;
      const receipt = receipts.get(key);
      if (receipt) return receipt;
      const change = (await request.json()) as Pick<typeof managed, 'title' | 'description' | 'visibility' | 'revision'>;
      if (change.revision !== managed.revision) return conflict();
      managed = { ...managed, ...change, revision: managed.revision + 1 };
      const result = { status: 200, collection: { ...managed } };
      receipts.set(key, result);
      return result;
    },
  },
  {
    method: 'DELETE',
    path: `/v1/collections/${savedQueryManagedId}`,
    story: ({ request }) => {
      const key = request.headers.get('idempotency-key')!;
      const receipt = receipts.get(key);
      if (receipt) return receipt;
      if (Number(new URL(request.url).searchParams.get('revision')) !== managed.revision) return conflict();
      deleted = true;
      const result = { status: 204 };
      receipts.set(key, result);
      return result;
    },
  },
];
