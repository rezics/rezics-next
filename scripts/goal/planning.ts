import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import ts from 'typescript-6';
import { git, root } from './ledger.ts';
import { goalAreas, goalFile, parseBrief, pathsOverlap } from './briefs.ts';
import { HOLDING, type Ledger, type Task } from './types.ts';
import { personas, pending, proved, notApplicable, rowOutcomes, type Persona, type RowOutcomes } from '../qa/cases/outcome-cells.ts';
import type { WakeEvent } from './coordinator.ts';
import { retryEventDatabase } from './event-store.ts';
import { launchCoverage } from '../qa/cases/launch-coverage.ts';

const declarationsPath = 'scripts/qa/cases/outcomes';
type DeclarationRead = { file: string } & ({ declaration: RowOutcomes; unreadable?: never } | { declaration?: never; unreadable: string });
const declarationsCache = new Map<string, { main: string; rows: DeclarationRead[] }>();
const verticalOrder = [...new Set(launchCoverage.map(row => row.kind))];
const ancestryCache = new Map<string, boolean>();
const introductionsCache = new Map<string, string>();
const commitOrderCache = new Map<string, { main: string; order: Map<string, number> }>();

// Resolve only values used by the default export. Declarations also export fixture
// helpers that the planner never needs to evaluate; imports must come from the same main.
function declarationModule(file: string, read: (file: string) => string,
  modules: Map<string, (name: string) => unknown>): (name: string) => unknown {
  const cached = modules.get(file);
  if (cached) return cached;
  const text = read(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const values = new Map<string, unknown>();
  const bindings = new Map<string, () => unknown>();
  const exports = new Map<string, () => unknown>();
  const resolving = new Set<string>();
  const helpers = new Map<string, (...args: never[]) => unknown>();
  const functions = { pending, proved, notApplicable, rowOutcomes };
  function binding(name: string): unknown {
    if (values.has(name)) return values.get(name);
    const get = bindings.get(name);
    if (!get) throw new Error(`Unknown outcome binding in ${file}: ${name}`);
    if (resolving.has(name)) throw new Error(`Circular outcome binding in ${file}: ${name}`);
    resolving.add(name);
    try {
      const result = get();
      values.set(name, result);
      return result;
    } finally { resolving.delete(name); }
  }
  function value(node: ts.Expression): unknown {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => {
      const text = value(span.expression);
      if (typeof text !== 'string') throw new Error(`Unsupported outcome interpolation in ${file}: ${span.expression.getText(source)}`);
      return text + span.literal.text;
    }).join('');
    if (ts.isIdentifier(node)) return binding(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const object = value(node.expression);
      if (object && typeof object === 'object' && Object.hasOwn(object, node.name.text))
        return (object as Record<string, unknown>)[node.name.text];
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left), right = value(node.right);
      if (typeof left !== 'string' || typeof right !== 'string') throw new Error(`Unsupported outcome string sum: ${node.getText(source)}`);
      return left + right;
    }
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
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const imported = statement.importClause?.namedBindings;
      if (imported && ts.isNamedImports(imported)) for (const item of imported.elements) {
        if (statement.importClause?.isTypeOnly || item.isTypeOnly) continue;
        const name = (item.propertyName ?? item.name).text;
        if (specifier.endsWith('/outcome-cells.ts') && Object.hasOwn(functions, name))
          helpers.set(item.name.text, functions[name as keyof typeof functions] as (...args: never[]) => unknown);
        else bindings.set(item.name.text, () => {
          if (!specifier.startsWith('.')) throw new Error(`Unsupported outcome import in ${file}: ${specifier}`);
          const dependency = posix.normalize(posix.join(posix.dirname(file), specifier));
          if (dependency === '..' || dependency.startsWith('../')) throw new Error(`Outcome import outside checkout: ${file} -> ${specifier}`);
          return declarationModule(dependency, read, modules)(name);
        });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const name = declaration.name.text, initializer = declaration.initializer;
        bindings.set(name, () => value(initializer));
        if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
          exports.set(name, () => binding(name));
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exports.set('default', () => value(statement.expression));
    }
  }
  const exported = (name: string): unknown => {
    const get = exports.get(name);
    if (!get) throw new Error(`Missing outcome export in ${file}: ${name}`);
    return get();
  };
  modules.set(file, exported);
  return exported;
}

function mainDeclarations(repo: string, main: string): DeclarationRead[] {
  const tree = git(repo, ['rev-parse', `${main}:${declarationsPath}`], true);
  if (!tree) return [];
  const cached = declarationsCache.get(repo);
  if (cached?.main === main) return cached.rows;
  const modules = new Map<string, (name: string) => unknown>();
  const read = (file: string) => git(repo, ['show', `${main}:${file}`]);
  const files = git(repo, ['ls-tree', '-r', '--name-only', main, '--', declarationsPath]).split('\n').filter(file => file.endsWith('.ts'));
  const rows: DeclarationRead[] = files.map(file => {
    try {
      const declaration = declarationModule(file, read, modules)('default') as RowOutcomes;
      return { file, declaration: rowOutcomes(declaration.rowId, declaration.cells, declaration) };
    }
    catch (error) { return { file, unreadable: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ') }; }
  });
  declarationsCache.set(repo, { main, rows });
  return rows;
}

export interface PlanningRow {
  id: string;
  file: string;
  pending: { persona: Persona; note: string }[];
  task?: string;
  handoff?: string;
  unreadable?: string;
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
  const covered = new Set(tasks.filter(task => (task.kind === 'implementation' || task.kind === 'outcome')
    && HOLDING.includes(task.state)).flatMap(task => task.rows ?? []));
  for (const goal of goals) {
    const briefs = join(repo, 'docs/goals', goal, 'tasks');
    if (!existsSync(briefs)) continue;
    for (const file of readdirSync(briefs).filter(file => file.endsWith('.md'))) {
      for (const row of parseBrief(readFileSync(join(briefs, file), 'utf8')).rows ?? []) covered.add(row);
    }
  }
  const result = new Map<string, PlanningRow[]>(goals.sort().map(goal => [goal, []]));
  for (const { file, declaration, unreadable } of mainDeclarations(repo, main)) {
    const id = declaration?.rowId ?? file.slice(declarationsPath.length + 1, -3);
    const cells = declaration ? personas.flatMap(persona => {
      const cell = declaration.cells[persona];
      return cell?.state === 'pending' ? [{ persona, note: cell.test }] : [];
    }) : [];
    if ((!unreadable && !cells.length) || covered.has(id)) continue;
    const task = landedDeclaration(repo, main, file, tasks);
    const goal = task?.goal ?? areas.find(area => area.paths.some(path => pathsOverlap(path, file)))?.goal;
    if (!goal || !result.has(goal)) continue;
    const attempt = task?.attempts.at(-1);
    const handoff = attempt ? join(directory, 'runs', task!.id, basename(attempt.lastMessage ?? attempt.output)) : undefined;
    result.get(goal)!.push({ id, file, pending: cells, task: task?.id, handoff, unreadable });
  }
  for (const rows of result.values()) rows.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function planningBody(goal: string, rows: readonly PlanningRow[]): string {
  const lines = [`Planning for Goal ${goal}: ${rows.length} uncovered pending rows.`];
  const rank = (row: PlanningRow): number => {
    const index = verticalOrder.findIndex(vertical => vertical === row.id.split('/')[0]);
    return index < 0 ? verticalOrder.length : index;
  };
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const vertical = ordered[0]?.id.split('/')[0];
  const slice = ordered.filter(row => row.id.split('/')[0] === vertical).slice(0, 6);
  for (const row of slice) lines.push(row.unreadable ? `${row.file}: unreadable declaration: ${row.unreadable}`
    : `${row.id} | ${row.pending.map(cell => `${cell.persona}: ${JSON.stringify(cell.note)}`).join('; ')} | declaration: ${row.file} | landed: ${row.task ?? 'no task in ledger'} | handoff: ${row.handoff ?? 'none'}`);
  lines.push(`${rows.length - slice.length} uncovered rows wait after this slice.`);
  lines.push('Create one implementation task for each cause, not for each cell; a fixture that cannot reach the state counts as a cause.',
    'A row that waits for another task gets its brief now, queued behind that task.');
  return lines.join('\n');
}

export function planningEvent(directory: string, goal: string, ledger: Ledger, repo = root): WakeEvent | undefined {
  const file = join(directory, 'coordinator.sqlite');
  if (!existsSync(file)) return;
  const db = retryEventDatabase(new Database(file, { readonly: true }));
  try {
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
