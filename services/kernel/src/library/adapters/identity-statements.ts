/** Identity SQL catalog. Core owns arithmetic; composition binds this catalog to the application. */

import { memoizedValue } from '../../memoized.ts';
import type { IdentityNativeCatalog, IdentitySqlWork } from '../contract/index.ts';
import { libraryIdentitySQL } from '../identity-native-planner-statements.ts';
import plan from '../identity-native-planner-read.sql';
import job from '../identity-native-planner-job.sql';
import time from '../../command/time.sql';
import fence from '../../command/fence.sql';
import noEffectFence from '../../command/no-effect-fence.sql';
import partition from '../../partition/read.sql';
import account from '../../access/account-share.sql';
import commit from '../../semantic/identity-epoch-store-insert-native-commit.sql';
import savedJob from '../../semantic/identity-epoch-store-select-job-4.sql';
import libraryTransform from '../../semantic/identity-epoch-store-library-transform.sql';
import { identityEpochLibraryInputsSQL } from '../../semantic/identity-epoch-library-inputs.ts';
import inputs from '../../semantic/identity-epoch-store-select-input.sql';
import originals from '../../semantic/identity-epoch-store-select-original.sql';
import owners from '../../semantic/identity-epoch-read-owners.sql';
import sources from '../../semantic/identity-epoch-read-sources.sql';
import pending from '../../semantic/identity-epoch-read-pending.sql';
import mapping from '../../semantic/identity-epoch-read-current.sql';
import facts from '../collection-source-native-facts.sql';
import labels from '../owner-index-native-label-originals.sql';
import accountQuery from '../native-source-custody-account.sql';
import sourceQuery from '../native-source-custody-source.sql';
import outputQuery from '../native-source-custody-output.sql';
import fencesQuery from '../native-source-custody-fences.sql';
import identityCapture from '../identity-native-planner-source.sql';
import proofQuery from '../native-source-custody-proof.sql';
import {
  LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
  LIBRARY_IDENTITY_SELECTED_STATEMENTS,
  libraryIdentityBoundedPlanSQL,
  libraryIdentitySelectedBindBound,
} from '../identity-native-planner-projection.ts';

export const nativeIdentityPartitionQuery = Object.freeze({
  sql: `SELECT epoch, position::text AS position, write_state AS "writeState",
    CASE WHEN moved_to IS NULL THEN NULL ELSE '' END AS "movedTo"
    FROM core.partition WHERE partition_no=$1 FOR SHARE`,
  params: Object.freeze(['partition_no']),
});

export const libraryIdentityJobSizeSQL =
  'SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3';

function identitySqlWork(): Readonly<Record<string, IdentitySqlWork>> {
  const part = (
    name: keyof typeof libraryIdentitySQL,
    nativeRows: number,
    nativePoints: number,
    identityMetadataRows: number,
    resultBytes: number,
    emptySeeks = 1,
    extra: { candidateKeys?: number; rangeLimitParameter?: number } = {},
  ): IdentitySqlWork =>
    Object.freeze({
      sql: libraryIdentitySQL[name],
      nativeRows,
      nativePoints,
      identityMetadataRows,
      emptySeeks,
      resultBytes,
      ...extra,
    });
  return Object.freeze({
    oldFacts: part('oldFacts', 0, 1, 0, 256, 1, { rangeLimitParameter: 8 }),
    oldReferences: part('oldReferences', 0, 1, 0, 256, 1, { rangeLimitParameter: 7 }),
    invalidateKey: part('invalidateKey', 1, 1, 0, 64),
    invalidateKeyInline: part('invalidateKeyInline', 1, 1, 0, 64),
    retainedGenerations: part('retainedGenerations', 3, 1, 0, 256),
    oldHead: part('oldHead', 1, 1, 0, 128),
    oldState: part('oldState', 1, 1, 0, 1024),
    invalidateGeneration: part('invalidateGeneration', 1, 1, 0, 64),
    abandonWorking: part('abandonWorking', 1, 1, 0, 64),
    insertGeneration: part('insertGeneration', 2, 2, 0, 64),
    insertPlan: part('insertPlan', 4, 4, 0, 64),
    advanceCapture: part('advanceCapture', 1, 1, 0, 64),
    mappingClaim: part('mappingClaim', 2, 2, 2, 256),
    insertEffect: part('insertEffect', 2, 2, 0, 64),
    readEffect: part('readEffect', 1, 1, 0, 4608),
    insertReference: part('insertReference', 2, 2, 0, 64),
    advanceGeneration: part('advanceGeneration', 1, 1, 0, 64),
    advancePlan: part('advancePlan', 1, 1, 0, 64),
    detachHead: part('detachHead', 2, 2, 0, 64),
    detachState: part('detachState', 2, 2, 0, 64),
    insertSeal: part('insertSeal', 2, 2, 0, 64),
    sealPlan: part('sealPlan', 1, 1, 0, 64),
    nextPlan: part('nextPlan', 2, 1, 0, 2304),
    effectPage: part('effectPage', 0, 1, 0, 512, 1, { rangeLimitParameter: 6 }),
  });
}

const boundId = 'f'.repeat(36);
const boundDecimal = '9'.repeat(20);
const boundText = String.fromCharCode(1);

const currentCaptureProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    captureId: boundId,
    collectionFence: boundDecimal,
    accountFence: boundDecimal,
    complete: false,
    driver: 'entry_deleted',
    after: boundText.repeat(512),
    tie: boundText.repeat(64),
    sessionId: boundId,
    scanned: boundDecimal,
    version: 2147483647,
  }),
);

export function createIdentityNativeCatalog(): IdentityNativeCatalog {
  return memoizedValue(createIdentityNativeCatalog, () => {
    const selected = LIBRARY_IDENTITY_SELECTED_STATEMENTS();
    return Object.freeze({
      libraryIdentitySQL,
      sqlWork: identitySqlWork(),
      selected: Object.freeze({
        plan: Object.freeze({
          sql: selected.plan.sql,
          values: selected.plan.values,
          rows: 1,
          points: 1,
          metadata: 0,
          output: LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
          seeks: 1,
        }),
        current: Object.freeze({
          sql: selected.current.sql,
          values: selected.current.values,
          rows: 7,
          points: 7,
          metadata: 1,
          output: 64,
          seeks: 1,
        }),
        job: Object.freeze({
          sql: selected.job.sql,
          values: selected.job.values,
          rows: 16,
          points: 13,
          metadata: 16,
          output: 2048,
          seeks: 4,
        }),
        seal: Object.freeze({
          sql: selected.seal.sql,
          values: selected.seal.values,
          rows: 5,
          points: 5,
          metadata: 2,
          output: 256,
          seeks: 1,
        }),
        page: Object.freeze({
          sql: selected.page.sql,
          values: selected.page.values,
          rows: 1,
          points: 0,
          metadata: 0,
          output: 512,
          seeks: 0,
          candidates: 1,
        }),
      }),
      basisQueries: Object.freeze([
        nativeIdentityPartitionQuery,
        accountQuery,
        sourceQuery,
        outputQuery,
        fencesQuery,
        identityCapture,
        proofQuery,
      ]),
      basisWork: Object.freeze([
        {
          sql: nativeIdentityPartitionQuery.sql,
          nativeRows: 16,
          nativePoints: 1,
          identityMetadataRows: 1,
          emptySeeks: 1,
          resultBytes: Buffer.byteLength(
            JSON.stringify({ epoch: 2147483647, position: boundDecimal, writeState: 'active', movedTo: null }),
          ),
        },
        {
          sql: accountQuery.sql,
          nativeRows: 16,
          nativePoints: 1,
          identityMetadataRows: 0,
          emptySeeks: 1,
          resultBytes: Buffer.byteLength(JSON.stringify({ state: 'suspended', fenced: false, epoch: boundDecimal })),
        },
        {
          sql: sourceQuery.sql,
          nativeRows: 16,
          nativePoints: 1,
          identityMetadataRows: 0,
          emptySeeks: 1,
          resultBytes: Buffer.byteLength(
            JSON.stringify({
              accountId: boundId,
              incarnation: boundText.repeat(128),
              generation: boundDecimal,
              state: 'deleted',
              kind: 'dynamic',
              builtin: 'everything',
              visibility: 'unlisted',
              ruleReady: false,
            }),
          ),
        },
        {
          sql: outputQuery.sql,
          nativeRows: 56,
          nativePoints: 7,
          identityMetadataRows: 1,
          emptySeeks: 7,
          resultBytes: Buffer.byteLength(
            JSON.stringify({
              generation: boundId,
              transactionId: boundId,
              position: boundDecimal,
              nativeXid: boundDecimal,
              members: boundDecimal,
              memberFence: boundDecimal,
              sourceGeneration: boundDecimal,
            }),
          ),
        },
        {
          sql: fencesQuery.sql,
          nativeRows: 32,
          nativePoints: 2,
          identityMetadataRows: 0,
          emptySeeks: 2,
          resultBytes: Buffer.byteLength(
            JSON.stringify([
              { kind: 'collection', generation: boundDecimal },
              { kind: 'account', generation: boundDecimal },
            ]),
          ),
        },
        {
          sql: identityCapture.sql,
          nativeRows: 32,
          nativePoints: 1,
          identityMetadataRows: 0,
          emptySeeks: 1,
          resultBytes: currentCaptureProjectionBytes,
        },
        {
          sql: proofQuery.sql,
          nativeRows: 64,
          nativePoints: 3,
          identityMetadataRows: 1,
          emptySeeks: 3,
          resultBytes: Buffer.byteLength(JSON.stringify({ transactionId: boundId, position: boundDecimal })),
        },
      ]),
      plan,
      job,
      time,
      fence,
      noEffectFence,
      partition,
      account,
      commit,
      savedJob,
      libraryTransform,
      identityEpochLibraryInputsSQL,
      inputs,
      originals,
      owners,
      sources,
      pending,
      mapping,
      facts,
      labels,
      libraryIdentityJobSizeSQL,
      libraryIdentityBoundedPlanSQL: libraryIdentityBoundedPlanSQL(),
      planResultBytes: LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
      selectedBindCeiling: libraryIdentitySelectedBindBound,
    });
  });
}
