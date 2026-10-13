import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import ts from 'typescript-6';
import { git, root } from './ledger.ts';
import { goalAreas, goalFile, pathsOverlap } from './briefs.ts';
import { HOLDING, type Ledger, type Task } from './types.ts';
import { personas, pending, proved, notApplicable, rowOutcomes, type Persona, type RowOutcomes } from '../qa/cases/outcome-cells.ts';
import type { WakeEvent } from './coordinator.ts';

const declarationsPath = 'scripts/qa/cases/outcomes';
const declarationsCache = new Map<string, { tree: string; rows: { file: string; declaration: RowOutcomes }[] }>();
const ancestryCache = new Map<string, boolean>();
const introductionsCache = new Map<string, string>();
const commitOrderCache = new Map<string, { main: string; order: Map<string, number> }>();

// Read the authored values without executing a declaration or importing a worker's copy.
function declarationValues(file: string, text: string): RowOutcomes {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const values = new Map<string, unknown>();
  const helpers = new Map<string, (...args: never[]) => unknown>();
  const functions = { pending, proved, notApplicable, rowOutcomes };
  function value(node: ts.Expression): unknown {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) && values.has(node.text)) return values.get(node.text);
    // A declaration is valid TypeScript that the loader runs; notes are also built from constants.
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => `${String(value(span.expression))}${span.literal.text}`).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return `${String(value(node.left))}${String(value(node.right))}`;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return value(node.expression);
    if (ts.isObjectLiteralExpression(node)) {
      const object: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) Object.assign(object, value(property.expression));
        else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)))
          object[property.name.text] = value(property.initializer);
        else throw new Error(`Unsupported outcome property in ${file}`);
      }
      return object;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = helpers.get(node.expression.text);
      if (helper) return helper(...node.arguments.map(argument => value(argument)) as never[]);
    }
    throw new Error(`Unsupported outcome value in ${file}: ${node.getText(source)}`);
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.endsWith('/outcome-cells.ts')) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text;
        if (Object.hasOwn(functions, name)) helpers.set(binding.name.text, functions[name as keyof typeof functions] as (...args: never[]) => unknown);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer) values.set(declaration.name.text, value(declaration.initializer));
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return value(statement.expression) as RowOutcomes;
    }
  }
  throw new Error(`Missing rowOutcomes default export: ${file}`);
}

function mainDeclarations(repo: string, main: string): { file: string; declaration: RowOutcomes }[] {
  const tree = git(repo, ['rev-parse', `${main}:${declarationsPath}`], true);
  if (!tree) return [];
  const cached = declarationsCache.get(repo);
  if (cached?.tree === tree) return cached.rows;
  const files = git(repo, ['ls-tree', '-r', '--name-only', main, '--', declarationsPath]).split('\n').filter(file => file.endsWith('.ts'));
  const rows = files.map(file => ({ file, declaration: declarationValues(file, git(repo, ['show', `${main}:${file}`])) }));
  declarationsCache.set(repo, { tree, rows });
  return rows;
}

export interface PlanningRow {
  id: string;
  file: string;
  pending: { persona: Persona; note: string }[];
  task?: string;
  handoff?: string;
}

/** The declaration's introducing task owns the row even when another Goal owns its file area. */
function ancestor(repo: string, before: string, after: string): boolean {
  const key = `${repo}:${before}:${after}`;
  if (!ancestryCache.has(key)) ancestryCache.set(key,
    spawnSync('git', ['merge-base', '--is-ancestor', before, after], { cwd: repo }).status === 0);
  return ancestryCache.get(key)!;
}

function landedDeclaration(repo: string, main: string, file: string, tasks: Task[]): Task | undefined {
  const introductionKey = `${repo}:${main}:${file}`;
  if (!introductionsCache.has(introductionKey)) introductionsCache.set(introductionKey,
    git(repo, ['log', '-1', '--diff-filter=A', '--format=%H', main, '--', file]));
  const introduction = introductionsCache.get(introductionKey)!;
  if (commitOrderCache.get(repo)?.main !== main) commitOrderCache.set(repo, { main,
    order: new Map(git(repo, ['rev-list', '--topo-order', main]).split('\n').map((commit, index) => [commit, index])) });
  const order = commitOrderCache.get(repo)!.order;
  // A later worker's original base can precede another task's landing. Choose the
  // earliest landing containing the introduction, rather than attributing that
  // addition to every later task whose base-to-head diff happens to include it.
  return tasks.filter(task => task.goal && task.mergedCommit && task.base && order.has(task.mergedCommit)
    && order.get(task.mergedCommit)! <= order.get(introduction)!)
    .sort((a, b) => order.get(b.mergedCommit!)! - order.get(a.mergedCommit!)!
      || Number(b.paths.some(path => pathsOverlap(path, file))) - Number(a.paths.some(path => pathsOverlap(path, file))))
    .find(task => ancestor(repo, introduction, task.mergedCommit!) && !ancestor(repo, introduction, task.base));
}

export function uncoveredPlanningRows(directory: string, ledger: Ledger, repo = root): Map<string, PlanningRow[]> {
  repo = resolve(repo);
  const goals = Object.keys(ledger.goals ?? {}).filter(goal => !ledger.goals![goal]!.closedAt);
  const areas = goals.map(goal => {
    const file = join(repo, goalFile(goal));
    return { goal, paths: existsSync(file) ? goalAreas(readFileSync(file, 'utf8')) : [] };
  });
  const tasks = Object.values(ledger.tasks);
  const main = git(repo, ['rev-parse', 'main'], true);
  const covered = new Set(tasks.filter(task => task.kind === 'implementation' && HOLDING.includes(task.state)).flatMap(task => task.rows ?? []));
  const result = new Map<string, PlanningRow[]>(goals.sort().map(goal => [goal, []]));
  for (const { file, declaration } of mainDeclarations(repo, main)) {
    const cells = personas.flatMap(persona => {
      const cell = declaration.cells[persona];
      return cell?.state === 'pending' ? [{ persona, note: cell.test }] : [];
    });
    if (!cells.length || covered.has(declaration.rowId)) continue;
    const task = landedDeclaration(repo, main, file, tasks);
    const goal = task?.goal ?? areas.find(area => area.paths.some(path => pathsOverlap(path, file)))?.goal;
    if (!goal || !result.has(goal)) continue;
    const attempt = task?.attempts.at(-1);
    const handoff = attempt ? join(directory, 'runs', task!.id, basename(attempt.lastMessage ?? attempt.output)) : undefined;
    result.get(goal)!.push({ id: declaration.rowId, file, pending: cells, task: task?.id, handoff });
  }
  for (const rows of result.values()) rows.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function planningBody(goal: string, rows: readonly PlanningRow[]): string {
  const lines = [`Planning for Goal ${goal}: ${rows.length} uncovered pending rows.`];
  for (const row of rows.slice(0, 40)) lines.push(`${row.id} | ${row.pending.map(cell => `${cell.persona}: ${JSON.stringify(cell.note)}`).join('; ')} | declaration: ${row.file} | landed: ${row.task ?? 'no task in ledger'} | handoff: ${row.handoff ?? 'none'}`);
  if (rows.length > 40) lines.push(`${rows.length - 40} more uncovered rows omitted.`);
  lines.push('Create one implementation task for each cause, not for each cell; a fixture that cannot reach the state counts as a cause.',
    `Name each row left uncovered with its reason in docs/goals/${goal}/state.md.`);
  return lines.join('\n');
}

export function planningEvent(directory: string, goal: string, ledger: Ledger, repo = root): WakeEvent | undefined {
  const file = join(directory, 'coordinator.sqlite');
  if (!existsSync(file)) return;
  const db = new Database(file, { readonly: true });
  try {
    // Enrollment and turn completion can briefly hold the event store's write lock.
    db.exec('PRAGMA busy_timeout = 5000;');
    if (!db.query('SELECT goal FROM managers WHERE goal=?').get(goal)) return;
    if (db.query("SELECT event_key FROM events WHERE goal=? AND event_key LIKE 'planning:%' AND handled=0 LIMIT 1").get(goal)) return;
    const previous = db.query("SELECT rowid,event_key,handled FROM events WHERE goal=? AND event_key LIKE 'planning:%' ORDER BY rowid DESC LIMIT 1")
      .get(goal) as { rowid: number; event_key: string; handled: number } | null;
    const rows = uncoveredPlanningRows(directory, ledger, repo).get(goal) ?? [];
    if (!rows.length) return;
    const set = createHash('sha256').update(JSON.stringify(rows.map(row => row.id))).digest('hex');
    if (previous?.event_key.endsWith(`:${set}`)) return;
    return { key: `planning:${(previous?.rowid ?? 0) + 1}:${set}`, body: planningBody(goal, rows) };
  } finally { db.close(); }
}

export function planningLines(directory: string, ledger: Ledger, goal?: string, repo = root): string[] {
  const groups = uncoveredPlanningRows(directory, ledger, repo);
  if (goal && !groups.has(goal)) throw new Error(`Unknown active Goal: ${goal}`);
  return [...groups].filter(([slug]) => !goal || slug === goal).map(([slug, rows]) => planningBody(slug, rows));
}
