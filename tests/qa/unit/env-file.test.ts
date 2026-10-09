import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { repository } from '../../../scripts/datasets/store.ts';
import { readEnv, serializeEnv } from '../../../scripts/dev/config.ts';

const scratch = join(repository, '.temp/env-file-tests');
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function envPath(name: string): string {
  mkdirSync(scratch, { recursive: true });
  return join(scratch, name);
}

/** The bytes after `=` on each assignment, which is what generated files store. */
function rawAssignments(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

function sameAssignments(path: string): void {
  const parsed = readEnv(path);
  const raw = rawAssignments(path);
  const left = Object.keys(parsed).sort().join('\0');
  const right = Object.keys(raw).sort().join('\0');
  if (left !== right) throw new Error(`${path} keys differ`);
  for (const key of Object.keys(raw)) {
    if (parsed[key] !== raw[key]) throw new Error(`${path} value changed for ${key}`);
  }
}

function envFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (name.endsWith('.env')) found.push(path);
    else if (name.startsWith('web-auth') && statSync(path).isDirectory()) {
      for (const child of readdirSync(path)) {
        if (child.endsWith('.env')) found.push(join(path, child));
      }
    }
  }
  return found;
}

test('environment files keep generated values, one quoting rule, and name a bad line', () => {
  const generated = envPath('generated.env');
  writeFileSync(
    generated,
    serializeEnv({
      MAIN_PORT: 3001,
      REZICS_FUSEKI_JVM_ARGS: '-Xms256m -Xmx2g',
      MAIN_RATE_LIMIT_BUDGETS: '{"anonymous":{"write":{"maximum":1000000,"seconds":60}}}',
      EMPTY: '',
      EQUALS: 'a=b',
    }),
  );
  expect(readEnv(generated)).toEqual({
    MAIN_PORT: '3001',
    REZICS_FUSEKI_JVM_ARGS: '-Xms256m -Xmx2g',
    MAIN_RATE_LIMIT_BUDGETS: '{"anonymous":{"write":{"maximum":1000000,"seconds":60}}}',
    EMPTY: '',
    EQUALS: 'a=b',
  });
  sameAssignments(generated);

  const quoted = envPath('quoted.env');
  const wrapped = "SINGLE='" + String.raw`a\'b` + "'";
  writeFileSync(
    quoted,
    [
      '# comment',
      '',
      'export QUOTED="a b"',
      wrapped,
      'PLAIN=hello # not a comment',
      'JSON={"a":"b"}',
      'CRLF=1',
    ].join('\r\n') + '\r\n',
  );
  expect(readEnv(quoted)).toEqual({
    QUOTED: 'a b',
    SINGLE: "a\\'b",
    PLAIN: 'hello # not a comment',
    JSON: '{"a":"b"}',
    CRLF: '1',
  });

  const broken = envPath('broken.env');
  writeFileSync(broken, 'OK=1\nNOT A LINE\nALSO=2\n');
  expect(() => readEnv(broken)).toThrow(`Invalid environment line ${broken}:2`);
  writeFileSync(broken, 'OPEN="unterminated\n');
  expect(() => readEnv(broken)).toThrow(`Invalid environment line ${broken}:1`);
  writeFileSync(broken, 'SPACED = 1\n');
  expect(() => readEnv(broken)).toThrow(`Invalid environment line ${broken}:1`);
});

test('current dev and QA environment files re-read to the same values', () => {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const stack = join(resolve(common, '..'), '.temp/stack');
  const dev = join(stack, 'rezics-dev');
  const qa = readdirSync(stack).filter(
    (name) => name.startsWith('rezics-qa-') && existsSync(join(stack, name, 'compose.env')),
  );
  expect(existsSync(join(dev, 'dev.env'))).toBe(true);
  expect(existsSync(join(dev, 'apps.env'))).toBe(true);
  expect(qa.length).toBeGreaterThan(0);
  expect(readEnv(join(dev, 'compose.env')).REZICS_STACK_PROFILE).toBe('dev');
  const qaProfile = qa.find(
    (name) => readEnv(join(stack, name, 'compose.env')).REZICS_STACK_PROFILE === 'qa',
  );
  expect(qaProfile).toBeTruthy();
  expect(existsSync(join(stack, qaProfile!, 'apps.env'))).toBe(true);

  const paths = [...envFiles(dev), ...qa.flatMap((name) => envFiles(join(stack, name)))];
  expect(paths.length).toBeGreaterThan(3);
  for (const path of paths) sameAssignments(path);
});
