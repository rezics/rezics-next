import { CatalogueArtifactError } from '@rezics/definitions';
import nativeWithdrawalAck from './definition-catalogue-withdrawal-ack.sql';
import nativeactivationCAS from './definition-catalogue-activation-cas.sql';
import nativefrontierRead from './definition-catalogue-frontier-read.sql';
import nativefrontierStage from './definition-catalogue-frontier-stage.sql';
import nativefrontierPoint from './definition-catalogue-frontier-pending.sql';
import nativeactivationCut from './definition-catalogue-activation-cut.sql';
import nativeactivationClosing from './definition-catalogue-activation-closing.sql';
import nativecloseRoot from './definition-catalogue-close.sql';
import nativeactivationRequest from './definition-catalogue-activation-request.sql';
import nativeactivationRead from './definition-catalogue-activation-read.sql';
import nativeenroll from './definition-catalogue-enroll.sql';
import nativeconsumerRead from './definition-catalogue-consumer-read.sql';
import nativerootLock from './definition-catalogue-root-lock.sql';
import nativeheadLock from './definition-catalogue-head-lock.sql';
import nativeregisterRoot from './definition-catalogue-register-root.sql';
import ledgerRootLock from './definition-catalogue-root-lock.sql';
import ledgerHeadLock from './definition-catalogue-head-lock.sql';
import ledgerRetirementOriginal from './definition-catalogue-retirement-original.sql';
import ledgerRetirementProgress from './definition-catalogue-retirement-progress.sql';
import ledgerRetirementProbe from './definition-catalogue-retirement-probe.sql';
import ledgerRetirementPositions from './definition-catalogue-retirement-positions.sql';
import ledgerRetirementTickets from './definition-catalogue-retirement-tickets.sql';
import ledgerRetirementConsumers from './definition-catalogue-retirement-consumers.sql';
import ledgerRetirementCaptures from './definition-catalogue-retirement-captures.sql';
import ledgerRetirementRead from './definition-catalogue-retirement-read.sql';
import ledgerRetirementStart from './definition-catalogue-retirement-start.sql';
import ledgerPosition from './definition-catalogue-position.sql';
import ledgerOriginalTerminal from './definition-catalogue-original-terminal.sql';
import ledgerTicketSpend from './definition-catalogue-ticket-spend.sql';
import ledgerTicketAdmit from './definition-catalogue-ticket-admit.sql';
import ledgerOriginalRead from './definition-catalogue-original-read.sql';
import ledgerOriginalAdmit from './definition-catalogue-original-admit.sql';
import { CATALOGUE_MECHANICAL_REPRESENTATION } from './definition-catalogue-mechanical.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { ProblemError } from '../http/problem.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';

/** Static catalogue operation bounds. Ordinary Core execution owns Access, receipts and transaction controls. */
/** Native SQL components. Every operation has a closed SQL identity below.
 * Consumer captures are 8192 + 8192 + 65536 = 81920 octets. Staging
 * reads AND writes 100 captures (16384000 bytes); a frontier read returns
 * both retained/current captures in bytea hex (4 * 81920 * 100), plus
 * 512 scalar bytes per row. FK reverse probes are included in points.
 */
export const CATALOGUE_BODY_COST = Object.freeze({
  withdrawalAck: Object.freeze({
    candidateKeys: 1,
    identityMetadataRows: 0,
    nativeRows: 5,
    nativePoints: 8,
    witnessKeys: 0,
    statements: 1,
    bytes: 164000,
    emptySeeks: 1,
  }),
  registerRoot: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 4,
    nativePoints: 5,
    witnessKeys: 0,
    statements: 1,
    bytes: 80,
    emptySeeks: 2,
  }),
  headLock: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 80,
    emptySeeks: 1,
  }),
  rootLock: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 160,
    emptySeeks: 1,
  }),
  consumerRead: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 163920,
    emptySeeks: 1,
  }),
  enroll: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 3,
    nativePoints: 6,
    witnessKeys: 0,
    statements: 1,
    bytes: 81940,
    emptySeeks: 1,
  }),
  activationRead: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 256,
    emptySeeks: 1,
  }),
  activationRequest: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 2,
    nativePoints: 5,
    witnessKeys: 0,
    statements: 1,
    bytes: 36,
    emptySeeks: 1,
  }),
  closeRoot: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 2,
    witnessKeys: 0,
    statements: 1,
    bytes: 40,
    emptySeeks: 1,
  }),
  activationClosing: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 0,
    emptySeeks: 1,
  }),
  activationCut: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 0,
    emptySeeks: 1,
  }),
  frontierPoint: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 71,
    emptySeeks: 1,
  }),
  frontierStage: Object.freeze({
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 403,
    nativePoints: 604,
    witnessKeys: 0,
    statements: 1,
    bytes: 16384020,
    emptySeeks: 2,
  }),
  frontierRead: Object.freeze({
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 200,
    nativePoints: 101,
    witnessKeys: 0,
    statements: 1,
    bytes: 32819200,
    emptySeeks: 1,
  }),
  activationCAS: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 10,
    nativePoints: 14,
    witnessKeys: 0,
    statements: 1,
    bytes: 4,
    emptySeeks: 3,
  }),
  headRead: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 80,
    emptySeeks: 1,
  }),
  buildRead: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 12,
    emptySeeks: 1,
  }),
  boundary: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 131104,
    emptySeeks: 1,
  }),
  kindSizes: Object.freeze({
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 100,
    nativePoints: 100,
    witnessKeys: 0,
    statements: 1,
    bytes: 2000,
    emptySeeks: 1,
  }),
  kindBodies: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 100,
    nativePoints: 100,
    witnessKeys: 0,
    statements: 1,
    bytes: 1065976,
    emptySeeks: 1,
  }),
  candidateRange: Object.freeze({
    candidateKeys: 101,
    identityMetadataRows: 0,
    nativeRows: 101,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 12625,
    emptySeeks: 1,
  }),
  control: Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 4194304,
    emptySeeks: 0,
  }),
} satisfies Record<string, WorkDimensions>);

/** Reserve the complete literal before any SQL/non-SQL dispatch. Failure keeps the full charge. */
export async function catalogueBodyWork<T>(
  work: NativeCollectionWork,
  cost: WorkDimensions,
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const reservation = work.reserve(cost);
  reservation.dispatch();
  try {
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new ProblemError('dependency_unavailable');
    const result = await reservation.query(operation);
    work.assertReady();
    if (Date.now() >= deadline) throw new ProblemError('dependency_unavailable');
    return result;
  } catch (error) {
    // A bounded domain refusal can be recorded after rolling back the step savepoint.
    // Infrastructure and unexpected failures still poison the frame.
    if (!(error instanceof CatalogueArtifactError))
      work.failure = error instanceof Error ? error : new Error('Catalogue body failed');
    throw error;
  } finally {
    reservation.settle();
  }
}
export function catalogueSQLCost(base: WorkDimensions, sql: string, params: unknown): WorkDimensions {
  const operation = Object.values(CATALOGUE_NATIVE_OPERATIONS).find((op) => op.sql === sql && op.bound === base);
  const values = params as Record<string, unknown>;
  if (operation) {
    const maxima: Readonly<Record<string, number>> = operation.parameters;
    if (
      Object.keys(values).length !== Object.keys(maxima).length ||
      Object.keys(values).some((key) => !(key in maxima))
    )
      throw new TypeError('Unknown catalogue native parameters');
    for (const [key, max] of Object.entries(maxima))
      if (catalogueParameterBytes(values[key]) > max)
        throw new TypeError('Catalogue native parameter exceeds its bound');
  } else {
    const read = nativeReadLiterals.find(([literal, bound]) => literal === sql && bound === base);
    if (!read || !Array.isArray(params)) throw new TypeError('Unknown catalogue native operation');
    const maxima = sql.includes('ANY($2')
      ? [71, 7401]
      : sql.includes('ordinal>$4')
        ? [71, 71, 11, 20, 3]
        : sql.includes('precedence<$3')
          ? [71, 71, 11, 3]
          : sql.includes('ordinal=$2')
            ? [71, 20]
            : sql.includes('root_digest=$1')
              ? [71]
              : [];
    if (params.length !== maxima.length) throw new TypeError('Unknown catalogue read parameters');
    params.forEach((value, index) => {
      if (catalogueParameterBytes(value) > maxima[index]!)
        throw new TypeError('Catalogue read parameter exceeds its bound');
    });
    if (sql.includes('ANY($2')) {
      const keys = params[1];
      if (
        !Array.isArray(keys) ||
        keys.length > 100 ||
        keys.some((key) => typeof key !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(key))
      )
        throw new TypeError('Catalogue key batch exceeds its admitted representation');
    }
    if (sql.includes(' LIMIT $')) {
      const limit = params.at(-1);
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 101)
        throw new TypeError('Catalogue page exceeds its admitted bound');
    }
  }
  // Exact Buffer binary/text scalar representations, plus protocol fields.
  const bytes = Object.values(values).reduce<number>((total, value) => total + catalogueParameterBytes(value) + 6, 0);
  return Object.freeze({ ...base, bytes: base.bytes + Buffer.byteLength(sql) + bytes });
}

/** Closed native operation sequences; ordinary Core execution supplies framework and Access behavior. */
export const CATALOGUE_CHILD_COMPOSITION = Object.freeze({
  register: Object.freeze(['lifecycleIdentity', 'headLock', 'registerRoot']),
  enroll: Object.freeze(['headLock', 'rootLock', 'consumerRead', 'enroll']),
  requestActivation: Object.freeze([
    'lifecycleIdentity',
    'headLock',
    'rootLock',
    'rootLock',
    'activationRead',
    'activationRequest',
    'activationRead',
  ]),
  close: Object.freeze([
    'lifecycleIdentity',
    'headLock',
    'rootLock',
    'activationRead',
    'rootLock',
    'closeRoot',
    'activationClosing',
  ]),
  cutAndStage: Object.freeze([
    'lifecycleIdentity',
    'headLock',
    'rootLock',
    'activationRead',
    'rootLock',
    'activationCut',
    'activationRead',
    'frontierPoint',
    'frontierStage',
  ]),
  readFrontier: Object.freeze(['lifecycleIdentity', 'headLock', 'rootLock', 'activationRead', 'frontierRead']),
  finish: Object.freeze(['lifecycleIdentity', 'headLock', 'rootLock', 'activationRead', 'activationCAS']),
});

/** An operation is the SQL literal plus its actual parameter/output representation.
 * Rows count addressed heap rows, including a failed FK/duplicate point; points
 * count equality/unique/FK and maintained index probes. MVCC and tree height are
 * engine work. Bytea outputs use PostgreSQL's hex representation (2 bytes/octet).
 * Task bytea fields are three node-sized keys; Release members are bounded by
 * their admitted 4 MiB original, declarations/labels by their 64 KiB original.
 * Build status projects a bounded pin and an 8192-byte refusal, not artifacts.
 * Every entry includes its hit/absence/conflict branch. No SQL prefix fallback.
 */
function literalOperation(
  sql: string,
  rows: number,
  points: number,
  keys: number,
  resultBytes: number,
  parameterMaxima: readonly number[],
) {
  return Object.freeze({
    sql,
    parameterMaxima: Object.freeze(parameterMaxima),
    bound: Object.freeze({
      candidateKeys: keys,
      identityMetadataRows: 0,
      nativeRows: rows,
      nativePoints: points,
      witnessKeys: 0,
      statements: 1,
      bytes: resultBytes,
      emptySeeks: points ? 1 : 0,
    } satisfies WorkDimensions),
  });
}
export const CATALOGUE_PUBLISHER_OPERATIONS = Object.freeze({
  buildIdentity: literalOperation(
    'SELECT recorded_transaction_id FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    36,
    [71],
  ),
  checkpointRead: literalOperation(
    'SELECT result FROM semantic.definition_catalogue_checkpoint WHERE route=0 AND root_digest=$1 AND phase=$2 AND job_id=$3 AND position=$4',
    1,
    1,
    0,
    131072,
    [71, 15, 36, 19],
  ),
  checkpointWrite: literalOperation(
    'INSERT INTO semantic.definition_catalogue_checkpoint(route,root_digest,phase,job_id,position,result,recorded_transaction_id) VALUES(0,$1,$2,$3,$4,$5,$6)',
    2,
    3,
    0,
    0,
    [71, 15, 36, 19, 65536, 36],
  ),
  artifactRead: literalOperation(
    'SELECT bytes FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1',
    1,
    1,
    0,
    8388624,
    [71],
  ),
  artifactInsert: literalOperation(
    'INSERT INTO semantic.definition_catalogue_artifact(route,digest,kind,bytes,recorded_transaction_id)\n       VALUES(0,$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING digest',
    1,
    1,
    0,
    80,
    [71, 11, 4194304, 36],
  ),
  artifactConflict: literalOperation(
    'SELECT kind,bytes FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1',
    1,
    1,
    0,
    8388640,
    [71],
  ),
  buildInsert: literalOperation(
    "INSERT INTO semantic.definition_catalogue_build(route,root_digest,pin,state,recorded_transaction_id)\n       VALUES(0,$1,$2,'building',$3) ON CONFLICT DO NOTHING RETURNING root_digest",
    1,
    1,
    0,
    80,
    [71, 256, 36],
  ),
  firstTask: literalOperation(
    "INSERT INTO semantic.definition_catalogue_task(route,root_digest,kind,digest)\n         VALUES(0,$1,'node',$2) RETURNING task_id",
    2,
    4,
    0,
    24,
    [71, 71],
  ),
  buildNext: literalOperation(
    'UPDATE semantic.definition_catalogue_build SET next_node=$2 WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    0,
    [71, 20],
  ),
  buildStatus: literalOperation(
    'SELECT CASE WHEN octet_length(pin::text)<=256 THEN pin END AS pin,state,phase,steps,nodes,releases,declarations,indexed_rows,examined_bytes,CASE WHEN octet_length(missing_digest)<=71 THEN missing_digest END AS missing_digest,CASE WHEN octet_length(error)<=8192 THEN error END AS error FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    8704,
    [71],
  ),
  identityUpsert: literalOperation(
    'INSERT INTO semantic.definition_catalogue_identity(route,root_digest,identity_key,identity,digest)\n     VALUES(0,$1,$2,$3,$4) ON CONFLICT(route,root_digest,identity_key) DO UPDATE\n     SET digest=semantic.definition_catalogue_identity.digest RETURNING CASE WHEN octet_length(identity)<=4194304 THEN identity END AS identity,digest',
    2,
    2,
    0,
    8388704,
    [71, 71, 4194304, 71],
  ),
  branchTask: literalOperation(
    "INSERT INTO semantic.definition_catalogue_task(route,root_digest,kind,digest,first_key,last_key,next_node)\n         VALUES(0,$1,'node',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING task_id",
    2,
    4,
    1,
    24,
    [71, 71, 262144, 262144, 20],
  ),
  leafTask: literalOperation(
    'INSERT INTO semantic.definition_catalogue_task(route,root_digest,kind,digest,entry_key) VALUES(0,$1,$2,$3,$4)',
    2,
    4,
    1,
    0,
    [71, 11, 71, 262144],
  ),
  nodeProgress: literalOperation(
    'UPDATE semantic.definition_catalogue_build SET next_node=$2,nodes=nodes+1 WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    0,
    [71, 20],
  ),
  taskDone: literalOperation(
    'UPDATE semantic.definition_catalogue_task SET done=true WHERE route=0 AND root_digest=$1 AND task_id=$2',
    1,
    2,
    0,
    0,
    [71, 20],
  ),
  memberInsert: literalOperation(
    'INSERT INTO semantic.definition_catalogue_member(route,root_digest,release_digest,category,id_key,id,body)\n       VALUES(0,$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
    1,
    1,
    1,
    8388624,
    [71, 71, 8, 71, 4194304, 4194304],
  ),
  taskOffset: literalOperation(
    'UPDATE semantic.definition_catalogue_task SET offset_rows=offset_rows+$3,done=$4 WHERE route=0 AND root_digest=$1 AND task_id=$2',
    1,
    2,
    0,
    0,
    [71, 20, 2, 5],
  ),
  releaseProgress: literalOperation(
    'UPDATE semantic.definition_catalogue_build SET releases=releases+1 WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    0,
    [71],
  ),
  typeClosure: literalOperation(
    "SELECT CASE WHEN octet_length(id)<=4194304 THEN id END AS id,CASE WHEN octet_length(body::text)<=4194304 THEN body END AS body FROM semantic.definition_catalogue_member WHERE route=0 AND root_digest=$1 AND release_digest=$2 AND category='type' AND id_key=$3",
    1,
    1,
    0,
    12582944,
    [71, 71, 71],
  ),
  profileClosure: literalOperation(
    "SELECT CASE WHEN octet_length(id)<=4194304 THEN id END AS id FROM semantic.definition_catalogue_member WHERE route=0 AND root_digest=$1 AND release_digest=$2 AND category='profile' AND id_key=$3",
    1,
    1,
    0,
    8388624,
    [71, 71, 71],
  ),
  kindInsert: literalOperation(
    'INSERT INTO semantic.definition_catalogue_kind(route,root_digest,id_key,id,ordinal,declaration_digest,body,exact_type_key,exact_type_id,precedence,eligible)\n       VALUES(0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id',
    1,
    3,
    1,
    131088,
    [71, 71, 65536, 20, 71, 65536, 71, 65536, 11, 5],
  ),
  labelInsert: literalOperation(
    'INSERT INTO semantic.definition_catalogue_label(route,root_digest,language_key,language,label_sort,ordinal,id_key) VALUES(0,$1,$2,$3,$4,$5,$6)',
    2,
    4,
    1,
    0,
    [71, 71, 65536, 131072, 20, 71],
  ),
  declarationProgress: literalOperation(
    'UPDATE semantic.definition_catalogue_build SET declarations=declarations+1 WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    0,
    [71],
  ),
  buildLock: literalOperation(
    'SELECT CASE WHEN octet_length(pin::text)<=256 THEN pin END AS pin,state,phase,steps,nodes,releases,declarations,indexed_rows,examined_bytes,CASE WHEN octet_length(missing_digest)<=71 THEN missing_digest END AS missing_digest,CASE WHEN octet_length(error)<=8192 THEN error END AS error,next_node FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1 FOR UPDATE',
    1,
    1,
    0,
    8736,
    [71],
  ),
  stepSavepoint: literalOperation('SAVEPOINT catalogue_step', 0, 0, 0, 0, []),
  nodeTask: literalOperation(
    'SELECT task_id,kind,digest,CASE WHEN octet_length(entry_key)<=262144 THEN entry_key END AS entry_key,CASE WHEN octet_length(first_key)<=262144 THEN first_key END AS first_key,CASE WHEN octet_length(last_key)<=262144 THEN last_key END AS last_key,next_node,offset_rows FROM semantic.definition_catalogue_task WHERE route=0 AND root_digest=$1 AND task_id=$2',
    1,
    1,
    0,
    1573376,
    [71, 20],
  ),
  phaseRelease: literalOperation(
    "UPDATE semantic.definition_catalogue_build SET phase='release' WHERE route=0 AND root_digest=$1",
    1,
    1,
    0,
    0,
    [71],
  ),
  releaseTask: literalOperation(
    "SELECT task_id,kind,digest,CASE WHEN octet_length(entry_key)<=262144 THEN entry_key END AS entry_key,CASE WHEN octet_length(first_key)<=262144 THEN first_key END AS first_key,CASE WHEN octet_length(last_key)<=262144 THEN last_key END AS last_key,next_node,offset_rows FROM semantic.definition_catalogue_task WHERE route=0 AND root_digest=$1 AND kind='release' AND NOT done ORDER BY task_id LIMIT 1",
    1,
    1,
    1,
    1573376,
    [71],
  ),
  phaseDeclaration: literalOperation(
    "UPDATE semantic.definition_catalogue_build SET phase='declaration' WHERE route=0 AND root_digest=$1",
    1,
    1,
    0,
    0,
    [71],
  ),
  declarationTask: literalOperation(
    "SELECT task_id,kind,digest,CASE WHEN octet_length(entry_key)<=262144 THEN entry_key END AS entry_key,CASE WHEN octet_length(first_key)<=262144 THEN first_key END AS first_key,CASE WHEN octet_length(last_key)<=262144 THEN last_key END AS last_key,next_node,offset_rows FROM semantic.definition_catalogue_task WHERE route=0 AND root_digest=$1 AND kind='declaration' AND NOT done ORDER BY task_id LIMIT 1",
    1,
    1,
    1,
    1573376,
    [71],
  ),
  artifactSize: literalOperation(
    'SELECT octet_length(bytes) AS size,kind FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1',
    1,
    1,
    0,
    32,
    [71],
  ),
  buildMissing: literalOperation(
    "UPDATE semantic.definition_catalogue_build SET state='incomplete',missing_digest=$2,steps=steps+1 WHERE route=0 AND root_digest=$1",
    1,
    1,
    0,
    0,
    [71, 71],
  ),
  stepRelease: literalOperation('RELEASE SAVEPOINT catalogue_step', 0, 0, 0, 0, []),
  buildProgress: literalOperation(
    'UPDATE semantic.definition_catalogue_build SET state=$2,missing_digest=NULL,error=NULL,steps=steps+1,indexed_rows=indexed_rows+$3,examined_bytes=examined_bytes+$4 WHERE route=0 AND root_digest=$1',
    1,
    1,
    0,
    0,
    [71, 10, 3, 7],
  ),
  stepRollback: literalOperation('ROLLBACK TO SAVEPOINT catalogue_step', 0, 0, 0, 0, []),
  buildRefused: literalOperation(
    "UPDATE semantic.definition_catalogue_build SET state='refused',error=$2,steps=steps+1,examined_bytes=examined_bytes+$3 WHERE route=0 AND root_digest=$1",
    1,
    1,
    0,
    0,
    [71, 8192, 7],
  ),
} as const);
export type CataloguePublisherOperation = keyof typeof CATALOGUE_PUBLISHER_OPERATIONS;

/** pg sends Buffer parameters in binary and other scalar/JSON parameters in text.
 * Count that exact representation rather than JSON.stringify(Buffer)'s integer array.
 */
export function catalogueParameterBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  // pg's arrayString quotes elements and escapes backslash/quote. Native batches
  // additionally restrict these strings to 100 digest keys before dispatch.
  if (Array.isArray(value)) {
    const arrayString = (items: readonly unknown[]): string =>
      '{' +
      items
        .map((item) => {
          if (item === null || item === undefined) return 'NULL';
          if (Array.isArray(item)) return arrayString(item);
          if (typeof item !== 'string') throw new TypeError('Unsupported catalogue array representation');
          return '"' + item.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
        })
        .join(',') +
      '}';
    return Buffer.byteLength(arrayString(value));
  }
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return Buffer.byteLength(String(value));
  return Buffer.byteLength(JSON.stringify(value));
}
export function catalogueOperationCost(
  id: CataloguePublisherOperation,
  params: readonly unknown[] = [],
): WorkDimensions {
  const operation = CATALOGUE_PUBLISHER_OPERATIONS[id];
  if (!operation || params.length !== operation.parameterMaxima.length)
    throw new TypeError('Unknown catalogue operation or parameter arity');
  let inputBytes = 0;
  params.forEach((param, index) => {
    const bytes = catalogueParameterBytes(param);
    if (bytes > operation.parameterMaxima[index]!)
      throw new TypeError(`Catalogue ${id} parameter exceeds its representation bound`);
    // Bind/length/format fields: four-byte length and two-byte format per parameter.
    inputBytes += bytes + 6;
  });
  return Object.freeze({
    ...operation.bound,
    bytes: operation.bound.bytes + Buffer.byteLength(operation.sql) + inputBytes,
  });
}
/** Additive package only. Core owns framework/auth/outbox/bootstrap.
 * These components describe the bounded catalogue body. Multiplicities below come
 * from ONE executable step: 256 node entries, 64 members or 64 labels.
 */
export const CATALOGUE_PUBLISHER_PATHS = Object.freeze({
  artifactNew: Object.freeze(['artifactInsert'] as const),
  artifactDuplicate: Object.freeze(['artifactInsert', 'artifactConflict'] as const),
  buildNew: Object.freeze(['artifactRead', 'buildInsert', 'firstTask', 'buildNext', 'buildStatus'] as const),
  buildDuplicate: Object.freeze(['artifactRead', 'buildInsert', 'buildStatus'] as const),
  missing: Object.freeze([
    'buildLock',
    'stepSavepoint',
    'nodeTask',
    'artifactSize',
    'buildMissing',
    'stepRelease',
    'buildStatus',
  ] as const),
  refused: Object.freeze(['stepRollback', 'stepRelease', 'buildRefused', 'buildStatus'] as const),
  node: Object.freeze({
    prefix: Object.freeze(['buildLock', 'stepSavepoint', 'nodeTask', 'artifactSize', 'artifactRead'] as const),
    repeated: Object.freeze(['branchTask'] as const),
    repetitions: 256,
    suffix: Object.freeze(['nodeProgress', 'taskDone', 'buildProgress', 'stepRelease', 'buildStatus'] as const),
  }),
  leaf: Object.freeze({
    prefix: Object.freeze(['buildLock', 'stepSavepoint', 'nodeTask', 'artifactSize', 'artifactRead'] as const),
    repeated: Object.freeze(['leafTask'] as const),
    repetitions: 256,
    suffix: Object.freeze(['nodeProgress', 'taskDone', 'buildProgress', 'stepRelease', 'buildStatus'] as const),
  }),
  release: Object.freeze({
    prefix: Object.freeze([
      'buildLock',
      'stepSavepoint',
      'nodeTask',
      'phaseRelease',
      'releaseTask',
      'artifactSize',
      'artifactRead',
      'identityUpsert',
    ] as const),
    repeated: Object.freeze(['identityUpsert', 'memberInsert'] as const),
    repetitions: 64,
    suffix: Object.freeze(['taskOffset', 'releaseProgress', 'buildProgress', 'stepRelease', 'buildStatus'] as const),
  }),
  declaration: Object.freeze({
    prefix: Object.freeze([
      'buildLock',
      'stepSavepoint',
      'nodeTask',
      'phaseRelease',
      'releaseTask',
      'phaseDeclaration',
      'declarationTask',
      'artifactSize',
      'artifactRead',
      'typeClosure',
      'profileClosure',
      'typeClosure',
      'profileClosure',
      'kindInsert',
    ] as const),
    repeated: Object.freeze(['labelInsert'] as const),
    repetitions: 64,
    suffix: Object.freeze([
      'taskOffset',
      'declarationProgress',
      'buildProgress',
      'stepRelease',
      'buildStatus',
    ] as const),
  }),
});

export const CATALOGUE_WORK_AXES = Object.freeze([
  'candidateKeys',
  'identityMetadataRows',
  'nativeRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
] as const satisfies readonly (keyof WorkDimensions)[]);
function ledgerOperation(
  sql: string,
  rows: number,
  points: number,
  keys: number,
  bytes: number,
  parameters: Readonly<Record<string, number>>,
) {
  return Object.freeze({
    ...literalOperation(sql, rows, points, keys, bytes, Object.values(parameters)),
    parameters: Object.freeze(parameters),
  });
}
/** Original/ticket array operations touch exactly eight axes and at most seven
 * components. No allowance is inferred from a page limit. A retirement page is
 * ONE component; it cannot price the remaining job. Input vectors are PostgreSQL
 * text arrays: braces + 8 sixteen-digit safe integers + 7 commas = 137 bytes.
 */
export const CATALOGUE_LEDGER_OPERATIONS = Object.freeze({
  originalAdmit: ledgerOperation(ledgerOriginalAdmit.sql, 2, 5, 0, 64, {
    original_key: 64,
    root: 71,
    phase: 15,
    input_digest: 32,
    episode: 36,
    deadline: 16,
    admitted: 137,
    position: 20,
  }),
  originalRead: ledgerOperation(ledgerOriginalRead.sql, 1, 1, 0, 768, { original_key: 64 }),
  ticketAdmit: ledgerOperation(ledgerTicketAdmit.sql, 2, 3, 0, 4, {
    original_key: 64,
    slot: 1,
    kind: 13,
    allowance: 137,
  }),
  ticketSpend: ledgerOperation(ledgerTicketSpend.sql, 16, 19, 7, 112, { original_key: 64, transaction_id: 36 }),
  originalTerminal: ledgerOperation(ledgerOriginalTerminal.sql, 2, 4, 0, 64, {
    transaction_id: 36,
    result_digest: 32,
    original_key: 64,
  }),
  position: ledgerOperation(ledgerPosition.sql, 12, 16, 2, 64, { root: 71, original_key: 64, transaction_id: 36 }),
  retirementStart: ledgerOperation(ledgerRetirementStart.sql, 4, 5, 0, 12, { transaction_id: 36, root: 71 }),
  retirementRead: ledgerOperation(ledgerRetirementRead.sql, 1, 1, 0, 100, { root: 71 }),
  retirementCaptures: ledgerOperation(ledgerRetirementCaptures.sql, 100, 1, 100, 16600, { root: 71 }),
  retirementConsumers: ledgerOperation(ledgerRetirementConsumers.sql, 400, 401, 100, 2000, { root: 71 }),
  retirementTickets: ledgerOperation(ledgerRetirementTickets.sql, 22, 24, 7, 476, { root: 71, original_key: 64 }),
  retirementPositions: ledgerOperation(ledgerRetirementPositions.sql, 400, 401, 100, 3600, { root: 71 }),
  retirementProbe: ledgerOperation(ledgerRetirementProbe.sql, 4, 4, 0, 4, { root: 71 }),
  retirementProgress: ledgerOperation(ledgerRetirementProgress.sql, 1, 1, 0, 12, {
    next: 9,
    after: 64,
    sequence: 20,
    root: 71,
    expected: 9,
  }),
  retirementOriginal: ledgerOperation(ledgerRetirementOriginal.sql, 1, 1, 0, 72, { root: 71, after: 64 }),
  headLock: ledgerOperation(ledgerHeadLock.sql, 1, 1, 0, 80, {}),
  rootLock: ledgerOperation(ledgerRootLock.sql, 1, 1, 0, 128, { root: 71 }),
} as const);
export type CatalogueLedgerOperation = keyof typeof CATALOGUE_LEDGER_OPERATIONS;
export function catalogueLedgerCost(
  id: CatalogueLedgerOperation,
  params: Readonly<Record<string, unknown>>,
): WorkDimensions {
  const operation = CATALOGUE_LEDGER_OPERATIONS[id];
  if (!operation) throw new TypeError('Unknown catalogue ledger operation');
  const maxima: Readonly<Record<string, number>> = operation.parameters;
  if (Object.keys(params).length !== Object.keys(maxima).length || Object.keys(params).some((key) => !(key in maxima)))
    throw new TypeError('Unknown catalogue ledger parameters');
  let bytes = Buffer.byteLength(operation.sql);
  for (const [key, max] of Object.entries(maxima)) {
    const length = catalogueParameterBytes(params[key]);
    if (length > max) throw new TypeError(`Catalogue ${id}.${key} exceeds its representation bound`);
    bytes += length + 6;
  }
  return Object.freeze({ ...operation.bound, bytes: operation.bound.bytes + bytes });
}

export const CATALOGUE_NATIVE_OPERATIONS = Object.freeze({
  withdrawalAck: Object.freeze({
    sql: nativeWithdrawalAck.sql,
    bound: CATALOGUE_BODY_COST.withdrawalAck,
    parameters: Object.freeze({
      root: 71,
      activation_id: 36,
      slot: 3,
      previous: 71,
      id: 71,
      sequence: 20,
      generation: 20,
      consumer: 8192,
      provenance: 8192,
      dependency: 65536,
      enrollment_generation: 20,
      receipt: 8192,
      owner: 1024,
      restore: 1024,
    }),
  }),
  registerRoot: Object.freeze({
    sql: nativeregisterRoot.sql,
    bound: CATALOGUE_BODY_COST.registerRoot,
    parameters: Object.freeze({ root: 71, transaction_id: 36 }),
  }),
  headLock: Object.freeze({
    sql: nativeheadLock.sql,
    bound: CATALOGUE_BODY_COST.headLock,
    parameters: Object.freeze({}),
  }),
  rootLock: Object.freeze({
    sql: nativerootLock.sql,
    bound: CATALOGUE_BODY_COST.rootLock,
    parameters: Object.freeze({ root: 71 }),
  }),
  consumerRead: Object.freeze({
    sql: nativeconsumerRead.sql,
    bound: CATALOGUE_BODY_COST.consumerRead,
    parameters: Object.freeze({ root: 71, id: 71 }),
  }),
  enroll: Object.freeze({
    sql: nativeenroll.sql,
    bound: CATALOGUE_BODY_COST.enroll,
    parameters: Object.freeze({
      root: 71,
      id: 71,
      consumer: 8192,
      provenance: 8192,
      dependency: 65536,
      generation: 20,
    }),
  }),
  activationRead: Object.freeze({
    sql: nativeactivationRead.sql,
    bound: CATALOGUE_BODY_COST.activationRead,
    parameters: Object.freeze({ root: 71 }),
  }),
  activationRequest: Object.freeze({
    sql: nativeactivationRequest.sql,
    bound: CATALOGUE_BODY_COST.activationRequest,
    parameters: Object.freeze({ root: 71, activation_id: 36, previous: 71, head: 10, transaction_id: 36 }),
  }),
  closeRoot: Object.freeze({
    sql: nativecloseRoot.sql,
    bound: CATALOGUE_BODY_COST.closeRoot,
    parameters: Object.freeze({ root: 71, generation: 20 }),
  }),
  activationClosing: Object.freeze({
    sql: nativeactivationClosing.sql,
    bound: CATALOGUE_BODY_COST.activationClosing,
    parameters: Object.freeze({ root: 71, activation_id: 36 }),
  }),
  activationCut: Object.freeze({
    sql: nativeactivationCut.sql,
    bound: CATALOGUE_BODY_COST.activationCut,
    parameters: Object.freeze({ root: 71, activation_id: 36, generation: 20, sequence: 20 }),
  }),
  frontierPoint: Object.freeze({
    sql: nativefrontierPoint.sql,
    bound: CATALOGUE_BODY_COST.frontierPoint,
    parameters: Object.freeze({ root: 71 }),
  }),
  frontierStage: Object.freeze({
    sql: nativefrontierStage.sql,
    bound: CATALOGUE_BODY_COST.frontierStage,
    parameters: Object.freeze({ root: 71, activation_id: 36, previous: 71, generation: 20, through: 20, after: 20 }),
  }),
  frontierRead: Object.freeze({
    sql: nativefrontierRead.sql,
    bound: CATALOGUE_BODY_COST.frontierRead,
    parameters: Object.freeze({ root: 71, previous: 71 }),
  }),
  activationCAS: Object.freeze({
    sql: nativeactivationCAS.sql,
    bound: CATALOGUE_BODY_COST.activationCAS,
    parameters: Object.freeze({ root: 71, activation_id: 36, previous: 71, head: 10, transaction_id: 36 }),
  }),
});
const nativeReadLiterals: readonly (readonly [string, WorkDimensions])[] = [
  [
    'SELECT id_key,declaration_digest,body FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND id_key=ANY($2::text[])',
    CATALOGUE_BODY_COST.kindBodies,
  ],
  ['SELECT root_digest,head FROM semantic.definition_catalogue_head WHERE route=0', CATALOGUE_BODY_COST.headRead],
  [
    'SELECT octet_length(body::text) AS size FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND id_key=ANY($2::text[])',
    CATALOGUE_BODY_COST.kindSizes,
  ],
  [
    'SELECT precedence,exact_type_id,eligible FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND ordinal=$2',
    CATALOGUE_BODY_COST.boundary,
  ],
  [
    'SELECT id_key,ordinal,octet_length(body::text) AS size,precedence FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND exact_type_key=$2 AND eligible AND precedence=$3 AND ordinal>$4 ORDER BY precedence DESC,ordinal LIMIT $5',
    CATALOGUE_BODY_COST.candidateRange,
  ],
  [
    'SELECT id_key,ordinal,octet_length(body::text) AS size,precedence FROM semantic.definition_catalogue_kind WHERE route=0 AND root_digest=$1 AND exact_type_key=$2 AND eligible AND precedence<$3 ORDER BY precedence DESC,ordinal LIMIT $4',
    CATALOGUE_BODY_COST.candidateRange,
  ],
  [
    'SELECT state FROM semantic.definition_catalogue_build WHERE route=0 AND root_digest=$1',
    CATALOGUE_BODY_COST.buildRead,
  ],
];

/** Bounded control inputs plus their canonical/decoded output. These are body
 * components, not a command/framework envelope. Native identity/SQL work is zero
 * for these pure operations; each reached query has its separate declaration.
 */
const controlOperation = (bytes: number) =>
  Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes,
    emptySeeks: 0,
  } satisfies WorkDimensions);
export const CATALOGUE_PUBLISHER_CONTROLS = Object.freeze({
  artifactDecode: controlOperation(2 * 4194304),
  artifactValidate: controlOperation(4194304),
  rootDecode: controlOperation(2 * 262144),
  nodeDecode: controlOperation(2 * 262144),
  releaseDecode: controlOperation(2 * 4194304),
  declarationDecode: controlOperation(2 * 65536),
  memberIdentity: controlOperation(2 * 4194304),
  // Input canonicalization, identity encoding and digest; bounded result
  // canonicalization and output copy. No native IO occurs in either component.
  mechanicalInput: controlOperation(3 * CATALOGUE_MECHANICAL_REPRESENTATION.inputBytes),
  mechanicalResult: controlOperation(
    3 * CATALOGUE_MECHANICAL_REPRESENTATION.inputBytes + 2 * CATALOGUE_MECHANICAL_REPRESENTATION.resultBytes,
  ),
});

/** Local control representation only: immutable input plus bounded decoded/canonical
 * output. The 256-byte lifecycle tuple covers root(71), activation/transaction
 * UUIDs(72), action(21), Global ID(36), partition/head(24), deadline(16), framing(16).
 * Source adapters own their documented static native read/withdrawal bounds.
 */
export const CATALOGUE_NATIVE_CONTROLS = Object.freeze({
  lifecycleIdentity: controlOperation(256),
});
