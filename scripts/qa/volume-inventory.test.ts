import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseVolumeInventory, volumeInventoryScript } from './volume-inventory.ts';

test('batched custody inventory hashes every small file and retains exact sizes and paths', () => {
  const directory = mkdtempSync(resolve('.temp/volume-inventory-'));
  try {
    mkdirSync(join(directory, 'database'));
    const expected: Record<string, { sha256: string; bytes: number }> = {};
    for (let index = 0; index < 1200; index++) {
      const path = `database/relation ${index}`, body = index % 2 ? Buffer.from(`tuple ${index}`) : Buffer.alloc(0);
      writeFileSync(join(directory, path), body);
      expected[path] = { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
    }
    const result = Bun.spawnSync(['sh', '-ec', volumeInventoryScript], { cwd: directory });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(parseVolumeInventory(result.stdout.toString())).toEqual(expected);
    symlinkSync('relation 1', join(directory, 'database/link'));
    expect(Bun.spawnSync(['sh', '-ec', volumeInventoryScript], { cwd: directory }).exitCode).not.toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('custody refuses missing, repeated, malformed and traversal entries', () => {
  const hash = 'a'.repeat(64);
  for (const output of ['', `${hash}  ./file`, 'size 1 ./file',
    `${hash}  ./file\nsize 1 ./other`, `${hash}  ./../file\nsize 1 ./../file`,
    `${hash}  ./file\n${hash}  ./file\nsize 1 ./file`,
    `${hash}  ./file\nsize 1 ./file\nsize 1 ./file`,
    `${hash}  ./file\nsize 9007199254740992 ./file`]) {
    expect(() => parseVolumeInventory(output)).toThrow();
  }
});
