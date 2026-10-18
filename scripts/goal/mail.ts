import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inboxEntries, type InboxEntry } from './regress.ts';

export interface GoalMailMessage {
  id: string; key: string; body: string; createdAt: string; recipients: string[];
  /** Historical mail predating sender/deadline recording retains null fields. */
  sender: string | null; deadlineMinutes: number | null; deadlineAt: string | null;
}
export interface GoalMailDelivery extends GoalMailMessage {
  goal: string; acknowledged: boolean; acknowledgedAt: string | null; overdueAt: string | null;
}
export type GoalMailInboxEntry =
  | (GoalMailDelivery & { source: 'mail' })
  | { source: 'legacy'; id: string; goal: string; path: string; body: string; acknowledged: false }
  | (InboxEntry & { source: 'regression'; id: string; number: number; acknowledged: boolean });
export interface GoalMailOptions {
  stateDir: string; goals: readonly string[]; messagesDir?: string;
  /** The CLI supplies its GOAL_ID; library callers may supply their caller context. */
  sender?: string; now?: () => number;
}

interface MessageRow {
  id: string; key: string; body: string; createdAt: string;
  sender?: string | null; deadlineMinutes?: number | null; deadlineAt?: string | null;
}
interface DeliveryRow extends MessageRow { goal: string; acknowledgedAt: string | null; overdueAt?: string | null }

/** Goal-addressed requests. Delivery and acknowledgement never confer authority. */
export class GoalMailStore {
  readonly path: string;
  private readonly goals: Set<string>;
  private readonly messagesDir: string;
  private db?: Database;
  private closed = false;

  constructor(private readonly options: GoalMailOptions) {
    for (const goal of options.goals) {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(goal) || goal === 'tasks') throw new Error(`Invalid mail Goal: ${goal}`);
    }
    // The resident supermanager has a mailbox even without a product Goal registration.
    this.goals = new Set(['program', ...options.goals]);
    this.path = join(options.stateDir, 'mail.sqlite');
    this.messagesDir = options.messagesDir ?? join(options.stateDir, 'messages');
  }

  private validateGoal(goal: string): void {
    this.ensureOpen();
    if (!this.goals.has(goal)) throw new Error(`Unknown mail Goal: ${goal}`);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Goal mail store is closed');
  }

  private writer(): Database {
    this.ensureOpen();
    if (this.db) return this.db;
    mkdirSync(this.options.stateDir, { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
      // Rollback journals also permit an inbox opened read-only to avoid creating WAL sidecar files.
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, body TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          messageId TEXT NOT NULL REFERENCES messages(id), goal TEXT NOT NULL, acknowledgedAt TEXT,
          PRIMARY KEY (messageId, goal)
        );
        CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(goal, acknowledgedAt);
      `);
      db.transaction(() => {
        for (const [table, columns] of [
          ['messages', ['sender TEXT', 'deadlineMinutes REAL', 'deadlineAt TEXT']],
          ['deliveries', ['overdueAt TEXT']],
        ] as const) {
          const present = new Set((db.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(column=>column.name));
          for (const column of columns) if (!present.has(column.split(' ')[0]!)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
        }
      }).immediate();
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private read<T>(operation: (db: Database) => T, empty: T): T {
    this.ensureOpen();
    if (this.db) return operation(this.db);
    if (!existsSync(this.path)) return empty;
    const db = new Database(this.path, { readonly: true, strict: true });
    try {
      db.exec('PRAGMA busy_timeout = 10000;');
      return operation(db);
    } finally { db.close(); }
  }

  private message(db: Database, row: MessageRow): GoalMailMessage {
    const recipients = db.query<{ goal: string }, [string]>(
      'SELECT goal FROM deliveries WHERE messageId = ? ORDER BY goal').all(row.id).map(entry => entry.goal);
    return { ...row, sender:row.sender ?? null, deadlineMinutes:row.deadlineMinutes ?? null,
      deadlineAt:row.deadlineAt ?? null, recipients };
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private insert(db: Database, recipients: string[], body: string, key: string, sender: string,
    deadlineMinutes: number | null): GoalMailMessage {
    const prior = db.query<MessageRow, [string]>('SELECT * FROM messages WHERE key = ?').get(key);
    if (prior) {
      const message = this.message(db, prior);
      if (message.body !== body || message.sender !== sender || message.deadlineMinutes !== deadlineMinutes
        || JSON.stringify(message.recipients) !== JSON.stringify(recipients)) {
        throw new Error(`Mail retry key already has a different payload: ${key}`);
      }
      return message;
    }
    const now = this.now();
    const message: GoalMailMessage = { id:`mail:${randomUUID()}`,key,body,createdAt:new Date(now).toISOString(),recipients,sender,
      deadlineMinutes,deadlineAt:deadlineMinutes === null ? null : new Date(now+deadlineMinutes*60_000).toISOString() };
    db.query('INSERT INTO messages (id,key,body,createdAt,sender,deadlineMinutes,deadlineAt) VALUES (?,?,?,?,?,?,?)')
      .run(message.id,key,body,message.createdAt,sender,deadlineMinutes,message.deadlineAt);
    const insert = db.query('INSERT INTO deliveries (messageId,goal) VALUES (?,?)');
    for (const recipient of recipients) insert.run(message.id,recipient);
    return message;
  }

  send(goal: string | readonly string[], body: string, key: string, deadlineMinutes?: number): GoalMailMessage {
    this.ensureOpen();
    const sender = this.options.sender ?? process.env.GOAL_ID;
    if (!sender) throw new Error('Mail send needs GOAL_ID to record its sender');
    this.validateGoal(sender);
    const recipients = [...new Set(typeof goal === 'string' ? [goal] : goal)].sort();
    if (!recipients.length) throw new Error('Mail needs at least one recipient Goal');
    for (const recipient of recipients) this.validateGoal(recipient);
    if (typeof key !== 'string' || !key.trim()) throw new Error('Mail needs a nonempty retry key');
    if (typeof body !== 'string' || !body.trim()) throw new Error('Mail needs a nonempty body');
    if (deadlineMinutes !== undefined && (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0
      || !Number.isFinite(new Date(this.now()+deadlineMinutes*60_000).getTime()))) {
      throw new Error('Mail deadline must be a positive finite number of minutes');
    }
    const db = this.writer();
    // IMMEDIATE serializes retry-key comparison and the complete recipient set across senders.
    const commit = db.transaction(() => this.insert(db,recipients,body,key,sender,deadlineMinutes ?? null));
    // The transaction wrapper commits before publishing the stable ID to its caller.
    return commit.immediate();
  }

  private deliveries(goal: string, pendingOnly: boolean): GoalMailDelivery[] {
    this.validateGoal(goal);
    return this.read(db => db.transaction(() => {
      const hasOverdue = (db.query('PRAGMA table_info(deliveries)').all() as {name:string}[]).some(column=>column.name === 'overdueAt');
      const rows = db.query<DeliveryRow, [string]>(`
        SELECT m.*, d.goal, d.acknowledgedAt, ${hasOverdue ? 'd.overdueAt' : 'NULL AS overdueAt'}
        FROM messages m JOIN deliveries d ON d.messageId = m.id
        WHERE d.goal = ? ${pendingOnly ? 'AND d.acknowledgedAt IS NULL' : ''} ORDER BY m.rowid
      `).all(goal);
      return rows.map(row => ({ ...this.message(db, row), goal: row.goal, overdueAt:row.overdueAt ?? null,
        acknowledged: row.acknowledgedAt !== null, acknowledgedAt: row.acknowledgedAt }));
    })(), []);
  }

  pending(goal: string): GoalMailDelivery[] { return this.deliveries(goal, true); }

  overdue(goal?: string): GoalMailDelivery[] {
    if (goal !== undefined) this.validateGoal(goal);
    return this.read(db => {
      if (!(db.query('PRAGMA table_info(messages)').all() as {name:string}[]).some(column=>column.name === 'deadlineAt')) return [];
      const rows = db.query(`SELECT m.*,d.goal,d.acknowledgedAt,d.overdueAt FROM messages m
        JOIN deliveries d ON d.messageId=m.id WHERE d.acknowledgedAt IS NULL AND m.deadlineAt IS NOT NULL
        ${goal === undefined ? '' : 'AND d.goal=?'} ORDER BY m.rowid,d.goal`)
        .all(...(goal === undefined ? [] : [goal])) as DeliveryRow[];
      const now = this.now();
      // Extended ISO years do not sort chronologically as text; compare actual instants.
      return rows.filter(row=>Date.parse(row.deadlineAt!) < now).map(row=>({...this.message(db,row),goal:row.goal,acknowledged:false,
        acknowledgedAt:null,overdueAt:row.overdueAt ?? null}));
    },[]);
  }

  /** One escalation per delivery, committed with its sender notice; notices have no deadline. */
  notifyOverdue(): void {
    if (!this.overdue().some(message=>message.overdueAt === null)) return;
    const db = this.writer();
    db.transaction(() => {
      for (const message of this.overdue()) {
        if (message.overdueAt !== null || !message.sender) continue;
        this.insert(db,[message.sender],`Coordinator deadline notice: ${message.id} from ${message.sender} to ${message.goal}
was not acknowledged by ${message.deadlineAt}. The recipient is being woken once more.`,
        `overdue:${message.id}:${message.goal}`,message.goal,null);
        db.query('UPDATE deliveries SET overdueAt=? WHERE messageId=? AND goal=? AND acknowledgedAt IS NULL')
          .run(new Date(this.now()).toISOString(),message.id,message.goal);
      }
    }).immediate();
  }

  inbox(goal: string): GoalMailInboxEntry[] {
    this.validateGoal(goal);
    const entries: GoalMailInboxEntry[] = this.deliveries(goal, false).map(entry => ({ ...entry, source: 'mail' }));
    const path = join(this.messagesDir, `${goal}.md`);
    if (existsSync(path)) entries.push({ source: 'legacy', id: `legacy:${goal}`, goal, path,
      body: readFileSync(path, 'utf8'), acknowledged: false });
    for (const entry of inboxEntries(this.options.stateDir, goal)) {
      entries.push({ ...entry, source: 'regression', id: `regression:${goal}:${entry.number}` });
    }
    return entries;
  }

  ack(goal: string, id: string): GoalMailDelivery {
    this.validateGoal(goal);
    if (id.startsWith('regression:') || /^\d+$/.test(id)) {
      throw new Error('Regression acknowledgements use the existing inbox --ack <number> command');
    }
    if (id.startsWith('legacy:')) throw new Error('Legacy Markdown mail cannot be acknowledged through mail ack');
    if (!/^mail:[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid mail message ID: ${id}`);
    return this.writer().transaction(() => {
      const db = this.writer();
      const row = db.query<DeliveryRow, [string, string]>(`
        SELECT m.*, d.goal, d.acknowledgedAt, d.overdueAt FROM messages m JOIN deliveries d ON d.messageId = m.id
        WHERE m.id = ? AND d.goal = ?
      `).get(id, goal);
      if (!row) throw new Error(`Mail message ${id} was not delivered to Goal ${goal}`);
      const acknowledgedAt = row.acknowledgedAt ?? new Date(this.now()).toISOString();
      if (row.acknowledgedAt === null) {
        db.query('UPDATE deliveries SET acknowledgedAt = ? WHERE messageId = ? AND goal = ?')
          .run(acknowledgedAt, id, goal);
      }
      return { ...this.message(db, row), goal, acknowledged: true, acknowledgedAt, overdueAt:row.overdueAt ?? null };
    }).immediate();
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.closed = true;
  }
}
