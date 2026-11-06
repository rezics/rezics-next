import type { Pool } from 'pg';
import { checkAvatarMedia, readAvatarSummaries } from '../../content/access-capabilities.ts';
import { applyRealmClaimApproval, lockRealmClaimApprovalSource } from '../../community/access-capabilities.ts';
import {
  accountAgentId,
  activeIdentitySourceConsumerMaintenance,
  readOriginalAccountAgentIdentity,
  verifyOriginalAccountAgentIdentity,
  withReadTransaction,
} from '../../semantic/access-capabilities.ts';
import {
  IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION,
  collectionKindInputWork,
  resolveCollectionKindRawInput,
} from '../../library/access-capabilities.ts';
import { collectionKindPreparationNativeWork, observeAccountErasureSearch } from '../../search/access-capabilities.ts';
import type {
  AccessApplicationPorts,
  AccessIdentityReceipt,
  AccessPool,
  AccessQueryClient,
  AccessWorkDeclaration,
  IdentityRecoveryStorePort,
  IdentityRetentionPort,
  IdentitySemanticPort,
  RealmCommandTransaction,
} from '../contract/index.ts';
import { EMPTY_ACCESS_WORK_DIMENSIONS } from '../contract/index.ts';

function asPool(pool: AccessPool): Pool {
  return pool as Pool;
}

function asClient(client: AccessQueryClient): Parameters<typeof checkAvatarMedia>[0] {
  return client as Parameters<typeof checkAvatarMedia>[0];
}

function declarationOf(value: unknown): AccessWorkDeclaration | null {
  const resolved = typeof value === 'function' ? (value as () => unknown)() : value;
  if (!resolved || typeof resolved !== 'object') return null;
  if (!('work' in resolved) || !('engineRequests' in resolved)) return null;
  return resolved as AccessWorkDeclaration;
}

/** Native Access ports. Composition roots bind these; applications never import this module. */
export function createNativeAccessPorts(): AccessApplicationPorts {
  const identity: IdentitySemanticPort = {
    accountAgentId: (accountId) => accountAgentId(accountId),
    async readOriginalAccountAgentIdentity(pool, input) {
      return readOriginalAccountAgentIdentity(asPool(pool), input);
    },
    async verifyOriginalAccountAgentIdentity(tx, selection, result) {
      return verifyOriginalAccountAgentIdentity(
        tx as Parameters<typeof verifyOriginalAccountAgentIdentity>[0],
        selection as Parameters<typeof verifyOriginalAccountAgentIdentity>[1],
        result as Parameters<typeof verifyOriginalAccountAgentIdentity>[2],
      );
    },
    withReadTransaction(pool, body) {
      return withReadTransaction(asPool(pool), (client) => body(client as AccessQueryClient));
    },
    activeIdentitySourceConsumerMaintenance(pool) {
      return activeIdentitySourceConsumerMaintenance(asPool(pool)) !== null;
    },
  };
  const identityStore: IdentityRecoveryStorePort = {
    async readVerificationDecision(pool, receipt) {
      return identity.withReadTransaction(pool, async (tx) => {
        const row = (
          await tx.query<{ request_id: string }>(
            `SELECT request_id FROM access.agent_verification_request
         WHERE route=0 AND account_id=$1 AND decision_receipt_id=$2`,
            [receipt.account, receipt.receipt],
          )
        ).rows[0];
        if (!row) return null;
        return {
          request_id: row.request_id,
          account_id: receipt.account,
          account_kind: 'actor',
          catalogue_subject_id: receipt.account,
          requested_by: receipt.account,
          transaction_id: receipt.receipt,
        };
      });
    },
    async recoverOriginalSource() {
      return;
    },
    async readReversal() {
      throw new Error('Native identity reversal requires the bound Access recovery writer');
    },
    async writeRecovery() {
      return;
    },
  };
  const identityRetention: IdentityRetentionPort = {
    async acceptTechnicalSource() {
      return false;
    },
    async verifyTechnicalSource() {
      return false;
    },
    async readAccountIdentityTechnicalSource() {
      return null;
    },
  };
  return {
    avatar: {
      checkAvatarMedia(client, mediaId, accountId) {
        return checkAvatarMedia(asClient(client), mediaId, accountId);
      },
      async readAvatarSummaries(client, ids) {
        return readAvatarSummaries(asClient(client), ids);
      },
    },
    realm: {
      lockClaimApprovalSource(tx, input) {
        return lockRealmClaimApprovalSource(tx as Parameters<typeof lockRealmClaimApprovalSource>[0], input);
      },
      applyClaimApproval(tx, source) {
        return applyRealmClaimApproval(
          tx as Parameters<typeof applyRealmClaimApproval>[0],
          source as Parameters<typeof applyRealmClaimApproval>[1],
        );
      },
    },
    identity,
    identityStore,
    identityRetention,
    kindAudience: {
      collectionKindPreparationNativeWork(input) {
        return collectionKindPreparationNativeWork(input as Parameters<typeof collectionKindPreparationNativeWork>[0]);
      },
      collectionKindInputWork() {
        return collectionKindInputWork();
      },
      async resolveCollectionKindRawInput() {
        return { status: 'unavailable' as const, work: EMPTY_ACCESS_WORK_DIMENSIONS };
      },
      resolveCollectionKindRawNative(tx, locator, originId, native) {
        return resolveCollectionKindRawInput(
          tx as Parameters<typeof resolveCollectionKindRawInput>[0],
          locator as Parameters<typeof resolveCollectionKindRawInput>[1],
          originId,
          native as Parameters<typeof resolveCollectionKindRawInput>[3],
        );
      },
    },
    originalWork: {
      async readHistoryOriginalSourceDeclaration() {
        return null;
      },
      async readHistoryOriginalLibraryDeclaration() {
        return declarationOf(IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION);
      },
    },
    searchErasure: {
      async observeAccountErasureSearch(pool, input) {
        const observation = await observeAccountErasureSearch(asPool(pool), input as never, Date.now() + 60_000);
        return { observed: !('gap' in observation) };
      },
    },
    clock: () => new Date(),
  };
}

export type { AccessIdentityReceipt, RealmCommandTransaction };
