import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { nativeModuleTestInvocation } from '../../../scripts/dev/fuseki-image.ts';

const root = resolve(import.meta.dir, '../../..');
const focused = Bun.env.REZICS_NATIVE_TEST_CLASSES
  ?? (Bun.env.REZICS_NATIVE_FULL_SUITE === '1' ? undefined : 'PrefixWalkTest');

test(focused ? `the image Maven invocation verifies ${focused}`
  : 'the native prefix projection and complete image Maven suite share one source pin', () => {
  if (focused && !/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/u.test(focused))
    throw new Error('invalid native test class selection');
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const build = mkdtempSync(join(temporary, 'prefix-walk-native-'));
  const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
  const image = /^FROM (\S+) AS module$/m.exec(dockerfile)?.[1];
  if (!image) throw new Error('missing pinned native builder');
  const stage = dockerfile.split(/\nFROM /, 1)[0]!;
  const invocation = nativeModuleTestInvocation(dockerfile);
  const environment = ['MAVEN_OPTS', 'JAVA_TOOL_OPTIONS'].map(name => {
    const value = new RegExp(`^ENV ${name}="([^"\\n]*)"$`, 'm').exec(stage)?.[1];
    if (!value) throw new Error(`missing native builder ${name}`);
    return ['--env', `${name}=${value}`];
  }).flat();
  const cache = join(temporary, 'native-visit-profile-maven-cache');
  mkdirSync(cache, { recursive: true });
  try {
    for (const line of stage.split('\n').filter(line => line.startsWith('COPY '))) {
      const copy = /^COPY (\S+) \/build\/(\S+)$/u.exec(line);
      if (!copy) throw new Error(`unsupported native module COPY: ${line}`);
      const destination = join(build, copy[2]!);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, copy[1]!), destination, { recursive: true });
    }
    mkdirSync(join(build, 'tmp'));
    // One retained native test resolves ../../../.temp from /build. Keep that
    // fixture under this worktree too when the builder runs as the host user.
    mkdirSync(join(build, 'root-temp'));
    const result = spawnSync('docker', [
      'run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--volume', `${build}:/build`, '--volume', `${cache}:/maven-cache`,
      '--volume', `${join(build, 'root-temp')}:/.temp`,
      '--env', 'MAVEN_CONFIG=/maven-cache', ...environment, '--workdir', '/build', image,
      'mvn', ...invocation.split(' '), '-Dmaven.repo.local=/maven-cache',
      ...(focused ? [`-Dtest=${focused}`] : []), 'package',
    ], { cwd: root, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 8 * 1024 * 1024 });
    const evidence = join(root, '.temp/goal/prefix-walk-native', focused ? `focused-${focused}` : '');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'maven.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    const reports = join(build, 'target/surefire-reports');
    try { cpSync(reports, join(evidence, 'surefire-reports'), { recursive: true }); } catch { /* Compilation may fail before tests. */ }
    if (result.status !== 0)
      throw new Error(`native suite failed (${result.status}); see ${evidence.slice(root.length + 1)}/maven.log\n`
        + `${result.stdout?.slice(-8000)}\n${result.stderr?.slice(-1000)}`);
    for (const name of focused?.split(',') ?? ['PrefixWalkTest'])
      expect(readdirSync(reports)).toContain(`TEST-com.rezics.jena.${name}.xml`);
    expect(result.stdout).toContain('BUILD SUCCESS');
    expect(result.stdout).toMatch(/Tests run: [1-9][0-9]*, Failures: 0, Errors: 0/);
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}, 1_240_000);
