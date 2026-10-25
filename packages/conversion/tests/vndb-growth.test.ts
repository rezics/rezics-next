import { expect, spyOn, test } from 'bun:test';
import * as bun from 'bun';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ConversionError } from '../src/index.ts';
import { converter_revision, convertVndb, vndbLimits } from '../src/vndb.ts';

const context = { subjectId: '00000000-0000-4000-8000-000000000001' };
// One seed grows actual permitted title fields; unknown catalogue/history state is inaccessible.
function seed(fields: number, title = 'Harbor') {
  const record = {
    vn: { id: 'v123', olang: 'en' },
    entry_meta: { id: 'v123', revision: 7 },
    vn_titles: Array.from({ length: fields }, (_, i) => ({
      id: 'v123',
      lang: `en-x-t${i}`,
      official: true,
      title: `${title} ${i}`,
      latin: null,
    })),
  };
  let visits = 0;
  const count = (value: object): object =>
    new Proxy(value, {
      getOwnPropertyDescriptor(target, key) {
        visits++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  const measured = {
    ...record,
    vn: count(record.vn),
    entry_meta: count(record.entry_meta),
    vn_titles: record.vn_titles.map(count),
  };
  return {
    input: { external_id: 'v123', record_revision: '7', record: measured },
    record,
    bytes: Buffer.byteLength(JSON.stringify(record)),
    visits: () => visits,
  };
}

test('pure converter growth stays within its declared field and byte cap', () => {
  const measurements = [1, 8, 64].map((fields) => {
    const generated = seed(fields);
    const output = convertVndb(generated.input, context);
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
    expect(output.proposals).toHaveLength(fields + 1);
    expect(output.assets).toEqual([]);
    expect(generated.visits()).toBeGreaterThanOrEqual(fields * 5);
    expect(generated.visits()).toBeLessThanOrEqual(40 + fields * 12);
    expect(generated.bytes).toBeLessThan(vndbLimits.recordBytes);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(4096 + fields * 4096);
    return { fields, visits: generated.visits(), bytes: generated.bytes };
  });
  for (let i = 1; i < measurements.length; i++) {
    const smaller = measurements[i - 1]!;
    const larger = measurements[i]!;
    expect(larger.bytes).toBeGreaterThan(smaller.bytes);
    expect(larger.visits).toBeGreaterThan(smaller.visits);
    expect(larger.visits).toBeLessThanOrEqual(smaller.visits * (larger.fields / smaller.fields) + 40);
  }
  expect(vndbLimits.maxTitles).toBe(64);
  expect(() => convertVndb(seed(vndbLimits.maxTitles + 1).input, context)).toThrow(ConversionError);
  expect(() => convertVndb(seed(1, 'x'.repeat(vndbLimits.stringBytes + 1)).input, context)).toThrow(ConversionError);
  expect(() => convertVndb(seed(64, 'x'.repeat(2048)).input, context)).toThrow(ConversionError);
});

test('fixed conversion performs zero SQL network or file I/O across unrelated populations', () => {
  const calls: string[] = [];
  const deny = (name: string) => () => {
    calls.push(name);
    throw new Error('Unexpected I/O');
  };
  const watches = [
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(deny('fetch'), { preconnect: fetch.preconnect })),
    spyOn(net, 'connect').mockImplementation(deny('net.connect')),
    spyOn(net.Socket.prototype, 'connect').mockImplementation(deny('Socket.connect')),
    spyOn(http, 'request').mockImplementation(deny('http.request')),
    spyOn(https, 'request').mockImplementation(deny('https.request')),
    // SQL is construct-only in its declarations; Bun's spy types require a callable surface.
    spyOn(bun as unknown as { SQL: (...args: unknown[]) => unknown }, 'SQL').mockImplementation(deny('SQL')),
    spyOn(Bun, 'file').mockImplementation(deny('Bun.file')),
    spyOn(Bun, 'write').mockImplementation(deny('Bun.write')),
    spyOn(fs, 'readFileSync').mockImplementation(deny('readFileSync')),
    spyOn(fs, 'writeFileSync').mockImplementation(deny('writeFileSync')),
  ];
  try {
    const fixed = seed(8);
    const baseline = convertVndb(fixed.input, context);
    for (const n of [1, 8, 64]) {
      const polluted = {
        ...fixed.input,
        record: {
          ...fixed.record,
          catalogue: Array.from({ length: n }, () => ({ private: 'PRIVATE_SENTINEL' })),
          history: Array.from({ length: n * n }, () => 'PRIVATE_SENTINEL'),
        },
      };
      expect(convertVndb(polluted, context)).toEqual(baseline);
    }
    expect(calls).toEqual([]);
  } finally {
    for (const watch of watches) watch.mockRestore();
  }
});

test('source scalars determine digest while native bindings and trusted registration do not', () => {
  const generated = seed(8);
  const first = convertVndb(generated.input, context);
  expect(convertVndb(generated.input, context)).toEqual(first);
  expect(convertVndb(seed(8, 'Changed').input, context).digest).not.toBe(first.digest);
  const bootstrap = convertVndb(generated.input);
  expect(bootstrap.digest).toBe(first.digest);
  expect(bootstrap.proposals).toHaveLength(1);
  const registered = convertVndb(generated.input, context, { converterRevision: 'registered-next' });
  expect(registered.digest).toBe(first.digest);
  expect(registered.converter_revision).toBe('registered-next');
  expect(first.converter_revision).toBe(converter_revision);
  expect(registered.proposals.map((command) => command.key)).not.toEqual(first.proposals.map((command) => command.key));
  const rebound = convertVndb(
    { external_id: first.external_id, record_revision: first.record_revision, record: first.normalizedRecord },
    context,
  );
  expect(rebound).toEqual(first);
});

test('invalid grouped rows fail safely and ignored private accessors are never read', () => {
  const generated = seed(1);
  const record = generated.record;
  Object.defineProperty(record, 'reviews', {
    get() {
      throw new Error('PRIVATE_SENTINEL');
    },
  });
  expect(() => convertVndb({ ...generated.input, record }, context)).not.toThrow();
  for (const changed of [
    { ...record, entry_meta: undefined },
    { ...record, vn_titles: [{ ...record.vn_titles[0], id: 'v999' }] },
    { ...record, vn_titles: [{ ...record.vn_titles[0], official: 'yes' }] },
    { ...record, vn_titles: [{ ...record.vn_titles[0], title: '\ud800PRIVATE_SENTINEL' }] },
  ]) {
    try {
      convertVndb({ ...generated.input, record: changed }, context);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionError);
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
    }
  }
});
