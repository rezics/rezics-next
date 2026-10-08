import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-6';

const modulesRoot = fileURLToPath(new URL('../src/modules/', import.meta.url));

/** These directory names are the launch modules whose operational logs stay free of row values. */
const prefixed = /^(?:library|progress|realm|zone|notification)/;
const exact = new Set(['reading-position', 'space', 'presentation', 'theme', 'saved-filter', 'follows']);

/** A string literal or `logWorkerFault(...)` carries no row value. A template with a substitution does. */
function argumentAllowed(argument: ts.Expression): boolean {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return true;
  return ts.isCallExpression(argument)
    && ts.isIdentifier(argument.expression)
    && argument.expression.text === 'logWorkerFault';
}

function isConsoleCall(expression: ts.Expression): expression is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'console';
}

/** Console calls that pass a value, reported as `<file>:<line>`. */
export function consoleValueLeaks(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const leaks: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isConsoleCall(node.expression)
      && node.arguments.some(argument => !argumentAllowed(argument))) {
      leaks.push(`${file}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return leaks;
}

function launchModuleFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!prefixed.test(entry.name) && !exact.has(entry.name)) continue;
    visit(join(modulesRoot, entry.name));
  }
  return files.sort();
}

test('a console call that passes a value is reported with its file and line', () => {
  const source = [
    'console.error("fixed");',
    'console.warn(`also fixed`);',
    'logWorkerFault("main.library.follow", error);',
    'console.error(logWorkerFault("main.library.follow", error));',
    'console.error("Safety alerts:", error);',
    '// console.error("hidden", error)',
    'const text = "console.error(\'hidden\', error)";',
    'const id = /^https:\\/\\/rezics\\.com\\/id\\/[0-9a-f-]{36}$/;',
    "const quoted = /^='\"?$/;",
    'let value = raw.replace(/^="?/, "").replace(/"$/, "");',
    'console.error("still fixed");',
    'const line = `kept ${console.warn("bad", error)}`;',
    'console.error(',
    '  "multi",',
    '  error,',
    ');',
    'console.error(`reader ${email}`);',
  ].join('\n');
  expect(consoleValueLeaks(source, 'sample.ts')).toEqual([
    'sample.ts:5',
    'sample.ts:12',
    'sample.ts:13',
    'sample.ts:17',
  ]);
});

test('launch module console calls pass only string literals or logWorkerFault', () => {
  const leaks = launchModuleFiles().flatMap(file =>
    consoleValueLeaks(readFileSync(file, 'utf8'), relative(modulesRoot, file)));
  expect(leaks).toEqual([]);
});
