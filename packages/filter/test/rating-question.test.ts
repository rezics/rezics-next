import { describe, expect, test } from 'bun:test';
import {
  admitDiscoveryFilter,
  admitFilter,
  FilterError,
  parseDiscoveryFilter,
  parseFilter,
  type FilterDocument,
  type FilterRelease,
} from '../src/index.ts';

const id = '00000000-0000-8000-8000-000000000001';
const leaf = { ratingQuestion: { id } };
const kinds = new Set(['core:Work']);
const release: FilterRelease = { types: { 'core:Work': {} }, properties: {} };

describe('request-only exact rating question grammar', () => {
  test('retains Boolean polarity and copies the exact identity without caller revision or authority', () => {
    const question = { ratingQuestion: { id } };
    const request = { or: [{ kind: { in: ['core:Work'] } }, { not: question }] };
    const admitted = admitDiscoveryFilter(parseDiscoveryFilter(request), release, kinds);
    expect(admitted).toEqual(request);
    expect(admitted).not.toBe(request);
    request.or[0] = { kind: { in: [] } };
    question.ratingQuestion.id = '00000000-0000-8000-8000-000000000002';
    expect(admitted).toEqual({
      or: [{ kind: { in: ['core:Work'] } }, { not: { ratingQuestion: { id } } }],
    });
  });

  test('rejects extra operands, non UUID identities, absent and accessor fields without invoking them', () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, 'id', {
      get() {
        invoked = true;
        return id;
      },
    });
    for (const ratingQuestion of [
      {},
      { id: null },
      { id: [id] },
      { id: '' },
      { id: `${id}\n` },
      { id, revision: '1' },
      { id, allow: true },
      { id, questionId: id },
      accessor,
      Object.create({ id }),
    ])
      expect(() => parseDiscoveryFilter({ ratingQuestion })).toThrow(FilterError);
    expect(invoked).toBe(false);
  });

  test('never enters a stored catalogue or saved filter, including under NOT and OR', () => {
    for (const tree of [leaf, { not: leaf }, { or: [{ type: { in: ['core:Work'] } }, leaf] }]) {
      expect(() => parseFilter(tree)).toThrow(FilterError);
      expect(() => admitFilter(tree as FilterDocument, release)).toThrow(FilterError);
    }
    for (const tree of [leaf, { not: leaf }, { or: [{ type: { in: ['core:Work'] } }, leaf] }]) {
      const savedRelease = { ...release, filters: { 'home/question': { filter: tree } } };
      expect(() => admitDiscoveryFilter(parseDiscoveryFilter({ saved: 'home/question' }), savedRelease, kinds)).toThrow(
        FilterError,
      );
    }
  });

  test('charges duplicate question leaves and enforces whole tree Boolean bounds before deduplication', () => {
    const maximum = { and: Array.from({ length: 32 }, () => leaf) };
    expect(admitDiscoveryFilter(parseDiscoveryFilter(maximum), release, kinds)).toEqual(maximum);
    expect(() => parseDiscoveryFilter({ and: [...maximum.and, leaf] })).toThrow(FilterError);
    expect(() => parseDiscoveryFilter({ or: Array.from({ length: 17 }, () => leaf) })).toThrow(FilterError);
    expect(() => parseDiscoveryFilter({ not: { not: leaf } })).toThrow(FilterError);
    const deep = { and: [{ and: [{ and: [{ and: [{ and: [leaf] }] }] }] }] };
    expect(() => parseDiscoveryFilter(deep)).toThrow(FilterError);
  });
});
