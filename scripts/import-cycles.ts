#!/usr/bin/env bun
// Lists the modules that sit in runtime import cycles under a source root and fails when their count exceeds a
// baseline. Static import and re-export declarations count. `import type`, type-only specifiers, dynamic import() and
// require() do not: the first two erase at compile time and the last two load lazily.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** A cycle may not span two of these directories. Other directories are core modules shared by all of them. */
export const DOMAIN_DIRECTORIES = [
  'library',
  'semantic',
  'access',
  'search',
  'content',
  'community',
  'rating',
  'zones',
  'commerce',
] as const;

/** Each source file mapped to the static import targets that resolve to source files. */
export type ImportGraph = Map<string, string[]>;

const SOURCE_FILE = /\.tsx?$/;
const transpiler = new Bun.Transpiler({ loader: 'ts' });

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_FILE.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

/** Reads the static import graph below an absolute or working-directory-relative root. */
export function readImportGraph(root: string): ImportGraph {
  const graph: ImportGraph = new Map();
  for (const file of sourceFiles(resolve(root))) {
    const targets: string[] = [];
    for (const imported of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (imported.kind !== 'import-statement' || !imported.path.startsWith('.')) continue;
      const target = resolve(dirname(file), imported.path);
      if (SOURCE_FILE.test(target) && existsSync(target)) targets.push(target);
    }
    graph.set(file, targets);
  }
  return graph;
}

/** The strongly connected components that hold a cycle, largest first; each lists its modules sorted. */
export function importCycles(graph: ImportGraph): string[][] {
  let counter = 0;
  const indexes = new Map<string, number>();
  const lows = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const connect = (node: string): void => {
    indexes.set(node, counter);
    lows.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indexes.has(next)) {
        connect(next);
        lows.set(node, Math.min(lows.get(node)!, lows.get(next)!));
      } else if (onStack.has(next)) {
        lows.set(node, Math.min(lows.get(node)!, indexes.get(next)!));
      }
    }
    if (lows.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || graph.get(node)?.includes(node)) cycles.push(component.sort());
  };
  for (const node of graph.keys()) if (!indexes.has(node)) connect(node);
  return cycles.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

/** The domain directories a module belongs to, or none for a core or root module. */
export function domainOf(root: string, file: string): string | undefined {
  const first = relative(resolve(root), file).split(sep)[0]!;
  return (DOMAIN_DIRECTORIES as readonly string[]).includes(first) ? first : undefined;
}

/** The distinct domain directories a cycle touches. A cycle spanning two or more is a cross-domain cycle. */
export function cycleDomains(root: string, cycle: string[]): string[] {
  return [...new Set(cycle.map((file) => domainOf(root, file)).filter((d): d is string => d !== undefined))].sort();
}

function parseArguments(argv: string[]): { root: string; baseline: number } {
  let root: string | undefined;
  let baseline = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--baseline') {
      const value = argv[(index += 1)];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error('--baseline needs a non-negative integer');
      baseline = Number(value);
    } else if (argument.startsWith('-') || root !== undefined) {
      throw new Error(`unexpected argument: ${argument}`);
    } else {
      root = argument;
    }
  }
  if (root === undefined) throw new Error('usage: bun scripts/import-cycles.ts <source-root> [--baseline <count>]');
  return { root, baseline };
}

/** Prints the cycles under the root; returns 1 when their module count exceeds the baseline, 2 on bad arguments. */
export function main(argv: string[]): number {
  let args: { root: string; baseline: number };
  try {
    args = parseArguments(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const graph = readImportGraph(args.root);
  const cycles = importCycles(graph);
  const inCycles = cycles.reduce((count, cycle) => count + cycle.length, 0);
  const crossDomain = cycles.filter((cycle) => cycleDomains(args.root, cycle).length > 1).length;
  console.log(
    `modules ${graph.size}, cyclic groups ${cycles.length}, modules in cycles ${inCycles}, ` +
      `cross-domain groups ${crossDomain}, baseline ${args.baseline}`,
  );
  for (const [index, cycle] of cycles.entries()) {
    const domains = cycleDomains(args.root, cycle);
    console.log(`\ncycle ${index + 1}: ${cycle.length} modules${domains.length ? ` (${domains.join(', ')})` : ''}`);
    for (const file of cycle) console.log(`  ${relative(resolve(args.root), file)}`);
  }
  if (inCycles <= args.baseline) return 0;
  console.error(`\nimport cycles: ${inCycles} modules exceed the baseline of ${args.baseline}`);
  return 1;
}

if (import.meta.main) process.exitCode = main(Bun.argv.slice(2));
