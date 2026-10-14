import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareComposeFileMounts } from './compose-mounts.ts';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function mode(path: string): number { return statSync(path).mode & 0o777; }

test('Compose file binds from a restrictive checkout are readable by container users', () => {
  mkdirSync('.temp', { recursive: true });
  const scratch = mkdtempSync(resolve('.temp/compose-mounts-'));
  const previous = process.umask(0o077);
  try {
    const source = join(scratch, 'source');
    const checkout = join(scratch, 'checkout');
    mkdirSync(source);
    writeFileSync(join(source, 'compose.yaml'), `services:
  storage:
    image: postgres:18
    volumes:
      - ./owners.sh:/docker-entrypoint-initdb.d/owners.sh:ro
      - ./config.json:/etc/config.json:ro
      - data:/data
volumes:
  data:
`);
    writeFileSync(join(source, 'overlay.yaml'), `services:
  storage:
    volumes:
      - type: bind
        source: ./assembler.ttl
        target: /etc/assembler.ttl
        read_only: true
      - ./bootstrap:/etc/bootstrap:ro
      - ./directory:/etc/directory:ro
`);
    writeFileSync(join(source, 'owners.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(source, 'bootstrap'), '#!/usr/bin/env python3\n', { mode: 0o755 });
    for (const name of ['config.json', 'assembler.ttl', 'unrelated']) writeFileSync(join(source, name), name);
    git(source, 'init', '--quiet');
    git(source, 'add', '.');
    git(source, '-c', 'user.name=Compose test', '-c', 'user.email=compose@example.test', 'commit', '--quiet', '-m', 'fixture');
    git(scratch, 'clone', '--quiet', source, checkout);
    mkdirSync(join(checkout, 'directory'));
    expect(mode(join(checkout, 'owners.sh'))).toBe(0o700);
    expect(mode(join(checkout, 'config.json'))).toBe(0o600);
    const args = ['compose', '-f', join(checkout, 'compose.yaml'), '-f', join(checkout, 'overlay.yaml'),
      '--project-name', 'mount-permissions-test', 'up', '-d', '--wait'];
    prepareComposeFileMounts(checkout, [...args.slice(0, -4), 'config'], process.env);
    expect(mode(join(checkout, 'config.json'))).toBe(0o600);
    prepareComposeFileMounts(checkout, args, process.env);
    for (const name of ['owners.sh', 'bootstrap']) expect(mode(join(checkout, name))).toBe(0o755);
    for (const name of ['config.json', 'assembler.ttl']) {
      expect(mode(join(checkout, name))).toBe(0o644);
      expect(readFileSync(join(checkout, name), 'utf8')).toBe(name);
    }
    expect(mode(join(checkout, 'unrelated'))).toBe(0o600);
    expect(mode(join(checkout, 'directory'))).toBe(0o700);
    prepareComposeFileMounts(checkout, args, process.env);
    expect(mode(join(checkout, 'config.json'))).toBe(0o644);
  } finally {
    process.umask(previous);
    rmSync(scratch, { recursive: true, force: true });
  }
});
