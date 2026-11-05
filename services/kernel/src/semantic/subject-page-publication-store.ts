import workHomes from './subject-page-publication-homes.sql';
import generationWitnesses from './subject-page-publication-witnesses.sql';
import deliveryTime from './subject-page-publication-delivery-time.sql';
import saveContinuationStatement from './subject-page-publication-continuation.sql';
import readContinuationStatement from './subject-page-publication-read-continuation.sql';
import type { Source } from '@rezics/definitions/bulk';
import readSourceStatement from './subject-page-publication-read-source.sql';
import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  commandTime,
  currentCommand,
  runCommand,
  type CommandEvent,
  type CommandTransaction,
} from '../command/command.ts';
import { accessCheck, type Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor } from '../request/deadline.ts';
import { globalReadEligibility, subjectReadEligibility } from './eligibility.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { slotView } from './slots.ts';
import { withPublicStatementReader } from './statement-disclosure.ts';
import { readCandidateDisclosure } from './disclosure.ts';
import { candidateSources, fencedIds } from './fences.ts';
import { loadRelated } from './subject.ts';
import { withReadTransaction } from './read.ts';
import locateCandidate from './moderation-read-live-candidate.sql';
import {
  SUBJECT_PAGE_DEPENDENCIES_CHANGED,
  SUBJECT_PAGE_REPAIR_REQUESTED,
  SUBJECT_PAGE_REPAIR_QUEUED,
} from '../events/contracts/semantic.ts';
import readPointStatement from './subject-page-publication-read.sql';
import {
  assertPublicationHome,
  bounded,
  initializeSubjectPagePublicationAt,
  listed,
  lockPoint,
  publishPoint,
  retainSubjectPageSourceAt,
} from './subject-page-publication-writes.ts';
import insertChangeStatement from './subject-page-publication-change.sql';
import installComponentStatement from './subject-page-publication-component.sql';
import readDependenciesStatement from './subject-page-publication-dependencies.sql';
import installDependencyStatement from './subject-page-publication-dependency.sql';
import enqueueStatement from './subject-page-publication-enqueue.sql';
import insertDeliveryStatement from './subject-page-publication-delivery.sql';
import ownerChangeStatement from './subject-page-publication-owner-change.sql';
import retainOwnerStatement from './subject-page-publication-owner-retain.sql';
import readOwnerStatement from './subject-page-publication-owner-read.sql';
import ownerDeltaStatement from './subject-page-publication-owner-delta.sql';
import repairCASStatement from './subject-page-publication-repair-cas.sql';
import fanoutCASStatement from './subject-page-publication-fanout-cas.sql';
import bootstrapCASStatement from './subject-page-publication-bootstrap-cas.sql';
import enqueueBootstrapStatement from './subject-page-publication-enqueue-bootstrap.sql';
import claimSubjectStatement from './subject-page-publication-claim-subject.sql';
import claimFanoutStatement from './subject-page-publication-claim-fanout.sql';
import claimBootstrapStatement from './subject-page-publication-claim-bootstrap.sql';
import replayWindowStatement from './subject-page-publication-replay.sql';
import fanoutWindowStatement from './subject-page-publication-fanout.sql';

const saveContinuation = {
  run: async (...args: Parameters<typeof saveContinuationStatement.run>) =>
    listed(await saveContinuationStatement.run(...args)),
};
const readContinuation = {
  run: async (...args: Parameters<typeof readContinuationStatement.run>) =>
    listed(await readContinuationStatement.run(...args)),
};
const readSource = {
  run: async (...args: Parameters<typeof readSourceStatement.run>) => listed(await readSourceStatement.run(...args)),
};
const readPoint = {
  run: async (...args: Parameters<typeof readPointStatement.run>) => listed(await readPointStatement.run(...args)),
};
const insertChange = {
  run: async (...args: Parameters<typeof insertChangeStatement.run>) =>
    listed(await insertChangeStatement.run(...args)),
};
const installComponent = {
  run: async (...args: Parameters<typeof installComponentStatement.run>) =>
    listed(await installComponentStatement.run(...args)),
};
const readDependencies = {
  run: async (...args: Parameters<typeof readDependenciesStatement.run>) =>
    listed(await readDependenciesStatement.run(...args)),
};
const installDependency = {
  run: async (...args: Parameters<typeof installDependencyStatement.run>) =>
    listed(await installDependencyStatement.run(...args)),
};
const enqueue = {
  run: async (...args: Parameters<typeof enqueueStatement.run>) => listed(await enqueueStatement.run(...args)),
};
const insertDelivery = {
  run: async (...args: Parameters<typeof insertDeliveryStatement.run>) =>
    listed(await insertDeliveryStatement.run(...args)),
};
const ownerChange = {
  run: async (...args: Parameters<typeof ownerChangeStatement.run>) => listed(await ownerChangeStatement.run(...args)),
};
const retainOwner = {
  run: async (...args: Parameters<typeof retainOwnerStatement.run>) => listed(await retainOwnerStatement.run(...args)),
};
const readOwner = {
  run: async (...args: Parameters<typeof readOwnerStatement.run>) => listed(await readOwnerStatement.run(...args)),
};
const ownerDelta = {
  run: async (...args: Parameters<typeof ownerDeltaStatement.run>) => listed(await ownerDeltaStatement.run(...args)),
};
const repairCAS = {
  run: async (...args: Parameters<typeof repairCASStatement.run>) => listed(await repairCASStatement.run(...args)),
};
const fanoutCAS = {
  run: async (...args: Parameters<typeof fanoutCASStatement.run>) => listed(await fanoutCASStatement.run(...args)),
};
const bootstrapCAS = {
  run: async (...args: Parameters<typeof bootstrapCASStatement.run>) =>
    listed(await bootstrapCASStatement.run(...args)),
};
const enqueueBootstrap = {
  run: async (...args: Parameters<typeof enqueueBootstrapStatement.run>) =>
    listed(await enqueueBootstrapStatement.run(...args)),
};
const claimSubject = {
  run: async (...args: Parameters<typeof claimSubjectStatement.run>) =>
    listed(await claimSubjectStatement.run(...args)),
};
const claimFanout = {
  run: async (...args: Parameters<typeof claimFanoutStatement.run>) => listed(await claimFanoutStatement.run(...args)),
};
const claimBootstrap = {
  run: async (...args: Parameters<typeof claimBootstrapStatement.run>) =>
    listed(await claimBootstrapStatement.run(...args)),
};
const replayWindow = {
  run: async (...args: Parameters<typeof replayWindowStatement.run>) =>
    listed(await replayWindowStatement.run(...args)),
};
const fanoutWindow = {
  run: async (...args: Parameters<typeof fanoutWindowStatement.run>) =>
    listed(await fanoutWindowStatement.run(...args)),
};

export type SubjectKey = { route: number; id: string };
export type ComponentKind = 'label' | 'fact' | 'cover' | 'relation';
export type ComponentKey = { kind: ComponentKind; key: string };
export type Witness = { kind: 'fact' | 'cover' | 'relation'; key: string };
export type PublicState = { shown: boolean; digest: string | null };
export type OwnerKey = { kind: 'subject' | 'source-fence'; route: number; key: string };
export type ComponentTransition = {
  component: ComponentKey;
  before: PublicState;
  after: PublicState;
  dependencies: OwnerKey[];
};
export type EvidenceTime = { effectiveAt: string | null; evidence: 'known' | 'missing' };
export type RepairPhase = 'bootstrap' | 'descriptive' | 'relations' | 'evidence' | 'replay' | 'done';
export type RepairCheckpoint = {
  version: string;
  generation: string;
  phase: RepairPhase;
  sourceKey: string[];
  highWater: string;
  replayPosition: string;
};
export type PublicationSnapshot = {
  generation: string;
  readiness: 'cold' | 'repairing' | 'ready';
  publicEffectiveAt: string | null;
  evidence: 'known' | 'missing';
  completedPosition: string;
  witnesses: Witness[];
};
export type PublicationEntry = {
  id: string;
  labels: { language: string; value: string }[];
  lastModified?: string;
  originalLanguage?: string;
};
export type PublicationStore = {
  read(subject: SubjectKey): Promise<PublicationSnapshot | null>;
  readCurrent(subject: SubjectKey): Promise<PublicationEntry | null>;
};
type Configuration = { pool: Pool; access: Access; clock: KernelClock; routeKey: Uint8Array };
export type Point = {
  generation: string;
  readiness: string;
  public_effective_at: string | null;
  evidence: string;
  completed_position: string;
  change_position: string;
  witnesses: unknown;
};
const absent: PublicState = { shown: false, digest: null };
const encoded = (key: ComponentKey) => `${key.kind}:${key.key}`;
const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());
const evidenceTime = (row: { effective_at: string | null; evidence: string }): EvidenceTime => ({
  effectiveAt: iso(row.effective_at),
  evidence: row.evidence as EvidenceTime['evidence'],
});
function home(tx: CommandTransaction, route: number) {
  assertPublicationHome(currentCommand(tx).partition, route);
}
function stringKeys(keys: (string | null)[]): string[] {
  return keys.map((key) => {
    if (key === null) throw new TypeError('Publication checkpoint key cannot be null');
    return key;
  });
}
function witnesses(value: unknown): Witness[] {
  return value as Witness[];
}
function snapshot(row: Point): PublicationSnapshot {
  return {
    generation: row.generation,
    readiness: row.readiness as PublicationSnapshot['readiness'],
    publicEffectiveAt: iso(row.public_effective_at),
    evidence: row.evidence as EvidenceTime['evidence'],
    completedPosition: row.completed_position,
    witnesses: witnesses(row.witnesses),
  };
}
export function publicState(value: unknown): PublicState {
  return { shown: true, digest: createHash('sha256').update(canonicalize(value)!).digest('hex') };
}

/** Native creation proves an empty baseline without inventing a public time. */
export async function initializeSubjectPagePublication(tx: CommandTransaction, subject: SubjectKey): Promise<void> {
  await initializeSubjectPagePublicationAt(tx, currentCommand(tx).partition, subject);
}

/** Persist only actual affected identities; this never discovers a subject's degree. */
export async function recordSubjectPageTransition(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    changeId: string;
    components: ComponentTransition[];
    outbox: CommandEvent[];
    invalidateGate?: boolean;
  },
): Promise<void> {
  home(tx, input.subject.route);
  bounded(input.components.length, 512);
  const changes: ComponentTransition[] = [];
  for (const component of input.components) {
    if (component.before.shown !== component.after.shown || component.before.digest !== component.after.digest) {
      changes.push(component);
      continue;
    }
    const existing = await readDependencies.run(tx, {
      route: input.subject.route,
      subject_id: input.subject.id,
      component_key: encoded(component.component),
    });
    const desired = new Set(
      component.dependencies.map((owner) => JSON.stringify([owner.kind, owner.route, owner.key])),
    );
    const retained = new Set(
      existing
        .filter((row) => row.present)
        .map((row) => JSON.stringify([row.owner_kind, row.owner_route, row.owner_key])),
    );
    if (desired.size !== retained.size || [...desired].some((key) => !retained.has(key))) changes.push(component);
  }
  if (!changes.length && !input.invalidateGate) return;
  const time = { effectiveAt: authoritativeTimeValue(commandTime(tx)!), evidence: 'known' as const };
  await recordTransitions(tx, { ...input, components: changes.map((c) => ({ ...c, ...time })) });
  if (input.invalidateGate)
    await applySubjectPageOwnerChange(tx, {
      owner: { kind: 'subject', route: input.subject.route, key: input.subject.id },
      changeId: input.changeId,
      time,
    });
}

async function dependencies(
  tx: CommandTransaction,
  subject: SubjectKey,
  component: ComponentKey,
  owners: OwnerKey[],
  version: string,
  changeId: string,
  time: EvidenceTime,
  outbox: CommandEvent[],
) {
  bounded(owners.length, 8);
  const key = encoded(component);
  const before = await readDependencies.run(tx, { route: subject.route, subject_id: subject.id, component_key: key });
  const ownerIdentity = (owner: OwnerKey) => JSON.stringify([owner.kind, owner.route, owner.key]);
  const wanted = new Map(owners.map((owner) => [ownerIdentity(owner), owner]));
  const all = new Map(wanted);
  for (const row of before) {
    const owner: OwnerKey = {
      kind: row.owner_kind as OwnerKey['kind'],
      route: row.owner_route,
      key: row.owner_key,
    };
    all.set(ownerIdentity(owner), owner);
  }
  const deltas = [];
  for (const [identity, owner] of all) {
    const present = wanted.has(identity);
    const previous = before.find(
      (row) => row.owner_kind === owner.kind && row.owner_route === owner.route && row.owner_key === owner.key,
    );
    if (previous?.present === present) continue;
    const eventId = `${changeId}:${key}:${version}:${identity}`;
    await installDependency.run(tx, {
      route: subject.route,
      subject_id: subject.id,
      owner_kind: owner.kind,
      owner_route: owner.route,
      owner_key: owner.key,
      component_key: key,
      version,
      present,
      event_id: eventId,
    });
    deltas.push({
      subject,
      component,
      owner,
      sourceVersion: version,
      eventId,
      changeId,
      present,
      time: { effectiveAt: time.effectiveAt, evidence: time.evidence },
    });
  }
  // Pack consecutive component deltas without spending one envelope per component.
  // This keeps the native write cap compatible with the ordinary command event cap.
  for (const delta of deltas) {
    const last = outbox.at(-1);
    if (last?.type === SUBJECT_PAGE_DEPENDENCIES_CHANGED && last.subject === subject.id) {
      const payload = last.data as { deltas: typeof deltas };
      if (payload.deltas.length < 16) {
        payload.deltas.push(delta);
        continue;
      }
    }
    outbox.push({ type: SUBJECT_PAGE_DEPENDENCIES_CHANGED, subject: subject.id, data: { deltas: [delta] } });
  }
}
async function recordTransitions(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    changeId: string;
    components: (ComponentTransition & EvidenceTime)[];
    outbox: CommandEvent[];
    invalidateGate?: boolean;
  },
) {
  const point = (await lockPoint.run(tx, { route: input.subject.route, subject_id: input.subject.id }))[0]! as Point;
  let position = BigInt(point.change_position);
  let effectiveAt: string | null = null;
  let current = witnesses(point.witnesses);
  const entries: ((ComponentTransition & EvidenceTime) | null)[] = [
    ...input.components,
    ...(input.invalidateGate ? [null] : []),
  ];
  let changed = false;
  for (const entry of entries) {
    const time: EvidenceTime = entry
      ? { effectiveAt: entry.effectiveAt, evidence: entry.evidence }
      : { effectiveAt: authoritativeTimeValue(commandTime(tx)!), evidence: 'known' };
    if (entry && entry.before.shown === entry.after.shown && entry.before.digest === entry.after.digest) {
      const installed = await installComponent.run(tx, {
        route: input.subject.route,
        subject_id: input.subject.id,
        kind: entry.component.kind,
        key: entry.component.key,
        generation: point.generation,
        shown: entry.after.shown,
        digest: entry.after.digest,
        effective_at: null,
        evidence: 'missing',
        position: String(position),
      });
      if (installed[0])
        await dependencies(
          tx,
          input.subject,
          entry.component,
          entry.dependencies,
          installed[0].source_version,
          input.changeId,
          time,
          input.outbox,
        );
      continue;
    }
    const id = `${input.changeId}:${entry ? encoded(entry.component) : 'gate'}`;
    const inserted = await insertChange.run(tx, {
      route: input.subject.route,
      subject_id: input.subject.id,
      position: String(position + 1n),
      change_id: id,
      kind: entry?.component.kind ?? null,
      key: entry?.component.key ?? null,
      before: entry?.before ?? absent,
      after: entry?.after ?? absent,
      effective_at: time.effectiveAt,
      evidence: time.evidence,
    });
    if (!inserted.length) continue;
    changed = true;
    position++;
    if (time.effectiveAt !== null && (effectiveAt === null || time.effectiveAt > effectiveAt))
      effectiveAt = time.effectiveAt;
    if (!entry) continue;
    const version = await installComponent.run(tx, {
      route: input.subject.route,
      subject_id: input.subject.id,
      kind: entry.component.kind,
      key: entry.component.key,
      generation: point.generation,
      shown: entry.after.shown,
      digest: entry.after.digest,
      effective_at: time.effectiveAt,
      evidence: time.evidence,
      position: String(position),
    });
    if (version[0])
      await dependencies(
        tx,
        input.subject,
        entry.component,
        entry.dependencies,
        version[0].source_version,
        input.changeId,
        time,
        input.outbox,
      );
    current = current.filter((w) => encoded(w) !== encoded(entry.component));
    if (entry.after.shown && entry.component.kind !== 'label') current.push(entry.component as Witness);
  }
  if (!changed) return;
  const readiness =
    point.readiness === 'repairing'
      ? 'repairing'
      : current.length
        ? 'ready'
        : witnesses(point.witnesses).length || point.readiness === 'cold'
          ? 'cold'
          : 'ready';
  await publishPoint.run(tx, {
    route: input.subject.route,
    subject_id: input.subject.id,
    generation: point.generation,
    readiness,
    completed_position: String(position),
    position: String(position),
    effective_at: effectiveAt,
    witnesses: current.slice(-8),
  });
  if (readiness === 'cold') await enqueueSubjectPageRepair(tx, { subject: input.subject, cause: 'missing-proof' });
}

export async function enqueueSubjectPageRepair(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    cause: 'explicit' | 'missing-proof' | 'owner' | 'continuation';
    delivery?: { owner: OwnerKey; changeId: string; eventId: string; time: EvidenceTime };
  },
): Promise<void> {
  home(tx, input.subject.route);
  if (input.cause === 'owner' && !input.delivery)
    throw new TypeError('Owner repair requires originating delivery evidence');
  if (input.delivery) {
    const { owner, time, changeId, eventId } = input.delivery;
    const inserted = await insertDelivery.run(tx, {
      route: input.subject.route,
      subject_id: input.subject.id,
      owner_kind: owner.kind,
      owner_route: owner.route,
      owner_key: owner.key,
      change_id: changeId,
      event_id: eventId,
      effective_at: time.effectiveAt,
      evidence: time.evidence,
    });
    if (!inserted.length) return;
  }
  const point = (await lockPoint.run(tx, { route: input.subject.route, subject_id: input.subject.id }))[0]! as Point;
  await enqueue.run(tx, {
    route: input.subject.route,
    subject_id: input.subject.id,
    generation: String(BigInt(point.generation) + 1n),
    high_water: point.change_position,
    invalidate: input.cause !== 'missing-proof',
  });
}

export async function commitSubjectPageRepairPage(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    expectedVersion: string;
    checkpoint: RepairCheckpoint;
    components: (ComponentTransition & EvidenceTime)[];
    outbox: CommandEvent[];
    replayedChangeIds: string[];
    complete: boolean;
  },
): Promise<boolean> {
  home(tx, input.subject.route);
  bounded(input.components.length + input.replayedChangeIds.length, 32);
  const cp = input.checkpoint;
  const updated = await repairCAS.run(tx, {
    route: input.subject.route,
    subject_id: input.subject.id,
    version: input.expectedVersion,
    generation: cp.generation,
    phase: cp.phase,
    source_key: cp.sourceKey,
    high_water: cp.highWater,
    replay_position: cp.replayPosition,
    complete: input.complete,
  });
  if (!updated.length) return false;
  const point = (await lockPoint.run(tx, { route: input.subject.route, subject_id: input.subject.id }))[0]! as Point;
  let effectiveAt: string | null = null;
  for (const component of input.components) {
    const installed = await installComponent.run(tx, {
      route: input.subject.route,
      subject_id: input.subject.id,
      kind: component.component.kind,
      key: component.component.key,
      generation: cp.generation,
      shown: component.after.shown,
      digest: component.after.digest,
      effective_at: component.effectiveAt,
      evidence: component.evidence,
      position: cp.replayPosition,
    });
    if (installed[0])
      await dependencies(
        tx,
        input.subject,
        component.component,
        component.dependencies,
        installed[0].source_version,
        `repair:${cp.generation}:${input.expectedVersion}`,
        component,
        input.outbox,
      );
    if (component.effectiveAt !== null && (effectiveAt === null || component.effectiveAt > effectiveAt))
      effectiveAt = component.effectiveAt;
  }
  const delivered = await readSubjectPageDeliveryTime(tx, input.subject);
  if (delivered.effectiveAt && (!effectiveAt || Date.parse(delivered.effectiveAt) > Date.parse(effectiveAt)))
    effectiveAt = delivered.effectiveAt;
  // A generation becomes visible only after replay catches the point high-water.
  const complete = input.complete && BigInt(cp.replayPosition) >= BigInt(point.change_position);
  if (input.complete && !complete) throw new TypeError('Repair completion has not replayed the current high-water');
  const currentWitnesses = complete
    ? await readSubjectPageGenerationWitnesses(tx, input.subject, cp.generation)
    : point.witnesses;
  await publishPoint.run(tx, {
    route: input.subject.route,
    subject_id: input.subject.id,
    generation: complete ? cp.generation : point.generation,
    readiness: complete ? 'ready' : 'repairing',
    completed_position: complete ? cp.replayPosition : point.completed_position,
    position: point.change_position,
    effective_at: effectiveAt,
    witnesses: currentWitnesses,
  });
  if (input.complete && updated[0]!.dirty)
    await enqueueSubjectPageRepair(tx, { subject: input.subject, cause: 'continuation' });
  return true;
}

export async function applySubjectPageOwnerChange(
  tx: CommandTransaction,
  input: { owner: OwnerKey; changeId: string; time: EvidenceTime },
): Promise<void> {
  home(tx, input.owner.route);
  const params = {
    route: input.owner.route,
    owner_kind: input.owner.kind,
    owner_key: input.owner.key,
    change_id: input.changeId,
    effective_at: input.time.effectiveAt,
    evidence: input.time.evidence,
  };
  if ((await ownerChange.run(tx, params)).length) await retainOwner.run(tx, params);
}
function repairEvent(
  subject: SubjectKey,
  owner: OwnerKey,
  changeId: string,
  eventId: string,
  time: EvidenceTime,
): CommandEvent {
  return {
    type: SUBJECT_PAGE_REPAIR_REQUESTED,
    subject: subject.id,
    data: { subject, owner, changeId, eventId, time },
  };
}
export async function applySubjectPageDependencyDelta(
  tx: CommandTransaction,
  input: {
    owner: OwnerKey;
    subject: SubjectKey;
    component: ComponentKey;
    sourceVersion: string;
    eventId: string;
    present: boolean;
    time: EvidenceTime;
    outbox: CommandEvent[];
  },
): Promise<void> {
  home(tx, input.owner.route);
  const installed = await ownerDelta.run(tx, {
    route: input.owner.route,
    owner_kind: input.owner.kind,
    owner_key: input.owner.key,
    source_route: input.subject.route,
    subject_id: input.subject.id,
    component_key: encoded(input.component),
    version: input.sourceVersion,
    present: input.present,
    event_id: input.eventId,
    effective_at: input.time.effectiveAt,
    evidence: input.time.evidence,
  });
  if (!installed.length || !input.present) return;
  const prior = (
    await readOwner.run(tx, { route: input.owner.route, owner_kind: input.owner.kind, owner_key: input.owner.key })
  )[0];
  if (prior)
    input.outbox.push(
      repairEvent(
        input.subject,
        input.owner,
        prior.change_id,
        `${input.eventId}:${prior.change_id}`,
        evidenceTime(prior),
      ),
    );
}
export async function commitSubjectPageFanoutPage(
  tx: CommandTransaction,
  input: {
    owner: OwnerKey;
    changeId: string;
    expectedVersion: string;
    after: string[];
    subjects: SubjectKey[];
    outbox: CommandEvent[];
    complete: boolean;
  },
): Promise<boolean> {
  home(tx, input.owner.route);
  bounded(input.subjects.length, 32);
  const updated = await fanoutCAS.run(tx, {
    route: input.owner.route,
    owner_kind: input.owner.kind,
    owner_key: input.owner.key,
    change_id: input.changeId,
    version: input.expectedVersion,
    source_key: input.after,
    complete: input.complete,
  });
  if (!updated[0]) return false;
  for (const subject of input.subjects)
    input.outbox.push(
      repairEvent(
        subject,
        input.owner,
        input.changeId,
        `${input.changeId}:${subject.route}:${subject.id}`,
        evidenceTime(updated[0]),
      ),
    );
  return true;
}
export async function commitSubjectPageBootstrapPage(
  tx: CommandTransaction,
  input: {
    partition: number;
    expectedVersion: string;
    after: [number, string] | null;
    subjects: SubjectKey[];
    complete: boolean;
  },
): Promise<boolean> {
  if (currentCommand(tx).partition !== input.partition) throw new TypeError('Bootstrap transaction home mismatch');
  bounded(input.subjects.length, 32);
  for (const subject of input.subjects) home(tx, subject.route);
  const rows = await bootstrapCAS.run(tx, {
    partition: input.partition,
    version: input.expectedVersion,
    source_key: input.after,
    complete: input.complete,
  });
  if (!rows.length) return false;
  if (input.subjects.length) {
    for (const subject of input.subjects) home(tx, subject.route);
    await enqueueBootstrap.run(tx, {
      subjects: input.subjects.map(({ route, id }) => ({ route, subject_id: id })),
    });
  }
  return true;
}
export type PublicationWork =
  | { kind: 'subject'; subject: SubjectKey; checkpoint: RepairCheckpoint }
  | { kind: 'bootstrap'; partition: number; version: string; after: [number, string] | null }
  | { kind: 'fanout'; owner: OwnerKey; changeId: string; version: string; after: string[]; time: EvidenceTime };
export async function claimSubjectPagePublicationWork(
  tx: CommandTransaction,
  input: { partition: number; worker: string; leaseUntil: string },
): Promise<PublicationWork | null> {
  if (currentCommand(tx).partition !== input.partition) throw new TypeError('Claim transaction home mismatch');
  const params = { partition: input.partition, worker: input.worker, lease_until: input.leaseUntil };
  const row = (await claimSubject.run(tx, params))[0];
  if (row)
    return {
      kind: 'subject',
      subject: { route: row.route, id: row.subject_id },
      checkpoint: {
        version: row.version,
        generation: row.generation,
        phase: row.phase as RepairPhase,
        sourceKey: stringKeys(row.source_key),
        highWater: row.high_water,
        replayPosition: row.replay_position,
      },
    };
  const fanout = (await claimFanout.run(tx, params))[0];
  if (fanout)
    return {
      kind: 'fanout',
      owner: { route: fanout.route, kind: fanout.owner_kind as OwnerKey['kind'], key: fanout.owner_key },
      changeId: fanout.change_id,
      version: fanout.version,
      after: stringKeys(fanout.source_key),
      time: evidenceTime(fanout),
    };
  const bootstrap = (
    await claimBootstrap.run(tx, { partition: input.partition, worker: input.worker, lease_until: input.leaseUntil })
  )[0];
  return bootstrap
    ? {
        kind: 'bootstrap',
        partition: input.partition,
        version: bootstrap.version,
        after: bootstrap.source_key as [number, string] | null,
      }
    : null;
}
export async function readSubjectPageReplayWindow(
  client: CommandTransaction,
  input: { subject: SubjectKey; after: string; limit: number; sentinel: boolean },
) {
  bounded(input.limit, 32);
  const rows = await replayWindow.run(client, {
    route: input.subject.route,
    subject_id: input.subject.id,
    after: input.after,
    limit: input.limit + Number(input.sentinel),
  });
  return {
    changes: rows.slice(0, input.limit).map((row) => ({
      position: row.position,
      changeId: row.change_id,
      component:
        row.component_kind === null ? null : { kind: row.component_kind as ComponentKind, key: row.component_key! },
      before: row.before_state as PublicState,
      after: row.after_state as PublicState,
      time: evidenceTime(row),
    })),
    hasMore: rows.length > input.limit,
  };
}
export async function readSubjectPageFanoutWindow(
  client: CommandTransaction,
  input: { owner: OwnerKey; after: string[]; limit: number; sentinel: boolean },
) {
  bounded(input.limit, 32);
  const rows = await fanoutWindow.run(client, {
    route: input.owner.route,
    owner_kind: input.owner.kind,
    owner_key: input.owner.key,
    after_route: Number(input.after[0] ?? -1),
    after_subject: input.after[1] ?? '00000000-0000-0000-0000-000000000000',
    after_component: input.after[2] ?? '',
    limit: input.limit + Number(input.sentinel),
  });
  return {
    edges: rows.slice(0, input.limit).map((row) => {
      const colon = row.component_key.indexOf(':');
      return {
        sourceKey: [String(row.source_route), row.source_subject_id, row.component_key],
        subject: { route: row.source_route, id: row.source_subject_id },
        component: {
          kind: row.component_key.slice(0, colon) as ComponentKind,
          key: row.component_key.slice(colon + 1),
        },
      };
    }),
    hasMore: rows.length > input.limit,
  };
}

/** A stored identity is a hint. Only the native public readers can prove it now. */
// Keep tag admission identical to apps/web/src/subject/language.ts.
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

/** Two bounded descriptive slots, resolved by the same public selector as the native page. */
async function readOriginalLanguage(client: PoolClient, subject: SubjectKey, routeKey: Uint8Array) {
  for (const property of ['schema:name', 'schema:inLanguage']) {
    const view = await slotView(client, subject.id, property, GLOBAL_CONTEXT);
    const selected = view.facts.filter(
      (fact) => fact.statement_id && (fact.body as { rank: string }).rank !== 'deprecated',
    );
    const gone = new Set<string>();
    for (let offset = 0; offset < selected.length; offset += 256) {
      const batch = selected.slice(offset, offset + 256);
      const sources = await candidateSources(
        client,
        batch.map((fact) => ({ route: subject.route, subject_id: subject.id, candidate_id: fact.statement_id! })),
      );
      for (const id of await fencedIds(
        client,
        routeKey,
        batch.map((fact) => ({
          id: fact.statement_id!,
          source: sources.get(`${subject.id}\n${fact.statement_id}`) ?? null,
        })),
      ))
        gone.add(id);
    }
    const disclosed = selected.filter((fact) => !gone.has(fact.statement_id!));
    const preferred = disclosed.filter((fact) => (fact.body as { rank: string }).rank === 'preferred');
    const ranked = preferred.length
      ? preferred
      : disclosed.filter((fact) => (fact.body as { rank: string }).rank === 'normal');
    for (const fact of ranked) {
      const body = fact.body as { value: { type: string; content?: unknown } };
      const content = body.value.type === 'value' ? body.value.content : undefined;
      const language =
        property === 'schema:name'
          ? typeof content === 'object' && content !== null && !Array.isArray(content)
            ? (content as { language?: unknown }).language
            : undefined
          : content;
      if (typeof language === 'string' && LANGUAGE_CODE.test(language)) return language;
    }
  }
  return undefined;
}

export function createSubjectPagePublicationStore({ pool, access, clock, routeKey }: Configuration): PublicationStore {
  return {
    read(subject) {
      return withReadTransaction(pool, async (client) => {
        const row = await readPoint.run(client, { route: subject.route, subject_id: subject.id });
        return row[0] ? snapshot(row[0] as Point) : null;
      });
    },
    async readCurrent(subject) {
      if (routeOf(subject.id) !== subject.route) return null;
      const deadline = deadlineFor(2000);
      const global = { route: 0, id: GLOBAL_CONTEXT, eligibility: globalReadEligibility('subject:read') };
      const target = { ...subject, eligibility: subjectReadEligibility(subject) };
      const actor = { kind: 'anonymous' as const };
      const gate = await accessCheck(access, actor, 'subject:read', global, { pool, deadline });
      const original = await accessCheck(access, actor, 'subject:read', target, { pool, deadline });
      // Access prepares evidence through the pool before the proof snapshot holds a connection.
      // These bounded hints grant no authority; the final snapshot rechecks every selected identity.
      const ownerIds = await withPublicStatementReader(() =>
        withReadTransaction(pool, async (client) => {
          const point = (await readPoint.run(client, { route: subject.route, subject_id: subject.id }))[0] as
            | Point
            | undefined;
          const ids = new Set<string>();
          for (const identity of point ? witnesses(point.witnesses).slice(0, 8) : []) {
            if (identity.kind !== 'relation' || routeOf(identity.key) !== subject.route) continue;
            const located = await locateCandidate.run(client, {
              route: subject.route,
              subject_id: subject.id,
              candidate_id: identity.key,
            });
            if (!located?.property || !located.relation) continue;
            const view = await slotView(client, subject.id, located.property, GLOBAL_CONTEXT, {}, located.slot_id);
            const fact = view.facts.find((fact) => fact.statement_id === identity.key);
            const body = fact?.body as { value?: { type: string; content?: unknown } } | undefined;
            const id = body?.value?.type === 'value' ? body.value.content : undefined;
            if (typeof id === 'string' && routeOf(id) !== null) ids.add(id);
          }
          const owners = await loadRelated({ query: client.query.bind(client) }, [...ids]);
          for (const owner of owners.values()) if (owner.redirect) ids.add(owner.redirect);
          return [...ids];
        }),
      );
      const ownerChecks = new Map<string, Awaited<ReturnType<typeof accessCheck>>>();
      for (const id of ownerIds)
        ownerChecks.set(
          id,
          await accessCheck(
            access,
            actor,
            'subject:read',
            { route: routeOf(id)!, id, eligibility: subjectReadEligibility({ route: routeOf(id)!, id }) },
            { pool, deadline },
          ),
        );
      let uncertain = false;
      const result = await withPublicStatementReader(() =>
        withReadTransaction(pool, async (client) => {
          if (!(await gate(client)) || !(await original(client))) return null;
          // Related-reader memoization belongs to this snapshot, not the pooled connection.
          const relatedClient = { query: client.query.bind(client) };
          const state = (await loadRelated(relatedClient, [subject.id])).get(subject.id);
          if (!state || state.redirect || state.visibility !== 'visible') return null;
          const point = (await readPoint.run(client, { route: subject.route, subject_id: subject.id }))[0] as
            | Point
            | undefined;
          if (!point) {
            uncertain = true;
            return null;
          }
          let proved: string | null = null;
          const identities = witnesses(point.witnesses).slice(0, 8);
          for (const identity of identities) {
            if (routeOf(identity.key) !== subject.route) continue;
            const located = await locateCandidate.run(client, {
              route: subject.route,
              subject_id: subject.id,
              candidate_id: identity.key,
            });
            if (!located?.property) continue;
            const view = await slotView(client, subject.id, located.property, GLOBAL_CONTEXT, {}, located.slot_id);
            const fact = view.facts.find(
              (f) => f.statement_id === identity.key && (f.body as { rank?: string }).rank !== 'deprecated',
            );
            if (
              !fact ||
              !(await readCandidateDisclosure(client, { subject: subject.id, candidate: identity.key }))?.disclosed
            )
              continue;
            const sources = await candidateSources(client, [
              { route: subject.route, subject_id: subject.id, candidate_id: identity.key },
            ]);
            if (
              (
                await fencedIds(client, routeKey, [
                  { id: identity.key, source: sources.get(`${subject.id}\n${identity.key}`) ?? null },
                ])
              ).size
            )
              continue;
            if (located.relation) {
              const body = fact.body as { value: { type: string; content?: unknown } };
              if (body.value.type === 'value') {
                const id = body.value.content;
                if (typeof id !== 'string' || routeOf(id) === null) continue;
                const owner = (await loadRelated(relatedClient, [id])).get(id);
                if (!owner || owner.visibility !== 'visible') continue;
                const ownerIds = [id];
                if (owner.redirect) {
                  const redirected = (await loadRelated(relatedClient, [owner.redirect])).get(owner.redirect);
                  if (redirected?.visibility !== 'visible') continue;
                  ownerIds.push(owner.redirect);
                }
                let disclosed = true;
                for (const ownerId of ownerIds) {
                  const authorize = ownerChecks.get(ownerId);
                  if (!authorize || !(await authorize(client))) disclosed = false;
                }
                if (!disclosed) continue;
              }
            }
            proved = identity.key;
            break;
          }
          if (!proved) {
            uncertain = identities.length > 0 || point.readiness !== 'ready';
            return null;
          }
          const originalLanguage = await readOriginalLanguage(client, subject, routeKey);
          if (
            !(await gate(client)) ||
            !(await original(client)) ||
            !(await readCandidateDisclosure(client, { subject: subject.id, candidate: proved }))?.disclosed
          )
            return null;
          const labels = Object.entries(state.labels)
            .sort(([left], [right]) => left.localeCompare(right, 'en'))
            .slice(0, 512)
            .map(([language, value]) => ({ language, value }));
          const entry = {
            id: subject.id,
            labels,
            ...(point.public_effective_at === null ? {} : { lastModified: iso(point.public_effective_at)! }),
            ...(originalLanguage === undefined ? {} : { originalLanguage }),
          };
          return entry;
        }),
      );
      if (uncertain)
        await runCommand(pool, { partition: partitionOf(subject.route), clock }, async (tx) => {
          await enqueueSubjectPageRepair(tx, { subject, cause: 'missing-proof' });
          return {
            value: null,
            events: [
              { type: SUBJECT_PAGE_REPAIR_QUEUED, subject: subject.id, data: { subject, cause: 'missing-proof' } },
            ],
          };
        });
      return result;
    },
  };
}

/** Retain the canonical source-fence owner when imported identity is first installed. */
export async function retainSubjectPageSource(
  tx: CommandTransaction,
  input: { subject: SubjectKey; candidates: string[]; source: Source; routeKey: Uint8Array },
): Promise<void> {
  await retainSubjectPageSourceAt(tx, currentCommand(tx).partition, input);
}
export async function readSubjectPageSourceOwner(
  tx: CommandTransaction,
  subject: SubjectKey,
  candidate: string,
): Promise<OwnerKey | null> {
  const row = (await readSource.run(tx, { route: subject.route, subject_id: subject.id, candidate_id: candidate }))[0];
  return row ? { kind: 'source-fence', route: row.owner_route, key: row.owner_key } : null;
}

export type PublicationOrigin = { changeId: string; time: EvidenceTime };
export async function retainSubjectPageContinuation(
  tx: CommandTransaction,
  input: { subject: SubjectKey; kind: string; changeId: string },
): Promise<void> {
  home(tx, input.subject.route);
  await saveContinuation.run(tx, {
    route: input.subject.route,
    subject_id: input.subject.id,
    kind: input.kind,
    change_id: input.changeId,
    effective_at: authoritativeTimeValue(commandTime(tx)!),
    evidence: 'known',
  });
}
export async function readSubjectPageContinuation(
  client: CommandTransaction,
  input: { subject: SubjectKey; kind: string },
): Promise<PublicationOrigin | null> {
  const row = (
    await readContinuation.run(client, { route: input.subject.route, subject_id: input.subject.id, kind: input.kind })
  )[0];
  return row ? { changeId: row.change_id, time: evidenceTime(row) } : null;
}

/** Fixed partition metadata is separate from application source/dependency windows. */
export async function subjectPagePublicationHomes(pool: Pool): Promise<number[]> {
  return withConnection(pool, async (client) => listed(await workHomes.run(client, {}))).then((rows) =>
    rows.map((row) => row.partition_no),
  );
}
export async function readSubjectPageGenerationWitnesses(
  tx: CommandTransaction,
  subject: SubjectKey,
  generation: string,
): Promise<Witness[]> {
  home(tx, subject.route);
  return listed(await generationWitnesses.run(tx, { route: subject.route, subject_id: subject.id, generation })).map(
    (row) => ({ kind: row.component_kind as Witness['kind'], key: row.component_key }),
  );
}
export async function readSubjectPageOwnerTime(tx: CommandTransaction, owner: OwnerKey): Promise<EvidenceTime> {
  const row = (await readOwner.run(tx, { route: owner.route, owner_kind: owner.kind, owner_key: owner.key }))[0];
  return row ? evidenceTime(row) : { effectiveAt: null, evidence: 'missing' };
}
export async function readSubjectPageDeliveryTime(tx: CommandTransaction, subject: SubjectKey): Promise<EvidenceTime> {
  home(tx, subject.route);
  const row = listed(await deliveryTime.run(tx, { route: subject.route, subject_id: subject.id }))[0];
  return row?.effective_at
    ? { effectiveAt: row.effective_at, evidence: 'known' }
    : { effectiveAt: null, evidence: 'missing' };
}
