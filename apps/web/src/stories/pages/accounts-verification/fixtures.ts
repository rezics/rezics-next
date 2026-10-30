import type { FakeRoute } from '../../../kernel/fake-modules';
import type { AgentVerificationRequest } from '../../../account-verification/transport';

export const accountId = '0192f3a0-6c1e-7b2a-9d4e-000100000001';
export const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000200000001';
export const requestId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const request: AgentVerificationRequest = {
  id: requestId,
  accountId,
  accountKind: 'actor',
  requestedBy: accountId,
  catalogueSubjectId: subjectId,
  statement:
    'I represent the author of River Atlas. The official site contains the requested account challenge. Please confirm it through the publisher’s independently listed contact.',
  links: [{ label: 'Official author website', url: 'https://example.org/author' }],
  state: 'pending',
  reason: null,
  problem: null,
  decisionReceiptId: null,
  decidedBy: null,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-31T08:30:00.000Z',
};
type Scenario =
  | 'loading'
  | 'pending'
  | 'empty'
  | 'denied'
  | 'preparing'
  | 'unavailable'
  | 'approving'
  | 'approved'
  | 'verified'
  | 'rejected'
  | 'lost-response';
let scenario: Scenario | undefined;
let current = request;
let decided = false;
export const attempts: { key: string | null; path: string; body: unknown }[] = [];
export function selectVerificationStory(value: Scenario) {
  scenario = value;
  current = {
    ...request,
    state:
      value === 'approving' || value === 'approved' || value === 'rejected'
        ? value
        : value === 'verified'
          ? 'approved'
          : 'pending',
    reason: value === 'rejected' ? 'The independently contacted publisher could not confirm representation.' : null,
  };
  decided = false;
  attempts.length = 0;
  sessionStorage.removeItem('verification:story-viewer:review');
  sessionStorage.removeItem(`verification:story-viewer:account:${accountId}`);
  return () => {
    scenario = undefined;
  };
}
function refusal() {
  if (scenario === 'denied') return { status: 403, code: 'forbidden' };
  if (scenario === 'preparing') return { status: 403, code: 'platform_closed' };
  if (scenario === 'unavailable') return { status: 503, code: 'partition_unavailable' };
  return undefined;
}
const account = {
  id: accountId,
  kind: 'actor',
  handle: 'mira',
  displayName: 'Mira Okabe',
  state: 'active',
  automated: false,
  operatorId: null,
  bio: 'Author of River Atlas',
  links: [],
  avatar: null,
  publicViews: { posts: true, reviews: true, collections: true, realms: true },
};
const operations = [
  'account.read_verification_request',
  'account.request_verification',
  'account.withdraw_verification',
  'account.release_verification',
  'account.revoke_verification',
  'verification_request.list_pending',
  'verification_request.approve',
  'verification_request.reject',
];
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/openapi.json',
    story: () =>
      scenario
        ? {
            status: 200,
            openapi: '3.1.0',
            info: { title: 'Story', version: '1' },
            paths: Object.fromEntries(
              operations.map((operationId, index) => [`/story/${index}`, { get: { operationId } }]),
            ),
            components: { schemas: {}, securitySchemes: {} },
          }
        : undefined,
  },
  {
    method: 'GET',
    path: '/v1/verification-requests',
    story: ({ request: incoming }) =>
      scenario === 'loading'
        ? new Promise(() => {})
        : scenario
          ? (refusal() ?? {
              status: 200,
              verificationRequests:
                scenario === 'empty' || decided || new URL(incoming.url).searchParams.has('cursor') ? [] : [current],
              next:
                scenario === 'pending' && !new URL(incoming.url).searchParams.has('cursor') && !decided
                  ? 'signed-story-continuation'
                  : null,
            })
          : undefined,
  },
  {
    method: 'GET',
    path: `/v1/accounts/${accountId}/verification`,
    story: () =>
      scenario === 'loading'
        ? new Promise(() => {})
        : scenario
          ? (refusal() ?? { status: 200, verificationRequest: scenario === 'empty' ? null : current })
          : undefined,
  },
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request: incoming }) => {
      if (!scenario) return;
      const query = new URL(incoming.url).searchParams;
      if (!query.get('ids')?.includes(accountId) && query.get('handle') !== 'mira') return;
      return {
        status: 200,
        accounts: [
          {
            ...account,
            verified: scenario === 'verified',
            subject: scenario === 'verified' ? { id: subjectId, label: 'Mira Okabe', type: 'schema:Person' } : null,
          },
        ],
        next: null,
      };
    },
  },
  {
    method: 'GET',
    path: `/v1/subjects/${subjectId}`,
    story: () =>
      scenario
        ? {
            status: 200,
            subject: {
              id: subjectId,
              type: 'schema:Person',
              labels: { en: 'Mira Okabe' },
              statements: {},
              descriptions: {},
              aliases: {},
            },
            related: {},
          }
        : undefined,
  },
  {
    method: 'POST',
    path: /^\/v1\/(?:verification-requests\/[^/]+:(?:approve|reject)|accounts\/[0-9a-f-]+:(?:withdraw|release|revoke)Verification)$/,
    story: async ({ request: incoming }) => {
      if (!scenario) return;
      if (refusal()) return refusal();
      const path = new URL(incoming.url).pathname;
      const body = await incoming.json();
      attempts.push({ key: incoming.headers.get('idempotency-key'), path, body });
      if (scenario === 'lost-response' && attempts.length === 1) {
        decided = true;
        current = { ...current, state: 'approving' };
        throw new TypeError('Story response lost after commit');
      }
      decided = true;
      if (path.endsWith(':releaseVerification') || path.endsWith(':revokeVerification')) {
        scenario = 'approved';
        return { status: 200, reversal: { kind: path.endsWith(':releaseVerification') ? 'released' : 'revoked' } };
      }
      current = {
        ...current,
        state: path.endsWith(':reject')
          ? 'rejected'
          : path.endsWith(':withdrawVerification')
            ? 'withdrawn'
            : 'approving',
      };
      return { status: 200, verificationRequest: current };
    },
  },
];

export const viewport = {
  options: {
    phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
    desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
  },
};
