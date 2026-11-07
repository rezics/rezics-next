import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { matchesPath } from './briefs.ts';
import { defaultPolicy } from './policy.ts';
import type { Settings, Task } from './types.ts';
import { ensureFlow, recordFlow } from './flow.ts';
import type { ManagerInbox } from './contracts.ts';

export const PAGE_DATA_CLASSES = ['DATA', 'EMPTY', 'UNAUTHORIZED', 'UNAVAILABLE', 'API', 'WEB', 'SEED'] as const;
export type PageDataClass = (typeof PAGE_DATA_CLASSES)[number];
export const PAGE_DATA_DEFECTS: ReadonlySet<PageDataClass> = new Set(['API', 'WEB', 'SEED']);
const previousHealthy = new Set<PageDataClass>(['DATA', 'EMPTY', 'UNAUTHORIZED', 'UNAVAILABLE']);
const pageDataTaskId = 'page-data';

type PageDataPolicy = typeof defaultPolicy.pageData;
type PageManifest = {
  version: 1;
  pages: {
    id: string;
    path: string;
    personas?: string[];
    sections: {
      id: string;
      name: string;
      personas?: string[];
      native: { path: string };
      sql?: { text: string };
    }[];
  }[];
};
export type PageDataSection = {
  page: string;
  persona: string;
  section: string;
  name: string;
  class: PageDataClass;
  goal: string;
  files: string[];
  firstErrorLine?: string;
};
export type PageDataRun = {
  runId: number;
  at: string;
  head: string;
  classes: Record<PageDataClass, number>;
  sections: PageDataSection[];
};
export type PageDataRepair = {
  repairKey: string;
  section: PageDataSection;
  previousClass: PageDataClass;
  owner?: Task;
  head: string;
};
export type PageDataRepairRoute = 'resumed' | 'dispatched';
export type PageDataOptions = {
  settings: Settings;
  db: Database;
  tasks: Pick<import('./store.ts').WorkerStore, 'tasks'>;
  inbox: Pick<ManagerInbox, 'deliver'>;
  routeDefect: (repair: PageDataRepair) => Promise<PageDataRepairRoute>;
  now?: () => Date;
  runStack?: (
    head: string,
  ) => Promise<{
    output: string;
    exitCode: number;
    registry?: ReadonlyMap<string, SectionConfig>;
    stackOutput?: string;
  }>;
};

export type SectionConfig = Pick<PageDataSection, 'page' | 'persona' | 'section' | 'name' | 'goal' | 'files'>;
type CommitChange = { commit: string; position: number; files: string[] };
type StackConfig = {
  version: 1;
  databasePort: number;
  searchPort: number;
  webPort: number;
  issuerPort: number;
  nativePort: number;
  kernelPort: number;
  dependenciesHead?: string;
};
type StackFailurePhase = 'boot' | 'check';

export class PageDataStackError extends Error {
  constructor(
    readonly phase: StackFailurePhase,
    message: string,
    readonly firstErrorLine = safeLine(message),
    readonly output = '',
  ) {
    super(message);
    this.name = 'PageDataStackError';
  }
}

const sectionKey = (section: Pick<PageDataSection, 'page' | 'persona' | 'section'>) =>
  `${section.page}\t${section.persona}\t${section.section}`;

export function duePageDataRun(
  lastRunAt: string | undefined,
  now: number,
  intervalMs = defaultPolicy.pageData.intervalMs,
): boolean {
  if (!lastRunAt) return true;
  return now - Date.parse(lastRunAt) >= intervalMs;
}

export function pageDataClassCounts(
  sections: readonly Pick<PageDataSection, 'class'>[],
): Record<PageDataClass, number> {
  return Object.fromEntries(
    PAGE_DATA_CLASSES.map((value) => [value, sections.filter((section) => section.class === value).length]),
  ) as Record<PageDataClass, number>;
}

export function newlyDefectiveSections(previous: readonly PageDataSection[], current: readonly PageDataSection[]) {
  const before = new Map(previous.map((section) => [sectionKey(section), section]));
  return current.flatMap((section) => {
    if (!PAGE_DATA_DEFECTS.has(section.class)) return [];
    const old = before.get(sectionKey(section));
    return old && previousHealthy.has(old.class) ? [{ section, previousClass: old.class }] : [];
  });
}

export function latestSectionOwner(
  tasks: readonly Task[],
  changes: readonly CommitChange[],
  files: readonly string[],
): Task | undefined {
  const byCommit = new Map(changes.map((change) => [change.commit, change]));
  const owners = tasks.flatMap((task) => {
    if (!['integrated', 'merged'].includes(task.state)) return [];
    const commits = [
      ...new Set(
        [...(task.integratedCommits ?? []), task.integratedCommit ?? task.mergedCommit].filter(
          (value): value is string => !!value,
        ),
      ),
    ];
    const positions = commits.flatMap((commit) => {
      const change = byCommit.get(commit);
      return change && change.files.some((file) => matchesPath(file, files)) ? [change.position] : [];
    });
    return positions.length ? [{ task, position: Math.max(...positions) }] : [];
  });
  owners.sort((a, b) => b.position - a.position || b.task.sequence - a.task.sequence);
  return owners[0]?.task;
}

function readManifest(cwd: string): PageManifest {
  const path = join(cwd, 'scripts/page-data-sections.json');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('page-data manifest must be an object');
  const manifest = value as PageManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.pages))
    throw new Error('page-data manifest has an unsupported shape');
  for (const page of manifest.pages) {
    if (typeof page.id !== 'string' || typeof page.path !== 'string' || !Array.isArray(page.sections))
      throw new Error('page-data manifest contains an invalid page');
    for (const section of page.sections)
      if (
        typeof section.id !== 'string' ||
        typeof section.name !== 'string' ||
        typeof section.native?.path !== 'string' ||
        (section.personas !== undefined &&
          (!Array.isArray(section.personas) || section.personas.some((persona) => typeof persona !== 'string')))
      )
        throw new Error(`page-data manifest contains an invalid section on ${page.id}`);
  }
  return manifest;
}

function fallbackGoal(page: string, nativePath: string): string {
  if (nativePath.includes('search') || page === 'search') return 'search';
  if (
    nativePath.includes('library') ||
    nativePath.includes('collection') ||
    page === 'collections' ||
    page === 'library'
  )
    return 'commerce';
  if (nativePath.includes('board') || nativePath.includes('thread') || nativePath.includes('rating')) return 'content';
  return 'web';
}

function sectionFiles(page: string, section: string, nativePath: string, sqlText: string): string[] {
  const files = new Set<string>();
  if (page === 'home') {
    files.add('apps/web/src/routes/index.tsx');
    files.add('apps/web/src/features/pages/home-*.ts');
    files.add('apps/web/src/features/pages/home-*.tsx');
  } else if (['vn', 'anime', 'book', 'character', 'person', 'tag'].includes(page)) {
    files.add('apps/web/src/routes/subjects/**');
    files.add('apps/web/src/routes/zones/*.subjects.*');
    files.add('apps/web/src/features/pages/subject-*.ts');
    files.add('apps/web/src/features/pages/subject-*.tsx');
    files.add('apps/web/src/features/pages/subject-*/**');
  } else if (page === 'search') {
    files.add('apps/web/src/features/search/**');
    files.add('apps/web/src/features/pages/search-*.ts');
    files.add('apps/web/src/routes/search*.tsx');
  } else if (page === 'collections') {
    files.add('apps/web/src/features/pages/curat*.ts');
    files.add('apps/web/src/features/pages/curat*.tsx');
    files.add('apps/web/src/features/pages/collection-*.ts');
    files.add('apps/web/src/routes/collections/**');
  } else if (page === 'library') {
    files.add('apps/web/src/features/pages/subject-personal-reader.tsx');
    files.add('apps/web/src/features/pages/member-*.ts');
    files.add('apps/web/src/routes/library/**');
  }

  if (section.startsWith('connections-') || section.startsWith('related-')) {
    files.add('apps/web/src/features/pages/subject-connections*');
    files.add('apps/web/src/features/pages/subject-relations-preview.ts');
  }
  if (section === 'ratings') {
    files.add('apps/web/src/features/pages/subject-ratings*');
    files.add('apps/web/src/features/pages/rating-*.ts');
    files.add('apps/web/src/features/pages/rating-*.tsx');
  }
  if (section === 'reviews' || section === 'discussion') {
    files.add('apps/web/src/features/pages/subject-community*');
    files.add('apps/web/src/threads/**');
  }

  if (nativePath.includes('search') || page === 'search') files.add('services/kernel/src/search/**');
  else if (nativePath.includes('library') || nativePath.includes('collection') || sqlText.includes('library.')) {
    files.add('services/kernel/src/library/**');
    files.add('services/kernel/src/commerce/**');
    files.add('services/kernel/db/library/**');
  } else if (nativePath.includes('board') || nativePath.includes('thread') || nativePath.includes('rating')) {
    files.add('services/kernel/src/content/**');
    files.add('services/kernel/db/content/**');
  } else {
    files.add('services/kernel/src/semantic/**');
    files.add('services/kernel/db/semantic/**');
  }
  if (sqlText) files.add('scripts/datasets/**');
  return [...files];
}

function sectionRegistry(cwd: string): Map<string, SectionConfig> {
  const manifest = readManifest(cwd);
  const registry = new Map<string, SectionConfig>();
  const pagePersonas = (personas: string[] | undefined) => (personas?.length ? personas : ['anonymous', 'member']);
  for (const page of manifest.pages) {
    for (const persona of pagePersonas(page.personas)) {
      for (const section of page.sections) {
        if (!pagePersonas(section.personas).includes(persona)) continue;
        const item: SectionConfig = {
          page: page.id,
          persona,
          section: section.id,
          name: section.name,
          goal: fallbackGoal(page.id, section.native.path),
          files: sectionFiles(page.id, section.id, section.native.path, section.sql?.text ?? ''),
        };
        const key = sectionKey(item);
        if (registry.has(key))
          throw new Error(`page-data manifest repeats ${item.page}/${item.persona}/${item.section}`);
        registry.set(key, item);
      }
    }
  }
  return registry;
}

const secretPattern =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|password[=:]\s*[^\s&]+|authorization:\s*[^\r\n]+)/gi;
function safeLine(value: string): string {
  return value
    .replace(secretPattern, '[redacted]')
    .split(/\r?\n/, 1)[0]!
    .replace(/[\t\0]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function safeOutput(value: string): string {
  return value.replace(secretPattern, '[redacted]');
}

export function parsePageDataOutput(output: string, registry: ReadonlyMap<string, SectionConfig>): PageDataSection[] {
  const results: PageDataSection[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [page, persona, section, className, ...extra] = line.trim().split(/\s+/);
    if (!page || !persona || !section || !className || extra.length)
      throw new Error(`invalid page-data output: ${safeLine(line)}`);
    const key = `${page}\t${persona}\t${section}`;
    const source = registry.get(key);
    if (!source) throw new Error(`page-data output named an unknown section: ${safeLine(line)}`);
    if (!PAGE_DATA_CLASSES.includes(className as PageDataClass))
      throw new Error(`page-data output has an unknown class: ${safeLine(line)}`);
    if (seen.has(key)) throw new Error(`page-data output repeated ${page}/${persona}/${section}`);
    seen.add(key);
    const classValue = className as PageDataClass;
    results.push({
      ...source,
      class: classValue,
      ...(PAGE_DATA_DEFECTS.has(classValue) ? { firstErrorLine: safeLine(line) } : {}),
    });
  }
  if (seen.size !== registry.size)
    throw new Error(`page-data output covered ${seen.size} of ${registry.size} sections`);
  return results;
}

function readLastCycle(db: Database): { at: string } | undefined {
  const row = db
    .query(
      `SELECT at FROM flow_events WHERE task_id=? AND stage='verification'
       AND action IN ('page-data-run','page-data-boot-failure','page-data-check-failure')
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(pageDataTaskId) as { at: string } | null;
  return row ?? undefined;
}

export function readLatestPageDataRun(db: Database): PageDataRun | undefined {
  const row = db
    .query(
      `SELECT attempt,at,detail FROM flow_events WHERE task_id=? AND stage='verification' AND action='page-data-run'
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(pageDataTaskId) as { attempt: number; at: string; detail: string } | null;
  if (!row) return undefined;
  const metadata = JSON.parse(row.detail) as { head: string; classes: Record<PageDataClass, number> };
  const sections = db
    .query(
      `SELECT detail FROM flow_events WHERE task_id=? AND attempt=? AND stage='verification' AND action='page-data-section'
       ORDER BY sequence`,
    )
    .all(pageDataTaskId, row.attempt) as { detail: string }[];
  return {
    runId: row.attempt,
    at: row.at,
    head: metadata.head,
    classes: metadata.classes,
    sections: sections.map((value) => JSON.parse(value.detail) as PageDataSection),
  };
}

function projectChanges(cwd: string, base: string, head: string): CommitChange[] {
  const result = spawnSync('git', ['log', '--reverse', '--name-only', '--pretty=format:%H', `${base}..${head}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Could not read the page-data source interval');
  const changes: CommitChange[] = [];
  let current: CommitChange | undefined;
  for (const line of result.stdout.split('\n')) {
    if (/^[0-9a-f]{40,}$/.test(line)) {
      current = { commit: line, position: changes.length, files: [] };
      changes.push(current);
    } else if (line && current) current.files.push(line);
  }
  return changes;
}

function firstParent(cwd: string, branch: string): string {
  const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
    cwd,
    encoding: 'utf8',
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Missing integration branch ${branch}`);
  return result.stdout.trim();
}

function repairKey(section: PageDataSection, owner: Task | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify([sectionKey(section), section.class, section.firstErrorLine, owner?.id ?? section.goal]))
    .digest('hex');
}

function repairWasRouted(db: Database, key: string): boolean {
  return Boolean(db.query("SELECT 1 FROM page_data_repairs WHERE repair_key=? AND status='routed' LIMIT 1").get(key));
}

function claimRepair(db: Database, key: string, at: string, detail: string): void {
  db.query('INSERT OR IGNORE INTO page_data_repairs(repair_key,created_at,status,detail) VALUES (?,?,?,?)').run(
    key,
    at,
    'pending',
    detail,
  );
}

function finishRepair(db: Database, key: string): void {
  db.query("UPDATE page_data_repairs SET status='routed' WHERE repair_key=?").run(key);
}

function saveRun(db: Database, run: PageDataRun): void {
  const events = [
    {
      taskId: pageDataTaskId,
      attempt: run.runId,
      stage: 'verification' as const,
      action: 'page-data-run',
      at: run.at,
      detail: JSON.stringify({ head: run.head, classes: run.classes }),
    },
    ...run.sections.map((section) => ({
      taskId: pageDataTaskId,
      attempt: run.runId,
      stage: 'verification' as const,
      action: 'page-data-section',
      at: run.at,
      detail: JSON.stringify(section),
    })),
  ];
  db.transaction(() => events.forEach((event) => recordFlow(db, event))).immediate();
}

function supermanagerNotice(
  options: PageDataOptions,
  action: 'boot' | 'check',
  head: string,
  line: string,
  logPath: string,
  at: string,
): void {
  const detail = safeLine(line) || `Page-data ${action} failed without an error line`;
  const prefix = `Page-data ${action} failed at ${head}: `;
  const suffix = `; output log: ${logPath}`;
  const available = Math.max(0, defaultPolicy.inbox.managerMessageCharacters - prefix.length - suffix.length);
  const summary = `${prefix}${detail.slice(0, available)}${suffix}`;
  recordFlow(options.db, {
    taskId: pageDataTaskId,
    attempt: Math.max(Date.parse(at), dbMaxPageDataAttempt(options.db) + 1),
    stage: 'verification',
    action: action === 'boot' ? 'page-data-boot-failure' : 'page-data-check-failure',
    at,
    detail: JSON.stringify({ head, firstErrorLine: detail, logPath }),
  });
  options.inbox.deliver({
    managerId: options.settings.integration.supermanager,
    kind: 'environment',
    summary,
  });
}

function writePageDataFailureLog(
  stateDirectory: string,
  runId: number,
  phase: StackFailurePhase,
  output: string,
): string {
  const directory = join(stateDirectory, 'page-data-failures');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${runId}-${phase}.log`);
  writeFileSync(path, safeOutput(output), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

function combineFailureOutput(stackOutput: string, commandOutput: string): string {
  if (!stackOutput) return commandOutput;
  if (!commandOutput || stackOutput === commandOutput) return stackOutput;
  return `=== page-data stack ===\n${stackOutput}\n=== page-data command ===\n${commandOutput}`;
}

function loadLastSuccessfulRun(db: Database): PageDataRun | undefined {
  return readLatestPageDataRun(db);
}

export async function runPageDataCycle(options: PageDataOptions): Promise<'skipped' | 'ran' | 'failed'> {
  const policy = options.settings.policy?.pageData ?? defaultPolicy.pageData;
  const now = options.now ?? (() => new Date());
  ensureFlow(options.db);
  let lock: ReturnType<typeof acquireDirectoryLease>;
  try {
    lock = acquireDirectoryLease(
      join(options.settings.stateDirectory, 'page-data.lease'),
      options.settings.policy?.leases,
    );
  } catch (error) {
    if (error instanceof LeaseHeldError) return 'skipped';
    throw error;
  }
  try {
    const lastCycle = readLastCycle(options.db);
    if (!duePageDataRun(lastCycle?.at, now().getTime(), policy.intervalMs)) return 'skipped';
    const at = now().toISOString();
    const latestAttempt = dbMaxPageDataAttempt(options.db);
    const runId = Math.max(Date.parse(at), latestAttempt + 1);
    const head = firstParent(options.settings.mainCheckout, options.settings.integrationBranch);
    let output = '';
    let stackOutput = '';
    let registryForRun: ReadonlyMap<string, SectionConfig> | undefined;
    try {
      const result = await (
        options.runStack ?? ((sourceHead) => runDedicatedPageDataStack(options.settings, sourceHead))
      )(head);
      output = result.output;
      stackOutput = result.stackOutput ?? '';
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const line = result.output.trim()
          ? terminalErrorLine(result.output)
          : `page-data-check exited ${result.exitCode}`;
        throw new PageDataStackError('check', line, line, combineFailureOutput(stackOutput, result.output));
      }
      registryForRun = result.registry;
    } catch (error) {
      const failure =
        error instanceof PageDataStackError
          ? error
          : new PageDataStackError('boot', errorMessage(error), undefined, stackOutput);
      const transcript = failure.output || combineFailureOutput(stackOutput, output || failure.message);
      const logPath = writePageDataFailureLog(options.settings.stateDirectory, runId, failure.phase, transcript);
      supermanagerNotice(options, failure.phase, head, failure.firstErrorLine, logPath, at);
      return 'failed';
    }

    const registry = registryForRun ?? sectionRegistry(options.settings.mainCheckout);
    let sections: PageDataSection[];
    try {
      sections = parsePageDataOutput(output, registry);
    } catch (error) {
      const transcript = combineFailureOutput(stackOutput, output);
      const logPath = writePageDataFailureLog(options.settings.stateDirectory, runId, 'check', transcript);
      supermanagerNotice(options, 'check', head, errorMessage(error), logPath, at);
      return 'failed';
    }
    const previous = loadLastSuccessfulRun(options.db);
    const newDefects = newlyDefectiveSections(previous?.sections ?? [], sections);
    const changes = previous?.head ? projectChanges(options.settings.mainCheckout, previous.head, head) : [];
    const tasks = options.tasks.tasks();
    for (const defect of newDefects) {
      const owner = latestSectionOwner(tasks, changes, defect.section.files);
      const key = repairKey(defect.section, owner);
      if (repairWasRouted(options.db, key)) continue;
      const detail = JSON.stringify({
        repairKey: key,
        section: sectionKey(defect.section),
        class: defect.section.class,
        owner: owner?.id,
      });
      claimRepair(options.db, key, at, detail);
      const resumed = owner
        ? Boolean(
            options.db
              .query("SELECT 1 FROM worker_events WHERE task_id=? AND kind='page-data-repair' AND body LIKE ? LIMIT 1")
              .get(owner.id, `%${key}%`),
          )
        : false;
      const dispatched = options.tasks
        .tasks()
        .some((task) => task.brief.markdown.includes(`page-data-repair-key: ${key}`));
      if (resumed || dispatched) {
        finishRepair(options.db, key);
        continue;
      }
      const route = await options.routeDefect({
        repairKey: key,
        section: defect.section,
        previousClass: defect.previousClass,
        ...(owner ? { owner } : {}),
        head,
      });
      recordFlow(options.db, {
        taskId: pageDataTaskId,
        attempt: runId,
        stage: 'verification',
        action: 'page-data-repair',
        at,
        detail: JSON.stringify({ ...JSON.parse(detail), route }),
      });
      finishRepair(options.db, key);
    }
    const run: PageDataRun = { runId, at, head, classes: pageDataClassCounts(sections), sections };
    saveRun(options.db, run);
    return 'ran';
  } finally {
    lock.release();
  }
}

function dbMaxPageDataAttempt(db: Database): number {
  return (
    db
      .query(
        "SELECT coalesce(max(attempt),0) AS attempt FROM flow_events WHERE task_id=? AND stage='verification' AND action LIKE 'page-data-%'",
      )
      .get(pageDataTaskId) as { attempt: number }
  ).attempt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageDataSettings(settings: Settings): PageDataPolicy {
  return settings.policy?.pageData ?? defaultPolicy.pageData;
}

/** Prefer the final substantive error from a process that exited; resilient background retries appear earlier. */
export function terminalErrorLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const skipped = (line: string) =>
    line.startsWith('$ ') || /^task:\s/i.test(line) || line.startsWith('+ ') || /^task \S/.test(line);
  const candidates = lines.filter((line) => !skipped(line));
  const preferred = candidates.filter((line) => /\b(?:error|fatal|fail(?:ed|ure)?|panic|exception)\b/i.test(line));
  const chosen = preferred.at(-1) ?? candidates.at(-1);
  const logReference = [...candidates].reverse().find((line) => /^see\s+\S+/i.test(line));
  const combined = chosen && logReference && logReference !== chosen ? `${chosen}; ${logReference}` : chosen;
  return safeLine(combined ?? 'process failed without output');
}

/** Retained as the public name used by existing callers. */
export function firstSubstantiveErrorLine(value: string): string {
  return terminalErrorLine(value);
}

function externalErrorLine(value: string): string {
  return terminalErrorLine(value);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local page-data port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 65536;
}

async function stackConfiguration(
  settings: Settings,
): Promise<{ file: string; worktree: string; stack: StackConfig; names: { database: string; search: string } }> {
  mkdirSync(settings.stateDirectory, { recursive: true });
  mkdirSync(settings.worktreeRoot, { recursive: true });
  const identity = createHash('sha256').update(settings.stateDirectory).digest('hex').slice(0, 10);
  const file = join(settings.stateDirectory, 'page-data-stack.json');
  const worktree = join(settings.worktreeRoot, 'page-data-stack');
  const names = { database: `rezics-pagecheck-${identity}`, search: `rezics-pagecheck-search-${identity}` };
  let stack: StackConfig;
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as StackConfig).version !== 1 ||
      !['databasePort', 'searchPort', 'webPort', 'issuerPort', 'nativePort', 'kernelPort'].every((key) =>
        validPort((parsed as StackConfig)[key as keyof StackConfig]),
      )
    )
      throw new Error('Page-data stack configuration is invalid');
    stack = parsed as StackConfig;
  } else {
    const ports = new Set<number>();
    const allocate = async () => {
      let port = await freePort();
      while (ports.has(port)) port = await freePort();
      ports.add(port);
      return port;
    };
    stack = {
      version: 1,
      databasePort: await allocate(),
      searchPort: await allocate(),
      webPort: await allocate(),
      issuerPort: await allocate(),
      nativePort: await allocate(),
      kernelPort: await allocate(),
    };
    writeFileSync(file, `${JSON.stringify(stack, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  return { file, worktree, stack, names };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function refreshWorktree(settings: Settings, worktree: string, head: string): void {
  if (!existsSync(worktree)) {
    runGit(settings.mainCheckout, ['worktree', 'add', '--detach', worktree, head]);
    return;
  }
  if (!existsSync(join(worktree, '.git')))
    throw new Error(`Page-data worktree path is not a Git worktree: ${worktree}`);
  runGit(worktree, ['reset', '--hard', head]);
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function stackEnvironment(
  worktree: string,
  stack: StackConfig,
  names: { database: string; search: string },
  mainCheckout: string,
): NodeJS.ProcessEnv {
  return {
    ...readEnvFile(join(mainCheckout, 'services/kernel/.env')),
    ...process.env,
    ...readEnvFile(join(worktree, 'services/kernel/.env')),
    KERNEL_DATABASE_CONTAINER: names.database,
    KERNEL_DATABASE_VOLUME: names.database,
    KERNEL_DATABASE_PORT: String(stack.databasePort),
    KERNEL_SEARCH_CONTAINER: names.search,
    KERNEL_SEARCH_VOLUME: names.search,
    KERNEL_SEARCH_PORT: String(stack.searchPort),
    REZICS_LOCAL_STACK_WEB_ORIGIN: `http://127.0.0.1:${stack.webPort}`,
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: `http://127.0.0.1:${stack.issuerPort}`,
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: `http://127.0.0.1:${stack.nativePort}`,
    REZICS_LOCAL_STACK_KERNEL_ORIGIN: `http://127.0.0.1:${stack.kernelPort}`,
    NODE_ENV: 'development',
  };
}

function boundedAppend(current: string, chunk: string, maximum: number): string {
  const next = current + chunk;
  const bytes = Buffer.from(next);
  return bytes.byteLength > maximum ? bytes.subarray(bytes.byteLength - maximum).toString('utf8') : next;
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string; output: string };
type BoundedOutput = { value: string };

function commandOutput(stdout: string, stderr: string): string {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}\n=== stderr ===\n${stderr}`;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  phase: StackFailurePhase = 'boot',
  allowedExitCodes: readonly number[] = [0],
  killAfterMs = defaultPolicy.pageData.stopTimeoutMs,
): Promise<ProcessResult> {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout?.on('data', (chunk: Buffer) => (stdout = boundedAppend(stdout, chunk.toString(), outputLimit)));
  child.stderr?.on('data', (chunk: Buffer) => (stderr = boundedAppend(stderr, chunk.toString(), outputLimit)));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), killAfterMs);
  }, timeoutMs);
  let code: number | null;
  try {
    code = await closed;
  } catch (error) {
    const firstErrorLine = externalErrorLine(errorMessage(error));
    throw new PageDataStackError(
      phase,
      `${command} ${args.join(' ')} failed: ${firstErrorLine}`,
      firstErrorLine,
      commandOutput(stdout, stderr),
    );
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
  }
  const output = commandOutput(stdout, stderr);
  const diagnostic = externalErrorLine(stderr || stdout);
  if (timedOut)
    throw new PageDataStackError(
      phase,
      `${command} ${args.join(' ')} timed out after ${timeoutMs} ms: ${diagnostic}`,
      diagnostic,
      output,
    );
  if (!allowedExitCodes.includes(code ?? -1))
    throw new PageDataStackError(
      phase,
      `${command} ${args.join(' ')} exited ${String(code)}: ${diagnostic}`,
      diagnostic,
      output,
    );
  return { exitCode: code ?? -1, stdout, stderr, output: stdout };
}

async function waitForStack(
  child: ChildProcess,
  origins: string[],
  timeoutMs: number,
  outputLimit: number,
  stopTimeoutMs: number,
  captured: BoundedOutput,
): Promise<void> {
  let spawnFailure: Error | undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    captured.value = boundedAppend(captured.value, chunk.toString(), outputLimit);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    captured.value = boundedAppend(captured.value, chunk.toString(), outputLimit);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnFailure = error;
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });
  const deadline = Date.now() + timeoutMs;
  let lastFailure = '';
  while (Date.now() < deadline) {
    if (spawnFailure) {
      const line = errorMessage(spawnFailure);
      throw new PageDataStackError('boot', line, line, captured.value);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await closed;
      const line = captured.value.trim()
        ? terminalErrorLine(captured.value)
        : `Local stack exited ${child.exitCode ?? child.signalCode}`;
      throw new PageDataStackError('boot', line, line, captured.value);
    }
    let ready = true;
    for (const origin of origins) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
        if (response.status >= 400) {
          ready = false;
          lastFailure = `${origin} returned HTTP ${response.status}`;
        }
      } catch (error) {
        ready = false;
        lastFailure = `${origin} ${errorMessage(error)}`;
      }
    }
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGTERM');
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, stopTimeoutMs))]);
  if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL');
  await closed;
  const line =
    lastFailure || (captured.value.trim() ? terminalErrorLine(captured.value) : 'Local stack did not become ready');
  throw new PageDataStackError('boot', line, line, captured.value);
}

async function stopStack(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  signalGroup(child, 'SIGTERM');
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!stopped) {
    signalGroup(child, 'SIGKILL');
    await closed;
  }
}

function dependencyFilesChanged(cwd: string, oldHead: string | undefined, head: string): boolean {
  if (!oldHead) return true;
  if (oldHead === head) return false;
  const result = spawnSync(
    'git',
    ['diff', '--name-only', `${oldHead}..${head}`, '--', 'bun.lock', 'package.json', '**/package.json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: defaultPolicy.merge.gitBufferBytes,
      timeout: defaultPolicy.merge.commandTimeoutMs,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Could not compare page-data dependency inputs');
  return Boolean(result.stdout.trim());
}

async function runDedicatedPageDataStack(
  settings: Settings,
  head: string,
): Promise<{
  output: string;
  exitCode: number;
  registry: ReadonlyMap<string, SectionConfig>;
  stackOutput: string;
}> {
  const policy = pageDataSettings(settings);
  const { file, worktree, stack, names } = await stackConfiguration(settings);
  refreshWorktree(settings, worktree, head);
  const bun = process.execPath;
  let config = stack;
  let env = stackEnvironment(worktree, config, names, settings.mainCheckout);
  if (dependencyFilesChanged(worktree, config.dependenciesHead, head)) {
    await runCommand(
      bun,
      ['install', '--frozen-lockfile', '--backend', 'copy'],
      worktree,
      env,
      policy.installTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    config = { ...config, dependenciesHead: head };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    env = stackEnvironment(worktree, config, names, settings.mainCheckout);
  }
  const seeded = join(settings.stateDirectory, 'page-data-seeded');
  const stackCapture: BoundedOutput = { value: '' };
  let child: ChildProcess | undefined;
  let checked: ProcessResult | undefined;
  let registry: ReadonlyMap<string, SectionConfig> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    await runCommand(
      bun,
      ['run', '--cwd', 'services/kernel', 'db', 'up'],
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    env = stackEnvironment(worktree, config, names, settings.mainCheckout);
    await runCommand(
      bun,
      ['run', '--cwd', 'services/kernel', 'search', 'up'],
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    await runCommand(
      bun,
      ['services/auth/scripts/dev-stack.ts', 'setup'],
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    env = stackEnvironment(worktree, config, names, settings.mainCheckout);

    child = spawn(bun, ['services/auth/scripts/dev-stack.ts', 'start'], {
      cwd: worktree,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForStack(
      child,
      [
        `http://127.0.0.1:${config.webPort}/en`,
        `http://127.0.0.1:${config.issuerPort}/.well-known/openid-configuration`,
        `http://127.0.0.1:${config.nativePort}/.well-known/openid-configuration`,
        `http://127.0.0.1:${config.kernelPort}/health`,
      ],
      policy.bootTimeoutMs,
      policy.outputBytes,
      policy.stopTimeoutMs,
      stackCapture,
    );

    if (!existsSync(seeded)) {
      await runCommand(
        bun,
        ['services/auth/scripts/dev-stack.ts', 'persona'],
        worktree,
        env,
        policy.seedTimeoutMs,
        policy.outputBytes,
        'boot',
        [0],
        policy.stopTimeoutMs,
      );
      env = { ...env, ...readEnvFile(join(worktree, '.temp/local-stack/seed.env')) };
      await runCommand(
        bun,
        ['scripts/datasets/cross-media-seed.ts', '--dev'],
        worktree,
        env,
        policy.seedTimeoutMs,
        policy.outputBytes,
        'boot',
        [0],
        policy.stopTimeoutMs,
      );
      mkdirSync(join(worktree, '.temp/local-stack'), { recursive: true });
      writeFileSync(seeded, `${head}\n`, { flag: 'w' });
    }

    checked = await runCommand(
      bun,
      [
        'scripts/page-data-check.ts',
        '--base-url',
        `http://127.0.0.1:${config.webPort}`,
        '--kernel',
        `http://127.0.0.1:${config.kernelPort}`,
        '--auth-origin',
        `http://127.0.0.1:${config.issuerPort}`,
      ],
      worktree,
      env,
      policy.checkTimeoutMs,
      policy.outputBytes,
      'check',
      [0, 1],
      policy.stopTimeoutMs,
    );
    registry = sectionRegistry(worktree);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (child) await stopStack(child, policy.stopTimeoutMs);
  }
  if (failed) {
    if (failure instanceof PageDataStackError)
      throw new PageDataStackError(
        failure.phase,
        failure.message,
        failure.firstErrorLine,
        combineFailureOutput(stackCapture.value, failure.output || failure.message),
      );
    const message = errorMessage(failure);
    throw new PageDataStackError('boot', message, undefined, stackCapture.value || message);
  }
  const result = checked!;
  return {
    output: result.stdout,
    exitCode: result.exitCode,
    registry: registry!,
    stackOutput: stackCapture.value,
  };
}
