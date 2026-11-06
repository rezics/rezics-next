/** Identity SQL catalog for fake-capability applications. Native matching uses identity-native-bounds.ts. */

import type { IdentityNativeCatalog } from '../contract/index.ts';
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
import { identityEpochLibraryInputsSQL } from '../../semantic/identity-adapters/index.ts';
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
import { nativeIdentityPartitionQuery } from '../identity-native-bounds.ts';

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
  const selected = LIBRARY_IDENTITY_SELECTED_STATEMENTS();
  return Object.freeze({
    libraryIdentitySQL,
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
        emptySeeks: 0,
        resultBytes: Buffer.byteLength(JSON.stringify({ state: 'suspended', fenced: false, epoch: boundDecimal })),
      },
      {
        sql: sourceQuery.sql,
        nativeRows: 16,
        nativePoints: 1,
        identityMetadataRows: 0,
        emptySeeks: 0,
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
        emptySeeks: 1,
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
        emptySeeks: 0,
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
        emptySeeks: 0,
        resultBytes: currentCaptureProjectionBytes,
      },
      {
        sql: proofQuery.sql,
        nativeRows: 64,
        nativePoints: 3,
        identityMetadataRows: 1,
        emptySeeks: 1,
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
    libraryIdentityJobSizeSQL:
      'SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3',
    libraryIdentityBoundedPlanSQL: libraryIdentityBoundedPlanSQL(),
    planResultBytes: LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
    selectedBindCeiling: libraryIdentitySelectedBindBound,
  });
}
