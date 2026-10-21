import { describe, expect, test } from 'bun:test';
import {
  datasetRecordDigest,
  datasetSourceIdentity,
  datasetSourceReference,
} from '../../../scripts/datasets/native/context.ts';
import { datasetCoverage } from '../../../scripts/datasets/native/coverage.ts';
import {
  datasetReleaseCandidates,
  datasetReleaseMapper,
  mapDatasetReleases,
  projectDatasetReleases,
  type DatasetReleaseCorrespondence,
} from '../../../scripts/datasets/native/releases.ts';
import type {
  DatasetCoverageKey,
  DatasetEdge,
  DatasetMappingContext,
  DatasetNativeRecord,
  DatasetRecord,
  DatasetSnapshot,
} from '../../../scripts/datasets/types.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const workId = id(1),
  releaseId = id(2),
  releaseRevision = id(3),
  realizationId = id(4),
  realizationRevision = id(5);
const record: DatasetRecord = {
  key: 'vndb:release:r1',
  provider: 'vndb',
  kind: 'release',
  externalId: 'r1',
  title: 'Fate/stay night',
  language: 'ja',
  sourceUrl: 'https://vndb.org/r1',
  native: 'release',
  data: {
    id: 'r1',
    olang: 'ja',
    released: '20049999',
    official: 't',
    tables: {
      releases_titles: [{ lang: 'zh-Hans', title: 'Fate/stay night', mtl: 'f' }],
      releases_platforms: [{ platform: 'win' }],
      releases_vn: [{ vid: 'v11', rtype: 'complete' }],
    },
  },
};
const work: DatasetRecord = {
  key: 'vndb:vn:v11',
  provider: 'vndb',
  kind: 'vn',
  externalId: 'v11',
  title: 'Fate/stay night',
  language: 'ja',
  sourceUrl: 'https://vndb.org/v11',
  data: {},
  native: 'work',
  semanticTypes: ['https://schema.org/VideoGame'],
};

function fixture(input = record, editingWork = work, dataEpoch = 'epoch-a', offset = 0) {
  const release = structuredClone(input),
    sourceWork = structuredClone(editingWork);
  const targetWork = offset ? id(1 + offset) : workId;
  const targetRelease = offset ? id(2 + offset) : releaseId;
  const targetRealization = offset ? id(4 + offset) : realizationId;
  const edge: DatasetEdge =
    release.provider === 'musicbrainz'
      ? { from: sourceWork.key, to: release.key, kind: 'release', data: {} }
      : { from: release.key, to: sourceWork.key, kind: 'release-of', data: { rtype: 'complete' } };
  const snapshot: DatasetSnapshot = {
    format: 'rezics-local-dataset-v1',
    id: 'captured-shape',
    digest: 'a'.repeat(64),
    createdAt: '2026-10-19',
    captures: [],
    images: [],
    sources: [
      {
        provider: release.provider,
        roots: [sourceWork.key],
        records: [release, sourceWork],
        edges: [edge],
        images: [],
        scope: { complete: true },
      },
    ],
  };
  const selected = new Set([release.key, sourceWork.key]);
  const inventory = datasetCoverage(snapshot, selected);
  for (const key of selected) inventory.retain(key);
  const source = datasetSourceReference(
    snapshot,
    release,
    [id(10)],
    [{ record: id(11), observation: id(10), byteDigest: 'b'.repeat(64) }],
  );
  const native = new Map<string, DatasetNativeRecord>([
    [sourceWork.key, { id: targetWork, kind: 'work', receipt: { work: targetWork }, urls: [] }],
    // The importer has already retained a descriptive event. It is not replaced.
    [
      release.key,
      {
        id: id(12 + offset),
        kind: 'resource',
        receipt: { component: id(12 + offset) },
        urls: [],
        sourceIdentity: datasetSourceIdentity(release),
        projection: {
          recordDigest: datasetRecordDigest(release),
          fields: { '/title': release.title },
        },
      },
    ],
  ]);
  inventory.disposition(
    { record: release.key, kind: 'field', path: '/title' },
    {
      status: 'mapped',
      reason: 'acknowledged-descriptive-resource',
      mapping: {
        target: id(12 + offset),
        readPath: `/v1/resources/${id(12 + offset).slice(-36)}/page`,
        receipt: { receipt: 'descriptive' },
      },
    },
  );
  const paths: string[] = [];
  const commands: unknown[][] = [];
  const view: Record<string, unknown> = {
    profile: 'release-v2',
    id: targetRelease,
    revision: releaseRevision,
    kind: 'formal',
    status: 'official',
    title: { value: release.title, language: release.language },
    platform: 'win',
    territory: null,
    identifiers: [],
    publicationYear: 2004,
    coverage: [
      {
        work: targetWork,
        realization: targetRealization,
        revision: realizationRevision,
        language: 'zh-Hans',
        completeness: 'complete',
      },
    ],
  };
  const realization: Record<string, unknown> = {
    profile: 'realization-v1',
    id: targetRealization,
    revision: realizationRevision,
    work: targetWork,
    language: 'zh-Hans',
    kind: 'original',
    translators: [],
    publishers: [],
    source: { kind: 'unresolved', work: targetWork },
    status: 'official',
    verification: 'verified',
    evidence: 'https://vndb.org/r1',
  };
  const releasePath = `/v1/works/${targetWork.slice(-36)}/releases/${targetRelease.slice(-36)}`;
  const realizationPath =
    `/v1/works/${targetWork.slice(-36)}/realizations/${targetRealization.slice(-36)}` +
    `?revision=${encodeURIComponent(realizationRevision)}`;
  const reads = new Map([
    [releasePath, view],
    [realizationPath, realization],
  ]);
  const context: DatasetMappingContext = {
    snapshot,
    actingSubject: id(9),
    selected,
    records: new Map([
      [release.key, release],
      [sourceWork.key, sourceWork],
    ]),
    native,
    source(key) {
      if (key === release.key) return structuredClone(source);
      return datasetSourceReference(
        snapshot,
        sourceWork,
        [id(20)],
        [{ record: id(21), observation: id(20), byteDigest: 'c'.repeat(64) }],
      );
    },
    async command(...args) {
      commands.push(args);
      throw new Error('No speculative release/support/publication commands');
    },
    async read(path) {
      paths.push(path);
      if (!reads.has(path)) throw new Error(`Unexpected consuming read: ${path}`);
      return structuredClone(reads.get(path)!);
    },
    disposition: inventory.disposition,
  };
  const candidate =
    datasetReleaseCandidates(context).find((item) => item.source.key === release.key) ??
    projectDatasetReleases(release, source);
  const fields = Object.fromEntries(
    candidate.facts.map((fact) => [fact.occurrence.path, structuredClone(fact.value)]),
  );
  const publication: DatasetNativeRecord = {
    id: targetRelease,
    kind: 'release',
    urls: [],
    sourceIdentity: datasetSourceIdentity(release),
    projection: { recordDigest: source.recordDigest, fields },
    receipt: {
      work: targetWork,
      release: targetRelease,
      revision: releaseRevision,
      receipt: 'release-command',
      sourcePosition: { datasetId: 'product', dataEpoch, sequence: '10' },
      replayed: false,
    },
  };
  const text: DatasetNativeRecord = {
    id: targetRealization,
    kind: 'realization',
    urls: [],
    sourceIdentity: datasetSourceIdentity(release),
    projection: { recordDigest: source.recordDigest, fields },
    receipt: {
      work: targetWork,
      realization: targetRealization,
      revision: realizationRevision,
      receipt: 'realization-command',
      sourcePosition: { datasetId: 'product', dataEpoch, sequence: '9' },
      replayed: false,
    },
  };
  const binding: DatasetReleaseCorrespondence = {
    source: structuredClone(source),
    work: sourceWork.key,
    release: publication,
    realizations: [{ work: sourceWork.key, native: text }],
  };
  return {
    context,
    source,
    release,
    sourceWork,
    binding,
    inventory,
    view,
    realization,
    reads,
    paths,
    commands,
    releasePath,
    realizationPath,
    native,
    entry(path: string, kind: DatasetCoverageKey['kind'] = 'field') {
      return inventory
        .report(true, new Set())
        .entries.find(
          (item) => item.record === release.key && item.kind === kind && item.path === path,
        )!;
    },
  };
}

describe('native release source candidates', () => {
  test('retains one dump release with correlated facts, exact source case and independent Work identity', () => {
    const f = fixture();
    const [candidate] = datasetReleaseCandidates(f.context);
    expect(candidate).toMatchObject({
      key: datasetSourceIdentity(f.release),
      source: f.source,
      grain: 'release',
      disposition: 'candidate',
      sourceUrl: 'https://vndb.org/r1',
    });
    const at = (path: string) => candidate!.facts.find((fact) => fact.occurrence.path === path)!;
    expect(at('/data/released')).toMatchObject({
      value: '20049999',
      normalized: '2004',
      precision: 'year',
    });
    expect(at('/data/official')).toMatchObject({ value: 't', normalized: 'official' });
    expect(at('/data/tables/releases_titles/0/lang')).toMatchObject({ normalized: 'zh-Hans' });
    expect(at('/data/tables/releases_titles/0/mtl')).toMatchObject({
      value: 'f',
      gap: { owner: 'realization' },
    });
    expect(at('/data/tables/releases_vn/0/rtype')).toMatchObject({
      normalized: 'complete',
      sourceWork: work.key,
    });
    expect(candidate!.facts.some((fact) => fact.occurrence.path === '/language')).toBe(false);
    expect(candidate!.gaps).toContainEqual(
      expect.objectContaining({
        owner: 'source',
        operation: 'postV1SourcesProposalsByProposalAdoptionNative-work',
      }),
    );
  });

  test('preserves day/month/year precision and rejects packed sentinels and impossible dates', () => {
    for (const [raw, normalized, precision] of [
      ['20040130', '2004-01-30', 'day'],
      ['20040199', '2004-01', 'month'],
      ['20049999', '2004', 'year'],
    ]) {
      const f = fixture({ ...record, data: { released: raw } });
      const fact = projectDatasetReleases(f.release, f.source).facts.find(
        (item) => item.role === 'publication-date',
      )!;
      expect(fact).toMatchObject({ value: raw, normalized, precision });
      expect(Boolean(fact.gap)).toBe(precision !== 'year');
    }
    for (const raw of [0, '0', '99999999', '20049901', '20030229', null, 'later']) {
      const f = fixture({ ...record, data: { released: raw } });
      const fact = projectDatasetReleases(f.release, f.source).facts.find(
        (item) => item.role === 'publication-date',
      )!;
      expect(fact.value).toBe(raw);
      expect(fact.normalized).toBeUndefined();
      expect(fact.gap?.required).toContain('stays unknown');
    }
  });

  test('release-group, publication-event, Bangumi game and Book subject dates never become editions', async () => {
    for (const input of [
      {
        ...record,
        provider: 'musicbrainz' as const,
        kind: 'release-group',
        native: 'work' as const,
      },
      { ...record, semanticTypes: ['https://schema.org/PublicationEvent'] },
      {
        ...work,
        key: 'bangumi:subject:1',
        provider: 'bangumi' as const,
        kind: 'subject',
        semanticTypes: ['https://schema.org/Book'],
        title: '红楼梦',
        data: { type: 1, date: '1982-03-01', infobox: '|版本=人民文学出版社' },
      },
      {
        ...work,
        key: 'bangumi:subject:2',
        provider: 'bangumi' as const,
        kind: 'subject',
        semanticTypes: ['https://schema.org/VideoGame'],
        data: {
          type: 4,
          api_subject: { date: '2004-01-30', infobox: [{ key: '平台', value: 'Windows' }] },
        },
      },
    ]) {
      const f = fixture(input);
      const candidate = projectDatasetReleases(f.release, f.source);
      expect(candidate.disposition).toBe('source-only');
      expect(candidate.facts).toEqual([]);
      await datasetReleaseMapper().map(f.context);
      expect(f.commands).toEqual([]);
      expect(f.paths).toEqual([]);
    }
  });

  test('MusicBrainz actual release facts retain source spelling; title language and media are not realizations', () => {
    const f = fixture({
      ...record,
      key: 'musicbrainz:release:album-one',
      provider: 'musicbrainz',
      externalId: 'album-one',
      sourceUrl: 'https://musicbrainz.org/release/album-one',
      language: 'eng',
      data: {
        status: 'Official',
        date: '2004-01',
        country: 'JP',
        barcode: '1234567890123',
        'text-representation': { language: 'eng', script: 'Latn' },
        'release-events': [
          { date: '2004-01-30', area: { name: 'Japan' } },
          { date: '2005', area: { name: 'United States' } },
        ],
        media: [{ format: 'CD', tracks: [{ recording: { id: 'recording-one' }, number: '1' }] }],
      },
    });
    const candidate = projectDatasetReleases(f.release, f.source);
    expect(candidate.grain).toBe('release');
    expect(candidate.facts.find((fact) => fact.role === 'publication-date')).toMatchObject({
      normalized: '2004-01',
      precision: 'month',
      gap: { owner: 'release' },
    });
    expect(candidate.facts.find((fact) => fact.role === 'language')).toMatchObject({
      value: 'eng',
      gap: { owner: 'realization' },
    });
    expect(candidate.facts.find((fact) => fact.role === 'language')?.normalized).toBeUndefined();
    expect(
      candidate.facts.filter((fact) => fact.role === 'coverage' || fact.role === 'platform'),
    ).toEqual([]);
    const events = candidate.facts.filter((fact) =>
      fact.occurrence.path.includes('/release-events/'),
    );
    expect(events.map((fact) => [fact.value, fact.precision])).toEqual([
      ['2004-01-30', 'day'],
      ['2005', 'year'],
    ]);
    expect(events.every((fact) => fact.gap?.required.includes('own area'))).toBe(true);
  });

  test('unknown official/completeness/translator and multi-platform observations stay independent', () => {
    const f = fixture({
      ...record,
      data: {
        official: false,
        released: 0,
        tables: {
          releases_platforms: [{ platform: 'win' }, { platform: 'lin' }],
          releases_titles: [
            { lang: 'zh-Hans', mtl: null },
            { lang: 'und', mtl: 't' },
          ],
          releases_vn: [{ vid: 'v11', rtype: 'unexpected' }],
        },
      },
    });
    const facts = projectDatasetReleases(f.release, f.source).facts;
    expect(facts.find((fact) => fact.role === 'status')).toMatchObject({
      value: false,
      normalized: 'unofficial',
    });
    expect(facts.filter((fact) => fact.role === 'platform').map((fact) => fact.value)).toEqual([
      'win',
      'lin',
    ]);
    expect(facts.find((fact) => fact.role === 'coverage')).toMatchObject({
      normalized: 'unknown',
      value: 'unexpected',
    });
    expect(
      facts.filter((fact) => fact.role === 'translator-status').map((fact) => fact.value),
    ).toEqual([null, 't']);
    expect(facts.filter((fact) => fact.role === 'language')[1]!.normalized).toBeUndefined();
  });
});

describe('acknowledged release and exact realization correspondence', () => {
  test('maps admissible native release facts through the shared context, preserving the descriptive resource', async () => {
    const f = fixture(),
      before = structuredClone(f.context.snapshot);
    const existing = structuredClone([...f.native]);
    const [result] = await mapDatasetReleases(f.context, [f.binding]);
    for (const path of [
      '/data/released',
      '/data/official',
      '/data/tables/releases_platforms/0/platform',
      '/data/tables/releases_titles/0/lang',
      '/data/tables/releases_vn/0/rtype',
    ]) {
      expect(f.entry(path).disposition).toMatchObject({
        status: 'mapped',
        mapping: {
          target: releaseId,
          readPath: f.releasePath,
          receipt: { source: f.source, release: f.binding.release.receipt },
        },
      });
    }
    expect(f.entry('/sources/0/edges/0', 'edge').disposition.status).toBe('mapped');
    expect(f.entry('/title').disposition).toMatchObject({
      status: 'mapped',
      mapping: { target: id(12) },
    });
    expect(result!.mappings.find((item) => item.occurrence.path === '/title')?.mapping.target).toBe(
      releaseId,
    );
    expect(
      result!.gaps.some(
        (gap) => gap.owner === 'importer' && gap.required.includes('cannot be replaced'),
      ),
    ).toBe(true);
    expect(f.entry('/data/tables/releases_titles/0/mtl').disposition).toMatchObject({
      status: 'unmapped',
    });
    expect(f.paths).toEqual([f.releasePath, f.realizationPath]);
    expect(f.context.snapshot).toEqual(before);
    expect([...f.native]).toEqual(existing);
    expect(f.commands).toEqual([]);
  });

  test('does not map attempts, Work receipts, descriptive events or missing source/adoption correspondence', async () => {
    const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.binding.release.receipt = {};
      },
      (f) => {
        f.binding.release.kind = 'resource';
      },
      (f) => {
        f.binding.release.receipt.release = workId;
      },
      (f) => {
        f.binding.release.sourceIdentity = 'wrong-source';
      },
      (f) => {
        f.binding.release.projection!.recordDigest = 'f'.repeat(64);
      },
      (f) => {
        f.binding.source.observations = [];
      },
      (f) => {
        f.binding.source.intakes = [];
      },
      (f) => {
        f.binding.source.snapshotDigest = 'f'.repeat(64);
      },
      (f) => {
        f.binding.release.receipt.sourcePosition = { dataEpoch: '', sequence: '10' };
      },
    ];
    for (const alter of variants) {
      const f = fixture();
      alter(f);
      const [result] = await mapDatasetReleases(f.context, [f.binding]);
      expect(result!.mappings).toEqual([]);
      expect(f.entry('/data/official').disposition.status).toBe('unmapped');
      expect(result!.gaps[0]).toMatchObject({ owner: 'source' });
      expect(f.commands).toEqual([]);
    }
    const f = fixture();
    const [result] = await mapDatasetReleases(f.context);
    expect(result!.candidate.source).toEqual(f.source);
    expect(result!.gaps[0]).toMatchObject({
      schema: 'source-native-work-adoption-v1 / source-native-child-adoption-v1',
    });
    expect(f.entry('/title').disposition.status).toBe('mapped');
  });

  test('a second provider maps real release facts without treating its title language or recording as text', async () => {
    const f = fixture(
      {
        ...record,
        key: 'musicbrainz:release:album-one',
        provider: 'musicbrainz',
        externalId: 'album-one',
        sourceUrl: 'https://musicbrainz.org/release/album-one',
        data: {
          status: 'Official',
          date: '2004',
          country: 'JP',
          barcode: '1234567890123',
          'text-representation': { language: 'eng' },
          media: [{ format: 'CD' }],
        },
      },
      {
        ...work,
        key: 'musicbrainz:release-group:group-one',
        provider: 'musicbrainz',
        kind: 'release-group',
        externalId: 'group-one',
        semanticTypes: ['https://schema.org/MusicAlbum'],
      },
    );
    f.view.platform = null;
    f.view.territory = 'JP';
    f.view.identifiers = [
      { provider: 'https://musicbrainz.org/doc/Barcode', value: '1234567890123' },
    ];
    const [result] = await mapDatasetReleases(f.context, [f.binding]);
    for (const path of ['/data/status', '/data/date', '/data/country', '/data/barcode'])
      expect(f.entry(path).disposition).toMatchObject({
        status: 'mapped',
        mapping: { target: releaseId },
      });
    expect(f.entry('/data/text-representation/language').disposition.status).toBe('unmapped');
    expect(result!.candidate.source.provider).toBe('musicbrainz');
    expect(f.commands).toEqual([]);
  });

  test('ordered multipart intake remains evidence, not one convertible/adopted observation', async () => {
    const f = fixture();
    f.source.intakes = [
      ...f.source.intakes,
      { record: id(30), observation: id(31), byteDigest: 'd'.repeat(64) },
    ];
    f.source.observations = f.source.intakes.map((item) => item.observation);
    f.binding.source = structuredClone(f.source);
    const [result] = await mapDatasetReleases(f.context, [f.binding]);
    expect(result!.candidate.source.intakes).toEqual(f.source.intakes);
    expect(result!.mappings).toEqual([]);
    expect(f.paths).toEqual([]);
  });

  test('a different release, stale release head or grain mismatch cannot supply an exact correspondence', async () => {
    for (const alter of [
      (f: ReturnType<typeof fixture>) => {
        f.view.id = id(90);
      },
      (f: ReturnType<typeof fixture>) => {
        f.view.revision = id(91);
      },
      (f: ReturnType<typeof fixture>) => {
        f.view.profile = 'release-v1';
      },
      (f: ReturnType<typeof fixture>) => {
        f.view.kind = 'virtual';
      },
    ]) {
      const f = fixture();
      alter(f);
      const [result] = await mapDatasetReleases(f.context, [f.binding]);
      expect(result!.mappings).toEqual([]);
      expect(result!.gaps[0]?.owner).toBe('release');
      expect(f.commands).toEqual([]);
    }
  });

  test('language, status and translators must be the exact release-covered realization revision', async () => {
    const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.binding.realizations = [];
      },
      (f) => {
        f.binding.realizations[0]!.native.receipt.revision = id(80);
      },
      (f) => {
        f.realization.revision = id(80);
      },
      (f) => {
        f.realization.work = id(81);
      },
      (f) => {
        f.realization.language = 'en';
      },
      (f) => {
        f.realization.status = 'unofficial';
      },
      (f) => {
        f.realization.kind = 'translation';
        f.realization.translators = [];
      },
      (f) => {
        f.realization.translators = ['a display name'];
      },
      (f) => {
        f.realization.evidence = null;
      },
      (f) => {
        f.view.coverage = [
          { work: workId, realization: null, revision: null, language: 'zh-Hans' },
        ];
      },
    ];
    for (const alter of variants) {
      const f = fixture();
      alter(f);
      const [result] = await mapDatasetReleases(f.context, [f.binding]);
      expect(result!.mappings).toEqual([]);
      expect(result!.gaps[0]?.owner).toBe('realization');
      expect(f.commands).toEqual([]);
    }
  });

  test('unavailable or denied exact owner reads leave an explicit gap without guessing another identity', async () => {
    for (const owner of ['release', 'realization']) {
      const f = fixture();
      f.reads.delete(owner === 'release' ? f.releasePath : f.realizationPath);
      const [result] = await mapDatasetReleases(f.context, [f.binding]);
      expect(result!.mappings).toEqual([]);
      expect(result!.gaps[0]).toMatchObject({ owner });
      expect(result!.gaps[0]!.required).toContain('unavailable or denied');
      expect(f.commands).toEqual([]);
    }
  });

  test('does not combine another release platform or a different covered language/completeness/translator', async () => {
    const f = fixture();
    f.view.platform = 'lin';
    // One release has complete English and partial Chinese. Neither is the source's complete Chinese text.
    const english = {
      ...f.realization,
      id: id(40),
      revision: id(41),
      language: 'en',
      kind: 'translation',
      translators: [id(42)],
    };
    f.view.coverage = [
      {
        work: workId,
        realization: id(40),
        revision: id(41),
        language: 'en',
        completeness: 'complete',
      },
      {
        work: workId,
        realization: realizationId,
        revision: realizationRevision,
        language: 'zh-Hans',
        completeness: 'partial',
      },
    ];
    f.reads.set(
      `/v1/works/${workId.slice(-36)}/realizations/${id(40).slice(-36)}?revision=${encodeURIComponent(id(41))}`,
      english,
    );
    const englishNative = structuredClone(f.binding.realizations[0]!.native);
    englishNative.id = id(40);
    englishNative.receipt.realization = id(40);
    englishNative.receipt.revision = id(41);
    f.binding.realizations = [...f.binding.realizations, { work: work.key, native: englishNative }];
    await mapDatasetReleases(f.context, [f.binding]);
    for (const path of [
      '/data/tables/releases_titles/0/lang',
      '/data/tables/releases_vn/0/rtype',
      '/data/tables/releases_platforms/0/platform',
    ])
      expect(f.entry(path).disposition.status).toBe('unmapped');
    expect(f.entry('/data/official').disposition.status).toBe('mapped');
  });

  test('requires source projection receipts on the exact realization, not just a matching language', async () => {
    const f = fixture();
    delete f.binding.realizations[0]!.native.projection;
    await mapDatasetReleases(f.context, [f.binding]);
    expect(f.entry('/data/tables/releases_titles/0/lang').disposition.status).toBe('unmapped');
    expect(f.entry('/data/tables/releases_vn/0/rtype').disposition.status).toBe('unmapped');
    expect(f.entry('/data/released').disposition.status).toBe('mapped');
  });

  test('historical realization pins are read explicitly and never replaced by a newer text head', async () => {
    const f = fixture();
    f.reads.set(f.realizationPath.split('?')[0]!, {
      ...f.realization,
      revision: id(99),
      language: 'en',
    });
    await mapDatasetReleases(f.context, [f.binding]);
    expect(f.entry('/data/tables/releases_titles/0/lang').disposition.status).toBe('mapped');
    expect(f.paths.filter((path) => path.includes('/realizations/'))).toEqual([f.realizationPath]);
    expect(f.binding.realizations[0]!.native.receipt.revision).toBe(realizationRevision);
  });

  test('precision loss and unknowns do not earn mapped coverage from a guessed publication year', async () => {
    for (const raw of ['20040130', '20040199', 0, null]) {
      const f = fixture({ ...record, data: { ...record.data, released: raw } });
      await mapDatasetReleases(f.context, [f.binding]);
      expect(f.entry('/data/released').disposition.status).toBe(
        raw === null ? 'absent' : 'unmapped',
      );
      expect(f.entry('/data/official').disposition.status).toBe('mapped');
    }
  });

  test('source refresh keeps stable source/native identity but cannot reuse adoption of different bytes', async () => {
    const before = fixture(),
      changed = fixture({
        ...record,
        title: 'Corrected source title',
        data: { ...record.data, released: '20059999' },
      });
    expect(datasetReleaseCandidates(before.context)[0]!.key).toBe(
      datasetReleaseCandidates(changed.context)[0]!.key,
    );
    expect(before.source.recordDigest).not.toBe(changed.source.recordDigest);
    const [result] = await mapDatasetReleases(changed.context, [before.binding]);
    expect(result!.mappings).toEqual([]);
    expect(changed.native.get(record.key)?.id).toBe(before.native.get(record.key)?.id);
    expect(changed.commands).toEqual([]);
  });

  test('replay preserves independent receipt supports, existing bindings and both 113-identity epochs', async () => {
    for (const [epoch, offset] of [
      ['original-epoch', 0],
      ['restored-epoch', 1000],
    ] as const) {
      const f = fixture(record, work, epoch, offset);
      for (let n = 0; n < 111; n++)
        f.native.set(`retained:${n}`, {
          id: id(2000 + n + offset),
          kind: 'work',
          receipt: { receipt: `independent:${n}` },
          urls: [],
        });
      const originalIdentities = structuredClone([...f.native]);
      const support = structuredClone(f.binding);
      support.release.receipt = {
        ...support.release.receipt,
        receipt: 'independent-release-support',
      };
      await datasetReleaseMapper([f.binding, support]).map(f.context);
      const mappedOnce = structuredClone(f.entry('/data/official').mappings);
      await datasetReleaseMapper([f.binding, support]).map(f.context);
      expect(f.entry('/data/official').mappings).toEqual(mappedOnce);
      expect(mappedOnce).toHaveLength(2);
      expect(f.native.size).toBe(113);
      expect([...f.native]).toEqual(originalIdentities);
      expect(f.commands).toEqual([]);
    }
  });

  test('does not choose a new release identity when correspondence receipts disagree', async () => {
    const f = fixture(),
      other = structuredClone(f.binding);
    other.release.id = id(99);
    other.release.receipt.release = id(99);
    const [result] = await mapDatasetReleases(f.context, [f.binding, other]);
    expect(result!.mappings).toEqual([]);
    expect(f.paths).toEqual([]);
  });

  test('selected source slice does not read or write out-of-slice releases or saved-choice owners', async () => {
    const f = fixture();
    f.context.selected = new Set([work.key]);
    expect(await mapDatasetReleases(f.context, [f.binding])).toEqual([]);
    expect(f.paths).toEqual([]);
    expect(f.commands).toEqual([]);
  });
});
