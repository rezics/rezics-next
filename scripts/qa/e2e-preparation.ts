import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isQaE2ePath } from './acceptance.ts';

/** One journey's data preparation. The tier runs it once, after the apps are ready
 * and before Playwright, and adds `budgetMs` only when this journey is selected
 * or the whole e2e tier runs. */
export interface JourneyPreparation {
  /** Repository-relative journey, for example `apps/web/tests/example.e2e.ts`. */
  journey: string;
  /** Program and arguments, spawned from the repository root. The program is a command name. */
  command: readonly [string, ...string[]];
  /** Wall-clock allowance for this preparation. The data-preparation ceiling is 600s. */
  budgetMs: number;
  /** Name recorded for the step. */
  step: string;
  /** Log file `logs/e2e-<slug>.log`. */
  slug: string;
}

/** Each preparation stays inside the shared data-preparation ceiling. A tier that
 * selects several journeys adds their budgets because the preparations run in order. */
const MAX_PREPARATION_MS = 600_000;

type Declaration = Omit<JourneyPreparation, 'journey'>;

function display(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/');
}

function validatePreparation(value: unknown, source: string, root: string): Declaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} preparation must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join() !== 'budgetMs,command,slug,step') {
    throw new Error(`${source} preparation must declare command, budgetMs, step and slug`);
  }
  const command = record.command;
  if (
    !Array.isArray(command) ||
    command.some((part) => typeof part !== 'string') ||
    command.length < 2 ||
    command.length > 16
  ) {
    throw new Error(`${source} preparation command must be a program and its arguments`);
  }
  const parts = command as string[];
  for (const part of parts) {
    if (part.length === 0 || part.length > 400 || /[\0\r\n]/.test(part) || part.includes('..')) {
      throw new Error(`${source} preparation command has an empty or unsafe argument`);
    }
  }
  const program = parts[0]!;
  if (!/^[A-Za-z0-9._+-]+$/.test(program)) {
    throw new Error(`${source} preparation program must be a command name`);
  }
  for (const arg of parts.slice(1)) {
    if (arg.startsWith('-') || !arg.endsWith('.ts')) continue;
    if (arg.startsWith('/') || !existsSync(join(root, arg))) {
      throw new Error(`${source} preparation script is missing: ${arg}`);
    }
  }
  const { budgetMs, step, slug } = record;
  if (
    !Number.isSafeInteger(budgetMs) ||
    (budgetMs as number) < 1 ||
    (budgetMs as number) > MAX_PREPARATION_MS
  ) {
    throw new Error(
      `${source} preparation budget must be an integer from 1 to ${MAX_PREPARATION_MS} milliseconds`,
    );
  }
  if (
    typeof step !== 'string' ||
    step.length < 3 ||
    step.length > 80 ||
    step.trim() !== step ||
    /[\0\r\n]/.test(step)
  ) {
    throw new Error(`${source} preparation step must be a single line`);
  }
  if (typeof slug !== 'string' || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`${source} preparation slug must be lowercase words separated by hyphens`);
  }
  return { command: [program, ...parts.slice(1)], budgetMs: budgetMs as number, step, slug };
}

/** A journey file may declare preparation as one object literal. Anything else belongs in the sibling module. */
function preparationFromJourney(
  source: string,
  journey: string,
): Record<string, unknown> | undefined {
  const marker = /(?:^|\n)[ \t]*export const e2ePreparation =/;
  const found = marker.exec(source);
  if (!found) {
    if (source.includes('export const e2ePreparation')) {
      throw new Error(`${journey} must export e2ePreparation as an object literal`);
    }
    return undefined;
  }
  let index = found.index + found[0].length;
  const skip = () => {
    while (index < source.length && /[ \t\n]/.test(source[index]!)) index += 1;
  };
  skip();
  if (source[index] !== '{')
    throw new Error(`${journey} must export e2ePreparation as an object literal`);
  index += 1;
  const record: Record<string, unknown> = {};
  const fail = (detail: string): never => {
    throw new Error(
      `${journey} preparation ${detail}; use a sibling .prepare.ts for anything else`,
    );
  };
  const stringLiteral = (): string => {
    const quote = source[index];
    if (quote !== '"' && quote !== "'") fail('strings must be quotes');
    let value = '';
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const char = source[cursor]!;
      if (char === '\\' || char === '\n') fail('cannot use escapes or line breaks');
      if (char === quote) {
        index = cursor + 1;
        return value;
      }
      value += char;
    }
    fail('has an unclosed string');
  };
  skip();
  while (index < source.length && source[index] !== '}') {
    const key = /^[A-Za-z]+/.exec(source.slice(index));
    if (!key) fail('has an unreadable field');
    if (Object.hasOwn(record, key[0])) fail(`repeats ${key[0]}`);
    index += key[0].length;
    skip();
    if (source[index] !== ':') fail(`must put a colon after ${key[0]}`);
    index += 1;
    skip();
    if (source[index] === '[') {
      index += 1;
      const items: string[] = [];
      skip();
      while (source[index] !== ']') {
        if (source[index] !== '"' && source[index] !== "'")
          fail('command must be an array of string literals');
        items.push(stringLiteral());
        skip();
        if (source[index] === ',') {
          index += 1;
          skip();
          continue;
        }
        if (source[index] !== ']') fail('command must be an array of string literals');
      }
      index += 1;
      record[key[0]] = items;
    } else if (source[index] === '"' || source[index] === "'") {
      record[key[0]] = stringLiteral();
    } else if (source[index] !== undefined && /\d/.test(source[index]!)) {
      const number = /^(\d+(?:_\d+)*)/.exec(source.slice(index));
      if (!number) fail('has an unreadable number');
      index += number[1]!.length;
      record[key[0]] = Number(number[1]!.replaceAll('_', ''));
    } else fail(`field ${key[0]} must be a literal`);
    skip();
    if (source[index] === ',') {
      index += 1;
      skip();
      continue;
    }
    if (source[index] !== '}') fail('must separate fields with commas');
  }
  if (source[index] !== '}') fail('is not closed');
  index += 1;
  skip();
  if (source[index] !== ';') fail('must end with a semicolon');
  return record;
}

function remember(
  found: Map<string, JourneyPreparation>,
  journey: string,
  declaration: Declaration,
  source: string,
): void {
  if (!isQaE2ePath(journey)) throw new Error(`${source} does not belong to a registered journey`);
  if (found.has(journey)) throw new Error(`${journey} declares preparation in more than one place`);
  found.set(journey, { journey, ...declaration });
}

/** Declarations under `apps/web/tests`: `<name>.prepare.ts` exports `preparation` for `<name>.e2e.ts`,
 * and a journey file may export `e2ePreparation` itself. */
export async function discoverJourneyPreparations(root: string): Promise<JourneyPreparation[]> {
  const directory = join(root, 'apps/web/tests');
  if (!existsSync(directory)) return [];
  const found = new Map<string, JourneyPreparation>();
  const prepareFiles = readdirSync(directory)
    .filter((file) => file.endsWith('.prepare.ts'))
    .sort();
  for (const file of prepareFiles) {
    if (!/^[A-Za-z0-9_-]+\.prepare\.ts$/.test(file)) {
      throw new Error(`apps/web/tests/${file} is not a journey preparation name`);
    }
    const journeyName = file.replace(/\.prepare\.ts$/, '.e2e.ts');
    const journey = `apps/web/tests/${journeyName}`;
    const preparePath = join(directory, file);
    if (!existsSync(join(directory, journeyName))) {
      throw new Error(`${display(root, preparePath)} has no journey file ${journeyName}`);
    }
    let imported: { preparation?: unknown };
    try {
      imported = (await import(pathToFileURL(preparePath).href)) as { preparation?: unknown };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load ${display(root, preparePath)}: ${message}`);
    }
    if (imported.preparation === undefined) {
      throw new Error(`${display(root, preparePath)} must export preparation`);
    }
    remember(
      found,
      journey,
      validatePreparation(imported.preparation, display(root, preparePath), root),
      file,
    );
  }
  const journeyFiles = readdirSync(directory)
    .filter((file) => file.endsWith('.e2e.ts'))
    .sort();
  for (const file of journeyFiles) {
    const journey = `apps/web/tests/${file}`;
    const source = readFileSync(join(directory, file), 'utf8');
    const literal = preparationFromJourney(source, journey);
    if (!literal) continue;
    remember(found, journey, validatePreparation(literal, journey, root), file);
  }
  return [...found.values()].sort((left, right) =>
    left.journey < right.journey ? -1 : left.journey > right.journey ? 1 : 0,
  );
}

function sameJourney(arg: string, journey: string): boolean {
  const path = arg.replaceAll('\\', '/').replace(/^\.\//, '');
  const target = journey.replaceAll('\\', '/');
  const base = target.slice(target.lastIndexOf('/') + 1);
  return (
    path === target || path.endsWith(`/${target}`) || path === base || path.endsWith(`/${base}`)
  );
}

/** No selected `*.e2e.ts` means the whole tier, so every declaration runs. A selected
 * journey runs its own preparation once, even when the file is repeated. */
export function selectJourneyPreparations(
  preparations: readonly JourneyPreparation[],
  playwrightArgs: readonly string[],
): JourneyPreparation[] {
  const files = playwrightArgs.filter((arg) => arg.replaceAll('\\', '/').endsWith('.e2e.ts'));
  const selected =
    files.length === 0
      ? preparations
      : preparations.filter((item) => files.some((file) => sameJourney(file, item.journey)));
  const seen = new Set<string>();
  const once: JourneyPreparation[] = [];
  for (const item of selected) {
    if (seen.has(item.journey)) continue;
    seen.add(item.journey);
    once.push(item);
  }
  return once.sort((left, right) =>
    left.journey < right.journey ? -1 : left.journey > right.journey ? 1 : 0,
  );
}

export function preparationBudgetMs(
  preparations: readonly Pick<JourneyPreparation, 'budgetMs'>[],
): number {
  const total = preparations.reduce((sum, item) => sum + item.budgetMs, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Journey preparation budgets overflow');
  return total;
}
