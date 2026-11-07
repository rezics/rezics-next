/** Native progress catalog. Access/Semantic descriptors and shelf-maintenance plans are bound here. */

import { RELEASE_LIMITS } from '@rezics/definitions';
import { accessAccountStatements } from '../../access/adapters/account-statements.ts';
import { semanticProgressIdentityStatements } from '../../semantic/adapters/progress-identity-statements.ts';
import type { Bound } from '@rezics/bounds';
import type {
  ProgressOperationCatalog,
  ProgressShelfStatement,
  ProgressSqlDescriptor,
  SessionWork,
} from '../contract/index.ts';
import { sessionWorkOf } from '../core/index.ts';
import { shelfMaintenanceStatementPlan } from '../shelf-maintenance-statement-bounds.ts';
import sessionInsert from '../progress-store-session-insert.sql';
import sessionRead from '../progress-store-session-read.sql';
import sessionUpdate from '../progress-store-session-update.sql';
import sessionPage from '../progress-store-session-page.sql';
import journalRead from '../progress-store-session-journal-read.sql';
import journalLock from '../progress-store-session-journal-lock.sql';
import journalUpdate from '../progress-store-session-journal-update.sql';
import unitAdd from '../progress-store-unit-add.sql';
import unitRemove from '../progress-store-unit-remove.sql';
import unitClear from '../progress-commands-clear-units.sql';
import unitPage from '../progress-store-unit-page.sql';
import changeAppend from '../progress-store-change-append.sql';
import changePage from '../progress-store-change-page.sql';
import sessionLock from '../session-lock.sql';
import discoveryPage from '../progress-discovery-page.sql';
import discoveryGeneration from '../progress-discovery-generation-read.sql';
import discoveryReleases from '../progress-discovery-releases.sql';
import profileMigration from '../profile-migration-progress.sql';
import receiptRead from '../../command/read-receipt.sql';
import eventFence from '../../command/fence.sql';
import noEffectFence from '../../command/no-effect-fence.sql';
import timeRead from '../../command/time.sql';
import partitionRead from '../../partition/read.sql';
import gateRead from '../shelf-maintenance-gate-read.sql';
import gateEnsure from '../shelf-maintenance-gate-ensure.sql';
import gateLock from '../shelf-maintenance-gate-lock.sql';
import gateShare from '../shelf-maintenance-gate-share.sql';
import gateSave from '../shelf-maintenance-gate-save.sql';
import shelfInputs from '../shelf-maintenance-inputs.sql';
import runCreate from '../shelf-maintenance-run-create.sql';
import runRead from '../shelf-maintenance-run-read.sql';
import stepSave from '../shelf-maintenance-step-save.sql';
import counterInitialize from '../shelf-counter-owner-initialize.sql';
import counterRead from '../shelf-counter-owner-read.sql';
import counterComplete from '../shelf-counter-owner-complete.sql';
import headEnsure from '../shelf-head-ensure.sql';
import headTouch from '../shelf-head-touch.sql';
import entryRaise from '../shelf-entry-raise.sql';

type QueryText = Readonly<{ sql: string; params?: readonly string[] }>;

const meaningSql = `INSERT INTO library.reading_insights_progress_meaning
        (route,session_id,unit_id,meaning_revision,mode,profile_pin,dimension,precision,minimum,maximum,
         total_policy,identity_kind,structure_kind)
       SELECT $1,$2,unit_id,1,mode,$3::jsonb,dimension,precision,minimum,maximum,total_policy,identity_kind,structure_kind
       FROM jsonb_to_recordset($4::jsonb) AS accepted(
         unit_id text, mode text, dimension text, precision smallint, minimum numeric, maximum numeric,
         total_policy text, identity_kind text, structure_kind text)`;
const refreshSql = 'SELECT library.reading_insights_current_progress_refresh($1,$2)';

function sqlOf(query: QueryText): string {
  return query.sql;
}

function copyDescriptor(descriptor: ProgressSqlDescriptor): ProgressSqlDescriptor {
  return Object.freeze({
    sql: descriptor.sql,
    ...(descriptor.params ? { params: descriptor.params } : {}),
    nativeRows: descriptor.nativeRows,
    nativePoints: descriptor.nativePoints,
    identityMetadataRows: descriptor.identityMetadataRows,
    resultBytes: descriptor.resultBytes,
  });
}

function sessionWorkFrom(bound: Bound): SessionWork {
  return sessionWorkOf(bound);
}

export const PROGRESS_MEANING_SQL = meaningSql;
export const PROGRESS_REFRESH_SQL = refreshSql;

export function createProgressOperationCatalog(): ProgressOperationCatalog {
  const shelfQueries: Readonly<Record<ProgressShelfStatement, QueryText>> = Object.freeze({
    'gate-read': gateRead,
    'gate-ensure': gateEnsure,
    'gate-lock': gateLock,
    'gate-share': gateShare,
    'gate-save': gateSave,
    inputs: shelfInputs,
    'run-create': runCreate,
    'run-read': runRead,
    'step-save': stepSave,
    'counter-initialize': counterInitialize,
    'counter-read': counterRead,
    'counter-complete': counterComplete,
    'head-ensure': headEnsure,
    'head-touch': headTouch,
    'entry-raise': entryRaise,
  });
  const access = accessAccountStatements();
  const semantic = semanticProgressIdentityStatements();
  return Object.freeze({
    releaseBytes: RELEASE_LIMITS.bytes,
    session: Object.freeze({
      insert: sqlOf(sessionInsert),
      read: sqlOf(sessionRead),
      update: sqlOf(sessionUpdate),
      lock: sqlOf(sessionLock),
      journalRead: sqlOf(journalRead),
      journalLock: sqlOf(journalLock),
      journalUpdate: sqlOf(journalUpdate),
      unitAdd: sqlOf(unitAdd),
      unitRemove: sqlOf(unitRemove),
      unitClear: sqlOf(unitClear),
      unitPage: sqlOf(unitPage),
      changeAppend: sqlOf(changeAppend),
      changePage: sqlOf(changePage),
      subjectPage: sqlOf(sessionPage),
      ownerPage: sqlOf(discoveryPage),
      ownerGeneration: sqlOf(discoveryGeneration),
      discoveryReleases: sqlOf(discoveryReleases),
      meaningInsert: meaningSql,
      meaningRefresh: refreshSql,
      profileMigration: sqlOf(profileMigration),
    }),
    access: Object.freeze({
      accountRead: copyDescriptor(access['account-read']),
      accountShare: copyDescriptor(access['account-share']),
    }),
    semantic: Object.freeze({
      releaseExists: copyDescriptor(semantic['release-exists']),
      releaseRead: copyDescriptor(semantic['release-read']),
      releaseActive: copyDescriptor(semantic['release-active']),
      mappingOwners: copyDescriptor(semantic['mapping-owners']),
      mappingSources: copyDescriptor(semantic['mapping-sources']),
      mappingPending: copyDescriptor(semantic['mapping-pending']),
      mappingCurrent: copyDescriptor(semantic['mapping-current']),
      subjectReference: copyDescriptor(semantic['subject-reference']),
      itemTypes: copyDescriptor(semantic['item-types']),
    }),
    command: Object.freeze({
      receiptRead: sqlOf(receiptRead),
      eventFence: sqlOf(eventFence),
      noEffectFence: sqlOf(noEffectFence),
      timeRead: sqlOf(timeRead),
      partitionRead: sqlOf(partitionRead),
    }),
    shelf: Object.freeze({
      plan(statement: ProgressShelfStatement, values: readonly unknown[], valueBytes: number): SessionWork {
        const plan = shelfMaintenanceStatementPlan(shelfQueries[statement].sql, values, valueBytes);
        if (!plan) throw new TypeError(`Missing shelf-maintenance descriptor for ${statement}`);
        return sessionWorkFrom(plan.total);
      },
    }),
  });
}
