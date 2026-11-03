import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import pinned from '../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json';
import { convertBangumi, converter_revision } from '../src/bangumi.ts';
import { bangumiPublicTagScheme, reviewedReferenceKey } from '../src/support.ts';
const source = '00000000-0000-4000-8000-000000000001';
const canonical = '00000000-0000-4000-8000-000000000002';
const subjectId = '00000000-0000-4000-8000-000000000003';
const key = reviewedReferenceKey(bangumiPublicTagScheme, '后宫');
const context = { subjectId, resolvedReferences: { [key]: source } };
const input = (record: unknown) => ({ external_id: '498', record_revision: null, record });
function keywords(record: unknown, bindings = context) {
  return convertBangumi(input(record), bindings).proposals.filter(
    (c) => c.op === 'propose' && c.statement.property.id === 'schema:keywords',
  );
}
test('actual pinned public meta_tags emit the trusted source Concept with its required qualifier and data-only digest', () => {
  const conversion = convertBangumi(input(pinned), context);
  expect(converter_revision).toBe('bangumi@5');
  expect(key).toBe('v1:["https://rezics.com/schemes/bangumi/public-tags","后宫"]');
  expect(key.length).toBe(58);
  expect(Buffer.byteLength(key)).toBe(62);
  expect(checkBatchWrite({ commands: conversion.proposals })).toEqual([]);
  expect(keywords(pinned)).toHaveLength(1);
  expect(keywords(pinned)[0]).toMatchObject({
    statement: {
      value: { content: source },
      qualifiers: [{ property: { id: 'rezics:spoilerLevel' }, value: { content: { amount: '0', unit: '1' } } }],
    },
    source: { record_revision: 'unversioned', field_group: 'facts' },
  });
  expect(JSON.stringify(conversion.proposals)).not.toContain(canonical);
  expect(
    conversion.proposals.some(
      (c) => c.op === 'propose' && ['wdt:P7937', 'schema:wordCount'].includes(c.statement.property.id),
    ),
  ).toBe(false);
  expect(conversion.digest).toBe(convertBangumi(input(pinned)).digest);
  expect(convertBangumi(input({ ...pinned, meta_tags: [...pinned.meta_tags].reverse() })).digest).not.toBe(
    conversion.digest,
  );
});
test('missing withheld empty ordinary private and inexact tags never substitute a public reviewed member', () => {
  expect(keywords(pinned, { subjectId, resolvedReferences: {} })).toEqual([]);
  for (const meta_tags of [undefined, [], ['後宮'], [' 后宫'], ['后宫 ']]) {
    const { meta_tags: _, ...base } = pinned;
    expect(
      keywords({
        ...base,
        ...(meta_tags ? { meta_tags } : {}),
        tags: [{ name: '后宫' }],
        privateCollectionLabels: ['后宫'],
        platform: '后宫',
      }),
    ).toEqual([]);
  }
});
test('public meta_tags normalization is bounded and descriptor safe; identity-only types never inspect it', () => {
  expect(() => convertBangumi(input({ ...pinned, meta_tags: Array(65).fill('后宫') }), context)).toThrow();
  expect(() => convertBangumi(input({ ...pinned, meta_tags: ['x'.repeat(201)] }), context)).toThrow();
  let reads = 0;
  const record = { ...pinned };
  Object.defineProperty(record, 'meta_tags', {
    get() {
      reads++;
      throw new Error('getter');
    },
  });
  expect(() => convertBangumi(input(record), context)).toThrow();
  expect(reads).toBe(0);
  for (const type of [3, 6]) {
    const ignored = { id: pinned.id, type };
    Object.defineProperty(ignored, 'meta_tags', {
      get() {
        reads++;
        throw new Error('ignored');
      },
    });
    expect(convertBangumi(input(ignored)).proposals).toEqual([]);
  }
  expect(reads).toBe(0);
});
