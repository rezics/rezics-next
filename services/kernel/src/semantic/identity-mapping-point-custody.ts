import type { Pool } from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { IDENTITY_EPOCH_PROGRESS } from './events.ts';
import { IdentityEpochStoreError } from './contract/identity-errors.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import { recordIdentityEpochNativeCommit } from './identity-adapters/native-commit.ts';
import { serializeIdentityValue as json } from './identity-core/index.ts';
import { withReadTransaction } from './read.ts';
import { bindSemanticProducerRoles, type SemanticCopyRole } from './erasure-producer.ts';
import proof from './identity-mapping-point-control-proof.sql';
import proofRead from './identity-mapping-point-control-proof-read.sql';
import depositSql from './identity-mapping-point-custody-deposit.sql';
import depositRead from './identity-mapping-point-custody-deposit-read.sql';

export type IdentityMappingPointControlProof = Readonly<{
  controlPartition: number;
  jobId: string;
  jobEpoch: string;
  scopeDigest: string;
  route: number;
  original: string;
  terminal: string;
  generation: string;
  incarnation: string;
  basisVersion: string;
  ownerEpoch: number;
  enrollment: string;
  sourceRevision: string;
  sourceEpoch: number;
  exportTransaction: string;
  preparedTransactionId: string;
  preparedEpoch: number;
  preparedPosition: string;
  acquiredTransactionId: string;
  acquiredEpoch: number;
  acquiredPosition: string;
  registrationTransactionId: string;
  registrationEpoch: number;
  registrationPosition: string;
  registrationXid: string;
  installTransactionId: string;
  transactionId: string;
  epoch: number;
  position: string;
}>;
type Work = { statements: number; points: number; bytes: number };
type ProofName = Readonly<{
  job: IdentityJobRef;
  scopeDigest: string;
  original: string;
  terminal: string;
  generation: string;
  basisVersion: string;
  controlPartition: number;
  ownerEpoch: number;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

async function measuredQuery(tx: CommandTransaction, measured: Work, text: string, values: unknown[]) {
  measured.statements++;
  measured.bytes += Buffer.byteLength(json(values));
  const result = await tx.query<Record<string, unknown>>(text, values);
  measured.points += result.rowCount ?? 0;
  measured.bytes += Buffer.byteLength(json(result.rows));
  return result;
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw unavailable(`Committed control proof lacks ${label}`);
  return value;
}
function int4(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && INTEGER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw unavailable(`Committed control proof lacks ${label}`);
  return parsed;
}
function int8(value: unknown, label: string): string {
  if (typeof value === 'string' && INTEGER.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw unavailable(`Committed control proof lacks ${label}`);
}
function field(row: object, key: string): unknown {
  const found = Object.getOwnPropertyDescriptor(row, key);
  if (!found || !Object.hasOwn(row, key)) throw unavailable(`Committed control proof lacks ${key}`);
  return found.value;
}
function names(input: ProofName): unknown[] {
  const route = routeOf(input.original);
  if (
    !Number.isSafeInteger(input.controlPartition) || input.controlPartition < 0 || input.controlPartition > 4095
    || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0
    || input.job.epoch <= 0n || !/^[0-9a-f]{64}$/.test(input.scopeDigest) || !INTEGER.test(input.basisVersion)
    || !UUID.test(input.job.jobId) || !UUID.test(input.terminal) || !UUID.test(input.generation)
    || route === null
  )
    throw new TypeError('Invalid native control-proof name');
  if (partitionOf(route) === input.controlPartition) throw unavailable('Control proof requires a foreign control home');
  return [
    input.controlPartition, input.job.jobId, input.job.epoch.toString(), input.scopeDigest, route, input.original,
    input.terminal, input.generation, input.basisVersion, input.ownerEpoch,
  ];
}
function committedProof(row: object): IdentityMappingPointControlProof {
  const scopeDigest = field(row, 'scope_digest');
  const registrationXid = field(row, 'registration_xid');
  const route = int4(field(row, 'route'), 'route');
  const controlPartition = int4(field(row, 'partition_no'), 'partition');
  if (typeof scopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(scopeDigest))
    throw unavailable('Committed control proof lacks scope');
  if (typeof registrationXid !== 'string' || registrationXid.length === 0)
    throw unavailable('Committed control proof lacks registration xid');
  if (route < 0 || route > 65535 || controlPartition < 0 || controlPartition > 4095 || partitionOf(route) === controlPartition)
    throw unavailable('Committed control proof names the source home');
  return Object.freeze({
    controlPartition,
    jobId: uuid(field(row, 'job_id'), 'job'),
    jobEpoch: int8(field(row, 'job_epoch'), 'job epoch'),
    scopeDigest,
    route,
    original: uuid(field(row, 'original'), 'original'),
    terminal: uuid(field(row, 'terminal'), 'terminal'),
    generation: uuid(field(row, 'generation'), 'generation'),
    incarnation: uuid(field(row, 'incarnation'), 'incarnation'),
    basisVersion: int8(field(row, 'basis_version'), 'basis'),
    ownerEpoch: int4(field(row, 'owner_epoch'), 'control owner epoch'),
    enrollment: uuid(field(row, 'enrollment'), 'enrollment'),
    sourceRevision: int8(field(row, 'source_revision'), 'source revision'),
    sourceEpoch: int4(field(row, 'source_epoch'), 'source epoch'),
    exportTransaction: uuid(field(row, 'export_transaction'), 'export'),
    preparedTransactionId: uuid(field(row, 'prepared_transaction_id'), 'prepared transaction'),
    preparedEpoch: int4(field(row, 'prepared_epoch'), 'prepared epoch'),
    preparedPosition: int8(field(row, 'prepared_position'), 'prepared position'),
    acquiredTransactionId: uuid(field(row, 'acquired_transaction_id'), 'acquired transaction'),
    acquiredEpoch: int4(field(row, 'acquired_epoch'), 'acquired epoch'),
    acquiredPosition: int8(field(row, 'acquired_position'), 'acquired position'),
    registrationTransactionId: uuid(field(row, 'registration_transaction_id'), 'registration transaction'),
    registrationEpoch: int4(field(row, 'registration_epoch'), 'registration epoch'),
    registrationPosition: int8(field(row, 'registration_position'), 'registration position'),
    registrationXid,
    installTransactionId: uuid(field(row, 'install_transaction_id'), 'install transaction'),
    transactionId: uuid(field(row, 'transaction_id'), 'transaction'),
    epoch: int4(field(row, 'native_epoch'), 'commit epoch'),
    position: int8(field(row, 'native_position'), 'commit position'),
  });
}

/** A foreign member has either a re-read committed proof or no terminal closure enrollment. */
async function recordIdentityMappingPointControlProof(
  pool: Pool,
  measured: Work,
  input: ProofName,
  roles: readonly SemanticCopyRole[],
): Promise<IdentityMappingPointControlProof | null> {
  const pin = names(input);
  const outcome = await runCommand(pool, { partition: input.controlPartition, deadline: Date.now() + 5000 }, async (tx, { transactionId }) => {
    const command = currentCommand(tx);
    if (command.basis !== null || command.partition !== input.controlPartition || command.transactionId !== transactionId)
      throw unavailable('Control proof requires its own mechanical command');
    const result = await measuredQuery(tx, measured, proof.sql, [...pin, transactionId]);
    const row = result.rows[0];
    if (
      result.rows.length === 1 &&
      row?.kind === 'unregistered' &&
      row.transaction_id === null &&
      row.inserted === null
    ) return noEffect(null);
    if (result.rows.length !== 1 || row?.kind !== 'registered' || typeof row.inserted !== 'boolean')
      throw unavailable('Control-home point proof is not current');
    const stored = uuid(row.transaction_id, 'transaction');
    if (row.inserted) {
      if (stored !== transactionId) throw unavailable('Control-home point proof is not current');
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, 'mapping');
      return {
        value: stored,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: input.controlPartition, generation: input.job.epoch.toString() } }],
      };
    }
    if (stored === transactionId) throw unavailable('Control-home point proof is not current');
    return noEffect(stored);
  });
  if (outcome.value === null) return null;
  const stored = typeof outcome.value === 'string' ? outcome.value : '';
  const visible = await withReadTransaction(pool, async (tx) => {
    const result = await measuredQuery(tx, measured, proofRead.sql, pin);
    return result.rows.length === 1 ? result.rows[0] : undefined;
  });
  if (visible === undefined || uuid(stored, 'transaction') !== uuid(field(visible, 'transaction_id'), 'transaction'))
    throw unavailable('Committed control proof is not visible');
  const committed = committedProof(visible);
  if (
    committed.controlPartition !== input.controlPartition || committed.jobId !== input.job.jobId
    || committed.jobEpoch !== input.job.epoch.toString() || committed.scopeDigest !== input.scopeDigest
    || committed.original !== input.original || committed.route !== routeOf(input.original)
    || committed.terminal !== input.terminal || committed.generation !== input.generation
    || committed.basisVersion !== input.basisVersion
    || committed.ownerEpoch !== input.ownerEpoch || committed.transactionId !== stored
  )
    throw unavailable('Committed control proof no longer matches its name');
  return committed;
}

type AdmittedInput = Readonly<{
  terminal: string;
  generation: string;
  basisVersion: string;
  controlPartition: number;
  ownerEpoch: number;
}>;
function depositPin(home: number, committed: IdentityMappingPointControlProof): unknown[] {
  return [
    home, committed.jobId, committed.jobEpoch, committed.scopeDigest, committed.route, committed.original,
    committed.terminal, committed.generation, committed.incarnation, committed.basisVersion, committed.ownerEpoch,
    committed.controlPartition, committed.enrollment, committed.sourceRevision, committed.sourceEpoch,
    committed.exportTransaction, committed.preparedTransactionId, committed.preparedEpoch, committed.preparedPosition,
    committed.acquiredTransactionId, committed.acquiredEpoch, committed.acquiredPosition,
    committed.registrationTransactionId, committed.registrationEpoch, committed.registrationPosition,
    committed.registrationXid, committed.installTransactionId, committed.controlPartition, committed.transactionId,
    committed.epoch, committed.position,
  ];
}
async function depositIdentityMappingPointCustody(
  pool: Pool,
  measured: Work,
  committed: IdentityMappingPointControlProof,
  roles: readonly SemanticCopyRole[],
): Promise<void> {
  const home = partitionOf(committed.route);
  if (home === committed.controlPartition) throw unavailable('Source deposit requires a foreign control home');
  const pin = depositPin(home, committed);
  const outcome = await runCommand(pool, { partition: home, deadline: Date.now() + 5000 }, async (tx, { transactionId }) => {
    const command = currentCommand(tx);
    if (command.basis !== null || command.partition !== home || command.transactionId !== transactionId)
      throw unavailable('Source deposit requires its own mechanical command');
    const result = await measuredQuery(tx, measured, depositSql.sql, [...pin, transactionId]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined || typeof row.inserted !== 'boolean')
      throw unavailable('Source-home point deposit is not current');
    const stored = uuid(row.transaction_id, 'deposit transaction');
    if (row.inserted) {
      if (stored !== transactionId) throw unavailable('Source-home point deposit is not current');
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, 'mapping');
      return {
        value: stored,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: home, generation: committed.jobEpoch } }],
      };
    }
    if (stored === transactionId) throw unavailable('Source-home point deposit is not current');
    return noEffect(stored);
  });
  const stored = typeof outcome.value === 'string' ? outcome.value : '';
  const visible = await withReadTransaction(pool, async (tx) => {
    const result = await measuredQuery(tx, measured, depositRead.sql, pin);
    return result.rows.length === 1 ? result.rows[0] : undefined;
  });
  if (visible === undefined || uuid(stored, 'deposit transaction') !== uuid(field(visible, 'transaction_id'), 'deposit transaction'))
    throw unavailable('Committed source deposit is not visible');
}

/** Checks foreign control custody and reports when the member has never been enrolled. */
export async function bindForeignMappingPointCustody(
  pool: Pool,
  measured: Work,
  input: Readonly<{
    job: IdentityJobRef;
    scopeDigest: string;
    original: string;
    previousTerminal: string;
    inputs: readonly AdmittedInput[];
  }>,
  roles: readonly SemanticCopyRole[],
): Promise<boolean> {
  if (input.inputs.length < 1 || input.inputs.length > 2) throw new TypeError('Invalid native point custody inputs');
  const named = input.inputs.filter((basis) => basis.terminal === input.previousTerminal);
  if (named.length > 1) throw unavailable('Point custody has no single admitted input');
  const basis = named[0];
  const route = routeOf(input.original);
  if (route === null) throw new TypeError('Invalid native point custody original');
  if (basis === undefined || partitionOf(route) === basis.controlPartition) return false;
  const committed = await recordIdentityMappingPointControlProof(pool, measured, {
    job: input.job,
    scopeDigest: input.scopeDigest,
    original: input.original,
    terminal: basis.terminal,
    generation: basis.generation,
    basisVersion: basis.basisVersion,
    controlPartition: basis.controlPartition,
    ownerEpoch: basis.ownerEpoch,
  }, roles);
  if (committed === null) return true;
  await depositIdentityMappingPointCustody(pool, measured, committed, roles);
  return false;
}
