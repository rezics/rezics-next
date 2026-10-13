import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

type DecisionOption = { letter: string; text: string };
type DecisionRow = {
  id: number; goal: string; task: string | null; question: string; options: string;
  recommended: string; defaultLetter: string | null; defaultAt: string | null; createdAt: string;
  answerLetter: string | null; answeredAt: string | null; answerNote: string | null;
};
type OutboxRow = { id: number; body: string; createdAt: string; sentAt: string | null; state: 'queued' | 'sending' | 'sent' };

export interface TelegramDecision {
  code: string; goal: string; task: string | null; question: string; options: DecisionOption[];
  recommended: string; defaultLetter: string | null; defaultAt: string | null; createdAt: string;
  answerLetter: string | null; answeredAt: string | null; answerNote: string | null;
}
export interface NotifyOptions {
  /** Isolates tests and local trials from the shared Goal state directory. */
  stateDir?: string;
  now?: () => number;
}
export interface FlushResult { sent: number; queuedId?: number; reason?: string; busy?: boolean }

const events = {
  start: { question: 'Should this Goal start?', notice: 'The Goal manager started.' },
  pause: { question: 'Should this Goal stay paused?', notice: 'The Goal manager paused the Goal.' },
  stop: { question: 'Should this Goal stop?', notice: 'The Goal manager stopped the Goal.' },
  fault: { question: 'What should happen after this fault?', notice: 'The Goal manager reported a fault.' },
  allowance: { question: 'Should this Goal wait for its allowance to reset?', notice: 'The Goal manager reached an allowance limit.' },
  host: { question: 'Should this Goal keep waiting on the host?', notice: 'The Goal manager is waiting on the host.' },
} as const;
type NoticeEvent = keyof typeof events;

class NotifyError extends Error {}

function mainCheckoutRoot(): string {
  const checkout = resolve(import.meta.dir, '../..');
  const marker = `${sep}.temp${sep}worktrees${sep}`;
  const markerIndex = checkout.lastIndexOf(marker);
  return markerIndex < 0 ? checkout : checkout.slice(0, markerIndex);
}

function stateDirectory(options: NotifyOptions): string {
  if (options.stateDir) return resolve(options.stateDir);
  if (process.env.GOAL_MAIL_STATE_DIR) return resolve(process.env.GOAL_MAIL_STATE_DIR);
  return join(mainCheckoutRoot(), '.temp', 'goal-orchestration');
}

function database(directory: string): Database {
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, 'telegram.sqlite'), { create: true, strict: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal TEXT NOT NULL,
      task TEXT,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      recommended TEXT NOT NULL,
      defaultLetter TEXT,
      defaultAt TEXT,
      createdAt TEXT NOT NULL,
      answerLetter TEXT,
      answeredAt TEXT,
      answerNote TEXT
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      sentAt TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'sent'))
    );
    CREATE INDEX IF NOT EXISTS telegram_outbox_pending ON outbox(state, id);
    CREATE INDEX IF NOT EXISTS telegram_decisions_open ON decisions(answeredAt, id);
  `);
  return db;
}

function timestamp(options: NotifyOptions): string {
  return new Date((options.now ?? Date.now)()).toISOString();
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function field(value: string, name: string, limit: number): string {
  const length = [...value].length;
  if (!value.trim()) throw new NotifyError(`${name} must not be empty`);
  if (length > limit) throw new NotifyError(`${name} must be ${limit} characters or fewer`);
  if (/[\r\n\u0085\u2028\u2029]/u.test(value)) throw new NotifyError(`${name} must fit on one line`);
  if (value.includes('```')) throw new NotifyError(`${name} must not contain a code fence`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new NotifyError(`${name} must be plain text`);
  return value;
}

function goalField(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,40}$/u.test(value)) throw new NotifyError('Goal must be a valid Goal slug');
  return value;
}

function taskField(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(value)) throw new NotifyError('Task must be a valid task identifier');
  return value;
}

function decisionCode(id: number): string { return `D-${id}`; }

function optionByLetter(options: DecisionOption[], letter: string): DecisionOption | undefined {
  return options.find(option => option.letter === letter);
}

function validLetter(value: string): boolean { return /^[a-z]$/u.test(value); }

function parseOptions(values: string[]): DecisionOption[] {
  if (values.length < 2 || values.length > 4) throw new NotifyError('Ask needs two to four --option values');
  const options = values.map(value => {
    const separator = value.indexOf('=');
    const letter = value.slice(0, separator);
    if (separator < 1 || !validLetter(letter)) throw new NotifyError('Each option must use --option <letter>=<text>');
    return { letter, text: field(value.slice(separator + 1), 'Option', 200) };
  });
  if (new Set(options.map(option => option.letter)).size !== options.length) {
    throw new NotifyError('Option letters must be unique');
  }
  return options;
}

function validateUtc(value: string): string {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/u.exec(value);
  const date = new Date(value);
  const milliseconds = Number((match?.[7] ?? '').padEnd(3, '0') || 0);
  if (!match || !Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3]) || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5]) || date.getUTCSeconds() !== Number(match[6])
    || date.getUTCMilliseconds() !== milliseconds) {
    throw new NotifyError('Default time must be an ISO UTC timestamp ending in Z');
  }
  return value;
}

function parseFlags(args: string[], allowed: string[], repeatable: string[] = [], bare: string[] = []): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.includes(flag)) throw new NotifyError('Unknown or invalid option');
    if (bare.includes(flag)) {
      if (values[flag]) throw new NotifyError('An option may only be supplied once');
      values[flag] = [];
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new NotifyError('Every option needs a value');
    if (!repeatable.includes(flag) && values[flag]) throw new NotifyError('An option may only be supplied once');
    (values[flag] ??= []).push(value);
    index += 1;
  }
  return values;
}

function one(flags: Record<string, string[]>, flag: string, required = false): string | undefined {
  const value = flags[flag]?.[0];
  if (required && value === undefined) throw new NotifyError(`${flag} is required`);
  return value;
}

function askBody(code: string, goal: string, task: string | null, question: string, options: DecisionOption[], recommended: string,
  defaultLetter: string | null, defaultAt: string | null): string {
  const recommendedOption = optionByLetter(options, recommended)!;
  return [
    `<code>${code}</code>`,
    `Goal: ${html(goal)}`,
    `Task: ${html(task ?? 'none')}`,
    `Question: ${html(question)}`,
    'Options:',
    ...options.map(option => `${html(option.letter)}) ${html(option.text)}`),
    `Recommended: ${html(recommended)} — ${html(recommendedOption.text)}`,
    ...(defaultLetter === null ? [] : [`Default: ${html(defaultLetter)} at ${html(defaultAt!)}`]),
    '',
    `<code>${code} ${html(recommended)}</code>`,
  ].join('\n');
}

function noticeBody(id: number, event: NoticeEvent, goal: string, task: string | null, note: string | undefined): string {
  const template = events[event];
  return [
    `<code>Goal ${event}</code>`,
    `Goal: ${html(goal)}`,
    `Task: ${html(task ?? 'none')}`,
    `Question: ${html(template.question)}`,
    `Notice #${id}: ${html(template.notice)}`,
    ...(note === undefined ? [] : [`Note: ${html(note)}`]),
  ].join('\n');
}

function enqueue(db: Database, bodyForId: (id: number) => string, createdAt: string): number {
  const result = db.query('INSERT INTO outbox (body, createdAt, state) VALUES (?, ?, \'queued\')').run('', createdAt);
  const id = Number(result.lastInsertRowid);
  db.query('UPDATE outbox SET body = ? WHERE id = ?').run(bodyForId(id), id);
  return id;
}

type TelegramConfig = { token?: string; chat?: string; api?: string };

function secretPath(): string {
  return process.env.GOAL_TELEGRAM_SECRETS || resolve(mainCheckoutRoot(), '../.secrets/bots.json');
}

function telegramConfig(stateDir: string): TelegramConfig {
  let token: string | undefined;
  try {
    const secrets = JSON.parse(readFileSync(secretPath(), 'utf8')) as { telegram?: { token?: unknown }[] };
    const candidate = secrets.telegram?.[0]?.token;
    if (typeof candidate === 'string' && candidate.trim()) token = candidate.trim();
  } catch {
    // Missing or malformed secrets stay private and leave notices queued.
  }
  let chat = process.env.GOAL_TELEGRAM_CHAT?.trim();
  if (!chat) {
    try { chat = readFileSync(join(stateDir, 'telegram-chat'), 'utf8').trim(); }
    catch { /* An absent chat is reported without exposing the file path. */ }
  }
  return { token, chat: chat || undefined, api: process.env.GOAL_TELEGRAM_API || 'https://api.telegram.org' };
}

function ensureSecretAbsent(text: string, token: string | undefined): void {
  if (token && text.includes(token)) throw new NotifyError('A Telegram token cannot appear in a notification');
}

function apiUrl(base: string, token: string): string | undefined {
  try {
    const root = new URL(base);
    const localHttp = root.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname);
    if (root.protocol !== 'https:' && !localHttp) return undefined;
    root.pathname = `${root.pathname.replace(/\/$/u, '')}/bot${token}/sendMessage`;
    root.search = '';
    root.hash = '';
    return root.toString();
  } catch { return undefined; }
}

function claimOldest(db: Database): { row?: OutboxRow; busy: boolean } {
  return db.transaction(() => {
    const active = db.query<OutboxRow, []>("SELECT * FROM outbox WHERE state = 'sending' ORDER BY id LIMIT 1").get();
    if (active) return { busy: true, row: active };
    const row = db.query<OutboxRow, []>("SELECT * FROM outbox WHERE state = 'queued' ORDER BY id LIMIT 1").get();
    if (!row) return { busy: false };
    db.query("UPDATE outbox SET state = 'sending' WHERE id = ? AND state = 'queued'").run(row.id);
    return { row, busy: false };
  }).immediate();
}

async function sendMessage(config: TelegramConfig, body: string): Promise<string | undefined> {
  if (!config.token || !config.chat) {
    const missing = [!config.token ? 'token' : '', !config.chat ? 'chat' : ''].filter(Boolean);
    return `missing Telegram ${missing.join(' and ')}`;
  }
  const url = apiUrl(config.api!, config.token);
  if (!url) return 'invalid Telegram API configuration';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chat, text: body, parse_mode: 'HTML' }),
    });
    if (!response.ok) return `Telegram returned HTTP ${response.status}`;
    const result = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
    if (result?.ok === false) return 'Telegram rejected the message';
    return undefined;
  } catch {
    return 'network error';
  }
}

function markSent(db: Database, id: number, sentAt: string): void {
  db.query("UPDATE outbox SET state = 'sent', sentAt = ? WHERE id = ? AND state = 'sending'").run(sentAt, id);
}

function returnToQueue(db: Database, id: number): void {
  db.query("UPDATE outbox SET state = 'queued' WHERE id = ? AND state = 'sending'").run(id);
}

/** Sends pending Telegram notices oldest first. Successful rows are never sent again. */
export async function flush(options: NotifyOptions = {}): Promise<FlushResult> {
  const directory = stateDirectory(options);
  const db = database(directory);
  const config = telegramConfig(directory);
  let sent = 0;
  try {
    for (;;) {
      const claim = claimOldest(db);
      if (claim.busy) return { sent, queuedId: claim.row?.id, reason: 'another delivery is in progress', busy: true };
      if (!claim.row) return { sent };
      ensureSecretAbsent(claim.row.body, config.token);
      const error = await sendMessage(config, claim.row.body);
      if (error) {
        returnToQueue(db, claim.row.id);
        return { sent, queuedId: claim.row.id, reason: error };
      }
      markSent(db, claim.row.id, timestamp(options));
      sent += 1;
    }
  } finally { db.close(); }
}

function displayFlush(result: FlushResult, subject?: string): string {
  if (result.busy) return `Queued ${subject ? `${subject}; ` : ''}waiting for message #${result.queuedId ?? 'in progress'}.`;
  if (result.queuedId !== undefined) {
    const label = subject ? `${subject}; ` : '';
    return `Queued ${label}message #${result.queuedId}: ${result.reason ?? 'waiting for an earlier delivery'}.`;
  }
  if (subject) return `Sent ${subject}.`;
  return result.sent ? `Sent ${result.sent} queued message${result.sent === 1 ? '' : 's'}.` : 'Outbox is empty.';
}

function age(createdAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatDecision(row: DecisionRow, now: number): string {
  const defaultValue = row.defaultLetter === null ? 'none' : `${row.defaultLetter} at ${row.defaultAt}`;
  return `${decisionCode(row.id)} | age: ${age(row.createdAt, now)} | ${row.question} | recommended: ${row.recommended} | default: ${defaultValue}`;
}

function parseDecisionCode(value: string): number {
  const match = /^D-([1-9]\d*)$/u.exec(value);
  if (!match) throw new NotifyError('Decision code must look like D-1');
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) throw new NotifyError('Decision code is out of range');
  return id;
}

function appendAsk(args: string[], options: NotifyOptions): { code: string; stateDir: string } {
  const flags = parseFlags(args, ['--goal', '--task', '--question', '--option', '--recommend', '--default', '--default-at'], ['--option']);
  const goal = goalField(one(flags, '--goal', true)!);
  const task = taskField(one(flags, '--task'));
  const question = field(one(flags, '--question', true)!, 'Question', 500);
  const optionList = parseOptions(flags['--option'] ?? []);
  const recommended = one(flags, '--recommend', true)!;
  const defaultLetter = one(flags, '--default') ?? null;
  const defaultAtRaw = one(flags, '--default-at') ?? null;
  if (!validLetter(recommended) || !optionByLetter(optionList, recommended)) throw new NotifyError('Recommended letter must match an option');
  if ((defaultLetter === null) !== (defaultAtRaw === null)) throw new NotifyError('--default and --default-at must be supplied together');
  if (defaultLetter !== null && (!validLetter(defaultLetter) || !optionByLetter(optionList, defaultLetter))) {
    throw new NotifyError('Default letter must match an option');
  }
  const defaultAt = defaultAtRaw === null ? null : validateUtc(defaultAtRaw);
  const directory = stateDirectory(options);
  const config = telegramConfig(directory);
  const text = [question, ...optionList.map(option => option.text), goal, task ?? ''].join('\n');
  ensureSecretAbsent(text, config.token);
  const db = database(directory);
  try {
    const createdAt = timestamp(options);
    const result = db.transaction(() => {
      const inserted = db.query(`INSERT INTO decisions (goal, task, question, options, recommended, defaultLetter, defaultAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(goal, task, question, JSON.stringify(optionList), recommended, defaultLetter, defaultAt, createdAt);
      const id = Number(inserted.lastInsertRowid);
      const code = decisionCode(id);
      enqueue(db, () => askBody(code, goal, task, question, optionList, recommended, defaultLetter, defaultAt), createdAt);
      return code;
    }).immediate();
    return { code: result, stateDir: directory };
  } finally { db.close(); }
}

function appendNotice(args: string[], options: NotifyOptions): { stateDir: string } {
  const flags = parseFlags(args, ['--event', '--goal', '--task', '--note']);
  const event = one(flags, '--event', true)!;
  if (!Object.hasOwn(events, event)) throw new NotifyError('Event must be start, pause, stop, fault, allowance or host');
  const goal = goalField(one(flags, '--goal', true)!);
  const task = taskField(one(flags, '--task'));
  const note = one(flags, '--note');
  if (note !== undefined) field(note, 'Note', 300);
  const directory = stateDirectory(options);
  const config = telegramConfig(directory);
  ensureSecretAbsent([goal, task ?? '', note ?? ''].join('\n'), config.token);
  const db = database(directory);
  try {
    const createdAt = timestamp(options);
    db.transaction(() => { enqueue(db, id => noticeBody(id, event as NoticeEvent, goal, task, note), createdAt); }).immediate();
    return { stateDir: directory };
  } finally { db.close(); }
}

function answerDecision(args: string[], options: NotifyOptions): string {
  const [codeText, letter, ...rest] = args;
  if (!codeText || !letter) throw new NotifyError('decide needs <code> <letter> [--note <text>]');
  if (!validLetter(letter)) throw new NotifyError('Decision answer must be a lowercase letter');
  const flags = parseFlags(rest, ['--note', '--replace'], [], ['--replace']);
  const note = one(flags, '--note');
  if (note !== undefined) field(note, 'Note', 300);
  const config = telegramConfig(stateDirectory(options));
  ensureSecretAbsent(note ?? '', config.token);
  const id = parseDecisionCode(codeText);
  const db = database(stateDirectory(options));
  try {
    const answeredAt = timestamp(options);
    const row = db.transaction(() => {
      const decision = db.query<DecisionRow, [number]>('SELECT * FROM decisions WHERE id = ?').get(id);
      if (!decision) throw new NotifyError('Decision code was not found');
      if (!optionByLetter(JSON.parse(decision.options) as DecisionOption[], letter)) throw new NotifyError('Answer letter must match an option');
      if (decision.answeredAt !== null && !flags['--replace']) throw new NotifyError('Decision already has an answer; use --replace');
      db.query('UPDATE decisions SET answerLetter = ?, answeredAt = ?, answerNote = ? WHERE id = ?')
        .run(letter, answeredAt, note ?? null, id);
      return decision;
    }).immediate();
    return `Recorded ${decisionCode(row.id)} ${letter} at ${answeredAt}.`;
  } finally { db.close(); }
}

function listDecisions(args: string[], options: NotifyOptions): string[] {
  if (args.length > 1 || args.some(value => value !== '--all')) throw new NotifyError('decisions accepts only [--all]');
  const all = args.includes('--all');
  const db = database(stateDirectory(options));
  try {
    const rows = db.query<DecisionRow, []>(`SELECT * FROM decisions ${all ? '' : 'WHERE answeredAt IS NULL'} ORDER BY id`).all();
    return rows.length ? rows.map(row => formatDecision(row, (options.now ?? Date.now)())) : ['No open decisions.'];
  } finally { db.close(); }
}

/** Executes one notify CLI command. `stateDir` is available to tests and isolated local trials. */
export async function notifyCommand(args: string[], options: NotifyOptions = {}): Promise<string[]> {
  const [command, ...rest] = args;
  if (command === 'ask') {
    const { code, stateDir } = appendAsk(rest, options);
    return [displayFlush(await flush({ ...options, stateDir }), code)];
  }
  if (command === 'tell') {
    const { stateDir } = appendNotice(rest, options);
    return [displayFlush(await flush({ ...options, stateDir }))];
  }
  if (command === 'decide') return [answerDecision(rest, options)];
  if (command === 'decisions') return listDecisions(rest, options);
  if (command === 'flush' && rest.length === 0) return [displayFlush(await flush(options))];
  throw new NotifyError('Use ask, tell, decide, decisions or flush');
}

if (import.meta.main) {
  try {
    for (const line of await notifyCommand(process.argv.slice(2))) console.log(line);
  } catch (error) {
    console.error(error instanceof NotifyError ? error.message : 'Telegram notification command failed');
    process.exitCode = 1;
  }
}
