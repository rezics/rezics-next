import { expect, test, spyOn } from 'bun:test';
import { checkDocument, documentText, serializeDocument } from '@rezics/document';
import { sourceEnvelope, sourceDigest, commandKey, safeSourceUrl, textDocument } from '../src/support.ts';
const meta = {
  source: 'bangumi',
  external_id: '12',
  record_revision: null,
  converter_revision: 'bangumi@1',
  digest: 'a'.repeat(64),
};

test('source provenance keeps exact revisions and uses unversioned only for absence', () => {
  expect(sourceEnvelope(meta, 'facts')).toEqual({ ...meta, record_revision: 'unversioned', field_group: 'facts' });
  expect(sourceEnvelope({ ...meta, record_revision: '0' }, 'summary').record_revision).toBe('0');
  expect(sourceEnvelope({ ...meta, record_revision: 'archive:2026-10-25:17' }, 'cover').record_revision).toBe(
    'archive:2026-10-25:17',
  );
  for (const invalid of [
    { ...meta, digest: 'bad' },
    { ...meta, source: '../bad' },
    { ...meta, external_id: '' },
    { ...meta, record_revision: '' },
  ])
    expect(() => sourceEnvelope(invalid, 'facts')).toThrow();
});

test('source digests and command keys are canonical deterministic and input sensitive', () => {
  const a = { id: 12, name: '星', title: { en: 'A', ja: 'あ' } };
  const before = structuredClone(a);
  Object.freeze(a.title);
  Object.freeze(a);
  expect(sourceDigest(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(sourceDigest(a)).toBe(sourceDigest({ title: { ja: 'あ', en: 'A' }, name: '星', id: 12 }));
  expect(sourceDigest(a)).not.toBe(sourceDigest({ ...a, name: '月' }));
  expect(a).toEqual(before);
  const key = commandKey(['bangumi', '12', sourceDigest(a), 'bangumi@1', 'facts']);
  expect(key).toMatch(/^[\x20-\x7e]{1,255}$/);
  expect(key).toBe(commandKey(['bangumi', '12', sourceDigest(a), 'bangumi@1', 'facts']));
  expect(commandKey(['a\nb', 'c'])).not.toBe(commandKey(['a', 'b\nc']));
  expect(commandKey(['bangumi', '12', sourceDigest(a), 'bangumi@2', 'facts'])).not.toBe(key);
  for (const value of [undefined, NaN, Infinity, { bad: undefined }, new Date()])
    expect(() => sourceDigest(value)).toThrow();
  const circular: any = {};
  circular.self = circular;
  expect(() => sourceDigest(circular)).toThrow();
});

test('source URLs and text documents remain bounded without ambient I/O', () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new Error('unexpected fetch');
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    expect(safeSourceUrl('https://lain.bgm.tv/pic/cover/l/12.jpg', ['lain.bgm.tv'])).toBe(
      'https://lain.bgm.tv/pic/cover/l/12.jpg',
    );
    for (const url of [
      'javascript:alert(1)',
      'http://127.0.0.1/x',
      'https://lain.bgm.tv.evil.test/x',
      'https://u:p@lain.bgm.tv/x',
      'https://lain.bgm.tv:8443/x',
      'https://lain.bgm.tv/x\r\nX:bad',
    ])
      expect(() => safeSourceUrl(url, ['lain.bgm.tv'])).toThrow();
    const raw = 'Line one\n\n**literal**, not interpreted. 🌙';
    const doc = textDocument(raw);
    expect(checkDocument(doc)).toBe(true);
    expect(documentText(doc)).toBe(raw);
    expect(textDocument(raw)).toEqual(doc);
    expect(new TextEncoder().encode(serializeDocument(doc)).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(() => textDocument('x'.repeat(33 * 1024))).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test('bounded field growth visits real descriptors and bytes once with fixed hash sizes', () => {
  const seed = '星🌙literal source field'.repeat(8);
  const seedBytes = new TextEncoder().encode(seed).byteLength;
  for (const fields of [1, 8, 64]) {
    const record = Object.fromEntries(Array.from({ length: fields }, (_, i) => [`field_${i}`, seed]));
    let visits = 0;
    let bytes = 0;
    const measured = new Proxy(record, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor && typeof descriptor.value === 'string') {
          visits++;
          bytes += new TextEncoder().encode(descriptor.value).byteLength;
        }
        return descriptor;
      },
    });
    const digest = sourceDigest(measured);
    expect(visits).toBe(fields);
    expect(bytes).toBe(fields * seedBytes);
    expect(digest).toBe(sourceDigest(record));
    expect(digest).toHaveLength(64);
    expect(commandKey(['bangumi', '12', digest, 'bangumi@1', 'facts'])).toHaveLength(64);
  }
});

test('JSON validation rejects silent coercion and never invokes accessors', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const customArray = Object.setPrototypeOf([], { custom: true });
  const invalid = [
    accessor,
    customArray,
    { value: () => 1 },
    { value: 1n },
    { value: Symbol() },
    Object.create({ inherited: true }),
    Object.defineProperty({}, 'hidden', { value: 1 }),
    { [Symbol('hidden')]: 1 },
    [, 1],
    Object.assign([], { extra: 1 }),
    '\ud800',
    { '\udfff': 1 },
  ];
  for (const value of invalid) expect(() => sourceDigest(value)).toThrow();
  expect(reads).toBe(0);
  const shared = { value: 'same' };
  expect(sourceDigest([shared, shared])).toBe(sourceDigest([{ value: 'same' }, { value: 'same' }]));
  expect(sourceDigest(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(sourceDigest({}));
  expect(sourceDigest({ value: -0 })).toBe(sourceDigest({ value: 0 }));
  expect(sourceDigest({ b: 1, a: 1e30 })).toBe(
    new Bun.CryptoHasher('sha256').update('{"a":1e+30,"b":1}').digest('hex'),
  );
});

test('envelopes enforce portable bounds and only copy owned schema fields', () => {
  expect(sourceEnvelope({ ...meta, extra: true } as typeof meta, 'facts')).not.toHaveProperty('extra');
  for (const changes of [
    { source: 'x'.repeat(33) },
    { source: 'bangumi\n' },
    { digest: 'a'.repeat(64) + '\n' },
    { external_id: 'x'.repeat(256) },
    { record_revision: 'x'.repeat(65) },
    { converter_revision: '' },
    { converter_revision: 'x'.repeat(65) },
    { record_revision: undefined },
  ]) {
    expect(() => sourceEnvelope({ ...meta, ...changes } as typeof meta, 'facts')).toThrow();
  }
  expect(() => sourceEnvelope(meta, 'unknown' as 'facts')).toThrow();
});

test('URL and document boundaries preserve literal input', () => {
  for (const url of [
    'https://lain.bgm.tv:443/x',
    'https://lain.bgm.tv/x\t',
    ' https://lain.bgm.tv/x',
    'https://lain.bgm.tv\\@evil.test/x',
    `https://lain.bgm.tv/${'x'.repeat(2048)}`,
    null,
  ]) {
    expect(() => safeSourceUrl(url, ['lain.bgm.tv'])).toThrow();
  }
  for (const text of ['', '\n', 'a\r\nb\rc\n', '<b>literal</b>\u0000']) {
    const doc = textDocument(text);
    expect(doc.profile).toBe('text');
    expect(checkDocument(doc)).toBe(true);
    expect(documentText(doc)).toBe(text);
    expect(textDocument(text)).toEqual(doc);
  }
  for (const text of ['\ud800', '🌙'.repeat(9000), '"'.repeat(17000), null]) {
    expect(() => textDocument(text as string)).toThrow();
  }
  expect(() => commandKey(['valid', undefined] as unknown as string[])).toThrow();
});
