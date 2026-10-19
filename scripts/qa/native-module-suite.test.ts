import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fusekiImageTag } from '../dev/fuseki-image.ts';
import { parseNativeModuleSuiteArgs, runNativeModuleSuite, validateNativeTestSelection } from './native-module-suite.ts';

const root = resolve(import.meta.dir, '../..');
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(exit = 0) {
  const scratch = join(root, '.temp/native-module-runner-tests');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'runner-'));
  roots.push(directory);
  mkdirSync(join(directory, 'infra/jena/command-module'), { recursive: true });
  writeFileSync(join(directory, 'infra/jena/Dockerfile'), 'ARG FUSEKI_VERSION=6.2.0\nCOPY infra/jena/command-module/pom.xml /build/pom.xml\n');
  writeFileSync(join(directory, 'infra/jena/command-module/pom.xml'), '<artifactId>fuseki-command</artifactId><version>0.1.0</version>');
  const docker = join(directory, 'docker');
  writeFileSync(docker, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\nconsole.log('Tests run: 1, Failures: ${exit ? 1 : 0}, Errors: 0');\nprocess.exit(${exit});\n`, { mode: 0o755 });
  return { directory, docker };
}

function records(directory: string) {
  const logs = join(directory, '.temp/native-module-suite');
  return readdirSync(logs).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(logs, file), 'utf8')));
}

test('the default command retains the complete module-test target and records a full-suite result', async () => {
  const f = fixture();
  expect(parseNativeModuleSuiteArgs([])).toEqual({});
  await runNativeModuleSuite(f.directory, { docker: f.docker });
  const [record] = records(f.directory);
  expect(record.command).toEqual([f.docker, 'build', '--progress', 'plain', '--target', 'module-test',
    '--file', join(f.directory, 'infra/jena/Dockerfile'), f.directory]);
  expect(JSON.parse(readFileSync(record.log, 'utf8').split('\n')[0]!)).toEqual(record.command.slice(1));
  expect(record).toMatchObject({ selection: null, scope: 'full', result: 'passed', budgetMs: 45 * 60_000, error: null,
    source: { root: f.directory, revision: null, status: null, inputTag: fusekiImageTag(f.directory) } });
  expect(Date.parse(record.finishedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt));
});

test.each(['RequestReadBoundaryTest', 'com.rezics.jena.RequestReadBoundaryTest#clientCancellationReleasesNativeExecutionWithinGrace',
  'RequestReadBoundaryTest#first+second,ConsistentReadCaptureTest', 'Outer$Inner#method$Name'])(
  'an exact Surefire selector is one Docker build argument and has a separate locked cache: %s', async selection => {
    const f = fixture();
    expect(parseNativeModuleSuiteArgs(['--tests', selection])).toEqual({ tests: selection });
    await runNativeModuleSuite(f.directory, { docker: f.docker, tests: selection });
    const [record] = records(f.directory);
    expect(record.command).toContain(`NATIVE_TEST_SELECTION=${selection}`);
    expect(record.command).toContain(`NATIVE_TEST_CACHE_ID=rezics-native-test-files-selected-${createHash('sha256').update(selection).digest('hex')}`);
    expect(record.command).not.toContain('NATIVE_TEST_CACHE_ID=rezics-native-test-files');
    expect(JSON.parse(readFileSync(record.log, 'utf8').split('\n')[0]!)).toEqual(record.command.slice(1));
    expect(record).toMatchObject({ selection, scope: 'selected', result: 'passed' });
  });

test.each(['', '-DskipTests', '--help', 'Test;touch /tmp/invalid', 'Test$(id)', '`id`', 'Test\n', 'Test\r\n',
  ' Test', 'Test Other', 'src/Test', 'Test\\Other', 'Test.java', 'Test.class#method', '*Test', 'Test#method*',
  '!Test', '%regex[.*]', '#method', 'Test#', 'Test#one+', 'Test#one#two', 'Test,,Other', 'com..Test', 'Test,',
  'Test#one|two', 'Test&Other', 'Test#one>file', 'Test#one\u0000', 'T'.repeat(4097)])(
  'invalid selectors are rejected before Docker starts: %j', selection => {
    expect(() => validateNativeTestSelection(selection)).toThrow('Invalid native test selection');
  });

test('flags and extra arguments cannot alter the Maven policy, and programmatic callers also validate', async () => {
  for (const args of [['--tests'], ['--tests=Test'], ['Test'], ['--tests', 'Test', '-DskipTests'], ['--help']]) {
    expect(() => parseNativeModuleSuiteArgs(args)).toThrow('usage: task jena:test');
  }
  const f = fixture();
  await expect(runNativeModuleSuite(f.directory, { docker: f.docker, tests: 'Test;exit 0' })).rejects.toThrow('Invalid native test selection');
  expect(existsSync(join(f.directory, '.temp/native-module-suite'))).toBe(false);
});

test('a selected Maven failure remains nonzero and keeps its selection, source, result and failure log', async () => {
  const f = fixture(23);
  const selection = 'RequestReadCaptureBoundaryTest#queryDisconnectLeavesHeldPublicationWithoutLaterWork';
  await expect(runNativeModuleSuite(f.directory, { docker: f.docker, tests: selection })).rejects.toThrow('Failures: 1');
  const [record] = records(f.directory);
  expect(record).toMatchObject({ selection, scope: 'selected', result: 'failed', error: 'Image command failed (exit 23)',
    source: { root: f.directory, inputTag: fusekiImageTag(f.directory) } });
  expect(readFileSync(record.log, 'utf8')).toContain('Tests run: 1, Failures: 1, Errors: 0');
  expect(record.finishedAt).toBeString();
});

test('Task forwards shell metacharacters as a single rejected selector and retains host admission', () => {
  const f = fixture();
  const bin = join(f.directory, 'bin');
  mkdirSync(bin);
  const captured = join(f.directory, 'arguments.json');
  const injected = join(f.directory, 'injected');
  writeFileSync(join(bin, 'bun'), `#!${process.execPath}\nawait Bun.write(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const selection = `Test; touch '${injected}'; $(touch '${injected}'); \`touch '${injected}'\``;
  const result = spawnSync('task', ['--taskfile', join(root, 'Taskfile.yml'), '--dir', f.directory,
    'jena:test', '--', '--tests', selection], { cwd: f.directory, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  expect(result.status).toBe(0);
  const args = JSON.parse(readFileSync(captured, 'utf8'));
  expect(args).toEqual(['scripts/qa/host-admission.ts', '--gib', '4', '--', 'bun', 'scripts/qa/native-module-suite.ts', '--tests', selection]);
  expect(() => parseNativeModuleSuiteArgs(args.slice(6))).toThrow('Invalid native test selection');
  expect(existsSync(injected)).toBe(false);
});
