import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import deletePage from './zone-grant-cleanup-delete.sql';
import resourcePage from './zone-grant-cleanup-resource-page.sql';
import rolePage from './zone-grant-cleanup-role-page.sql';
import writerLock from './zone-grant-writer-lock.sql';

export type ZoneCleanupBranch = 'ordinary-expiry' | 'early-privacy' | 'legal-order' | 'terminal-account';

export type ZoneGrantCleanupSource = Readonly<{
  zone: Readonly<{
    route: number;
    zoneId: string;
    home: Readonly<{ partition: number; epoch: string }>;
  }>;
  revision: string;
  lifecycleRevision: string;
  generation: string;
  progress: string;
  protectionRevision: string;
}>;

declare const admittedZoneCleanup: unique symbol;
declare const zoneCleanupBranchEvidence: unique symbol;

/** Semantic supplies this only after admitting and locking its current Zone branch. */
export type ZoneCleanupBranchEvidence = Readonly<{ [zoneCleanupBranchEvidence]: true }>;

export type ZonePrimaryOwnerEvidence = Readonly<{
  accountId: string;
  revision: string;
  lifecycleRevision: string;
  transactionId: string;
}>;

/** Opaque, transaction-local owner input. There is deliberately no Access-side issuer. */
export type ZoneGrantCleanupAdmission = (
  | Readonly<{
      kind: 'zone-disposition';
      branch: ZoneCleanupBranch;
      source: ZoneGrantCleanupSource;
      branchEvidence: ZoneCleanupBranchEvidence;
    }>
  | Readonly<{
      kind: 'terminal-account-subject';
      branch: 'terminal-account';
      source: ZoneGrantCleanupSource;
      accountId: string;
      barrier: Readonly<{ version: string; at: string }>;
      primaryOwner: ZonePrimaryOwnerEvidence;
    }>
) & Readonly<{ [admittedZoneCleanup]: true }>;

export type ZoneGrantCleanupCursor = Readonly<{
  scope: Readonly<{
    kind: ZoneGrantCleanupAdmission['kind'];
    branch: ZoneCleanupBranch;
    zone: ZoneGrantCleanupSource['zone'];
    revision: string;
    lifecycleRevision: string;
    generation: string;
    progress: string;
    protectionRevision: string;
    terminal?: Readonly<{
      accountId: string;
      barrierVersion: string;
      barrierAt: string;
      primaryOwner: ZonePrimaryOwnerEvidence;
    }>;
  }>;
  store: 'resource_grant' | 'resource_role_grant';
  afterKey: string;
}>;

export type ZoneGrantCleanupPage = Readonly<{
  disposition: 'progress' | 'complete' | 'rebound';
  candidateKeys: number;
  processedKeys: number;
  removedRows: number;
  next: ZoneGrantCleanupCursor | null;
}>;

type GrantPageRow = {
  afterKey: string;
  subjectKind: string;
  subjectId: string;
  subjectRole: string;
};

function scopeOf(admission: ZoneGrantCleanupAdmission): ZoneGrantCleanupCursor['scope'] {
  return {
    kind: admission.kind,
    branch: admission.branch,
    zone: admission.source.zone,
    revision: admission.source.revision,
    lifecycleRevision: admission.source.lifecycleRevision,
    generation: admission.source.generation,
    progress: admission.source.progress,
    protectionRevision: admission.source.protectionRevision,
    ...(admission.kind === 'terminal-account-subject'
      ? {
          terminal: {
            accountId: admission.accountId,
            barrierVersion: admission.barrier.version,
            barrierAt: admission.barrier.at,
            primaryOwner: admission.primaryOwner,
          },
        }
      : {}),
  };
}

function sameOwner(a: ZonePrimaryOwnerEvidence, b: ZonePrimaryOwnerEvidence): boolean {
  return (
    a.accountId === b.accountId &&
    a.revision === b.revision &&
    a.lifecycleRevision === b.lifecycleRevision &&
    a.transactionId === b.transactionId
  );
}

function sameScope(a: ZoneGrantCleanupCursor['scope'], b: ZoneGrantCleanupCursor['scope']): boolean {
  return (
    a.kind === b.kind &&
    a.branch === b.branch &&
    a.zone.route === b.zone.route &&
    a.zone.zoneId === b.zone.zoneId &&
    a.zone.home.partition === b.zone.home.partition &&
    a.zone.home.epoch === b.zone.home.epoch &&
    a.revision === b.revision &&
    a.lifecycleRevision === b.lifecycleRevision &&
    a.generation === b.generation &&
    a.progress === b.progress &&
    a.protectionRevision === b.protectionRevision &&
    (a.terminal === undefined) === (b.terminal === undefined) &&
    (a.terminal === undefined ||
      (b.terminal !== undefined &&
        a.terminal.accountId === b.terminal.accountId &&
        a.terminal.barrierVersion === b.terminal.barrierVersion &&
        a.terminal.barrierAt === b.terminal.barrierAt &&
        sameOwner(a.terminal.primaryOwner, b.terminal.primaryOwner)))
  );
}

function cursorFor(
  scope: ZoneGrantCleanupCursor['scope'],
  store: ZoneGrantCleanupCursor['store'] = 'resource_grant',
  afterKey = '0',
): ZoneGrantCleanupCursor {
  return { scope, store, afterKey };
}

/**
 * Minimize one bounded Access grant page inside the Semantic owner's command.
 * Semantic locks/rechecks the Zone parent first and persists `next` with its
 * existing cleanup CAS in this same transaction.
 */
export async function minimizeZoneGrantPage(
  tx: CommandTransaction,
  input: Readonly<{
    admission: ZoneGrantCleanupAdmission;
    cursor: ZoneGrantCleanupCursor | null;
    limit: number;
  }>,
): Promise<ZoneGrantCleanupPage> {
  const { admission, limit } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Zone grant cleanup page size must be between 1 and 100');
  const command = currentCommand(tx);
  const { source } = admission;
  if (
    partitionOf(source.zone.route) !== source.zone.home.partition ||
    command.partition !== source.zone.home.partition
  )
    throw new RangeError('Zone grant cleanup must run in the original Zone home');

  const scope = scopeOf(admission);
  const prior = input.cursor;
  if (prior && !sameScope(prior.scope, scope))
    return { disposition: 'rebound', candidateKeys: 0, processedKeys: 0, removedRows: 0, next: cursorFor(scope) };

  const cursor = prior ?? cursorFor(scope);
  const parameters = {
    route: source.zone.route,
    zone_id: source.zone.zoneId,
    after_key: cursor.afterKey,
    limit: limit + 1,
  };
  const rows: GrantPageRow[] =
    cursor.store === 'resource_grant'
      ? await resourcePage.run(tx, parameters)
      : await rolePage.run(tx, parameters);
  const selected = rows.slice(0, limit);
  const eligible =
    admission.kind === 'zone-disposition'
      ? selected
      : selected.filter(
          (row) =>
            row.subjectKind === 'identity' &&
            row.subjectId === admission.accountId &&
            row.subjectRole === '',
        );

  let removedRows = 0;
  if (eligible.length > 0) {
    const result = await deletePage.run(tx, {
      route: source.zone.route,
      zone_id: source.zone.zoneId,
      store: cursor.store,
      keys: eligible.map((row) => row.afterKey),
    });
    removedRows = result?.removed ?? 0;
  }

  if (rows.length > limit) {
    return {
      disposition: 'progress',
      candidateKeys: rows.length,
      processedKeys: selected.length,
      removedRows,
      next: cursorFor(scope, cursor.store, selected[selected.length - 1]!.afterKey),
    };
  }
  if (cursor.store === 'resource_grant') {
    return {
      disposition: 'progress',
      candidateKeys: rows.length,
      processedKeys: selected.length,
      removedRows,
      next: cursorFor(scope, 'resource_role_grant'),
    };
  }
  return {
    disposition: 'complete',
    candidateKeys: rows.length,
    processedKeys: selected.length,
    removedRows,
    next: null,
  };
}

/** Serialize Zone grant additions with its source parent and terminal subject barrier. */
export async function lockZoneGrantWriterTarget(
  tx: CommandTransaction,
  input: Readonly<{
    resource: Readonly<{ route: number; id: string }>;
    subjectAccountId?: string;
    addsGrant: boolean;
  }>,
): Promise<boolean> {
  const subjectRoute = input.subjectAccountId === undefined ? null : routeOf(input.subjectAccountId);
  const row = await writerLock.run(tx, {
    route: input.resource.route,
    zone_id: input.resource.id,
    subject_route: subjectRoute,
    subject_account_id: input.subjectAccountId ?? null,
  });
  if (!row?.isZone || !input.addsGrant) return true;
  if (input.subjectAccountId !== undefined &&
      (row.subjectCount !== 1 || row.subjectState !== 'active' || row.subjectFenced))
    return false;
  return row.state === 'active' && !row.writeFenced && !row.held;
}
