import { describe, expect, test } from 'bun:test';
import {
  datasetRelationCandidates,
  datasetRelationMapper,
} from '../../../scripts/datasets/native/relations.ts';
import { datasetClassificationCandidates } from '../../../scripts/datasets/native/classifications.ts';
import { datasetCompositionCandidates } from '../../../scripts/datasets/native/compositions.ts';
import { datasetCoverage, datasetCoverageId } from '../../../scripts/datasets/native/coverage.ts';
import { datasetSourceReference } from '../../../scripts/datasets/native/context.ts';
import { canonical, sha256 } from '../../../scripts/datasets/store.ts';
import type {
  DatasetEdge,
  DatasetIntakeReference,
  DatasetMappingContext,
  DatasetNativeRecord,
  DatasetRecord,
  DatasetSnapshot,
} from '../../../scripts/datasets/types.ts';
import { projectBangumiSubject } from '../../../services/main/src/modules/source/bangumi-conversion.ts';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import type { StagedSourceObservation } from '../../../services/main/src/modules/source/intake.ts';
import { workReceiptIri } from '../../../services/main/src/modules/work/receipt.ts';
import { workEditReceiptIri } from '../../../services/main/src/modules/work/edit.ts';

type Row = Record<string, unknown>;
const iri = (id: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
function record(
  key: string,
  data: Row = {},
  native: DatasetRecord['native'] = 'work',
): DatasetRecord {
  const [provider, kind, externalId] = key.split(':') as [
    DatasetRecord['provider'],
    string,
    string,
  ];
  return {
    key,
    provider,
    kind,
    externalId,
    title: externalId,
    language: 'ja',
    sourceUrl: `https://${provider}.example.test/${kind}/${externalId}`,
    data,
    native,
  };
}

function fixture(records: DatasetRecord[], edges: DatasetEdge[] = [], epoch = 0) {
  const snapshot: DatasetSnapshot = {
    format: 'rezics-local-dataset-v1',
    id: 'captured-shape',
    digest: 'a'.repeat(64),
    createdAt: '2026-10-02T15:11:16.692Z',
    captures: [],
    images: [],
    sources: [...new Set(records.map((row) => row.provider))].map((provider) => ({
      provider,
      roots: records
        .filter((row) => row.provider === provider && row.native === 'work')
        .map((row) => row.key),
      records: records.filter((row) => row.provider === provider),
      edges: edges.filter(
        (edge) => records.find((row) => row.key === edge.from)?.provider === provider,
      ),
      images: [],
      scope: {},
    })),
  };
  const selected = new Set(records.map((row) => row.key));
  const coverage = datasetCoverage(snapshot, selected);
  selected.forEach((key) => coverage.retain(key));
  const native = new Map<string, DatasetNativeRecord>(
    records.map((row, index) => [
      row.key,
      {
        id: iri(100 + epoch * 1000 + index),
        kind: row.native,
        receipt: { receipt: iri(10000 + index) },
        urls: [],
      },
    ]),
  );
  const intakes = new Map<string, DatasetIntakeReference[]>();
  const reads = new Map<string, Row>();
  const requests: Array<{ label: string; method: string; path: string; body: Row }> = [];
  const receipts = new Map<string, { body: string; result: Row }>();
  let reply: (body: Row) => Row = () => {
    throw new Error('No native write is admitted by this fixture');
  };
  let loseReply = false;
  const context: DatasetMappingContext = {
    snapshot,
    selected,
    actingSubject: iri(1),
    records: new Map(records.map((row) => [row.key, row])),
    native,
    source(key) {
      return datasetSourceReference(
        snapshot,
        records.find((row) => row.key === key)!,
        (intakes.get(key) ?? []).map((item) => item.observation),
        intakes.get(key) ?? [],
      );
    },
    async read(path) {
      const result = reads.get(path);
      if (!result) throw new Error(`Unadmitted owner read: ${path}`);
      return structuredClone(result);
    },
    async command(label, method, path, value) {
      const body = value as Row,
        prior = receipts.get(label);
      if (prior) {
        expect(canonical(body)).toBe(prior.body);
        return structuredClone(prior.result);
      }
      requests.push({ label, method, path, body: structuredClone(body) });
      const result = reply(body);
      receipts.set(label, { body: canonical(body), result });
      if (loseReply) {
        loseReply = false;
        throw new Error('lost reply after commit');
      }
      return structuredClone(result);
    },
    disposition: coverage.disposition,
  };
  return {
    context,
    coverage,
    native,
    reads,
    intakes,
    requests,
    receipts,
    respond: (value: typeof reply) => {
      reply = value;
    },
    loseReply: () => {
      loseReply = true;
    },
    entry: (key: string, path: string, kind: 'field' | 'edge' = 'field') =>
      coverage.entries.get(datasetCoverageId({ record: key, path, kind }))!,
  };
}

/** Shapes inspected in the frozen Bangumi 424753e973cbd3609613 subject response.
 * Repeated labels and qualified entries below are deliberate counterexamples. */
function tagFixture(
  tags: Row[] = [
    { count: 2968, name: 'J.C.STAFF', total_count: 138201 },
    { count: 1918, name: 'とある魔術の禁書目録', total_count: 2584 },
  ],
) {
  const raw = { id: 1014, name: 'とある魔術の禁書目録', type: 2, tags };
  const subject = record('bangumi:subject:1014', { ...raw, api_subject: structuredClone(raw) });
  const result = fixture([subject]);
  const work = result.native.get(subject.key)!,
    bytes = Buffer.from(JSON.stringify(raw));
  const observation: StagedSourceObservation = {
    profile: 'source-manual-intake-v1',
    state: 'staged',
    observation: iri(501),
    record: iri(502),
    provider: 'bangumi',
    namespace: 'subject',
    externalId: '1014',
    sourceRevision: 'a'.repeat(64),
    mediaType: 'application/json',
    retention: 'retained',
    byteDigest: sha256(bytes),
    byteLength: bytes.length,
    rawBytesBase64: bytes.toString('base64'),
    coverage: { scope: 'bangumi-subject-response-v1', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: 'Retained factual source reference.' },
    submittedAt: '2026-10-02T15:11:16.692Z',
  };
  const support: Row = {
    profile: 'native-work-source-support-v1',
    state: 'recorded',
    work: work.id,
    binding: iri(503),
    sourceRecord: observation.record,
    sourceObservation: observation.observation,
    sourceConversion: iri(504),
    sourceProposal: iri(505),
    currentHead: iri(506),
    adoptionReceipt: workReceiptIri(iri(507).slice(-36)),
    adoptedAtRevision: iri(506),
  };
  work.receipt = {
    profile: 'source-native-work-adoption-v1',
    state: 'adopted',
    work: work.id,
    binding: support.binding,
    sourceRecord: support.sourceRecord,
    sourceConversion: support.sourceConversion,
    proposal: support.sourceProposal,
    workRevision: support.currentHead,
    receipt: support.adoptionReceipt,
  };
  result.intakes.set(subject.key, [
    {
      record: observation.record,
      observation: observation.observation,
      byteDigest: observation.byteDigest!,
    },
  ]);
  result.reads.set(`/v1/works/${work.id.slice(-36)}/source-support`, support);
  result.reads.set(
    `/v1/sources/observations/${observation.observation.slice(-36)}`,
    observation as unknown as Row,
  );
  result.reads.set(`/v1/sources/conversions/${iri(504).slice(-36)}`, {
    profile: 'source-mapped-conversion-v1',
    state: 'staged',
    conversion: iri(504),
    observation: observation.observation,
    mappingRevision: 'bangumi-subject-map-v1',
    sourceDigest: observation.byteDigest,
    projection: projectBangumiSubject(observation).values,
  });
  let rewrite: (receipt: Row) => Row = (receipt) => receipt;
  result.respond((body) =>
    rewrite({
      support: {
        profile: 'source-native-child-support-v1',
        state: 'recorded',
        support: iri(600 + Number(body.sourceOrdinal)),
        work: work.id,
        field: 'tags',
        child: {
          profile: 'work-native-child-v1',
          state: 'active',
          work: work.id,
          child: iri(700 + Number(body.sourceOrdinal)),
          revision: iri(800 + Number(body.sourceOrdinal)),
          field: 'tags',
          sourceKey: body.confirmedSourceKey,
          nativeOrdinal: body.nativeOrdinal,
          expectedHead: body.expectedHead,
          actingSubject: body.actingSubject,
          retiredBy: null,
        },
        proposal: support.sourceProposal,
        conversion: support.sourceConversion,
        record: support.sourceRecord,
        observation: support.sourceObservation,
        sourceOccurrence: body.occurrence,
        sourceOrdinal: body.sourceOrdinal,
        sourceKey: body.confirmedSourceKey,
        nativeReceipt: workEditReceiptIri(iri(900 + Number(body.sourceOrdinal)).slice(-36)),
        baseSupport: null,
        correspondence: null,
      },
      replayed: false,
    }),
  );
  return {
    ...result,
    subject,
    work,
    support,
    observation,
    raw,
    rewriteReceipt: (value: typeof rewrite) => {
      rewrite = value;
    },
  };
}

describe('faithful retained relation candidates', () => {
  test('preserves repeated source occurrences, direction, roles, official status and every qualifier', () => {
    const from = record('vndb:vn:v11'),
      to = record('vndb:vn:v7');
    const edge = {
      from: from.key,
      to: to.key,
      kind: 'vn:preq',
      data: { id: 'v11', vid: 'v7', relation: 'preq', official: 'f', uncertain: false, extra: 0 },
    };
    const f = fixture([from, to], [edge, structuredClone(edge)]);
    const before = canonical(f.context.snapshot),
      candidates = datasetRelationCandidates(f.context);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.key).not.toBe(candidates[1]!.key);
    expect(candidates.map((item) => item.coverage.path)).toEqual([
      '/sources/0/edges/0',
      '/sources/0/edges/1',
    ]);
    expect(candidates[0]!.qualifiers).toEqual(edge.data);
    expect(candidates[0]!.participants.map((item) => [item.role, item.sourceKey])).toEqual([
      ['from', from.key],
      ['to', to.key],
    ]);
    expect(candidates[0]!.source.snapshotDigest).toBe(f.context.snapshot.digest);
    expect(candidates[0]!.valueDigest).toBe(sha256(canonical(edge)));
    expect(candidates[0]!.native.missing.join(' ')).toContain('exact relation DefinitionRef');
    candidates[0]!.qualifiers.official = true;
    expect(canonical(f.context.snapshot)).toBe(before);
  });

  test('protagonist supplies no gender and traits remain with their own subject and release occurrence', async () => {
    const one = record(
      'vndb:character:c1',
      {
        tables: {
          chars_vns: [
            { id: 'c1', vid: 'v11', rid: 'r1', role: 'main', spoil: '0' },
            { id: 'c1', vid: 'v11', rid: 'r2', role: 'primary', spoil: '2' },
          ],
          chars_traits: [{ id: 'c1', tid: 'i1', spoil: '1', lie: 't' }],
        },
      },
      'character',
    );
    const two = record('vndb:character:c2', {}, 'character'),
      work = record('vndb:vn:v11');
    const trait = record('vndb:trait:i1', { gid: 'i2', name: '性格' }, 'concept');
    const f = fixture(
      [one, two, work, trait],
      [
        {
          from: one.key,
          to: work.key,
          kind: 'appearance',
          data: { role: 'main', rid: 'r1', spoil: '0' },
        },
        {
          from: two.key,
          to: work.key,
          kind: 'appearance',
          data: { role: 'primary', rid: 'r2', spoil: '2' },
        },
        { from: one.key, to: trait.key, kind: 'trait', data: { tid: 'i1', lie: 't', spoil: '1' } },
      ],
    );
    const appearances = datasetRelationCandidates(f.context);
    const classifications = datasetClassificationCandidates(f.context);
    expect(appearances.filter((item) => item.kind === 'appearance')).toHaveLength(4);
    expect(classifications.every((item) => item.participants[0]!.sourceKey === one.key)).toBe(true);
    expect(classifications[0]!.qualifiers).toMatchObject({ tid: 'i1', lie: 't', spoil: '1' });
    expect(canonical([...appearances, ...classifications])).not.toMatch(
      /MaleLead|FemaleLead|gender|male/i,
    );
    await datasetRelationMapper().map(f.context);
    expect(f.entry(one.key, '/data/tables/chars_vns/1/rid').disposition.status).toBe('unmapped');
    expect(f.entry(one.key, '/data/tables/chars_traits/0/lie').disposition.status).toBe('unmapped');
    expect(f.requests).toHaveLength(0);
  });

  test('source tag votes remain exact source scores and concept IDs, including false and zero', async () => {
    const row = {
      date: '2010-12-15',
      ignore: 'f',
      lie: null,
      notes: '',
      spoiler: '0',
      tag: 'g100',
      uid: 'fixture-voter',
      vid: 'v11',
      vote: '3.00',
      uncertain: false,
      count: 0,
    };
    const work = record('vndb:vn:v11', { tables: { tags_vn: [row, { ...row, vote: '0' }] } });
    const tag = record('vndb:tag:g100', { name: 'Trait', cat: 'cont' }, 'concept');
    const f = fixture([work, tag], [{ from: work.key, to: tag.key, kind: 'tag-vote', data: row }]);
    const candidates = datasetClassificationCandidates(f.context);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((item) => item.key).length).toBe(
      new Set(candidates.map((item) => item.key)).size,
    );
    expect(candidates[0]!.qualifiers).toEqual(row);
    expect(candidates[1]!.participants[1]!.sourceKey).toBe(tag.key);
    await datasetRelationMapper().map(f.context);
    expect(f.entry(work.key, '/data/tables/tags_vn/0/count').disposition.status).toBe('unmapped');
    expect(f.entry(work.key, '/data/tables/tags_vn/0/uncertain').disposition.status).toBe(
      'unmapped',
    );
    expect(f.entry(work.key, '/data/tables/tags_vn/0/lie').disposition.status).toBe('absent');
    expect(f.requests).toHaveLength(0);
  });

  test('Bangumi cast retains source role/order; unknown nonempty relations name the missing owner adapter', async () => {
    const work = record('bangumi:subject:311310'),
      character = record('bangumi:character:100710', {}, 'character');
    const f = fixture(
      [work, character],
      [
        {
          from: work.key,
          to: character.key,
          kind: 'cast:2',
          data: { character_id: 100710, order: 0, subject_id: 311310, type: 2 },
        },
        {
          from: work.key,
          to: 'bangumi:character:missing',
          kind: 'unknown-kind',
          data: { lie: true, scope: ['edition'] },
        },
      ],
    );
    const candidates = datasetRelationCandidates(f.context);
    expect(candidates[0]!.qualifiers.order).toBe(0);
    expect(candidates[1]!.participants[1]!.target).toBeNull();
    await datasetRelationMapper().map(f.context);
    expect(f.entry(work.key, '/sources/0/edges/1', 'edge').disposition).toMatchObject({
      status: 'unmapped',
      reason: expect.stringContaining('source relation conversion/adoption/support adapter'),
    });
  });
});

describe('admitted source tag names', () => {
  test('maps only exact acknowledged names; IDs, counts and aggregates stay pending', async () => {
    const f = tagFixture();
    await datasetRelationMapper().map(f.context);
    expect(f.requests).toHaveLength(2);
    const request = f.requests[0]!;
    expect(request.path).toBe(`/v1/works/${f.work.id.slice(-36)}/source-children`);
    expect(request.body).toEqual({
      profile: 'source-native-child-adoption-v1',
      field: 'tags',
      proposal: iri(505),
      conversion: iri(504),
      occurrence: sourceChildOccurrence(iri(501), 'tags', 0),
      sourceOrdinal: 0,
      confirmedSourceKey: 'J.C.STAFF',
      nativeOrdinal: 0,
      expectedHead: iri(506),
      actingSubject: iri(1),
      baseSupport: null,
      correspondence: null,
      confirmedUse: 'factual-reference-only',
    });
    for (const base of ['/data/tags/0', '/data/api_subject/tags/0']) {
      const mapped = f.entry(f.subject.key, `${base}/name`).disposition;
      expect(mapped.status).toBe('mapped');
      if (mapped.status !== 'mapped') throw new Error('Expected acknowledged mapping');
      expect(mapped.mapping.target).toBe(iri(700));
      expect(mapped.mapping.receipt).toEqual(f.receipts.get(request.label)!.result);
      expect(mapped.mapping.readPath).toBe(
        `/v1/works/${f.work.id.slice(-36)}/native-children/${iri(700).slice(-36)}/revisions/${iri(800).slice(-36)}?actingSubject=${encodeURIComponent(f.context.actingSubject)}`,
      );
      expect(f.entry(f.subject.key, `${base}/count`).disposition.status).toBe('unmapped');
      expect(f.entry(f.subject.key, `${base}/total_count`).disposition.status).toBe('unmapped');
      expect(f.entry(f.subject.key, base).disposition.status).toBe('unmapped');
    }
  });

  test('lost replies and a later Work head preserve repeated same-name child identities', async () => {
    const f = tagFixture([
      { name: '同名', count: 0 },
      { name: '同名', count: 0 },
    ]);
    f.loseReply();
    await expect(datasetRelationMapper().map(f.context)).rejects.toThrow('lost reply after commit');
    f.reads.set(`/v1/works/${f.work.id.slice(-36)}/source-support`, {
      ...f.support,
      currentHead: iri(999),
    });
    await datasetRelationMapper().map(f.context);
    await datasetRelationMapper().map(f.context);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]!.label).not.toBe(f.requests[1]!.label);
    expect(f.entry(f.subject.key, '/data/tags/0/name').disposition).toMatchObject({
      status: 'mapped',
      mapping: { target: iri(700) },
    });
    expect(f.entry(f.subject.key, '/data/tags/1/name').disposition).toMatchObject({
      status: 'mapped',
      mapping: { target: iri(701) },
    });
  });

  test('native creation, split envelopes and qualified source names cannot certify adoption', async () => {
    const f = tagFixture([{ name: '秘密', count: 0, spoiler: 2, lie: true, uncertain: true }]);
    await datasetRelationMapper().map(f.context);
    expect(f.requests).toHaveLength(0);
    expect(f.entry(f.subject.key, '/data/tags/0/name').disposition.status).toBe('unmapped');
    const plain = tagFixture();
    plain.work.receipt = { work: plain.work.id, workRevision: iri(506) };
    await datasetRelationMapper().map(plain.context);
    expect(plain.requests).toHaveLength(0);
    expect(plain.entry(plain.subject.key, '/data/tags/0/name').disposition.status).toBe('unmapped');
    const split = tagFixture();
    split.intakes.set(split.subject.key, [
      { record: iri(502), observation: iri(777), byteDigest: 'b'.repeat(64) },
    ]);
    await datasetRelationMapper().map(split.context);
    expect(split.requests).toHaveLength(0);
  });

  test.each([
    'wrong-observation',
    'wrong-conversion',
    'wrong-child',
    'wrong-actor',
    'resource-as-receipt',
    'withdrawn',
    'native-only',
  ])('%s cannot produce a mapped disposition', async (failure) => {
    const f = tagFixture();
    f.rewriteReceipt((receipt) => {
      const support = receipt.support as Row,
        child = support.child as Row;
      if (failure === 'wrong-observation') support.observation = iri(999);
      if (failure === 'wrong-conversion') support.conversion = iri(999);
      if (failure === 'wrong-child') child.sourceKey = 'another name';
      if (failure === 'wrong-actor') child.actingSubject = iri(999);
      if (failure === 'resource-as-receipt') support.nativeReceipt = iri(999);
      if (failure === 'withdrawn') support.state = 'withdrawn';
      return failure === 'native-only' ? { child: iri(700), revision: iri(800) } : receipt;
    });
    await expect(datasetRelationMapper().map(f.context)).rejects.toThrow(
      'exact acknowledged child/support receipt',
    );
    expect(
      [...f.coverage.entries.values()].some((entry) => entry.disposition.status === 'mapped'),
    ).toBe(false);
  });

  test('a source binding for another native adoption cannot authorize tag writes', async () => {
    const f = tagFixture();
    f.reads.set(`/v1/works/${f.work.id.slice(-36)}/source-support`, {
      ...f.support,
      adoptionReceipt: workReceiptIri(iri(999).slice(-36)),
    });
    await expect(datasetRelationMapper().map(f.context)).rejects.toThrow(
      'differs from the native adoption',
    );
    expect(f.requests).toHaveLength(0);
  });

  test('different observations with matching labels and denied reads remain explicit', async () => {
    const f = tagFixture();
    f.reads.set(`/v1/sources/observations/${iri(501).slice(-36)}`, {
      ...f.observation,
      rawBytesBase64: Buffer.from(
        JSON.stringify({ ...f.raw, tags: [{ name: 'J.C.STAFF', count: 1 }] }),
      ).toString('base64'),
    });
    await datasetRelationMapper().map(f.context);
    expect(f.requests).toHaveLength(0);
    const denied = tagFixture();
    denied.reads.delete(`/v1/works/${denied.work.id.slice(-36)}/source-support`);
    await expect(datasetRelationMapper().map(denied.context)).rejects.toThrow(
      'Unadmitted owner read',
    );
  });
});

describe('ordered occurrence grains and frozen identities', () => {
  test('keeps medium, repeated track, recording and composition separate, with source order and direction', async () => {
    const recordingId = '17b86554-953c-4188-bb39-bb15862cb6f2',
      compositionId = '13be4fe1-bbc7-3b8c-97f3-a2486406f36e';
    const recording = record(`musicbrainz:recording:${recordingId}`, {
      relations: [
        {
          type: 'performance',
          'type-id': 'a3005666-a872-32c3-ad06-98af558e99b0',
          direction: 'backward',
          'target-type': 'work',
          attributes: ['live'],
          begin: '1981-02',
          ended: false,
          work: { id: compositionId, title: 'Aria' },
        },
      ],
    });
    const composition = record(`musicbrainz:work:${compositionId}`);
    const track = {
      id: '1084607a-59e9-49f4-9c55-6dfb9b544fe0',
      position: 1,
      number: 'A1',
      title: 'Aria',
      length: 0,
      recording: { id: recordingId, title: 'Aria' },
    };
    const medium = {
      id: '18e7cb56-693e-329a-94a6-d852d4aeb0d7',
      position: 1,
      format: 'CD',
      'track-count': 2,
      'track-offset': 0,
      tracks: [track, { ...track, id: 'second-track', position: 2, number: 'A2' }],
    };
    const release = record('musicbrainz:release:album-release', { media: [medium] }, 'release');
    const f = fixture(
      [release, recording, composition],
      medium.tracks.map((value) => ({
        from: release.key,
        to: recording.key,
        kind: 'track',
        data: { ...value, medium: { ...medium, tracks: undefined } },
      })),
    );
    const candidates = datasetCompositionCandidates(f.context),
      relations = datasetRelationCandidates(f.context);
    const tracks = candidates.filter(
      (item) => item.kind === 'musicbrainz-track' && item.coverage.kind === 'field',
    );
    expect(candidates.filter((item) => item.native.grain === 'medium-occurrence')).toHaveLength(1);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.key).not.toBe(tracks[1]!.key);
    expect(tracks[0]!.participants[1]!.sourceKey).toBe(recording.key);
    expect(tracks[1]!.participants[1]!.target).toBe(tracks[0]!.participants[1]!.target);
    expect(tracks[0]!.qualifiers).toMatchObject({ number: 'A1', position: 1, length: 0 });
    expect(relations[0]!.native.grain).toBe('recording-composition-relation');
    expect(relations[0]!.participants.map((item) => item.sourceKey)).toEqual([
      recording.key,
      composition.key,
    ]);
    expect(relations[0]!.qualifiers).toMatchObject({
      direction: 'backward',
      attributes: ['live'],
      ended: false,
    });
    await datasetRelationMapper().map(f.context);
    expect(f.entry(release.key, '/data/media/0/tracks/0/length').disposition.status).toBe(
      'unmapped',
    );
    expect(f.entry(recording.key, '/data/relations/0/direction').disposition.status).toBe(
      'unmapped',
    );
    expect(f.requests).toHaveLength(0);
  });

  test('Bangumi decimal episode sort, disc, type and exact episode target survive unsupported profile mapping', async () => {
    const subject = record('bangumi:subject:5393'),
      episode = record(
        'bangumi:episode:36420',
        {
          id: 36420,
          subject_id: 5393,
          sort: 0.5,
          disc: 0,
          type: 1,
          duration: '00:24:00',
          name: '特番',
        },
        'episode',
      );
    const f = fixture(
      [subject, episode],
      [
        {
          from: subject.key,
          to: episode.key,
          kind: 'episode',
          data: { sort: 0.5, disc: 0, type: 1 },
        },
      ],
    );
    const candidate = datasetCompositionCandidates(f.context)[0]!;
    expect(candidate.native.grain).toBe('episode-occurrence');
    expect(candidate.qualifiers).toMatchObject({
      sort: 0.5,
      disc: 0,
      type: 1,
      episode: episode.data,
    });
    expect(candidate.participants[1]!.sourceKey).toBe(episode.key);
    await datasetRelationMapper().map(f.context);
    expect(f.entry(subject.key, '/sources/0/edges/0', 'edge').disposition).toMatchObject({
      status: 'unmapped',
      reason: expect.stringContaining('fractional sort'),
    });
  });

  test('both 113-identity epochs, immutable snapshots, selection and evidence survive replay', async () => {
    const records = Array.from({ length: 113 }, (_, index) => record(`vndb:vn:v${index + 1}`));
    const edges = records.slice(1).map((target) => ({
      from: records[0]!.key,
      to: target.key,
      kind: 'vn:seq',
      data: { official: 't', relation: 'seq' },
    }));
    const one = fixture(records, edges),
      two = fixture(structuredClone(records), structuredClone(edges), 1);
    const snapshots = [canonical(one.context.snapshot), canonical(two.context.snapshot)];
    const identities = [canonical([...one.native]), canonical([...two.native])];
    const candidates = datasetRelationCandidates(one.context);
    expect(datasetRelationCandidates(two.context).map((item) => item.key)).toEqual(
      candidates.map((item) => item.key),
    );
    await datasetRelationMapper().map(one.context);
    await datasetRelationMapper().map(one.context);
    await datasetRelationMapper().map(two.context);
    expect(one.native.size).toBe(113);
    expect(two.native.size).toBe(113);
    expect([canonical([...one.native]), canonical([...two.native])]).toEqual(identities);
    expect([canonical(one.context.snapshot), canonical(two.context.snapshot)]).toEqual(snapshots);
    expect(one.requests).toHaveLength(0);
    expect(two.requests).toHaveLength(0);
    one.context.selected = new Set([records[1]!.key]);
    expect(datasetRelationCandidates(one.context)).toEqual([]);
  });
});
