import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-6';
import type { TestResult } from '../qa/acceptance.ts';

export type ReviewTestResult = 'passed' | 'failed' | 'setup-failed' | 'unavailable';
export interface ReviewFailure {
  file: string; name: string; detail: string;
  assertionReached: 'yes' | 'no' | 'unknown';
}
export interface ReviewProof {
  head: string;
  results: Record<string, ReviewTestResult>;
  failures: ReviewFailure[];
}

export function readReviewProof(directory: string): ReviewProof | undefined {
  try {
    const proof = JSON.parse(readFileSync(join(directory, 'test-proof.json'), 'utf8')) as ReviewProof;
    try {
      const corrected = JSON.parse(readFileSync(join(directory, 'setup-correction/test-proof.json'), 'utf8')) as ReviewProof;
      if (corrected.head === proof.head) {
        proof.failures = proof.failures.filter(test => !(test.file in corrected.results)).concat(corrected.failures);
        Object.assign(proof.results, corrected.results);
      }
    } catch { /* The initial evidence remains valid if no correction ran. */ }
    return proof;
  } catch { return undefined; }
}

function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression)) return rootName(expression.expression);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return rootName(expression.expression);
  return undefined;
}

function testRegistration(expression: ts.Expression, tests: Set<string>): boolean {
  if (ts.isIdentifier(expression)) return tests.has(expression.text);
  if (ts.isCallExpression(expression)) return testRegistration(expression.expression, tests);
  return ts.isPropertyAccessExpression(expression)
    && ['each', 'only', 'skip', 'todo', 'failing', 'concurrent', 'serial', 'skipIf', 'todoIf'].includes(expression.name.text)
    && testRegistration(expression.expression, tests);
}

/** A helper's expect, a hook, or a throw before expect cannot establish the test's outcome. */
export function assertionReached(test: Pick<TestResult, 'file' | 'detail' | 'stack' | 'timeout' | 'preparationFailure'>,
  source: string, worktree: string): ReviewFailure['assertionReached'] {
  if (test.timeout || /ECONNREFUSED|ETIMEDOUT|timed out|stack startup|bootstrap failed/i.test(test.detail ?? '')) return 'unknown';
  if (test.preparationFailure) return 'no';
  const frame = /^\s*at (?:.*?\()?((?:file:\/\/)?[^()\n]+?):(\d+):(\d+)\)?\s*$/m.exec(test.stack ?? test.detail ?? '');
  if (!frame) return 'unknown';
  const location = frame[1]!.replace(/^file:\/\//, '');
  if (resolve(worktree, location) !== resolve(worktree, test.file)) return 'no';
  const parsed = ts.createSourceFile(test.file, source, ts.ScriptTarget.Latest, true);
  const line = Number(frame[2]) - 1;
  const column = Number(frame[3]) - 1;
  const starts = parsed.getLineStarts();
  if (line < 0 || line >= starts.length || column < 0 || starts[line]! + column >= (starts[line + 1] ?? source.length)) return 'unknown';
  const offset = parsed.getPositionOfLineAndCharacter(line, column);
  const tests = new Set<string>();
  const expects = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !['bun:test', 'vitest', '@playwright/test'].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      const name = binding.propertyName?.text ?? binding.name.text;
      if (name === 'test' || name === 'it') tests.add(binding.name.text);
      if (name === 'expect') expects.add(binding.name.text);
    }
  }
  let reached = false;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(parsed) || offset >= node.end) return;
    if (ts.isCallExpression(node) && expects.has(rootName(node.expression) ?? '')) {
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
      reached ||= !!parent && ts.isCallExpression(parent.parent)
        && testRegistration(parent.parent.expression, tests)
        && parent.parent.arguments.includes(parent as ts.Expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return reached && /expect\(|AssertionError|Expected:|Received:/.test(test.detail ?? '') ? 'yes' : 'no';
}

/** Both landing admission and refusal routing consume this evidence, pinned to the tested head. */
export function reviewProof(worktree: string, files: string[], head: string, directory: string): ReviewProof {
  const proof: ReviewProof = { head, results: Object.fromEntries(files.map(file => [file, 'unavailable'])), failures: [] };
  const cases = new Map<string, TestResult[]>();
  try {
    const result = JSON.parse(readFileSync(join(directory, 'test-result.json'), 'utf8')) as { artifactPaths: string[] };
    for (const artifact of result.artifactPaths) {
      const report = JSON.parse(readFileSync(join(artifact, 'acceptance.json'), 'utf8')) as {
        sourceStable: boolean; source?: { head: string }; tests: TestResult[];
      };
      if (!report.sourceStable || report.source?.head !== head) continue;
      for (const test of report.tests) if (files.includes(test.file)) cases.set(test.file, [...cases.get(test.file) ?? [], test]);
    }
    for (const [file, tests] of cases) {
      const source = readFileSync(join(worktree, file), 'utf8');
      const failed = tests.filter(test => test.failed && !test.skipped).map(test => ({ file, name: test.name,
        detail: [test.detail, test.stack].filter(Boolean).join('\n'), assertionReached: assertionReached(test, source, worktree) }));
      proof.failures.push(...failed);
      proof.results[file] = failed.some(test => test.assertionReached === 'yes') ? 'failed'
        : failed.some(test => test.assertionReached === 'no') ? 'setup-failed'
          : tests.every(test => !test.failed && !test.skipped) ? 'passed' : 'unavailable';
    }
  } catch { /* Incomplete evidence is unconfirmed, never a worker defect. */ }
  return proof;
}
