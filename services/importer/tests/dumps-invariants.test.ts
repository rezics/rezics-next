import { expect, test } from 'bun:test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { createImportDumpsDriver } from './dumps-driver';
import { readDump } from '../src/dumps';

test('boundary instrumentation records failed attempts and restores nested bindings safely', async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = fs.writeFileSync;
  const db = new Database(':memory:');
  const first = await createImportDumpsDriver();
  const second = await createImportDumpsDriver();
  try {
    expect(() => globalThis.fetch('https://invalid.example/')).toThrow();
    expect(() => fs.writeFileSync('.temp/should-never-be-written', 'blocked')).toThrow();
    expect(() => Bun.write('.temp/should-never-be-written', 'blocked')).toThrow();
    expect(() => Bun.file('.temp/should-never-be-written').writer()).toThrow();
    expect(() => db.exec('SELECT 1')).toThrow();
    expect(() => Bun.sql`SELECT 2`).toThrow();
    expect(() => new (require('bun:sqlite').Database)('.temp/should-never-be-written')).toThrow();
    const handle = await fsPromises.open(import.meta.filename, 'r');
    try { expect(() => handle.writeFile('blocked')).toThrow(); }
    finally { await handle.close(); }
    const effects = await first.effects();
    expect(effects.requests).toHaveLength(1);
    expect(effects.fileWrites).toHaveLength(4);
    expect(effects.sql).toHaveLength(3);
    expect(await second.effects()).toEqual(effects);
    await first.close();
    expect(() => fs.writeFileSync('.temp/should-never-be-written', 'blocked')).toThrow();
    expect((await first.effects()).fileWrites).toHaveLength(4);
    expect((await second.effects()).fileWrites).toHaveLength(5);
  } finally {
    await first.close();
    await second.close();
    db.close();
  }
  expect(globalThis.fetch).toBe(originalFetch);
  expect(fs.writeFileSync).toBe(originalWrite);
  expect(fs.existsSync('.temp/should-never-be-written')).toBe(false);
});

const encoder = new TextEncoder();
async function* input(text: string) { yield encoder.encode(text); }
async function collect(text: string) {
  const rows = [];
  for await (const row of readDump('vndb', input(text), { maxRecordBytes: 512 })) rows.push(row);
  return rows;
}

test('COPY octal and hex bytes decode correctly without interpreting SQL or object prototype columns', async () => {
  const rows = await collect('COPY public.vn (id, description, __proto__) FROM stdin;\nv1\t\\360\\237\\214\\231\\x09end\tvalue\n\\.\n');
  expect(rows[0]!.payload.description).toBe('🌙\tend');
  expect(Object.hasOwn(rows[0]!.payload, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(rows[0]!.payload)).toBe(Object.prototype);
  await expect(collect('COPY public.vn (id, description) FROM stdin;\nv1\t\\377\n\\.\n')).rejects.toBeInstanceOf(Error);
});

test('failure closes upstream, and interleaved dump iterators own independent duplicate state', async () => {
  let closed = false;
  async function* broken() {
    try { yield encoder.encode('{broken}\n'); throw new Error('Must not pull tail'); }
    finally { closed = true; }
  }
  await expect(readDump('bangumi', broken(), { maxRecordBytes: 64 }).next()).rejects.toThrow('Invalid');
  expect(closed).toBe(true);
  const text = '{"id":1,"type":2}\n';
  const left = readDump('bangumi', input(text + text), { maxRecordBytes: 64 });
  const right = readDump('bangumi', input(text), { maxRecordBytes: 64 });
  expect((await left.next()).value?.key).toBe('1');
  expect((await right.next()).value?.key).toBe('1');
  await expect(left.next()).rejects.toThrow('Duplicate');
  expect((await right.next()).done).toBe(true);
});
