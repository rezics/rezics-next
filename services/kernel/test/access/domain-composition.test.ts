import { expect, test } from 'bun:test';
import {
  ACCESS_ANONYMOUS_PRINCIPAL_ID,
  EMPTY_ACCESS_WORK_DIMENSIONS,
  type AccessApplicationPorts,
  type AccessDecision,
  type AccessWorkDeclaration,
  type AvatarSummary,
} from '../../src/access/contract/index.ts';
import {
  ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
  HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
  composeOriginalWorkAdmission,
  originalControlWork,
} from '../../src/access/core/index.ts';
import { createAccessApplication } from '../../src/access/application/index.ts';
import {
  bindAccessApplication,
  tryAccessApplication,
  unbindAccessApplication,
} from '../../src/access/adapters/bind.ts';

const actor = {
  kind: 'account' as const,
  accountId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  scopes: ['collection:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const resource = { route: 0, id: ACCESS_ANONYMOUS_PRINCIPAL_ID };
const media = '33333333-3333-4333-8333-333333333333';
const child = originalControlWork(1, 1, 1, 64);
const declaration: AccessWorkDeclaration = Object.freeze({ work: child, engineRequests: 0 });

function fakePorts(overrides: Partial<AccessApplicationPorts> = {}): AccessApplicationPorts {
  const avatars = new Map<string, AvatarSummary | null>();
  return {
    avatar: {
      async checkAvatarMedia(_client, mediaId, accountId) {
        return mediaId === media && accountId === actor.accountId;
      },
      async readAvatarSummaries(_client, ids) {
        return new Map(ids.map((id) => [id, avatars.get(id) ?? null]));
      },
    },
    realm: {
      async lockClaimApprovalSource() {
        return null;
      },
      async applyClaimApproval() {
        throw new Error('realm apply is not used');
      },
    },
    identity: {
      accountAgentId: (accountId) => `agent:${accountId}`,
      async readOriginalAccountAgentIdentity() {
        return null;
      },
      async withReadTransaction(_pool, body) {
        return body({
          query: async () => ({ rows: [], rowCount: 0 }),
        });
      },
    },
    identityStore: {
      async readVerificationDecision() {
        return null;
      },
      async recoverOriginalSource() {},
      async readReversal() {
        throw new Error('reversal unused');
      },
      async writeRecovery() {},
    },
    identityRetention: {
      async acceptTechnicalSource() {
        return false;
      },
      async verifyTechnicalSource() {
        return false;
      },
      async readAccountIdentityTechnicalSource() {
        return null;
      },
    },
    kindAudience: {
      collectionKindPreparationNativeWork: () => EMPTY_ACCESS_WORK_DIMENSIONS,
      collectionKindInputWork: () => EMPTY_ACCESS_WORK_DIMENSIONS,
      async resolveCollectionKindRawInput() {
        return { status: 'unavailable' as const, work: EMPTY_ACCESS_WORK_DIMENSIONS };
      },
    },
    originalWork: {
      async readHistoryOriginalSourceDeclaration() {
        return declaration;
      },
      async readHistoryOriginalLibraryDeclaration() {
        return declaration;
      },
    },
    nativeErasure: {
      async acknowledgeCompletion() {},
    },
    ...overrides,
  };
}

function facts(input: {
  actor?: typeof actor | { kind: 'anonymous' };
  partition?: number;
  attemptPartition?: number;
  basis?: unknown;
  eligibility?: unknown;
}): Parameters<ReturnType<typeof createAccessApplication>['decideAuthorization']>[0] {
  const chosen = input.actor ?? actor;
  return {
    actor: chosen,
    action: 'realm:approve_claim',
    resource: { ...resource, eligibility: input.eligibility },
    partition: input.partition ?? 0,
    deadline: Date.now() + 60_000,
    attempt: {
      partition: input.attemptPartition ?? 0,
      time: new Date(),
      basis: (input.basis ??
        (chosen.kind === 'account'
          ? {
              actorAccountId: chosen.accountId,
              clientId: chosen.clientId,
              requestedBy: chosen.requestedBy,
            }
          : null)) as never,
    },
  };
}

test('Access application instantiates against fake ports and records allow and deny', () => {
  const application = createAccessApplication(fakePorts());
  expect(application.decideAuthorization(facts({}))).toEqual({
    outcome: 'allow',
    explicit: false,
  } satisfies AccessDecision);
  expect(application.decideAuthorization(facts({ attemptPartition: 1 }))).toEqual({
    outcome: 'deny',
    explicit: true,
  });
  expect(
    application.decideAuthorization(
      facts({
        actor: { kind: 'anonymous' },
        basis: {
          actorAccountId: null,
          clientId: null,
          requestedBy: null,
          principal: { kind: 'anonymous', id: ACCESS_ANONYMOUS_PRINCIPAL_ID },
        },
        eligibility: { admitted: true },
      }),
    ),
  ).toEqual({ outcome: 'allow', explicit: true });
  expect(application.decideAuthorization(facts({ actor: { kind: 'anonymous' } }))).toEqual({
    outcome: 'deny',
    explicit: true,
  });
});

test('Access application qualifies avatars, admits original work and plans Kind audience without native adapters', async () => {
  const application = createAccessApplication(fakePorts());
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };
  expect(await application.qualifyAvatar({ client, mediaId: media, accountId: actor.accountId })).toBe(true);
  expect(await application.qualifyAvatar({ client, mediaId: media, accountId: ACCESS_ANONYMOUS_PRINCIPAL_ID })).toBe(
    false,
  );
  expect(await application.admitOriginalWork({ local: HISTORY_ORIGINAL_LOCAL_ALLOWANCE })).toEqual(
    composeOriginalWorkAdmission(HISTORY_ORIGINAL_LOCAL_ALLOWANCE, child, child, ADDITIONAL_ORIGINAL_TRANSFER_CONTROL),
  );
  const plan = application.planKindAudience(actor, 128);
  expect(plan.shape.members).toBe(1);
  expect(plan.source).toEqual(EMPTY_ACCESS_WORK_DIMENSIONS);
});

test('bindAccessApplication exposes the fake application to Access facades', () => {
  const application = createAccessApplication(fakePorts());
  bindAccessApplication(application);
  expect(tryAccessApplication()).toBe(application);
  unbindAccessApplication();
  expect(tryAccessApplication()).toBeUndefined();
});
