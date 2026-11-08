import { expect, test } from 'bun:test';
import { projectPublicationPresentations } from '../../src/community/publication-preparation.ts';
import type { CoverCredit, SubjectSummary } from '../../src/semantic/contract/index.ts';

const originalId = '0192f3a0-6c1e-7b2a-9d4e-000000000040';
const terminalId = '0192f3a0-6c1e-7b2a-9d4e-000000000041';
const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000042';

function summary(id: string, value: string): SubjectSummary {
  return {
    id,
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value, language: 'zh-Hant' },
    creativeWork: true,
    cover: null,
  };
}

class IndexedMap<Key, Value> extends Map<Key, Value> {
  reads = 0;

  override get(key: Key) {
    this.reads++;
    return super.get(key);
  }
}

test('selected presentation projection uses indexed original and terminal lookups at supplied populations 1, 10 and 20', () => {
  for (const population of [1, 10, 20]) {
    const sameSubject = population === 1;
    const terminal = sameSubject ? originalId : terminalId;
    const summaries = new IndexedMap<string, SubjectSummary | null>();
    const covers = new IndexedMap<string, 'available' | 'absent' | 'concealed'>();
    for (let index = 0; index < population; index++) {
      const id = index === 0 ? originalId : index === 1 ? terminalId : `unselected-${index}`;
      summaries.set(id, summary(id, `Selected ${index}`));
      covers.set(id, 'absent');
    }

    const result = projectPublicationPresentations(originalId, terminal, summaries, covers);

    expect(result.original.label).toEqual({ state: 'available', value: 'Selected 0', language: 'zh-Hant' });
    expect(result.original.cover).toEqual({ state: 'empty' });
    expect(summaries.reads).toBe(sameSubject ? 1 : 2);
    expect(covers.reads).toBe(sameSubject ? 1 : 2);
  }
});

test('empty and concealed sibling outcomes retain their independent disclosure meaning', () => {
  const original = summary(originalId, '');
  original.label = null;
  const projected = projectPublicationPresentations(
    originalId,
    terminalId,
    new Map([
      [originalId, original],
      [terminalId, null],
    ]),
    new Map([
      [originalId, 'absent'],
      [terminalId, 'concealed'],
    ]),
  );

  expect(projected.original).toEqual({ label: { state: 'empty' }, cover: { state: 'empty' } });
  expect(projected.terminal).toEqual({ label: { state: 'concealed' }, cover: { state: 'concealed' } });
});

test('multibyte labels and complete cover credit survive, while an oversized obligation sibling becomes unavailable', () => {
  const label = '書'.repeat(4096);
  const credit: CoverCredit = {
    rightsHolder: '權'.repeat(1024),
    via: { name: '來源'.repeat(341), url: 'https://example.com/source' },
    license: 'CC-BY-4.0',
    obligations: ['cc:Attribution', 'cc:Notice'],
  };
  const cover: NonNullable<SubjectSummary['cover']> = {
    media: mediaId,
    width: 640,
    height: 960,
    placeholder: { thumbhash: 'abcdefghijklmnopqrstuvwx', color: '#123456' },
    variants: [{ format: 'webp' as const, width: 640 }],
    focalPoint: null,
    credit,
  };
  const source = summary(originalId, label);
  source.cover = cover;
  const oversized = summary(terminalId, 'Terminal');
  oversized.cover = {
    ...cover,
    credit: {
      ...credit,
      obligations: ['complete obligation '.repeat(2048)] as unknown as CoverCredit['obligations'],
    },
  };
  const projected = projectPublicationPresentations(
    originalId,
    terminalId,
    new Map([
      [originalId, source],
      [terminalId, oversized],
    ]),
    new Map([
      [originalId, 'available'],
      [terminalId, 'available'],
    ]),
  );

  expect(projected.original.label).toEqual({ state: 'available', value: label, language: 'zh-Hant' });
  expect(projected.original.cover).toEqual({ state: 'available', value: cover });
  expect(projected.terminal.label).toEqual({ state: 'available', value: 'Terminal', language: 'zh-Hant' });
  expect(projected.terminal.cover).toEqual({ state: 'unavailable' });
  expect(JSON.stringify(projected.terminal.cover)).not.toContain('complete obligation');
});
