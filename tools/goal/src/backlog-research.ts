import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { ManagerEvent, ManagerInbox } from './contracts.ts';
import { readResearchFanout, type ResearchFanoutBrief } from './briefs.ts';
import {
  BACKLOG_DISPATCHED_DIRECTORY as DISPATCHED_DIRECTORY,
  BACKLOG_DISPATCHING_DIRECTORY as CLAIM_DIRECTORY,
  backlogDirectory,
  briefs,
  dispatchResult,
  errorText,
  stem,
  taskLintWarnings,
  type BacklogDispatchResult,
} from './backlog-shared.ts';

export type BacklogResearchRuntime = {
  db: Database;
  stateDirectory: string;
  inbox: ManagerInbox;
  dispatch(briefFile: string): Promise<BacklogDispatchResult>;
};

type ResearchGroupRow = {
  id: string;
  goal: string;
  manager: string;
  source_name: string;
  researchers: string;
  reports: string;
  dispatch_failures: string;
  notified_at: number | null;
};
type ResearchTaskRow = { id: string; body: string; state: string; model: string };

function setFrontMatterFields(markdown: string, fields: Record<string, unknown | undefined>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('brief needs Markdown front matter');
  const replacing = new Set(Object.keys(fields));
  const kept: string[] = [];
  let skipValue = false;
  for (const line of match[1]!.split(/\r?\n/)) {
    const key = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line)?.[1];
    if (key) {
      skipValue = replacing.has(key);
      if (!skipValue) kept.push(line);
      continue;
    }
    if (skipValue && (!line.trim() || /^\s/.test(line))) continue;
    skipValue = false;
    kept.push(line);
  }
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) kept.push(`${key}: ${JSON.stringify(value)}`);
  return `---\n${kept.join('\n')}\n---\n${markdown.slice(match[0].length)}`;
}

function researchSlug(markdown: string, sourceName: string, input: ResearchFanoutBrief): string {
  const report = input.paths.find(
    (path) => path.startsWith('docs/research/') && path.endsWith('.md') && !/[?*]/.test(path),
  );
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1];
  const raw = report ? basename(report, '.md') : heading || basename(sourceName, '.md');
  return (
    raw
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'research'
  );
}

function researchReportPaths(markdown: string, sourceName: string, input: ResearchFanoutBrief): Record<string, string> {
  const slug = researchSlug(markdown, sourceName, input);
  return Object.fromEntries(input.researchers.map((model) => [model, `docs/research/${slug}-${model}.md`]));
}

function researcherBrief(
  markdown: string,
  input: ResearchFanoutBrief,
  model: string,
  groupId: string,
  report: string,
): string {
  for (const authoredPath of input.paths.filter((path) => path.startsWith('docs/research/')))
    markdown = markdown.split(authoredPath).join(report);
  const paths = [...input.paths.filter((path) => !path.startsWith('docs/research/')), report];
  const rewritten = setFrontMatterFields(markdown, {
    researchers: undefined,
    model,
    paths,
    researchGroup: groupId,
    researchReport: report,
  });
  return `${rewritten.trimEnd()}\n\nWork independently using web search. Do not wait for or read another researcher's report. Write the report to \`${report}\`.\n`;
}

function ensureResearchGroup(
  runtime: BacklogResearchRuntime,
  id: string,
  goal: string,
  manager: string,
  sourceName: string,
  researchers: string[],
  reports: Record<string, string>,
): void {
  runtime.db
    .query(
      `INSERT INTO research_groups(id, goal, manager, source_name, researchers, reports)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, goal, manager, sourceName, JSON.stringify(researchers), JSON.stringify(reports));
}

function groupFailures(runtime: BacklogResearchRuntime, id: string): Record<string, string> {
  const row = runtime.db.query('SELECT dispatch_failures FROM research_groups WHERE id=?').get(id) as
    | { dispatch_failures: string }
    | undefined;
  return row ? (JSON.parse(row.dispatch_failures) as Record<string, string>) : {};
}

function failResearcher(runtime: BacklogResearchRuntime, id: string, model: string, reason: string): void {
  const failures = groupFailures(runtime, id);
  failures[model] = reason.slice(0, 500);
  runtime.db.query('UPDATE research_groups SET dispatch_failures=? WHERE id=?').run(JSON.stringify(failures), id);
}

function researchTasks(runtime: BacklogResearchRuntime, groupId: string): ResearchTaskRow[] {
  const rows = runtime.db
    .query("SELECT id, body FROM worker_tasks WHERE json_extract(body, '$.brief.researchGroup') = ?")
    .all(groupId) as { id: string; body: string }[];
  return rows.flatMap(({ id, body }) => {
    try {
      const task = JSON.parse(body) as { state?: unknown; brief?: { model?: unknown } };
      return typeof task.state === 'string' && typeof task.brief?.model === 'string'
        ? [{ id, body, state: task.state, model: task.brief.model }]
        : [];
    } catch {
      return [];
    }
  });
}

function archiveResearchMember(
  goalDirectory: string,
  sourceName: string,
  taskId: string,
  model: string,
  temporary: string,
): void {
  const dispatched = join(goalDirectory, DISPATCHED_DIRECTORY);
  mkdirSync(dispatched, { recursive: true });
  const destination = join(dispatched, `${taskId}-${stem(sourceName)}-${model}.md`);
  if (!existsSync(temporary)) return;
  if (existsSync(destination)) rmSync(temporary, { force: true });
  else renameSync(temporary, destination);
}

export async function dispatchResearchClaim(
  runtime: BacklogResearchRuntime,
  goal: string,
  claimed: string,
  markdown: string,
  writtenMs: number,
  maxNewTasks: number,
): Promise<{
  dispatched: { taskId: string; brief: string; lintWarnings?: string[] }[];
  started: number;
  complete: boolean;
  writtenMs: number;
}> {
  const input = readResearchFanout(markdown);
  if (!input) return { dispatched: [], started: 0, complete: false, writtenMs };
  const groupId = input.groupId ?? randomUUID();
  if (!input.groupId) {
    markdown = setFrontMatterFields(markdown, { researchGroup: groupId });
    writeFileSync(claimed, markdown);
  }
  const sourceName = basename(claimed);
  const reports = researchReportPaths(markdown, sourceName, input);
  ensureResearchGroup(runtime, groupId, input.goal || goal, input.manager, sourceName, input.researchers, reports);
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const children = dirname(claimed);
  const dispatched: { taskId: string; brief: string; lintWarnings?: string[] }[] = [];
  let started = 0;

  for (const model of input.researchers) {
    const existing = researchTasks(runtime, groupId).filter((task) => task.model === model);
    const temporary = join(children, `research-${groupId}-${model}.md`);
    if (existing.length) {
      for (const task of existing) {
        archiveResearchMember(goalDirectory, sourceName, task.id, model, temporary);
        const lintWarnings = taskLintWarnings(runtime.db, task.id);
        dispatched.push({ taskId: task.id, brief: sourceName, ...(lintWarnings.length ? { lintWarnings } : {}) });
      }
      continue;
    }
    if (Object.hasOwn(groupFailures(runtime, groupId), model)) continue;
    if (started >= maxNewTasks) continue;

    writeFileSync(temporary, researcherBrief(markdown, input, model, groupId, reports[model]!));
    try {
      const dispatchedTask = dispatchResult(await runtime.dispatch(temporary));
      const taskId = dispatchedTask.taskId;
      started += 1;
      archiveResearchMember(goalDirectory, sourceName, taskId, model, temporary);
      const lintWarnings = dispatchedTask.lintWarnings.length
        ? dispatchedTask.lintWarnings
        : taskLintWarnings(runtime.db, taskId);
      dispatched.push({ taskId, brief: sourceName, ...(lintWarnings.length ? { lintWarnings } : {}) });
    } catch (error) {
      const created = researchTasks(runtime, groupId).filter((task) => task.model === model);
      if (created.length) {
        for (const task of created) {
          started += 1;
          archiveResearchMember(goalDirectory, sourceName, task.id, model, temporary);
          const lintWarnings = taskLintWarnings(runtime.db, task.id);
          dispatched.push({ taskId: task.id, brief: sourceName, ...(lintWarnings.length ? { lintWarnings } : {}) });
        }
      } else {
        failResearcher(runtime, groupId, model, errorText(error));
        rmSync(temporary, { force: true });
      }
    }
  }

  const failures = groupFailures(runtime, groupId);
  const completedMembers = new Set([
    ...researchTasks(runtime, groupId).map((task) => task.model),
    ...Object.keys(failures),
  ]);
  const complete = input.researchers.every((model) => completedMembers.has(model));
  if (!complete) return { dispatched, started, complete: false, writtenMs };

  const archive = join(goalDirectory, DISPATCHED_DIRECTORY);
  mkdirSync(archive, { recursive: true });
  const groupBrief = join(archive, `research-group-${groupId}-${sourceName}`);
  if (existsSync(groupBrief)) rmSync(claimed, { force: true });
  else renameSync(claimed, groupBrief);
  return { dispatched, started, complete: true, writtenMs };
}

export async function recoverResearchClaims(
  runtime: BacklogResearchRuntime,
  goal: string,
  maxNewTasks: number,
): Promise<{
  dispatched: { taskId: string; brief: string }[];
  started: number;
  completed: { goal: string; writtenMs: number }[];
}> {
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const result = {
    dispatched: [] as { taskId: string; brief: string }[],
    started: 0,
    completed: [] as { goal: string; writtenMs: number }[],
  };
  for (const claimed of briefs(join(goalDirectory, CLAIM_DIRECTORY))) {
    const markdown = readFileSync(claimed, 'utf8');
    if (!readResearchFanout(markdown)) continue;
    const group = await dispatchResearchClaim(
      runtime,
      goal,
      claimed,
      markdown,
      statSync(claimed).mtimeMs,
      maxNewTasks - result.started,
    );
    result.dispatched.push(...group.dispatched);
    result.started += group.started;
    if (group.complete) result.completed.push({ goal, writtenMs: group.writtenMs });
  }
  return result;
}

export function deliverResearchCompletions(runtime: BacklogResearchRuntime, now: number): string[] {
  const notified: string[] = [];
  const groups = runtime.db
    .query('SELECT * FROM research_groups WHERE notified_at IS NULL ORDER BY rowid')
    .all() as ResearchGroupRow[];
  const terminal = new Set(['integrated', 'merged', 'verified', 'stopped', 'cancelled']);
  const successful = new Set(['integrated', 'merged', 'verified']);
  for (const group of groups) {
    const researchers = JSON.parse(group.researchers) as string[];
    const reports = JSON.parse(group.reports) as Record<string, string>;
    const failures = JSON.parse(group.dispatch_failures) as Record<string, string>;
    const tasks = researchTasks(runtime, group.id);
    const failed: string[] = [];
    let pending = false;
    for (const model of researchers) {
      if (Object.hasOwn(failures, model)) {
        failed.push(model);
        continue;
      }
      const memberTasks = tasks.filter((task) => task.model === model);
      if (!memberTasks.length || memberTasks.some((task) => !terminal.has(task.state))) {
        pending = true;
        continue;
      }
      if (memberTasks.some((task) => !successful.has(task.state))) failed.push(model);
    }
    if (pending) continue;

    const summary = `Research complete: reports ${Object.values(reports).join(', ')}; failed researchers: ${failed.join(', ') || 'none'}.`;
    let delivered = false;
    runtime.db
      .transaction(() => {
        const updated = runtime.db
          .query('UPDATE research_groups SET notified_at=? WHERE id=? AND notified_at IS NULL')
          .run(now, group.id);
        if (updated.changes !== 1) return;
        const event: ManagerEvent = {
          managerId: group.manager,
          goalId: group.goal,
          kind: 'research-complete',
          summary,
        };
        runtime.inbox.deliver(event);
        delivered = true;
      })
      .immediate();
    if (delivered) notified.push(group.id);
  }
  return notified;
}
