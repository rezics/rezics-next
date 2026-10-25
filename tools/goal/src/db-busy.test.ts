import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';

test(
  'opening the store waits for a writer that holds the lock longer than five seconds',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-db-busy-'));
    const databasePath = join(directory, 'goal.db');
    const lockPath = join(directory, 'writer-has-lock');
    const initialDb = openDb(databasePath);
    initialDb.exec('CREATE TABLE entries (value TEXT NOT NULL)');
    initialDb.close();

    const writer = spawn(
      process.execPath,
      [
        '-e',
        `
          import { Database } from 'bun:sqlite';
          import { writeFileSync } from 'node:fs';
          const db = new Database(${JSON.stringify(databasePath)});
          db.exec('BEGIN IMMEDIATE');
          db.query('INSERT INTO entries (value) VALUES (?)').run('writer');
          writeFileSync(${JSON.stringify(lockPath)}, 'locked');
          setTimeout(() => {
            db.exec('COMMIT');
            db.close();
          }, 6000);
        `,
      ],
      { stdio: 'inherit' },
    );

    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(lockPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(lockPath)).toBe(true);

      const db = openDb(databasePath);
      db.query('INSERT INTO entries (value) VALUES (?)').run('opener');
      db.close();

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        writer.once('error', reject);
        writer.once('exit', (code) => resolve(code));
      });
      expect(exitCode).toBe(0);

      const verifyDb = openDb(databasePath);
      const rows = verifyDb.query('SELECT value FROM entries ORDER BY value').all() as { value: string }[];
      verifyDb.close();
      expect(rows.map(({ value }) => value)).toEqual(['opener', 'writer']);
    } finally {
      writer.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
