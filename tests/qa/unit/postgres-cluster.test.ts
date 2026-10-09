import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { processRunning } from '../support/process-liveness.ts';

function pidsUsing(dataDirectory: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(join('/proc', entry, 'cmdline')).includes(dataDirectory)) found.push(Number(entry));
    } catch { /* the process exited or is not readable */ }
  }
  return found.filter(pid => processRunning(pid));
}

test('a failure after initdb leaves no directory', async () => {
  let directory = '';
  await expect(startPostgresCluster({}, {
    afterInitdb(created) {
      directory = created.directory;
      expect(existsSync(created.dataDirectory)).toBe(true);
      throw new Error('injected after initdb');
    },
  })).rejects.toThrow('injected after initdb');
  expect(directory).not.toBe('');
  expect(existsSync(directory)).toBe(false);
});

test('a failure after start leaves no postgres process and no directory', async () => {
  let directory = '';
  let dataDirectory = '';
  let pid = 0;
  await expect(startPostgresCluster({}, {
    afterStart(started) {
      directory = started.directory;
      dataDirectory = started.dataDirectory;
      pid = Number(readFileSync(join(started.dataDirectory, 'postmaster.pid'), 'utf8').split('\n')[0]);
      expect(processRunning(pid)).toBe(true);
      throw new Error('injected after start');
    },
  })).rejects.toThrow('injected after start');
  expect(existsSync(directory)).toBe(false);
  expect(existsSync(dataDirectory)).toBe(false);
  expect(processRunning(pid)).toBe(false);
  expect(pidsUsing(dataDirectory)).toEqual([]);
});
