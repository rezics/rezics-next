import { canonical, sha256 } from '../store.ts';
import { datasetRecordDigest } from './context.ts';
import type {
  DatasetCoverageKey, DatasetMapperId, DatasetMappingDisposition, DatasetMappingReceipt, DatasetSnapshot,
} from '../types.ts';

export const DATASET_NATIVE_MAPPERS: readonly DatasetMapperId[] = [
  'fields', 'relations', 'credits', 'releases', 'media',
];

export interface DatasetCoverageEntry extends DatasetCoverageKey {
  recordDigest: string;
  valueDigest: string;
  observation: 'present' | 'empty' | 'unavailable';
  acquisition?: 'not-acquired' | 'captured' | 'missing' | 'unavailable';
  disposition: DatasetMappingDisposition;
  /** Additional acknowledged supports do not discard the earlier receipt. */
  mappings?: DatasetMappingReceipt[];
}

export interface DatasetCoverageReport {
  format: 'rezics-dataset-coverage-v1';
  snapshot: string;
  digest: string;
  selectedRecords: string[];
  transportCompleted: boolean;
  catalogueReady: boolean;
  pendingMappers: DatasetMapperId[];
  counts: Record<DatasetMappingDisposition['status'], number>;
  /** Roots without even an acknowledged native user fact cannot be ready. */
  rootsWithoutNativeFacts: string[];
  /** Real source candidates and frozen images whose acquisition is incomplete. */
  pendingAcquisitions: DatasetCoverageKey[];
  entries: DatasetCoverageEntry[];
}

export function datasetCoverageId(key: DatasetCoverageKey): string {
  return canonical([key.record, key.kind, key.path]);
}

function emptyReason(value: unknown): string | undefined {
  if (value === null) return 'source-null';
  if (value === '') return 'source-empty-string';
  if (Array.isArray(value) && !value.length) return 'source-empty-array';
  if (value && typeof value === 'object' && !Object.keys(value).length) return 'source-empty-object';
  return undefined;
}

/** Disposable inventory of observed occurrences. It makes no adoption or rights decision. */
export function datasetCoverage(snapshot: DatasetSnapshot, selected: ReadonlySet<string>) {
  const entries = new Map<string, DatasetCoverageEntry>();
  const records = new Map(snapshot.sources.flatMap(source => source.records).map(record => [record.key, record]));
  const recordDigests = new Map([...records].map(([key, record]) => [key, datasetRecordDigest(record)]));
  const retained = new Set<string>();
  const add = (key: DatasetCoverageKey, value: unknown, unavailable = false,
    acquisition?: DatasetCoverageEntry['acquisition']) => {
    const record = records.get(key.record);
    if (!record) throw new Error(`Coverage has no source record: ${key.record}`);
    const empty = emptyReason(value);
    const observation = unavailable ? 'unavailable' : empty ? 'empty' : 'present';
    entries.set(datasetCoverageId(key), {
      ...key, recordDigest: recordDigests.get(record.key)!, valueDigest: sha256(canonical(value)), observation,
      ...(acquisition ? { acquisition } : {}),
      disposition: observation === 'empty' ? { status: 'absent', reason: empty! }
        : { status: 'unmapped', reason: !selected.has(key.record) ? 'outside-selected-slice'
          : acquisition === 'not-acquired' ? 'source-image-not-acquired'
          : unavailable ? 'acquisition-failed' : 'pending-native-mapping' },
    });
  };
  const walk = (record: string, path: string, value: unknown) => {
    add({ record, kind: 'field', path }, value);
    if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
      walk(record, `${path}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`, child);
    }
  };
  for (const record of records.values()) {
    for (const name of ['title', 'language', 'externalId', 'sourceUrl', 'data'] as const)
      walk(record.key, `/${name}`, record[name]);
    if (record.semanticTypes !== undefined) walk(record.key, '/semanticTypes', record.semanticTypes);
  }
  const imageIdentity = (image: { record: string; role: string; url: string }) =>
    canonical([image.record, image.role, image.url]);
  const acquired = new Map(snapshot.images.map(image => [imageIdentity(image), image]));
  for (const [sourceIndex, source] of snapshot.sources.entries()) {
    for (const [index, edge] of source.edges.entries())
      add({ record: edge.from, kind: 'edge', path: `/sources/${sourceIndex}/edges/${index}` }, edge);
    for (const [index, image] of source.images.entries()) {
      const stored = acquired.get(imageIdentity(image));
      add({ record: image.record, kind: 'source-image', path: `/sources/${sourceIndex}/images/${index}` },
        image, false, !stored ? 'not-acquired' : stored.missing ? 'missing'
          : stored.unavailable || !stored.capture ? 'unavailable' : 'captured');
    }
  }
  for (const [index, image] of snapshot.images.entries())
    add({ record: image.record, kind: 'image', path: `/images/${index}` }, image,
      image.missing || Boolean(image.unavailable) || !image.capture,
      image.missing ? 'missing' : image.unavailable || !image.capture ? 'unavailable' : 'captured');

  const disposition = (key: DatasetCoverageKey, value: DatasetMappingDisposition) => {
    const entry = entries.get(datasetCoverageId(key));
    if (!entry) throw new Error(`Disposition has no observed source occurrence: ${datasetCoverageId(key)}`);
    if (!value.reason.trim()) throw new Error('Coverage disposition requires a reason');
    if (value.status === 'absent' && entry.observation !== 'empty')
      throw new Error('A present, zero, false or unavailable observation is not absent');
    if (value.status === 'source-only' && !retained.has(key.record))
      throw new Error('Source-only disposition requires retained source evidence');
    if (value.status === 'mapped') {
      const { target, readPath, receipt } = value.mapping;
      if (!/^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target)
        || !readPath.startsWith('/v1/') || readPath.startsWith('/v1/sources/')
        || !receipt || !Object.keys(receipt).length)
        throw new Error('Mapped disposition requires an exact native receipt and consuming read');
      if (!retained.has(key.record)) throw new Error('Mapped disposition requires retained source evidence');
      if (entry.observation === 'unavailable' || entry.acquisition === 'not-acquired'
        || entry.acquisition === 'missing' || entry.acquisition === 'unavailable')
        throw new Error('Unavailable source evidence is not a native mapping');
    }
    if (entry.disposition.status === 'mapped'
      && (value.status !== 'mapped' || value.mapping.target !== entry.disposition.mapping.target))
      throw new Error('An acknowledged mapping identity cannot be replaced');
    if (value.status === 'mapped') {
      const mappings = entry.mappings ?? [];
      if (!mappings.some(mapping => canonical(mapping) === canonical(value.mapping)))
        entry.mappings = [...mappings, structuredClone(value.mapping)];
    }
    entry.disposition = structuredClone(value);
  };

  return {
    entries,
    disposition,
    retain(record: string) { retained.add(record); },
    report(transportCompleted: boolean, completedMappers: ReadonlySet<DatasetMapperId>): DatasetCoverageReport {
      const counts: DatasetCoverageReport['counts'] = { mapped: 0, 'source-only': 0, unmapped: 0, absent: 0 };
      const nativeFacts = new Set<string>();
      for (const entry of entries.values()) {
        counts[entry.disposition.status]++;
        if (entry.disposition.status === 'mapped') nativeFacts.add(entry.record);
      }
      const pendingMappers = DATASET_NATIVE_MAPPERS.filter(id => !completedMappers.has(id));
      const rootsWithoutNativeFacts = [...new Set(snapshot.sources.flatMap(source => source.roots))]
        .filter(root => !nativeFacts.has(root));
      const pendingAcquisitions = [...entries.values()]
        .filter(entry => selected.has(entry.record) && entry.acquisition && entry.acquisition !== 'captured')
        .map(({ record, kind, path }) => ({ record, kind, path }));
      return {
        format: 'rezics-dataset-coverage-v1', snapshot: snapshot.id, digest: snapshot.digest,
        selectedRecords: [...selected],
        transportCompleted, catalogueReady: transportCompleted && !pendingMappers.length
          && counts.unmapped === 0 && !rootsWithoutNativeFacts.length && !pendingAcquisitions.length,
        pendingMappers, counts, rootsWithoutNativeFacts, pendingAcquisitions, entries: [...entries.values()],
      };
    },
  };
}
