import type { Database } from 'bun:sqlite';
import type { InboxDocumentReference, InboxEscalation, ManagerEvent, ManagerEventKind } from './contracts.ts';
import { migrate } from './db.ts';

export const SHARED_INBOX_DEFAULT_PAGE_SIZE = 50;
export const SHARED_INBOX_MAX_PAGE_SIZE = 100;
const OPEN_QUESTION_AGE_MS = 30 * 60_000;
const OLD_BLOCKER_AGE_MS = 60 * 60_000;

const inboxMigrations = [
  {
    module: 'inbox',
    version: 1,
    sql: `
      CREATE TABLE manager_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, manager TEXT NOT NULL, event TEXT NOT NULL,
        wakeable INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0, read_at INTEGER, acknowledged_at INTEGER
      );
      CREATE INDEX manager_inbox_pending ON manager_inbox(manager, wakeable, read_at);`,
  },
  {
    module: 'inbox',
    version: 2,
    sql: `
      ALTER TABLE manager_inbox ADD COLUMN created_at INTEGER;
      ALTER TABLE manager_inbox ADD COLUMN sender TEXT;
      ALTER TABLE manager_inbox ADD COLUMN goal_id TEXT;
      ALTER TABLE manager_inbox ADD COLUMN task_id TEXT;
      ALTER TABLE manager_inbox ADD COLUMN kind TEXT;
      ALTER TABLE manager_inbox ADD COLUMN summary TEXT;
      ALTER TABLE manager_inbox ADD COLUMN reply_to_id INTEGER;
      ALTER TABLE manager_inbox ADD COLUMN thread_root_id INTEGER;
      ALTER TABLE manager_inbox ADD COLUMN document_refs TEXT;
      ALTER TABLE manager_inbox ADD COLUMN escalation TEXT;
      UPDATE manager_inbox SET
        sender = CASE WHEN json_valid(event) THEN json_extract(event, '$.from') END,
        task_id = CASE WHEN json_valid(event) THEN json_extract(event, '$.taskId') END,
        kind = CASE WHEN json_valid(event) THEN json_extract(event, '$.kind') END,
        summary = CASE WHEN json_valid(event) THEN json_extract(event, '$.summary') END;
      CREATE INDEX manager_inbox_created ON manager_inbox(created_at, id);
      CREATE INDEX manager_inbox_sender ON manager_inbox(sender, id);
      CREATE INDEX manager_inbox_goal ON manager_inbox(goal_id, id);
      CREATE INDEX manager_inbox_task ON manager_inbox(task_id, id);
      CREATE INDEX manager_inbox_reply ON manager_inbox(reply_to_id, id);
      CREATE INDEX manager_inbox_thread_root ON manager_inbox(thread_root_id, id);
      CREATE INDEX manager_inbox_question_created ON manager_inbox(goal_id, created_at, id) WHERE kind = 'question';
      CREATE TRIGGER manager_inbox_created_immutable
        BEFORE UPDATE OF created_at ON manager_inbox
        WHEN OLD.created_at IS NOT NEW.created_at
        BEGIN SELECT RAISE(ABORT, 'manager inbox creation time is immutable'); END;`,
  },
  {
    module: 'inbox',
    version: 3,
    sql: `
      ALTER TABLE manager_inbox ADD COLUMN dedupe_key TEXT;
      ALTER TABLE manager_inbox ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE manager_inbox ADD COLUMN last_delivered_at INTEGER;
      ALTER TABLE manager_inbox ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX manager_inbox_dedupe ON manager_inbox(dedupe_key, created_at) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX manager_inbox_sender_created ON manager_inbox(sender, created_at);`,
  },
] as const;

/** The writer and all read-only consumers use this one schema contract. Historical arrival times stay unknown. */
export function migrateSharedInbox(db: Database): void {
  migrate(db, inboxMigrations);
}

export type SharedInboxFilter = {
  from?: string;
  to?: string;
  goal?: string;
  task?: string;
  since?: string | number;
  grep?: string;
  limit?: number;
  cursor?: number;
};

export type SharedInboxMessage = {
  id: number;
  event: unknown;
  from: string | null;
  to: string;
  goal: string | null;
  task: string | null;
  kind: string | null;
  summary: string | null;
  createdAt: number | null;
  replyToId: number | null;
  threadRootId: number;
  documentRefs: InboxDocumentReference[] | null;
  escalation: InboxEscalation | null;
};

export type InboxPage<T> = {
  entries: T[];
  limit: number;
  nextCursor: number | null;
  hasMore: boolean;
};

export type InboxDigestCounts = {
  decisions: number;
  blockers: number;
  escalations: number;
  overdueQuestions: number;
  blockersOverOneHour: number;
};

export type InboxDigestGroup = { goal: string | null; counts: InboxDigestCounts };
export type InboxDigestDetail = SharedInboxMessage & {
  category: 'decision' | 'blocker' | 'escalation' | 'overdue-question' | 'blocker-intervention';
  ageMs: number | null;
  answeredById: number | null;
};
export type InboxDigest = {
  since: number;
  generatedAt: number;
  groups: InboxDigestGroup[];
  totals: InboxDigestCounts;
  details: InboxPage<InboxDigestDetail>;
};

type InboxRow = {
  id: number;
  manager: string;
  event: string;
  sender: string | null;
  goal_id: string | null;
  task_id: string | null;
  kind: string | null;
  summary: string | null;
  created_at: number | null;
  reply_to_id: number | null;
  thread_root_id: number | null;
  document_refs: string | null;
  escalation: string | null;
  category?: InboxDigestDetail['category'];
  answered_by_id?: number | null;
};

function parsed<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function documentReferences(text: string | null): InboxDocumentReference[] | null {
  const value = parsed<unknown>(text);
  if (
    !Array.isArray(value) ||
    !value.every(
      (reference) =>
        isObjectRecord(reference) &&
        typeof reference.path === 'string' &&
        Boolean(reference.path.trim()) &&
        (reference.change === undefined || typeof reference.change === 'string'),
    )
  )
    return null;
  return value as InboxDocumentReference[];
}

function escalationMetadata(text: string | null): InboxEscalation | null {
  const value = parsed<unknown>(text);
  if (
    !isObjectRecord(value) ||
    typeof value.reason !== 'string' ||
    (value.target !== undefined && typeof value.target !== 'string')
  )
    return null;
  return value as InboxEscalation;
}

function validEscalationSql(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN
    json_type(${column}) = 'object'
    AND json_type(${column}, '$.reason') = 'text'
    AND (json_type(${column}, '$.target') IS NULL OR json_type(${column}, '$.target') = 'text')
    ELSE 0 END`;
}

function safeEvent(text: string): unknown {
  return parsed(text);
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label}`);
  return value;
}

export function parseInboxTime(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid inbox time');
    return value <= 9_999_999_999 ? value * 1000 : value;
  }
  const text = value.trim();
  if (!text) throw new Error('invalid inbox time');
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error('invalid inbox time');
    return text.length <= 10 ? numeric * 1000 : numeric;
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid inbox time: ${value}`);
  return timestamp;
}

function pageLimit(limit: number | undefined): number {
  const selected = limit ?? SHARED_INBOX_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > SHARED_INBOX_MAX_PAGE_SIZE)
    throw new Error(`inbox page limit must be between 1 and ${SHARED_INBOX_MAX_PAGE_SIZE}`);
  return selected;
}

function message(row: InboxRow): SharedInboxMessage {
  return {
    id: row.id,
    event: safeEvent(row.event),
    from: row.sender,
    to: row.manager,
    goal: row.goal_id,
    task: row.task_id,
    kind: row.kind,
    summary: row.summary,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
    threadRootId: row.thread_root_id ?? row.id,
    documentRefs: documentReferences(row.document_refs),
    escalation: escalationMetadata(row.escalation),
  };
}

function appendPage<T>(rows: T[], limit: number, cursorFor: (item: T) => number): InboxPage<T> {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  return {
    entries,
    limit,
    hasMore,
    nextCursor: hasMore && entries.length ? cursorFor(entries[entries.length - 1]!) : null,
  };
}

function filterWhere(filter: SharedInboxFilter): { clauses: string[]; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  for (const [value, column] of [
    [filter.from, 'sender'],
    [filter.to, 'manager'],
    [filter.goal, 'goal_id'],
    [filter.task, 'task_id'],
  ] as const) {
    if (value !== undefined) {
      if (!value.trim()) throw new Error('inbox filters must be nonempty');
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (filter.since !== undefined) {
    clauses.push('created_at >= ?');
    values.push(parseInboxTime(filter.since));
  }
  if (filter.grep !== undefined) {
    if (!filter.grep.trim()) throw new Error('inbox --grep must be nonempty');
    clauses.push("instr(lower(COALESCE(summary, '')), lower(?)) > 0");
    values.push(filter.grep);
  }
  const cursor = positiveInteger(filter.cursor, 'inbox cursor');
  if (cursor !== undefined) {
    clauses.push('id < ?');
    values.push(cursor);
  }
  return { clauses, values };
}

function answerJoin(questionId: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM manager_inbox AS answer
    WHERE answer.reply_to_id = ${questionId} AND answer.kind IN ('decision', 'info')
  )`;
}

/** Read-only, cross-recipient queries. This class never reads or updates delivery state. */
export class SharedInboxQueries {
  constructor(private readonly db: Database) {}

  log(filter: SharedInboxFilter = {}): InboxPage<SharedInboxMessage> {
    const limit = pageLimit(filter.limit);
    const { clauses, values } = filterWhere(filter);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .query(`SELECT id, manager, event, sender, goal_id, task_id, kind, summary, created_at,
          reply_to_id, thread_root_id, document_refs, escalation
        FROM manager_inbox ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values, limit + 1) as InboxRow[];
    return appendPage(rows.map(message), limit, (item) => item.id);
  }

  thread(
    reference: string | number,
    options: { limit?: number; cursor?: number } = {},
  ): InboxPage<SharedInboxMessage> & {
    reference: string;
    rootId: number | null;
  } {
    const limit = pageLimit(options.limit);
    const cursor = positiveInteger(options.cursor, 'inbox cursor');
    const text = String(reference).trim();
    if (!text) throw new Error('inbox thread reference must be nonempty');
    const numericId = /^\d+$/.test(text) ? Number(text) : undefined;
    if (numericId !== undefined && !Number.isSafeInteger(numericId)) throw new Error('invalid inbox message id');
    let rootId: number | null = null;
    let taskLookup = false;
    if (numericId !== undefined) {
      const found = this.db.query('SELECT id, thread_root_id FROM manager_inbox WHERE id = ?').get(numericId) as {
        id: number;
        thread_root_id: number | null;
      } | null;
      if (found) rootId = found.thread_root_id ?? found.id;
      else taskLookup = true;
    } else taskLookup = true;

    const bindLimit = limit + 1;
    let rows: InboxRow[];
    if (taskLookup) {
      const task = text;
      const count = this.db.query('SELECT COUNT(*) AS count FROM manager_inbox WHERE task_id = ?').get(task) as {
        count: number;
      };
      if (!count.count) throw new Error(`inbox thread not found: ${text}`);
      const cursorClause = cursor === undefined ? '' : 'AND id > ?';
      const params = cursor === undefined ? [task, task, bindLimit] : [task, task, cursor, bindLimit];
      rows = this.db
        .query(`SELECT id, manager, event, sender, goal_id, task_id, kind, summary, created_at,
            reply_to_id, thread_root_id, document_refs, escalation
          FROM manager_inbox
          WHERE (task_id = ? OR thread_root_id IN (
            SELECT DISTINCT COALESCE(thread_root_id, id) FROM manager_inbox WHERE task_id = ?
          )) ${cursorClause}
          ORDER BY id ASC LIMIT ?`)
        .all(...params) as InboxRow[];
    } else {
      const cursorClause = cursor === undefined ? '' : 'AND id > ?';
      const params = cursor === undefined ? [rootId, rootId, bindLimit] : [rootId, rootId, cursor, bindLimit];
      rows = this.db
        .query(`SELECT id, manager, event, sender, goal_id, task_id, kind, summary, created_at,
            reply_to_id, thread_root_id, document_refs, escalation
          FROM manager_inbox WHERE (thread_root_id = ? OR id = ?) ${cursorClause}
          ORDER BY id ASC LIMIT ?`)
        .all(...params) as InboxRow[];
    }
    const page = appendPage(rows.map(message), limit, (item) => item.id);
    return { ...page, reference: text, rootId };
  }

  digest(sinceValue: string | number, options: { limit?: number; cursor?: number; now?: number } = {}): InboxDigest {
    const since = parseInboxTime(sinceValue);
    const generatedAt = options.now ?? Date.now();
    if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) throw new Error('invalid digest time');
    const limit = pageLimit(options.limit);
    const cursor = positiveInteger(options.cursor, 'inbox cursor');
    const openQuestion = answerJoin('manager_inbox.id');
    const validEscalation = validEscalationSql('escalation');
    const groupsRows = this.db
      .query(`SELECT goal_id,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS decisions,
          COALESCE(SUM(CASE WHEN kind = 'blocker' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS blockers,
          COALESCE(SUM(CASE WHEN (${validEscalation}) AND created_at >= ? THEN 1 ELSE 0 END), 0) AS escalations,
          COALESCE(SUM(CASE WHEN kind = 'question' AND created_at < ? AND ${openQuestion} THEN 1 ELSE 0 END), 0) AS overdue_questions,
          COALESCE(SUM(CASE WHEN kind = 'blocker' AND created_at < ? AND ${answerJoinForBlocker()} THEN 1 ELSE 0 END), 0) AS old_blockers
        FROM manager_inbox
        WHERE (created_at >= ? AND (kind IN ('decision', 'blocker') OR (${validEscalation})))
          OR (kind = 'question' AND created_at < ? AND ${openQuestion})
          OR (kind = 'blocker' AND created_at < ? AND ${answerJoinForBlocker()})
        GROUP BY goal_id ORDER BY goal_id`)
      .all(
        since,
        since,
        since,
        generatedAt - OPEN_QUESTION_AGE_MS,
        generatedAt - OLD_BLOCKER_AGE_MS,
        since,
        generatedAt - OPEN_QUESTION_AGE_MS,
        generatedAt - OLD_BLOCKER_AGE_MS,
      ) as {
      goal_id: string | null;
      decisions: number;
      blockers: number;
      escalations: number;
      overdue_questions: number;
      old_blockers: number;
    }[];
    const groups: InboxDigestGroup[] = groupsRows
      .map((row) => ({
        goal: row.goal_id,
        counts: {
          decisions: row.decisions,
          blockers: row.blockers,
          escalations: row.escalations,
          overdueQuestions: row.overdue_questions,
          blockersOverOneHour: row.old_blockers,
        },
      }))
      .filter((group) => Object.values(group.counts).some((count) => count > 0));
    const totals = groups.reduce(
      (total, group) => {
        for (const key of Object.keys(total) as (keyof InboxDigestCounts)[]) total[key] += group.counts[key];
        return total;
      },
      { decisions: 0, blockers: 0, escalations: 0, overdueQuestions: 0, blockersOverOneHour: 0 },
    );

    const cursorClause = cursor === undefined ? '' : 'AND event_row.id > ?';
    const detailRows = this.db
      .query(`WITH candidates AS (
          SELECT id, CASE
            WHEN kind = 'question' THEN 'overdue-question'
            WHEN kind = 'blocker' AND created_at < ? THEN 'blocker-intervention'
            WHEN kind = 'blocker' THEN 'blocker'
            WHEN (${validEscalation}) THEN 'escalation'
            ELSE 'decision' END AS category
          FROM manager_inbox AS question
          WHERE (kind = 'decision' AND created_at >= ?)
            OR (kind = 'blocker' AND created_at >= ?)
            OR ((${validEscalation}) AND created_at >= ?)
            OR (kind = 'question' AND created_at < ? AND ${answerJoin('question.id')})
            OR (kind = 'blocker' AND created_at < ? AND ${answerJoinForBlocker('question.id')})
        )
        SELECT event_row.id, event_row.manager, event_row.event, event_row.sender, event_row.goal_id, event_row.task_id,
          event_row.kind, event_row.summary, event_row.created_at, event_row.reply_to_id, event_row.thread_root_id,
          event_row.document_refs, event_row.escalation,
          candidates.category,
          (SELECT answer.id FROM manager_inbox AS answer WHERE answer.reply_to_id = event_row.id
            AND answer.kind IN ('decision','info') ORDER BY answer.id ASC LIMIT 1) AS answered_by_id
          FROM candidates JOIN manager_inbox AS event_row ON event_row.id = candidates.id
        WHERE 1 = 1 ${cursorClause}
        ORDER BY event_row.id ASC LIMIT ?`)
      .all(
        generatedAt - OLD_BLOCKER_AGE_MS,
        since,
        since,
        since,
        generatedAt - OPEN_QUESTION_AGE_MS,
        generatedAt - OLD_BLOCKER_AGE_MS,
        ...(cursor === undefined ? [] : [cursor]),
        limit + 1,
      ) as InboxRow[];
    const details = appendPage(
      detailRows.map((row) => ({
        ...message(row),
        category: row.category!,
        ageMs: row.created_at === null ? null : Math.max(0, generatedAt - row.created_at),
        answeredById: row.answered_by_id ?? null,
      })),
      limit,
      (item) => item.id,
    );
    return { since, generatedAt, groups, totals, details };
  }
}

function answerJoinForBlocker(id = 'manager_inbox.id'): string {
  return `NOT EXISTS (
    SELECT 1 FROM manager_inbox AS answer
    WHERE answer.reply_to_id = ${id} AND answer.kind IN ('decision', 'info')
  )`;
}

/** Extract only known fields from an event before they enter the indexed shared relation. */
export function sharedInboxFields(event: unknown): {
  sender: string | null;
  taskId: string | null;
  goalId: string | null;
  kind: ManagerEventKind | string | null;
  summary: string | null;
  replyToId: number | null;
  documentRefs: InboxDocumentReference[] | null;
  escalation: InboxEscalation | null;
} {
  if (!event || typeof event !== 'object' || Array.isArray(event))
    return {
      sender: null,
      taskId: null,
      goalId: null,
      kind: null,
      summary: null,
      replyToId: null,
      documentRefs: null,
      escalation: null,
    };
  const value = event as Partial<ManagerEvent>;
  if (value.replyToId !== undefined && (!Number.isSafeInteger(value.replyToId) || value.replyToId <= 0))
    throw new Error('inbox reply reference must be a positive message id');
  const replyToId = Number.isSafeInteger(value.replyToId) && value.replyToId! > 0 ? value.replyToId! : null;
  const documentRefs = Array.isArray(value.documentRefs)
    ? value.documentRefs.filter(
        (reference): reference is InboxDocumentReference =>
          Boolean(reference && typeof reference.path === 'string' && reference.path.trim()) &&
          (reference.change === undefined || typeof reference.change === 'string'),
      )
    : null;
  const escalation =
    value.escalation &&
    typeof value.escalation === 'object' &&
    typeof value.escalation.reason === 'string' &&
    value.escalation.reason.trim()
      ? value.escalation
      : null;
  return {
    sender: typeof value.from === 'string' && value.from ? value.from : null,
    taskId: typeof value.taskId === 'string' && value.taskId ? value.taskId : null,
    goalId: typeof value.goalId === 'string' && value.goalId ? value.goalId : null,
    kind: typeof value.kind === 'string' && value.kind ? value.kind : null,
    summary: typeof value.summary === 'string' ? value.summary : null,
    replyToId,
    documentRefs,
    escalation,
  };
}
