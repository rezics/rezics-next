import type { FakeRoute } from '../fake-modules';
import active from '../recorded/definitions-active.json';
import { storyViewerId } from './identities';

export const savedRuleUnavailableId = 'saved-rule-unavailable';
export const savedRuleReadyId = 'saved-rule-ready';

/** Delivered GET schema and the recorded release; no invented write or member-execution success. */
const savedRule = {
  filter: { and: [{ owner: { presence: true } }, { type: { in: ['schema:Book'] } }] },
  sort: 'id' as const,
  releaseDigest: active.digest,
  revision: 1,
  collectionRevision: 1,
  sourceGeneration: '1',
};

const unavailable = () => ({ status: 503, code: 'dependency_unavailable' });

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/collections/${savedRuleReadyId}/rule`,
    story: () => ({ status: 200, rule: savedRule }),
  },
  {
    method: 'GET',
    path: `/v1/collections/${savedRuleReadyId}`,
    story: () => ({
      status: 200,
      collection: {
        id: savedRuleReadyId,
        curatorAccountId: storyViewerId,
        title: 'Private saved definition',
        description: null,
        visibility: 'private',
        revision: 1,
        membershipKind: 'dynamic',
      },
    }),
  },
  { method: 'PUT', path: `/v1/collections/${savedRuleReadyId}/rule`, story: unavailable },
  { method: 'GET', path: `/v1/collections/${savedRuleUnavailableId}/rule`, story: unavailable },
  { method: 'PUT', path: `/v1/collections/${savedRuleUnavailableId}/rule`, story: unavailable },
];
