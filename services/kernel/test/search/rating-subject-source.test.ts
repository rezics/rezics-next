import { expect, mock, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { documentActions } from '../../src/search/document.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import type { PublicRatingFigure, PublicRatingSnapshot, PublicRatingSource } from '../../src/search/rating-source.ts';
import { withPublicRatings } from '../../src/search/rating-subject-source.ts';
import type { IndexedSubject, SubjectSnapshot, SubjectSource } from '../../src/search/source.ts';

const partition = 10;
const binding = { questionId: '00000000-0000-8000-8000-000000000001', populationId: GLOBAL_CONTEXT.id };
const id = (index = 1) => `00000000-0000-8000-8000-00a0${index.toString(16).padStart(8, '0')}`;
const foreignId = '00000000-0000-8000-8000-00b000000001';
const subject = (subjectId = id()): IndexedSubject => ({
  id: subjectId,
  type: 'work',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: 'Current body' }],
  aliases: [],
  descriptions: [],
  statements: [],
});
const figure = (subjectId = id()): PublicRatingFigure => ({
  ...binding,
  subjectId,
  count: 5,
  mean: 0,
  score: 0,
  priorEpoch: 1,
  revision: '9007199254740993',
  asOf: '2026-10-28T00:00:00Z',
});

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of value instanceof Map ? value.values() : Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ports(position = 7n) {
  const source = {
    read: mock(async (requestedPartition: number, ids: readonly string[]): Promise<SubjectSnapshot> => ({
      partition: requestedPartition,
      position,
      subjects: ids.map((subjectId) => subject(subjectId)),
    })),
    count: mock(async (_partition: number) => ({ position, count: 1 })),
  } satisfies SubjectSource;
  const ratings = {
    read: mock(async (requestedPartition: number, ids: readonly string[]): Promise<PublicRatingSnapshot> => ({
      partition: requestedPartition,
      position,
      figures: new Map(ids.map((subjectId) => [subjectId, figure(subjectId)])),
    })),
    epoch: mock(async () => ({ ...binding, priorEpoch: 1 })),
  } satisfies PublicRatingSource;
  return { source, ratings, wrapped: withPublicRatings(source, ratings, binding) };
}

test('a rating-enriched snapshot never labels old subject state with a newer figure position', async () => {
  const { source, ratings, wrapped } = ports();
  const old = freeze({
    partition,
    position: 6n,
    subjects: [{ ...subject(), labels: [{ language: 'en', value: 'Old body' }] }],
  });
  const current = freeze({ partition, position: 7n, subjects: [subject()] });
  const figures = freeze({ partition, position: 7n, figures: new Map([[id(), figure()]]) });
  source.read.mockResolvedValueOnce(old).mockResolvedValue(current);
  ratings.read.mockResolvedValue(figures);

  const result = await wrapped.read(partition, [id()]);
  expect(result).toEqual({ ...current, subjects: [{ ...subject(), publicRating: figure() }] });
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(ratings.read).toHaveBeenCalledTimes(2);
  expect(documentActions(result, [id()])[0]).toMatchObject({ version: 7n, document: { names: ['Current body'] } });
  expect(old.subjects[0]!.labels[0]!.value).toBe('Old body');
  expect(ratings.epoch).not.toHaveBeenCalled();
});

test.each([64, 256, 1024])('coherent enrichment has exact bounded calls and row inputs for %i ids', async (size) => {
  const { source, ratings, wrapped } = ports(9_007_199_254_740_993n);
  const ids = Array.from({ length: size }, (_, index) => id(index + 1));
  const result = await wrapped.read(partition, freeze([...ids, ids[0]!, ids[size - 1]!]));
  expect(result.position).toBe(9_007_199_254_740_993n);
  expect(result.subjects.map((entry) => entry.id)).toEqual(ids);
  expect(result.subjects.every((entry) => entry.publicRating?.score === 0)).toBe(true);
  for (const read of [source.read, ratings.read]) {
    expect(read).toHaveBeenCalledTimes(Math.ceil(size / 256));
    expect(read.mock.calls.flatMap((call) => call[1])).toEqual(ids);
    expect(read.mock.calls.every(([anchor, batch]) => anchor === partition && batch.length <= 256)).toBe(true);
  }
  expect(ratings.epoch).not.toHaveBeenCalled();
});

test.each([64, 256, 1024])(
  'permanent mismatch retries the entire %i-id collection exactly three times',
  async (size) => {
    const { source, ratings, wrapped } = ports(9_007_199_254_740_992n);
    const ids = Array.from({ length: size }, (_, index) => id(index + 1));
    ratings.read.mockImplementation(async (anchor, batch) => ({
      partition: anchor,
      position: 9_007_199_254_740_993n,
      figures: new Map(batch.map((subjectId) => [subjectId, figure(subjectId)])),
    }));
    const error = await wrapped.read(partition, ids).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SearchUnavailableError);
    expect((error as Error).message).toContain('9007199254740992');
    expect((error as Error).message).toContain('9007199254740993');
    expect((error as Error).message).toContain('10');
    for (const read of [source.read, ratings.read]) {
      expect(read).toHaveBeenCalledTimes(3 * Math.ceil(size / 256));
      expect(read.mock.calls.flatMap((call) => call[1])).toEqual([...ids, ...ids, ...ids]);
      expect(read.mock.calls.every(([, batch]) => batch.length <= 256)).toBe(true);
    }
  },
);

test('every semantic chunk and figure chunk must share one position before any collection is returned', async () => {
  const { source, ratings, wrapped } = ports();
  const ids = Array.from({ length: 257 }, (_, index) => id(index + 1));
  source.read.mockResolvedValueOnce({ partition, position: 6n, subjects: ids.slice(0, 256).map(subject) });
  ratings.read.mockResolvedValueOnce({ partition, position: 6n, figures: new Map() });
  const result = await wrapped.read(partition, ids);
  expect(result.position).toBe(7n);
  expect(result.subjects).toHaveLength(257);
  expect(source.read).toHaveBeenCalledTimes(4);
  expect(ratings.read).toHaveBeenCalledTimes(4);
});

test('a mismatch in the last figure chunk retries all earlier semantic and figure reads', async () => {
  const { source, ratings, wrapped } = ports();
  const ids = Array.from({ length: 257 }, (_, index) => id(index + 1));
  ratings.read
    .mockResolvedValueOnce(freeze({ partition, position: 7n, figures: new Map() }))
    .mockResolvedValueOnce(freeze({ partition, position: 8n, figures: new Map() }));
  const result = await wrapped.read(partition, ids);
  expect(result.subjects.every((entry) => entry.publicRating !== undefined)).toBe(true);
  expect(result.position).toBe(7n);
  for (const read of [source.read, ratings.read]) {
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.flatMap((call) => call[1])).toEqual([...ids, ...ids]);
  }
});

test('the third complete attempt may succeed after two mismatches', async () => {
  const { source, ratings, wrapped } = ports();
  ratings.read
    .mockResolvedValueOnce(freeze({ partition, position: 8n, figures: new Map() }))
    .mockResolvedValueOnce(freeze({ partition, position: 9n, figures: new Map() }));
  expect((await wrapped.read(partition, [id()])).subjects[0]!.publicRating).toEqual(figure());
  expect(source.read).toHaveBeenCalledTimes(3);
  expect(ratings.read).toHaveBeenCalledTimes(3);
});

test.each([-1n, 7, '7'])('invalid figure snapshot position %s cannot establish coherence', async (position) => {
  const { source, ratings, wrapped } = ports();
  ratings.read.mockResolvedValue({ partition, position: position as bigint, figures: new Map() });
  await expect(wrapped.read(partition, [id()])).rejects.toBeInstanceOf(SearchUnavailableError);
  expect(source.read).toHaveBeenCalledTimes(3);
  expect(ratings.read).toHaveBeenCalledTimes(3);
});

test.each(['semantic', 'ratings'])('wrong %s snapshot partitions exhaust coherence retries', async (port) => {
  const { source, ratings, wrapped } = ports();
  if (port === 'semantic') source.read.mockResolvedValue({ partition: 11, position: 7n, subjects: [subject()] });
  else ratings.read.mockResolvedValue({ partition: 11, position: 7n, figures: new Map() });
  const error = await wrapped.read(partition, [id()]).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(SearchUnavailableError);
  expect((error as Error).message).toContain('11');
  expect((error as Error).message).toContain(port);
  expect(source.read).toHaveBeenCalledTimes(3);
  expect(ratings.read).toHaveBeenCalledTimes(3);
});

test('empty input still reads a coherent partition position without epochs', async () => {
  const { source, ratings, wrapped } = ports();
  expect(await wrapped.read(partition, [])).toEqual({ partition, position: 7n, subjects: [] });
  expect(source.read.mock.calls).toEqual([[partition, []]]);
  expect(ratings.read.mock.calls).toEqual([[partition, []]]);
  expect(ratings.epoch).not.toHaveBeenCalled();
});

test('invalid partitions and foreign or malformed anchor ids are refused before any I/O', async () => {
  const { source, ratings, wrapped } = ports();
  for (const anchor of [-1, 4096, 0.5, NaN, Infinity]) await expect(wrapped.read(anchor, [id()])).rejects.toThrow();
  for (const subjectId of [foreignId, 'bad-id', '00000000-0000-4000-8000-00a000000001']) {
    await expect(wrapped.read(partition, [id(), subjectId])).rejects.toThrow();
  }
  expect(source.read).not.toHaveBeenCalled();
  expect(ratings.read).not.toHaveBeenCalled();
});

test('binding must be a routable question and fixed Global population at construction', () => {
  const { source, ratings } = ports();
  for (const patch of [{ questionId: 'invalid' }, { populationId: foreignId }, { populationId: 'invalid' }]) {
    expect(() => withPublicRatings(source, ratings, { ...binding, ...patch })).toThrow();
  }
  expect(source.read).not.toHaveBeenCalled();
  expect(ratings.read).not.toHaveBeenCalled();
  expect(ratings.epoch).not.toHaveBeenCalled();
});

test('binding is captured from startup metadata rather than caller mutation or an epoch read', async () => {
  const { source, ratings } = ports();
  const metadata = { ...binding };
  const wrapped = withPublicRatings(source, ratings, metadata);
  metadata.questionId = foreignId;
  metadata.populationId = foreignId;
  expect((await wrapped.read(partition, [id()])).subjects[0]!.publicRating).toEqual(figure());
  expect(ratings.epoch).not.toHaveBeenCalled();
});

test.each([
  'extra semantic',
  'foreign semantic',
  'duplicate semantic',
  'extra figure',
  'foreign figure',
  'wrong figure subject',
])('%s data is rejected', async (kind) => {
  const { source, ratings, wrapped } = ports();
  if (kind === 'extra semantic') source.read.mockResolvedValue({ partition, position: 7n, subjects: [subject(id(2))] });
  if (kind === 'foreign semantic')
    source.read.mockResolvedValue({ partition, position: 7n, subjects: [subject(foreignId)] });
  if (kind === 'duplicate semantic')
    source.read.mockResolvedValue({ partition, position: 7n, subjects: [subject(), subject()] });
  if (kind === 'extra figure')
    ratings.read.mockResolvedValue({ partition, position: 7n, figures: new Map([[id(2), figure(id(2))]]) });
  if (kind === 'foreign figure')
    ratings.read.mockResolvedValue({ partition, position: 7n, figures: new Map([[foreignId, figure(foreignId)]]) });
  if (kind === 'wrong figure subject')
    ratings.read.mockResolvedValue({ partition, position: 7n, figures: new Map([[id(), figure(id(2))]]) });
  await expect(wrapped.read(partition, [id()])).rejects.toThrow();
});

test.each([
  { questionId: foreignId },
  { populationId: foreignId },
  { count: '5' },
  { count: 4, mean: 0, score: null },
  { score: Infinity },
  { mean: NaN },
  { voterId: id() },
  { voters: [id()] },
  { realmId: foreignId },
  { revision: '01' },
  { asOf: 'yesterday' },
])('the shared validator rejects malformed or private figure fields: %j', async (patch) => {
  const { ratings, wrapped } = ports();
  ratings.read.mockResolvedValue({
    partition,
    position: 7n,
    figures: new Map([[id(), { ...figure(), ...patch } as PublicRatingFigure]]),
  });
  await expect(wrapped.read(partition, [id()])).rejects.toThrow(TypeError);
});

test('absent figures remove stale enrichment; native null and zero figures stay unchanged', async () => {
  const { source, ratings, wrapped } = ports();
  const subjects = [subject(), subject(id(2)), subject(id(3))].map((entry) => ({
    ...entry,
    publicRating: figure(entry.id),
  }));
  source.read.mockResolvedValue(freeze({ partition, position: 7n, subjects }));
  const unscored = { ...figure(id(2)), count: 0, mean: null, score: null, priorEpoch: null };
  const zeroMean = { ...figure(id(3)), score: null, priorEpoch: null };
  ratings.read.mockResolvedValue(
    freeze({
      partition,
      position: 7n,
      figures: new Map([
        [id(2), unscored],
        [id(3), zeroMean],
      ]),
    }),
  );
  const result = await wrapped.read(
    partition,
    subjects.map((entry) => entry.id),
  );
  expect(Object.hasOwn(result.subjects[0]!, 'publicRating')).toBe(false);
  expect(result.subjects[1]!.publicRating).toEqual(unscored);
  expect(result.subjects[2]!.publicRating).toEqual(zeroMean);
  expect(subjects[0]!.publicRating).toEqual(figure());
});

test('missing semantic subjects remain absent even when requested figures exist', async () => {
  const { source, wrapped } = ports();
  source.read.mockResolvedValue({ partition, position: 7n, subjects: [] });
  expect((await wrapped.read(partition, [id()])).subjects).toEqual([]);
});

test('caller snapshots, subject objects, figures and map entries remain unchanged', async () => {
  const { source, ratings, wrapped } = ports();
  const semantic = freeze({ partition, position: 7n, subjects: [subject()] });
  const native = freeze({ partition, position: 7n, figures: new Map([[id(), figure()]]) });
  const before = structuredClone({ semantic, native });
  source.read.mockResolvedValue(semantic);
  ratings.read.mockResolvedValue(native);
  const output = await wrapped.read(partition, freeze([id()]));
  expect({ semantic, native }).toEqual(before);
  expect(output).not.toBe(semantic);
  expect(output.subjects[0]).not.toBe(semantic.subjects[0]);
  expect(output.subjects[0]!.publicRating).not.toBe(native.figures.get(id()));
  output.subjects[0]!.publicRating!.mean = 8;
  expect(native.figures.get(id())!.mean).toBe(0);
});

test('enrichment leaves hidden, taken-down and redirected subjects deleted by documentActions', async () => {
  const { source, wrapped } = ports();
  const subjects: IndexedSubject[] = [
    { ...subject(), visibility: 'hidden' },
    { ...subject(id(2)), visibility: 'taken_down' },
    { ...subject(id(3)), redirect: id(4) },
  ];
  const ids = subjects.map((entry) => entry.id);
  source.read.mockResolvedValue(freeze({ partition, position: 7n, subjects }));
  const result = await wrapped.read(partition, ids);
  expect(result.subjects.map(({ publicRating: _rating, ...entry }) => entry)).toEqual(subjects);
  expect(documentActions(result, ids)).toEqual(ids.map((subjectId) => ({ op: 'delete', id: subjectId, version: 7n })));
});

test.each(['semantic', 'ratings'])('%s I/O failures propagate without retry or empty fallback', async (port) => {
  const { source, ratings, wrapped } = ports();
  const failure = new Error(`${port} unavailable`);
  if (port === 'semantic') source.read.mockRejectedValue(failure);
  else ratings.read.mockRejectedValue(failure);
  await expect(wrapped.read(partition, [id()])).rejects.toBe(failure);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(ratings.read.mock.calls.length).toBe(port === 'semantic' ? 0 : 1);
});

test('read, count and optional facet probes preserve the owning port as this', async () => {
  const { source, ratings } = ports();
  const countResult = { position: 7n, count: 1 };
  const facetResult = [true, false, 'not_proven'] as const;
  const complete: SubjectSource = {
    async read(anchor, ids) {
      expect(this).toBe(complete);
      return source.read(anchor, ids);
    },
    async count(anchor) {
      expect(this).toBe(complete);
      expect(anchor).toBe(partition);
      return countResult;
    },
    async matchRelationFacets(anchor, probes) {
      expect(this).toBe(complete);
      expect(anchor).toBe(partition);
      expect(probes).toBe(probeInput);
      return [...facetResult];
    },
  };
  const native: PublicRatingSource = {
    async read(anchor, ids) {
      expect(this).toBe(native);
      return ratings.read(anchor, ids);
    },
    async epoch() {
      throw new Error('The enrichment wrapper must not read epochs');
    },
  };
  const probeInput = freeze([{ subject: id(), property: id(2), value: id(3) }]);
  const wrapped = withPublicRatings(complete, native, binding);
  await wrapped.read(partition, [id()]);
  expect(await wrapped.count(partition)).toBe(countResult);
  expect(await wrapped.matchRelationFacets!(partition, probeInput)).toEqual([...facetResult]);
  const historical = withPublicRatings(source, ratings, binding);
  expect(Object.hasOwn(historical, 'matchRelationFacets')).toBe(false);
  expect(historical.matchRelationFacets).toBeUndefined();
});
