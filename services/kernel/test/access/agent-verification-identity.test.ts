import { expect, test } from 'bun:test';
import type {
  AccessApplicationPorts,
  AccessIdentityReceipt,
  AccountIdentityOriginal,
  IdentityRecoveryStorePort,
} from '../../src/access/contract/index.ts';
import { EMPTY_ACCESS_WORK_DIMENSIONS } from '../../src/access/contract/index.ts';
import { identityReceiptKey, identityRecoveryApplies } from '../../src/access/core/index.ts';
import { createAccessApplication } from '../../src/access/application/index.ts';
import { IdentityRecoveryUnavailableError } from '../../src/access/application/identity-recovery.ts';

const receipt: AccessIdentityReceipt = {
  kind: 'account-agent.verify',
  account: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  receipt: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const deadline = Date.now() + 5_000;
const original: AccountIdentityOriginal = {
  account: receipt.account,
  direction: receipt.kind,
  receipt: receipt.receipt,
  intentDigest: 'digest',
  consumerCustody: 'custody',
  epoch: 1,
  digest: 'digest',
  job: { jobId: requestId, epoch: 1 },
  release: 'release',
  survivor: 'survivor',
};

function missingSourceError() {
  return Object.assign(
    new Error(
      `Accounts source: missing original ${identityReceiptKey(receipt)}; owner must recover native decision/pending or reversal custody`,
    ),
    { code: 'identity_epoch_unavailable' },
  );
}

function ports(store: Partial<IdentityRecoveryStorePort> = {}): AccessApplicationPorts {
  return {
    avatar: {
      async checkAvatarMedia() {
        return false;
      },
      async readAvatarSummaries() {
        return new Map();
      },
    },
    realm: {
      async lockClaimApprovalSource() {
        return null;
      },
      async applyClaimApproval() {
        throw new Error('unused');
      },
    },
    identity: {
      accountAgentId: (accountId) => `agent:${accountId}`,
      async readOriginalAccountAgentIdentity() {
        return original;
      },
      async withReadTransaction(_pool, body) {
        return body({ query: async () => ({ rows: [], rowCount: 0 }) });
      },
    },
    identityStore: {
      async readVerificationDecision() {
        return {
          request_id: requestId,
          account_id: receipt.account,
          account_kind: 'actor',
          catalogue_subject_id: receipt.account,
          requested_by: receipt.account,
          transaction_id: receipt.receipt,
        };
      },
      async recoverOriginalSource() {},
      async readReversal() {
        throw new Error('unused reversal');
      },
      async writeRecovery() {},
      ...store,
    },
    identityRetention: {
      async acceptTechnicalSource() {
        return true;
      },
      async verifyTechnicalSource() {
        return true;
      },
      async readAccountIdentityTechnicalSource() {
        return original;
      },
    },
    kindAudience: {},
    originalWork: {
      async readHistoryOriginalSourceDeclaration() {
        return null;
      },
      async readHistoryOriginalLibraryDeclaration() {
        return null;
      },
    },
  };
}

test('identity recovery applies only to the original missing-source error', () => {
  expect(identityRecoveryApplies(missingSourceError(), identityReceiptKey(receipt))).toBe(true);
  expect(identityRecoveryApplies(new Error('other'), identityReceiptKey(receipt))).toBe(false);
});

test('identity recovery uses the original actor, request and deadline through fake ports', async () => {
  const recovered: Array<{ receipt: AccessIdentityReceipt; deadline: number; request: string | undefined }> = [];
  const application = createAccessApplication(
    ports({
      async recoverOriginalSource(_pool, nextReceipt, _source, decision, nextDeadline) {
        recovered.push({
          receipt: nextReceipt,
          deadline: nextDeadline,
          request: decision?.request_id,
        });
      },
    }),
  );
  expect(
    await application.recoverIdentitySource({
      pool: {},
      receipt,
      error: missingSourceError(),
      deadline,
      requestId,
    }),
  ).toBe(true);
  expect(recovered).toEqual([{ receipt, deadline, request: requestId }]);
});

test('identity recovery fail-closes when the deadline is missing and skips unrelated errors', async () => {
  const application = createAccessApplication(ports());
  expect(await application.recoverIdentitySource({ pool: {}, receipt, error: new Error('no'), deadline })).toBe(false);
  await expect(
    application.recoverIdentitySource({ pool: {}, receipt, error: missingSourceError(), deadline: 0 }),
  ).rejects.toBeInstanceOf(IdentityRecoveryUnavailableError);
  expect(await application.retainIdentitySource({ pool: {}, receipt, deadline })).toBe(true);
  expect(application.originalWorkLocalAllowance).not.toEqual(EMPTY_ACCESS_WORK_DIMENSIONS);
});
