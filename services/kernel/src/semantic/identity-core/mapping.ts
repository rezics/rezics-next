import type { IdentityJobRef, IdentityMapping } from './values.ts';
import { serializeIdentityValue } from './encoding.ts';

type Integer = string | number | bigint;
export type IdentityOwnerEvidence = Readonly<{
  partition_no: number;
  epoch: number;
  position?: Integer;
  write_state: string;
}>;
export type IdentitySourceEvidence = Readonly<{
  subject_id: string;
  original: string | null;
  control_partition: number | null;
  control_group: string | null;
  epoch: Integer;
  owner_epoch: number;
  dirty_revision: Integer;
  captured_revision: Integer;
  terminal: string;
  closure_state: string;
  closure_immediate: string | null;
  current_target: string | null;
  source_revision: Integer;
  closure_enrollment: string | null;
  closure_generation: string | null;
  closure_incarnation: string | null;
  closure_install_transaction: string | null;
  closure_registration_transaction: string | null;
  closure_export_transaction: string | null;
}>;
export type IdentityPendingEvidence = Readonly<{
  partition_no: number;
  terminal: string;
  pending_job: string | null;
  pending_epoch: Integer;
}>;
export type IdentityControlEvidence = Readonly<{
  partition_no: number;
  terminal: string;
  requested_original: string;
  redirected: boolean;
  owner_epoch: number;
  closure_state: string;
  directory_state: string | null;
  directory_enrollment: string | null;
  generation: string;
  closure_incarnation: string | null;
  directory_incarnation: string | null;
  directory_install: string | null;
  registration_transaction: string | null;
  directory_export: string | null;
  directory_owner: number | null;
  directory_revision: Integer | null;
  published_epoch: Integer;
}>;
export type IdentityMappingEvidence = Readonly<{
  sourceOwners: readonly IdentityOwnerEvidence[];
  sourceRows: readonly IdentitySourceEvidence[];
  controlOwners: readonly IdentityOwnerEvidence[];
  pendingRows: readonly IdentityPendingEvidence[];
  currentRows: readonly IdentityControlEvidence[];
}>;
export type IdentityMappingRequest = Readonly<{ original: string; sourceHome: number }>;

function firstBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  const result = new Map<K, T>();
  for (const row of rows) if (!result.has(key(row))) result.set(key(row), row);
  return result;
}
function groupByHome<T extends { partition_no: number; terminal: string }>(
  rows: readonly T[],
): Map<number, Map<string, T>> {
  const result = new Map<number, Map<string, T>>();
  for (const row of rows) {
    let home = result.get(row.partition_no);
    if (!home) result.set(row.partition_no, (home = new Map()));
    if (!home.has(row.terminal)) home.set(row.terminal, row);
  }
  return result;
}

export const comparableIdentityEvidence = (value: IdentityMappingEvidence) =>
  serializeIdentityValue({
    ...value,
    sourceOwners: value.sourceOwners.map(({ position: _position, ...owner }) => owner),
    controlOwners: value.controlOwners.map(({ position: _position, ...owner }) => owner),
  });

/** Classifies only acquired bounded evidence; never acquires facts or native authority. */
export function classifyIdentityMappings(
  requests: readonly IdentityMappingRequest[],
  evidence: IdentityMappingEvidence,
  installedJob: IdentityJobRef | null = null,
): IdentityMapping[] {
  if (requests.length > 100) throw new RangeError('Identity page must contain at most 100 originals');
  const { sourceOwners, sourceRows, controlOwners, pendingRows, currentRows } = evidence;

  const sourceOwnerByHome = firstBy(sourceOwners, (row) => row.partition_no);
  const sourceByOriginal = firstBy(sourceRows, (row) => row.subject_id);
  const controlOwnerByHome = firstBy(controlOwners, (row) => row.partition_no);
  const claimByHome = groupByHome(pendingRows);
  const basisByHome = new Map<number, Map<string, Map<string, IdentityControlEvidence>>>();
  for (const row of currentRows) {
    let home = basisByHome.get(row.partition_no);
    if (!home) basisByHome.set(row.partition_no, (home = new Map()));
    let group = home.get(row.terminal);
    if (!group) home.set(row.terminal, (group = new Map()));
    if (!group.has(row.requested_original)) group.set(row.requested_original, row);
  }
  return requests.map(({ original }, index): IdentityMapping => {
    const sourceOwner = sourceOwnerByHome.get(requests[index]!.sourceHome);
    if (!sourceOwner) return { state: 'unavailable', reason: 'missing-owner' };
    if (sourceOwner.write_state !== 'active')
      return { state: 'unavailable', reason: sourceOwner.write_state === 'moved' ? 'moved-owner' : 'bootstrap' };
    const source = sourceByOriginal.get(original);
    if (!source) return { state: 'absent' };
    if (
      !source.original ||
      source.control_partition === null ||
      !source.control_group ||
      BigInt(source.epoch) <= 0n ||
      source.owner_epoch !== sourceOwner.epoch ||
      BigInt(source.dirty_revision) > BigInt(source.captured_revision) ||
      source.control_group !== source.terminal ||
      (source.closure_state === 'active'
        ? source.closure_immediate !== (source.current_target ?? original) ||
          BigInt(source.source_revision) !== BigInt(source.dirty_revision)
        : source.closure_state !== 'legacy' ||
          (source.terminal === original ? source.current_target !== null : source.current_target !== source.terminal))
    )
      return { state: 'unavailable', reason: 'bootstrap' };
    const controlOwner = controlOwnerByHome.get(source.control_partition);
    if (!controlOwner) return { state: 'unavailable', reason: 'missing-owner' };
    if (controlOwner.write_state !== 'active')
      return { state: 'unavailable', reason: controlOwner.write_state === 'moved' ? 'moved-owner' : 'bootstrap' };
    const basis = basisByHome.get(source.control_partition)?.get(source.control_group)?.get(original);
    if (
      !basis ||
      basis.redirected ||
      basis.owner_epoch !== controlOwner.epoch ||
      basis.closure_state !== 'open' ||
      (source.closure_state === 'active' &&
        (basis.directory_state !== 'installed' ||
          basis.directory_enrollment !== source.closure_enrollment ||
          basis.generation !== source.closure_generation ||
          basis.closure_incarnation !== source.closure_incarnation ||
          basis.directory_incarnation !== source.closure_incarnation ||
          basis.directory_install !== source.closure_install_transaction ||
          basis.registration_transaction !== source.closure_registration_transaction ||
          basis.directory_export !== source.closure_export_transaction ||
          basis.directory_owner !== source.owner_epoch ||
          BigInt(basis.directory_revision ?? -1) !== BigInt(source.source_revision)))
    )
      return { state: 'unavailable', reason: 'bootstrap' };
    const claim = claimByHome.get(source.control_partition)?.get(source.control_group);
    if (claim?.pending_job) {
      const job = installedJob;
      // The actual mapping must already be installed for THIS job, with its ordinary
      // source/owner/dirty/redirect checks above intact. Old mappings cannot borrow
      // a pending destination's identity, and another job never gains availability.
      if (
        job &&
        claim.pending_job === job.jobId &&
        BigInt(claim.pending_epoch) === job.epoch &&
        BigInt(source.epoch) === job.epoch
      )
        return {
          state: 'mapped',
          original,
          terminal: source.terminal,
          epoch: job.epoch,
        };
      return {
        state: 'pending',
        original,
        job: { jobId: claim.pending_job, epoch: BigInt(claim.pending_epoch) },
      };
    }
    return { state: 'mapped', original, terminal: source.terminal, epoch: BigInt(basis.published_epoch) };
  });
}
