import {
  minimizeZoneGrantPage,
  type ZoneCleanupBranch,
  type ZoneCleanupBranchEvidence,
  type ZoneGrantCleanupAdmission,
  type ZoneGrantCleanupCursor,
  type ZoneGrantCleanupPage,
  type ZoneGrantCleanupSource,
  type ZonePrimaryOwnerEvidence,
} from '../../access/zone-grant-cleanup.ts';
import type { CommandTransaction } from '../../command/command.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import { liveCoverage, purgeIntent } from '../../zones/cleanup-intent.ts';
import type { ZoneHead } from '../../zones/resource-head.ts';

export type ZoneCleanupIntent = 'ordinary-expiry' | 'early-privacy' | 'legal-order' | 'terminal-account';

export type ZoneCleanupAdmission = Readonly<{
  branch: ZoneCleanupIntent;
  zoneId: string;
  route: number;
  revision: string;
  lifecycleRevision: string;
  generation: string;
  protectionRevision: string;
  grants: ZoneGrantCleanupAdmission;
}>;

const issued = new WeakMap<ZoneGrantCleanupAdmission, ZoneCleanupAdmission>();
const evidence = Object.freeze({}) as ZoneCleanupBranchEvidence;

function branchOf(intent: ZoneCleanupIntent): ZoneCleanupBranch {
  return intent === 'ordinary-expiry'
    ? 'ordinary-expiry'
    : intent === 'early-privacy'
      ? 'early-privacy'
      : intent === 'legal-order'
        ? 'legal-order'
        : 'terminal-account';
}

function intentOf(row: ZoneHead, at: string): ZoneCleanupIntent | null {
  const intent = purgeIntent(row);
  if (intent?.branch === 'early_privacy') return 'early-privacy';
  if (intent?.branch === 'legal_order') return 'legal-order';
  if (intent?.branch === 'ordinary') return 'ordinary-expiry';
  if (row.state === 'deleted' && row.restoreUntil !== null && Date.parse(at) >= Date.parse(row.restoreUntil))
    return 'ordinary-expiry';
  return null;
}

async function home(tx: CommandTransaction, route: number) {
  const partition = partitionOf(route);
  const row = await tx.query<{ epoch: string }>(
    `SELECT epoch::text FROM core.partition WHERE partition_no=$1 AND write_state='active' AND moved_to IS NULL`,
    [partition],
  );
  if (!row.rows[0]) throw new Error('zone_cleanup_home_unavailable');
  return { partition, epoch: row.rows[0].epoch };
}

function generationOf(row: ZoneHead): string | null {
  return row.deletionGeneration ?? row.transactionId;
}

async function committedBarrier(tx: CommandTransaction, accountId: string) {
  const route = routeOf(accountId);
  if (route === null) return null;
  const row = await tx.query<{ version: string; at: string }>(
    'SELECT version::text, at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
    [route, accountId],
  );
  return row.rows[0] ?? null;
}

function resumeSource(
  row: ZoneHead,
  accountId: string,
  barrier: Readonly<{ version: string; at: string }>,
  resume: ZoneGrantCleanupCursor,
): { source: ZoneGrantCleanupSource; primaryOwner: ZonePrimaryOwnerEvidence } | null {
  const terminal = resume.scope.terminal;
  if (
    resume.scope.kind !== 'terminal-account-subject' ||
    resume.scope.branch !== 'terminal-account' ||
    resume.scope.zone.zoneId !== row.id ||
    resume.scope.zone.route !== row.route ||
    !terminal ||
    terminal.accountId !== accountId ||
    terminal.barrierVersion !== barrier.version ||
    terminal.barrierAt !== barrier.at
  )
    return null;
  return {
    source: {
      zone: resume.scope.zone,
      revision: resume.scope.revision,
      lifecycleRevision: resume.scope.lifecycleRevision,
      generation: resume.scope.generation,
      progress: resume.scope.progress,
      protectionRevision: resume.scope.protectionRevision,
    },
    primaryOwner: terminal.primaryOwner,
  };
}

/** Issue Access's opaque grant admission only after the Zone parent is locked in this command. */
export async function admitZoneCleanup(
  tx: CommandTransaction,
  row: ZoneHead,
  input: Readonly<{
    at: string;
    accountId?: string;
    primaryOwner?: ZonePrimaryOwnerEvidence;
    resume?: ZoneGrantCleanupCursor;
  }>,
): Promise<ZoneCleanupAdmission | null> {
  if (row.held) return null;
  const terminal = input.accountId !== undefined;
  const branch = terminal ? 'terminal-account' : intentOf(row, input.at);
  if (!branch) return null;
  if (branch === 'ordinary-expiry' && liveCoverage(row).length > 0) return null;
  const barrier = terminal ? await committedBarrier(tx, input.accountId!) : undefined;
  if (terminal && !barrier) return null;
  const continued =
    terminal && input.resume && barrier ? resumeSource(row, input.accountId!, barrier, input.resume) : null;
  const generation = continued?.source.generation ?? generationOf(row);
  if (!generation) return null;
  const primaryOwner = continued?.primaryOwner ?? input.primaryOwner;
  if (terminal && !primaryOwner) return null;
  const route = row.route;
  const zone = continued?.source.zone ?? { route, zoneId: row.id, home: await home(tx, route) };
  const source: ZoneGrantCleanupSource = continued?.source ?? {
    zone,
    revision: row.revision,
    lifecycleRevision: row.lifecycleRevision,
    generation,
    progress: row.revision,
    protectionRevision: row.lifecycleRevision,
  };
  const grants = (
    terminal
      ? {
          kind: 'terminal-account-subject' as const,
          branch: 'terminal-account' as const,
          source,
          accountId: input.accountId!,
          barrier,
          primaryOwner: primaryOwner!,
          branchEvidence: evidence,
        }
      : {
          kind: 'zone-disposition' as const,
          branch: branchOf(branch),
          source,
          branchEvidence: evidence,
        }
  ) as ZoneGrantCleanupAdmission;
  const admission: ZoneCleanupAdmission = {
    branch,
    zoneId: row.id,
    route,
    revision: source.revision,
    lifecycleRevision: source.lifecycleRevision,
    generation: source.generation,
    protectionRevision: source.protectionRevision,
    grants,
  };
  issued.set(grants, admission);
  return admission;
}

export async function advanceZoneCleanupGrants(
  tx: CommandTransaction,
  admission: ZoneCleanupAdmission,
  cursor: ZoneGrantCleanupCursor | null,
  limit: number,
): Promise<ZoneGrantCleanupPage> {
  if (issued.get(admission.grants) !== admission) throw new TypeError('Zone cleanup admission was not issued here');
  if (routeOf(admission.zoneId) !== admission.route) throw new TypeError('Zone cleanup admission identity changed');
  return minimizeZoneGrantPage(tx, { admission: admission.grants, cursor, limit });
}
