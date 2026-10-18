import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bangumiImageCandidate, enrichBangumiSubjects } from '../../../scripts/datasets/bangumi.ts';
import { Acquisition, type Capture } from '../../../scripts/datasets/network.ts';
import {
  datasetMediaCandidates,
  datasetMediaMapper,
  datasetWorkCoverImages,
  electedDatasetCovers,
} from '../../../scripts/datasets/native/media.ts';
import { datasetSourceIdentity } from '../../../scripts/datasets/native/context.ts';
import { datasetCoverage, datasetCoverageId } from '../../../scripts/datasets/native/coverage.ts';
import {
  checkSources,
  freezeSnapshot,
  normalizedCaptureRole,
  readSnapshot,
  snapshotMediaImages,
  verifyCoverSourceCapture,
  verifySnapshot,
} from '../../../scripts/datasets/snapshot.ts';
import {
  atomicJson,
  blobPath,
  canonical,
  putBlob,
  repository,
  sha256,
} from '../../../scripts/datasets/store.ts';
import type {
  DatasetImage,
  DatasetMappingContext,
  DatasetMappingDisposition,
  DatasetNativeRecord,
  DatasetSnapshot,
  DatasetSource,
} from '../../../scripts/datasets/types.ts';
import { selectFate, VndbDump, VNDB_DUMP_URL } from '../../../scripts/datasets/vndb.ts';

// COPY and public v0 response shapes from the retained adapter fixtures. This
// miniature archive/byte fixture is not a live capture or business-page image proof.
const columns: Record<string, string[]> = {
  vn: ['id', 'image', 'c_image', 'olang', 'alias', 'description'],
  vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
  vn_relations: ['id', 'vid', 'relation', 'official'],
  releases: ['id', 'olang', 'released', 'engine'],
  releases_vn: ['id', 'vid', 'rtype'],
  releases_supersedes: ['id', 'rid'],
  releases_titles: ['id', 'lang', 'title'],
  releases_producers: ['id', 'pid', 'developer', 'publisher'],
  releases_drm: ['id', 'drm'],
  releases_extlinks: ['id', 'link'],
  releases_images: ['id', 'img', 'vid', 'itype'],
  releases_media: ['id', 'medium', 'qty'],
  releases_platforms: ['id', 'platform'],
  chars: ['id', 'main', 'image', 'description'],
  chars_vns: ['id', 'vid', 'rid', 'role', 'spoil'],
  chars_names: ['id', 'lang', 'name'],
  chars_alias: ['id', 'name'],
  chars_traits: ['id', 'tid', 'spoil', 'lie'],
  vn_seiyuu: ['id', 'cid', 'aid', 'note'],
  vn_staff: ['id', 'aid', 'role', 'note'],
  staff: ['id', 'lang', 'main', 'prod'],
  staff_alias: ['id', 'aid', 'name', 'latin'],
  staff_extlinks: ['id', 'link'],
  producers: ['id', 'lang', 'name'],
  producers_relations: ['id', 'pid', 'relation'],
  producers_extlinks: ['id', 'link'],
  tags: ['id', 'name'],
  tags_parents: ['id', 'parent', 'main'],
  tags_vn: ['tag', 'vid', 'uid', 'vote', 'spoiler', 'ignore'],
  traits: ['id', 'gid', 'name'],
  traits_parents: ['id', 'parent', 'main'],
  vn_anime: ['id', 'aid'],
  vn_editions: ['id', 'eid'],
  vn_extlinks: ['id', 'link'],
  vn_screenshots: ['id', 'scr', 'rid'],
  vn_image_votes: ['vid', 'uid', 'img'],
  vn_length_votes: ['vid', 'uid', 'length'],
  quotes: ['id', 'vid', 'cid', 'quote'],
  anime: ['id', 'title_romaji'],
  drm: ['id', 'name'],
  engines: ['id', 'name'],
  extlinks: ['id', 'site', 'value'],
  wikidata: ['id', 'enwiki'],
  images: ['id', 'width', 'height'],
  image_votes: ['id', 'uid', 'sexual'],
  entry_meta: ['id', 'revision'],
};
const tables: Record<string, string[]> = {
  vn: ['v11\tcv1\tcv2\tja\t\tA\\nB'],
  vn_titles: ['v11\tja\tt\tFate/stay night\t\\N'],
  releases: ['r1\tja\t20040130\t\\N'],
  releases_vn: ['r1\tv11\tcomplete'],
  releases_images: ['r1\tcv3\t\\N\tpkgfront'],
  chars: ['c1\t\\N\tch1\tCharacter'],
  chars_vns: ['c1\tv11\tr1\tmain\t0'],
  chars_names: ['c1\tja\tセイバー'],
  vn_screenshots: ['v11\tsf1\tr1'],
  vn_image_votes: ['v11\tu1\tcv4'],
  images: [
    'cv1\t500\t700',
    'cv2\t500\t700',
    'cv3\t500\t700',
    'cv4\t500\t700',
    'ch1\t400\t600',
    'sf1\t1280\t720',
  ],
};
function tar(overrides: Record<string, string[]> = {}): Buffer {
  const chunks: Buffer[] = [];
  for (const [table, header] of Object.entries(columns)) {
    for (const [name, content] of [
      [`db/${table}.header`, `${header.join('\t')}\n`],
      [`db/${table}`, (overrides[table] ?? tables[table] ?? []).join('\n')],
    ] as const) {
      const bytes = Buffer.from(content),
        block = Buffer.alloc(512);
      block.write(name);
      block.write(bytes.length.toString(8).padStart(11, '0'), 124);
      chunks.push(block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64',
);
function temporary(): string {
  const parent = join(repository, '.temp/datasets');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'media-unit-'));
}
function retain(
  root: string,
  acquisition: Acquisition,
  url: string,
  bytes: Uint8Array,
  mediaType = 'application/json',
): Capture {
  const capture: Capture = {
    url,
    digest: putBlob(root, bytes),
    bytes: bytes.length,
    mediaType,
    fetchedAt: '2026-10-02T00:00:00.000Z',
    etag: null,
    lastModified: null,
  };
  acquisition.captures.set(sha256(canonical([url, null])), capture);
  return capture;
}
function vndb(
  root: string,
  acquisition: Acquisition,
  overrides: Record<string, string[]> = {},
): DatasetSource {
  const bytes = tar(overrides);
  const capture = retain(
    root,
    acquisition,
    VNDB_DUMP_URL,
    Bun.zstdCompressSync(bytes),
    'application/zstd',
  );
  return selectFate(new VndbDump(bytes), { url: capture.url, digest: capture.digest });
}
function bangumi(
  root: string,
  acquisition: Acquisition,
  kind: 'subject' | 'character',
  requestedId?: number,
): DatasetSource {
  const row = {
    id: kind === 'subject' ? 975 : 10,
    type: kind === 'subject' ? 2 : 1,
    name: kind === 'subject' ? 'ONE PIECE' : 'Character',
    images: { large: `https://lain.bgm.tv/pic/${kind}/l/source.jpg` },
    tags: [],
    meta_tags: [],
  };
  const capture = retain(
    root,
    acquisition,
    `https://api.bgm.tv/v0/${kind === 'subject' ? 'subjects' : 'characters'}/${requestedId ?? row.id}`,
    Buffer.from(JSON.stringify(row)),
  );
  const image = bangumiImageCandidate(row, kind, capture.url, capture.digest)!;
  return {
    provider: 'bangumi',
    roots: [image.record],
    edges: [],
    images: [image],
    records: [
      {
        key: image.record,
        provider: 'bangumi',
        kind,
        externalId: String(row.id),
        title: row.name,
        language: 'ja',
        native: kind === 'subject' ? 'work' : 'character',
        data: { id: row.id, type: row.type, name: row.name },
        sourceUrl: `https://bgm.tv/${kind}/${row.id}`,
      },
    ],
    scope: {
      familySubjectIds: kind === 'subject' ? [row.id] : [],
      license: 'CC BY-SA 3.0 (database, not image art)',
    },
  };
}
function acquisition(root: string, failed?: string): Acquisition {
  return new Acquisition(
    root,
    false,
    async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === failed) return new Response('', { status: 404 });
      if (!/^https:\/\/(t\.vndb\.org|lain\.bgm\.tv)\//.test(url))
        throw new Error(`Unexpected request: ${url}`);
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
    async () => {},
  );
}
function native(snapshot: DatasetSnapshot): Map<string, DatasetNativeRecord> {
  let index = 0;
  return new Map(
    snapshot.sources
      .flatMap((source) => source.records)
      .filter((record) => record.native === 'work' || record.native === 'character')
      .map((record) => [
        record.key,
        {
          id: `https://rezics.com/id/00000000-0000-4000-8000-${String(++index).padStart(12, '0')}`,
          kind: record.native,
          receipt: { mainVersion: 'https://rezics.com/id/00000000-0000-4000-8000-000000001234' },
          urls: [],
        },
      ]),
  );
}
// Encode a frozen v1 fixture using its historical identity projection. It deliberately
// contains no new role/evidence properties; reading must not rewrite its identity.
function legacy(snapshot: DatasetSnapshot): DatasetSnapshot {
  const value = structuredClone(snapshot);
  for (const source of value.sources)
    for (const image of source.images) delete image.sourceEvidence;
  for (const image of value.images) {
    delete image.sourceEvidence;
    image.captureRole = image.role === 'cover' ? 'cover' : 'other';
  }
  value.digest = sha256(
    canonical({
      format: value.format,
      sources: value.sources,
      captures: value.captures.map(({ url, digest, bytes, mediaType }) => ({
        url,
        digest,
        bytes,
        mediaType,
      })),
      images: value.images.map((image) => ({
        ...image,
        capture: image.capture
          ? (({ url, digest, bytes, mediaType }) => ({ url, digest, bytes, mediaType }))(
              image.capture,
            )
          : null,
      })),
    }),
  );
  value.id = `dataset-${value.digest.slice(0, 20)}`;
  return value;
}

test('VNDB retains exact COPY witnesses for covers, portraits, screenshots and release images', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root),
      source = vndb(root, owner);
    const archive = [...owner.captures.values()][0]!;
    const expected = {
      cover: ['vn', '/image'],
      'selected-cover': ['vn', '/c_image'],
      portrait: ['chars', '/image'],
      screenshot: ['vn_screenshots', '/scr'],
      'cover:release:pkgfront': ['releases_images', '/img'],
      'candidate-cover': ['vn_image_votes', '/img'],
    };
    expect(source.images).toHaveLength(6);
    for (const image of source.images) {
      const [table, field] = expected[image.role as keyof typeof expected]!;
      expect(image.sourceEvidence).toMatchObject({
        captureUrl: VNDB_DUMP_URL,
        field,
        holder: null,
        derivation: { table, archiveDigest: archive.digest, format: 'vndb-copy-image-v1' },
      });
      const row = [...new VndbDump(tar()).rows(table!)].find(
        (item) => item[field!.slice(1)] === image.sourceEvidence!.derivation!.imageId,
      )!;
      expect(image.sourceEvidence!.recordDigest).toBe(sha256(canonical(row)));
      verifyCoverSourceCapture(root, [...owner.captures.values()], image);
    }
    const snapshot = await freezeSnapshot(owner, [source], 'all');
    expect(snapshot.images.find((image) => image.role === 'portrait')?.captureRole).toBe(
      'portrait',
    );
    expect(snapshot.images.find((image) => image.role === 'screenshot')?.captureRole).toBe(
      'screenshot',
    );
    expect(verifySnapshot(root, snapshot).images).toBe(6);
    const covers = datasetWorkCoverImages(root, snapshot);
    expect(covers.map((image) => image.role)).toEqual(['selected-cover']);
    expect(covers[0]?.url).toBe('https://t.vndb.org/cv/02/2.jpg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('media capture roles use explicit source meaning even when evidence is present', () => {
  const base: DatasetImage = {
    record: 'vndb:vn:v11',
    role: 'unknown',
    url: 'https://t.vndb.org/ch/01/1.jpg',
  };
  expect(normalizedCaptureRole(base)).toBe('other');
  expect(normalizedCaptureRole({ ...base, role: 'screenshot' })).toBe('screenshot');
  expect(
    normalizedCaptureRole({ ...base, role: 'portrait', url: 'https://t.vndb.org/cv/01/1.jpg' }),
  ).toBe('portrait');
  expect(electedDatasetCovers([{ ...base, role: 'candidate-cover' }])).toEqual([]);
});

test('independent captured rows for the same image keep their distinct source digests', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root);
    const source = vndb(root, owner, { vn_image_votes: ['v11\tu1\tcv4', 'v11\tu2\tcv4'] });
    const snapshot = await freezeSnapshot(owner, [source], 'all');
    const votes = snapshotMediaImages(root, snapshot).filter(
      (image) => image.role === 'candidate-cover',
    );
    expect(votes).toHaveLength(2);
    expect(new Set(votes.map((image) => image.sourceEvidence?.recordDigest)).size).toBe(2);
    expect(new Set(votes.map((image) => image.capture?.digest)).size).toBe(1);
    expect(datasetWorkCoverImages(root, snapshot).map((image) => image.role)).toEqual([
      'selected-cover',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bangumi captured subject and character JSON preserve endpoint roles and unknown art rights', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root),
      source = bangumi(root, owner, 'character');
    checkSources([source]);
    const snapshot = await freezeSnapshot(owner, [source], 'all');
    const [candidate] = datasetMediaCandidates(root, { snapshot, native: native(snapshot) });
    expect(candidate).toMatchObject({
      role: 'portrait',
      status: 'captured',
      reason: 'native-use-required',
      variant: null,
      rights: { basis: 'unknown', license: null, holder: null },
      sourceEvidence: { namespace: 'character', field: '/images/large', holder: null },
    });
    expect(candidate?.target).toBe(native(snapshot).get('bangumi:character:10')?.id);
    expect(() =>
      bangumiImageCandidate(
        { id: 10, images: { large: source.images[0]!.url } },
        'subject',
        'https://api.bgm.tv/v0/characters/10',
        'a'.repeat(64),
      ),
    ).toThrow('endpoint');

    const subjectOwner = acquisition(join(root, 'subject'));
    const subject = bangumi(join(root, 'subject'), subjectOwner, 'subject');
    const subjectSnapshot = await freezeSnapshot(subjectOwner, [subject], 'covers');
    expect(
      datasetMediaCandidates(join(root, 'subject'), {
        snapshot: subjectSnapshot,
        native: native(subjectSnapshot),
      })[0],
    ).toMatchObject({
      role: 'cover',
      status: 'captured',
      rights: { basis: 'unknown', license: null },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const defect of [
  'portrait relabeled screenshot',
  'character on subject endpoint',
  'subject on character endpoint',
  'unsupported namespace',
  'unsupported matching image field',
  'noncanonical response id type',
  'unofficial endpoint',
  'different canonical source page',
] as const) {
  test(`present Bangumi media evidence rejects ${defect}`, async () => {
    const root = temporary();
    try {
      const owner = acquisition(root);
      const source = bangumi(
        root,
        owner,
        defect === 'subject on character endpoint' ? 'subject' : 'character',
      );
      const image = source.images[0]!;
      const evidence = image.sourceEvidence!;
      const row = JSON.parse(readFileSync(blobPath(root, evidence.recordDigest), 'utf8'));
      if (defect === 'portrait relabeled screenshot') image.role = 'screenshot';
      else if (defect === 'character on subject endpoint')
        evidence.captureUrl = `https://api.bgm.tv/v0/subjects/${row.id}`;
      else if (defect === 'subject on character endpoint')
        evidence.captureUrl = `https://api.bgm.tv/v0/characters/${row.id}`;
      else if (defect === 'unsupported namespace') evidence.namespace = 'person';
      else if (defect === 'unsupported matching image field') {
        row.images.common = row.images.large;
        evidence.field = '/images/common';
      } else if (defect === 'noncanonical response id type') row.id = String(row.id);
      else if (defect === 'unofficial endpoint')
        evidence.captureUrl = `https://records.example.test/characters/${row.id}`;
      else {
        evidence.sourceUrl = `https://bgm.tv/character/999`;
        source.records[0]!.sourceUrl = evidence.sourceUrl;
      }
      // Each refusal has real retained fixture bytes with a matching hash and
      // matching URL pointer. The defect is the provider meaning, not corruption.
      const capture = retain(root, owner, evidence.captureUrl, Buffer.from(JSON.stringify(row)));
      evidence.recordDigest = capture.digest;
      expect(row.images[evidence.field.split('/').at(-1)!]).toBe(image.url);
      expect(() => verifyCoverSourceCapture(root, [...owner.captures.values()], image)).toThrow();
      await expect(freezeSnapshot(owner, [source], 'all')).rejects.toThrow();
      expect(
        [...owner.captures.values()].every((item) => item.mediaType === 'application/json'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('Bangumi merged-subject canonical identity survives present and legacy evidence verification', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root);
    const source = bangumi(root, owner, 'subject', 974);
    const snapshot = await freezeSnapshot(owner, [source], 'all');
    const expected = {
      record: 'bangumi:subject:975',
      role: 'cover',
      sourceEvidence: {
        captureUrl: 'https://api.bgm.tv/v0/subjects/974',
        namespace: 'subject',
        externalId: '975',
        sourceUrl: 'https://bgm.tv/subject/975',
        field: '/images/large',
        holder: null,
      },
    };
    expect(snapshotMediaImages(root, snapshot)[0]).toMatchObject(expected);
    const old = legacy(snapshot);
    const before = canonical(old);
    const indices = old.images.map((image, index) => [index, image.record, image.role, image.url]);
    const recovered = snapshotMediaImages(root, old);
    expect(recovered[0]).toMatchObject(expected);
    expect(recovered.map((image, index) => [index, image.record, image.role, image.url])).toEqual(
      indices,
    );
    expect(canonical(old)).toBe(before);
    expect(datasetMediaCandidates(root, { snapshot: old, native: native(old) })[0]).toMatchObject({
      role: 'cover',
      status: 'captured',
      variant: null,
      rights: { basis: 'unknown', license: null, holder: null },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a historically deduplicated legacy image recovers one retained witness without inventing occurrences', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root);
    const overrides = { vn_image_votes: ['v11\tu1\tcv4', 'v11\tu2\tcv4'] };
    const retained = vndb(root, owner, overrides);
    // Without new evidence fields, selectFate still projects the historical
    // {record,role,url} tuple and deduplicates it. Restore only its retained
    // archive link, as supplied by the historical fetchVndb producer.
    const source = selectFate(new VndbDump(tar(overrides)));
    source.scope = retained.scope;
    expect(source.images.filter((image) => image.role === 'candidate-cover')).toHaveLength(1);
    const old = legacy(await freezeSnapshot(owner, [source], 'all'));
    const before = canonical(old);
    const indices = old.images.map((image, index) => [index, image.record, image.role, image.url]);
    const recovered = snapshotMediaImages(root, old);
    const votes = recovered.filter((image) => image.role === 'candidate-cover');
    const witnesses = [...new VndbDump(tar(overrides)).rows('vn_image_votes')].map((row) =>
      sha256(canonical(row)),
    );
    expect(new Set(witnesses).size).toBe(2);
    expect(votes).toHaveLength(1);
    expect(witnesses).toContain(votes[0]!.sourceEvidence!.recordDigest);
    expect(votes[0]!.sourceEvidence!.derivation).toMatchObject({
      table: 'vn_image_votes',
      imageId: 'cv4',
    });
    verifyCoverSourceCapture(root, old.captures, votes[0]!);
    expect(recovered.map((image, index) => [index, image.record, image.role, image.url])).toEqual(
      indices,
    );
    expect(canonical(old)).toBe(before);
    // One witness proves the deduplicated image. It establishes no association
    // between indistinguishable occurrences or a contract for all supporting rows.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('frozen old snapshots repair only derivable evidence in a view and preserve source/native identity', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root);
    const frozen = await freezeSnapshot(
      owner,
      [vndb(root, owner), bangumi(root, owner, 'character')],
      'all',
    );
    const old = legacy(frozen),
      serialized = canonical(old);
    const path = join(root, 'snapshots', old.id, 'snapshot.json');
    atomicJson(path, old);
    const beforeBytes = readFileSync(path),
      before = readSnapshot(root, old.id);
    const ids = native(old),
      sourceIds = before.sources.flatMap((source) => source.records.map(datasetSourceIdentity));
    const repaired = snapshotMediaImages(root, before);
    expect(
      repaired
        .filter((image) => image.role === 'portrait')
        .every((image) => image.captureRole === 'portrait'),
    ).toBe(true);
    expect(repaired.find((image) => image.role === 'screenshot')?.captureRole).toBe('screenshot');
    expect(repaired.every((image) => image.sourceEvidence)).toBe(true);
    expect(canonical(before)).toBe(serialized);
    expect(readFileSync(path)).toEqual(beforeBytes);
    expect(readSnapshot(root, old.id).id).toBe(old.id);
    expect(before.sources.flatMap((source) => source.records.map(datasetSourceIdentity))).toEqual(
      sourceIds,
    );
    expect(native(before)).toEqual(ids);
    expect(verifySnapshot(root, before).images).toBe(7);
    expect(datasetWorkCoverImages(root, before).map((image) => image.role)).toEqual([
      'selected-cover',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source evidence rejects wrong archive, row, field, URL, role, holder and record identity', () => {
  const root = temporary();
  try {
    const owner = acquisition(root),
      source = vndb(root, owner);
    const portrait = source.images.find((image) => image.role === 'portrait')!;
    const mutations: Array<(image: DatasetImage) => void> = [
      (image) => {
        image.sourceEvidence!.derivation!.archiveDigest = 'f'.repeat(64);
      },
      (image) => {
        image.sourceEvidence!.recordDigest = 'f'.repeat(64);
      },
      (image) => {
        image.sourceEvidence!.field = '/description';
      },
      (image) => {
        image.url = 'https://t.vndb.org/ch/02/2.jpg';
      },
      (image) => {
        image.role = 'cover';
      },
      (image) => {
        image.sourceEvidence!.derivation!.table = 'vn';
      },
      (image) => {
        image.sourceEvidence!.holder = { name: 'Claimed owner', field: '/description' };
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(portrait);
      mutate(changed);
      expect(() => verifyCoverSourceCapture(root, [...owner.captures.values()], changed)).toThrow();
    }
    const second = bangumi(root, owner, 'character');
    const changed = structuredClone(second.images[0]!);
    changed.sourceEvidence!.externalId = '11';
    expect(() => verifyCoverSourceCapture(root, [...owner.captures.values()], changed)).toThrow(
      'different record',
    );
    writeFileSync(blobPath(root, [...owner.captures.values()][0]!.digest), 'corrupt archive');
    expect(() => verifyCoverSourceCapture(root, [...owner.captures.values()], portrait)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old snapshot without a retained derivation link stays unknown and never invents source evidence', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root);
    const source = vndb(root, owner);
    delete source.scope.url;
    delete source.scope.digest;
    const old = legacy(await freezeSnapshot(owner, [source], 'all'));
    const before = canonical(old);
    const images = snapshotMediaImages(root, old);
    expect(images.every((image) => image.sourceEvidence === undefined)).toBe(true);
    const candidates = datasetMediaCandidates(root, { snapshot: old, native: native(old) });
    expect(candidates.find((candidate) => candidate.role === 'portrait')).toMatchObject({
      status: 'pending',
      reason: 'missing-evidence',
      sourceEvidence: null,
      rights: { basis: 'unknown', license: null, holder: null },
    });
    expect(canonical(old)).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unacquired, missing and unelected media stay pending; a placeholder is never a mapped Use', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root, 'https://t.vndb.org/ch/01/1.jpg');
    const snapshot = await freezeSnapshot(owner, [vndb(root, owner)], 'all');
    const candidates = datasetMediaCandidates(root, { snapshot, native: native(snapshot) });
    expect(candidates.find((candidate) => candidate.role === 'portrait')).toMatchObject({
      status: 'pending',
      reason: 'acquisition-failed',
      acquisition: 'missing',
      capture: null,
    });
    expect(
      candidates.find((candidate) => candidate.sourceRole === 'candidate-cover'),
    ).toMatchObject({
      status: 'source-only',
      reason: 'unelected-cover',
    });
    const empty = await freezeSnapshot(owner, [snapshot.sources[0]!], 'none');
    expect(
      datasetMediaCandidates(root, { snapshot: empty, native: native(empty) }).find(
        (candidate) => candidate.role === 'portrait',
      ),
    ).toMatchObject({
      status: 'pending',
      reason: 'acquisition-failed',
      acquisition: 'not-captured',
      capture: null,
    });

    const dispositions: DatasetMappingDisposition[] = [];
    const selected = new Set(
      snapshot.sources.flatMap((source) => source.records).map((record) => record.key),
    );
    const coverage = datasetCoverage(snapshot, selected);
    for (const key of selected) coverage.retain(key);
    const coverIndex = snapshot.images.findIndex((image) => image.role === 'selected-cover');
    const cover = snapshot.images[coverIndex]!;
    const coverKey = {
      record: cover.record,
      kind: 'image' as const,
      path: `/images/${coverIndex}`,
    };
    // A prior acknowledged importer receipt is immutable. This models that
    // contract; fixture bytes and this stub receipt prove no actual media Use.
    coverage.disposition(coverKey, {
      status: 'mapped',
      reason: 'acknowledged-cover-selection',
      mapping: {
        target: native(snapshot).get(cover.record)!.id,
        readPath: '/v1/resources/00000000-0000-4000-8000-000000000001',
        receipt: { selection: '00000000-0000-4000-8000-000000000002' },
      },
    });
    const coverBefore = canonical(coverage.entries.get(datasetCoverageId(coverKey)));
    const context: DatasetMappingContext = {
      snapshot,
      native: native(snapshot),
      actingSubject: 'unused',
      records: new Map(
        snapshot.sources.flatMap((source) => source.records).map((record) => [record.key, record]),
      ),
      selected,
      command: async () => {
        throw new Error('No source-art upload bypass is allowed');
      },
      read: async () => {
        throw new Error('No public decode was proved');
      },
      source: () => {
        throw new Error('No replacement source identity is allowed');
      },
      disposition: (key, disposition) => {
        coverage.disposition(key, disposition);
        dispositions.push(disposition);
      },
    };
    await datasetMediaMapper(root).map(context);
    expect(dispositions).toHaveLength(2);
    expect(dispositions.some((disposition) => disposition.status === 'mapped')).toBe(false);
    expect(canonical(coverage.entries.get(datasetCoverageId(coverKey)))).toBe(coverBefore);
    expect(dispositions.some((disposition) => disposition.reason.includes('media-set-v1'))).toBe(
      true,
    );
    const emptyCoverage = datasetCoverage(empty, selected);
    for (const key of selected) emptyCoverage.retain(key);
    await datasetMediaMapper(root).map({
      ...context,
      snapshot: empty,
      disposition: emptyCoverage.disposition,
    });
    expect([...emptyCoverage.entries.values()].filter((entry) => entry.kind === 'image')).toEqual(
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bangumi subject enrichment retains already captured portraits without extra API acquisition', async () => {
  const root = temporary();
  try {
    const owner = acquisition(root),
      source = bangumi(root, owner, 'character');
    // No elected subjects: enrichment must preserve the retained portrait, without a new request.
    const enriched = await enrichBangumiSubjects(owner, source);
    expect(enriched.images).toEqual(source.images);
    expect(enriched.records).toEqual(source.records);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
