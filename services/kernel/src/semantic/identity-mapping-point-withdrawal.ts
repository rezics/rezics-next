import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import { IdentityEpochStoreError } from './contract/identity-errors.ts';
import begin from './identity-mapping-point-withdraw-begin.sql';
import complete from './identity-mapping-point-withdraw-complete.sql';

export type IdentityMappingPointInput = Readonly<{
  terminal: string;
  generation: string;
  basisVersion: string;
  controlPartition: number;
  ownerEpoch: number;
}>;
export type IdentityMappingPointFrame = Readonly<{
  job: IdentityJobRef;
  unit: number;
  scopeDigest: string;
  planDigest: string;
  original: string;
  inputs: readonly IdentityMappingPointInput[];
}>;
type Work = { statements: number; points: number; rows: number; bytes: number };
type BeginRow = {
  status: string;
  control_group: string | null;
  generation: string | null;
  incarnation: string | null;
  owner_epoch: number | null;
  basis_version: string | null;
  source_image: Uint8Array | null;
};
type Binding = Readonly<{
  home: number;
  job: string;
  epoch: string;
  unit: number;
  scope: string;
  plan: string;
  frame: string;
  route: number;
  original: string;
  controlGroup: string;
  generation: string;
  incarnation: string;
  ownerEpoch: number;
  basisVersion: string;
  sourceImage: Uint8Array;
}>;
const bindings = new WeakMap<CommandTransaction, Map<string, Binding>>();
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

async function query<Row extends Record<string, unknown>>(
  tx: CommandTransaction,
  text: string,
  values: unknown[],
  work?: Work,
) {
  if (work) {
    work.statements++;
    work.bytes += Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(values));
  }
  const result = await tx.query<Row>(text, values);
  if (work) {
    work.points += result.rows.length;
    work.rows += result.rows.length;
    work.bytes += Buffer.byteLength(JSON.stringify(result.rows));
  }
  return result;
}

/** Local records prove the input pin. Caller references only identify which native basis to check. */
export async function beginIdentityMappingPointWithdrawal(
  tx: CommandTransaction,
  input: IdentityMappingPointFrame,
  work?: Work,
): Promise<'legacy' | 'withdrawn'> {
  const command = currentCommand(tx);
  const route = routeOf(input.original);
  if (command.basis !== null || route === null || partitionOf(route) !== command.partition)
    throw unavailable('Point withdrawal requires the actual local mechanical command');
  if (!Number.isSafeInteger(input.unit) || input.unit<1 || input.job.epoch<=0n
    || !/^[0-9a-f]{64}$/.test(input.scopeDigest) || !/^[0-9a-f]{64}$/.test(input.planDigest)
    || input.inputs.length<1 || input.inputs.length>2)
    throw new TypeError('Invalid native point-withdrawal frame');
  const frame = {
    home: command.partition,job: input.job.jobId,epoch: input.job.epoch.toString(),unit: input.unit,
    scope: input.scopeDigest,plan: input.planDigest,frame: command.transactionId,route,original: input.original,
  };
  const prior = bindings.get(tx)?.get(input.original);
  if (prior) {
    if (prior.frame!==frame.frame || prior.job!==frame.job || prior.epoch!==frame.epoch
      || prior.unit!==frame.unit || prior.scope!==frame.scope || prior.plan!==frame.plan)
      throw unavailable('Point mutation belongs to another native unit');
    return 'withdrawn';
  }
  const inputs = input.inputs.map((basis) => ({
    terminal: basis.terminal,generation: basis.generation,basis_version: basis.basisVersion,
    control_partition: basis.controlPartition,owner_epoch: basis.ownerEpoch,
  }));
  const row = (await query<BeginRow>(tx,begin.sql,[
    frame.home,frame.job,frame.epoch,frame.unit,frame.scope,frame.plan,frame.frame,frame.route,frame.original,
    JSON.stringify(inputs),
  ],work)).rows[0];
  if (row?.status==='legacy') return 'legacy';
  if (row?.status==='foreign-control')
    throw unavailable('Foreign active Source requires bound native control-home evidence');
  if (row?.status!=='withdrawn' || row.control_group===null || row.generation===null || row.incarnation===null
    || row.owner_epoch===null || row.basis_version===null || !(row.source_image instanceof Uint8Array)
    || row.source_image.byteLength!==32)
    throw unavailable('Local active Source lacks exact point-withdrawal custody');
  const held = bindings.get(tx) ?? new Map<string,Binding>();
  held.set(frame.original,Object.freeze({
    ...frame,controlGroup: row.control_group,generation: row.generation,incarnation: row.incarnation,
    ownerEpoch: row.owner_epoch,basisVersion: row.basis_version,sourceImage: new Uint8Array(row.source_image),
  }));
  bindings.set(tx,held);
  return 'withdrawn';
}

/** Retire only this live command's point binding; native output enrollment still owns activation. */
export async function completeIdentityMappingPointWithdrawal(
  tx: CommandTransaction,
  original: string,
  work?: Work,
): Promise<void> {
  const command = currentCommand(tx);
  const held = bindings.get(tx)?.get(original);
  if (!held || command.transactionId!==held.frame || command.partition!==held.home || command.basis!==null)
    throw unavailable('Point completion requires its exact live native binding');
  const row = (await query<{completed: boolean}>(tx,complete.sql,[
    held.home,held.job,held.epoch,held.unit,held.scope,held.plan,held.frame,held.route,held.original,
    held.controlGroup,held.generation,held.incarnation,held.ownerEpoch,held.basisVersion,
  ],work)).rows[0];
  if (row?.completed!==true) throw unavailable('Point completion custody changed');
  bindings.get(tx)!.delete(original);
}
