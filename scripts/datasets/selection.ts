import type { Capture } from './network.ts';
import type {
  DatasetEdge,
  DatasetImage,
  DatasetRecord,
  DatasetSnapshot,
  DatasetSource,
  StoredImage,
} from './types.ts';

export interface DatasetSelectionBudget {
  /** All input source, record, edge, image and capture occurrences, before indexing. */
  maxInputItems: number;
  maxRecords: number;
  maxEdges: number;
  /** Source image descriptors plus stored image occurrences; neither is deduplicated. */
  maxImages: number;
  /** Selected JSON payloads, scopes and retained capture descriptors, excluding blob bytes. */
  maxJsonBytes: number;
  /** Unique frozen image blobs that a consumer could transfer. No bytes are read here. */
  maxMediaBytes: number;
}

export interface DatasetSelectionOptions {
  roots: readonly string[];
  budget: DatasetSelectionBudget;
  /** Default 0: retain related Work records/edges without expanding their catalogues. */
  relatedWorkDepth?: number;
}

export interface DatasetSelectionLimit {
  code:
    | 'budget-exceeded'
    | 'invalid-input'
    | 'missing-root'
    | 'root-is-not-work'
    | 'missing-record'
    | 'source-frontier'
    | 'unknown-relationship'
    | 'missing-context'
    | 'missing-evidence-capture'
    | 'image-not-captured'
    | 'image-unavailable';
  /** Exact JSON Pointer in the immutable parent (or /options for caller limits). */
  at: string;
  detail: string;
  affects: 'selection' | 'knowledge' | 'media';
  budget?: keyof DatasetSelectionBudget;
  maximum?: number;
  observed?: number;
}

export interface DatasetSelectionManifest {
  profile: 'dataset-root-selection-v1';
  parent: { id: string; digest: string };
  roots: readonly string[];
  relatedWorkDepth: number;
  budget: DatasetSelectionBudget;
  inputItems: number;
  selected: {
    records: number;
    edges: number;
    images: number;
    storedImages: number;
    jsonBytes: number;
    mediaBytes: number;
  };
  /** Completeness is relative to the parent's elected surfaces, never the provider corpus. */
  coverage: {
    knowledge: 'complete' | 'incomplete' | 'not-evaluated';
    media: 'complete' | 'incomplete' | 'not-evaluated';
  };
  sources: {
    source: number;
    provider: DatasetSource['provider'];
    /** Unchanged capture scope, including source limitations and acquisition consistency. */
    scope: DatasetSource['scope'];
    /** Parent array indexes align with the selected arrays, preserving occurrences. */
    records: number[];
    edges: number[];
    images: number[];
    omitted: { records: number; edges: number; images: number };
  }[];
  storedImages: number[];
  /** Full records retained as endpoints; their unrelated neighbourhoods were not expanded. */
  references: string[];
  expandedWorks: string[];
  excluded: {
    at: string;
    reason: 'other-work-context' | 'related-work-expansion' | 'reference-neighbourhood';
  }[];
  limitations: DatasetSelectionLimit[];
}

/** A view of its parent, deliberately not a new DatasetSnapshot with a borrowed digest. */
export interface DatasetRootSelection {
  sources: DatasetSource[];
  captures: readonly Capture[];
  images: StoredImage[];
}

export type DatasetSelectionResult =
  | {
      status: 'complete' | 'incomplete';
      selection: DatasetRootSelection;
      manifest: DatasetSelectionManifest;
    }
  | { status: 'refused'; selection: null; manifest: DatasetSelectionManifest };

interface RecordLocation {
  record: DatasetRecord;
  source: number;
  index: number;
}
interface EdgeLocation {
  edge: DatasetEdge;
  source: number;
  index: number;
  context: string | null;
}

function workContext(source: DatasetSource, edge: DatasetEdge): string | null {
  if (source.provider === 'vndb' && edge.kind === 'voice-actor')
    return typeof edge.data.id === 'string' ? `vndb:vn:${edge.data.id}` : null;
  if (source.provider === 'bangumi' && edge.kind === 'voice')
    return typeof edge.data.subject_id === 'number' || typeof edge.data.subject_id === 'string'
      ? `bangumi:subject:${edge.data.subject_id}`
      : null;
  return null;
}

function contextual(source: DatasetSource, edge: DatasetEdge): boolean {
  return (
    (source.provider === 'vndb' && edge.kind === 'voice-actor') ||
    (source.provider === 'bangumi' && edge.kind === 'voice')
  );
}

function relatedWork(edge: DatasetEdge): boolean {
  return (
    edge.kind.startsWith('vn:') ||
    edge.kind.startsWith('subject-relation:') ||
    edge.kind === 'anime-adaptation'
  );
}

/** These records were explicitly captured as a frontier, even when their native type is Work. */
function capturedFrontier(source: DatasetSource): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown, prefix = '') => {
    if (Array.isArray(value))
      for (const key of value)
        if (typeof key === 'string' || typeof key === 'number') keys.add(`${prefix}${key}`);
  };
  if (source.provider === 'vndb') add(source.scope.referenceVns, 'vndb:vn:');
  if (source.provider === 'bangumi') {
    add(source.scope.referenceSubjectIds, 'bangumi:subject:');
    const frontier = source.scope.frontier;
    if (frontier && typeof frontier === 'object' && !Array.isArray(frontier))
      for (const value of Object.values(frontier)) add(value);
  }
  return keys;
}

const forwardKinds = new Set([
  'trait',
  'trait-group',
  'tag',
  'meta-tag',
  'tag-vote',
  'producer',
  'drm',
  'engine',
  'external-link',
  'wikidata',
  'affiliation',
  'speaker',
  'episode',
  'release',
  'track',
]);

function forward(edge: DatasetEdge): boolean {
  return (
    forwardKinds.has(edge.kind) ||
    edge.kind.startsWith('credit:') ||
    edge.kind.startsWith('staff:') ||
    edge.kind.startsWith('cast:') ||
    edge.kind.startsWith('reference:') ||
    edge.kind === 'parent' ||
    edge.kind === 'redirect'
  );
}

/**
 * Offline, deterministic preparation over an already verified, immutable capture.
 * Required closure is atomic under the budget: refusal returns no truncated view.
 * Records, edge occurrences, image descriptors and source scopes are never rewritten.
 * All parent captures remain evidence because dump rows need not have individual URLs.
 */
export function selectDatasetRoots(
  snapshot: Readonly<DatasetSnapshot>,
  options: DatasetSelectionOptions,
): DatasetSelectionResult {
  const depthLimit = options.relatedWorkDepth ?? 0;
  const manifest: DatasetSelectionManifest = {
    profile: 'dataset-root-selection-v1',
    parent: { id: snapshot.id, digest: snapshot.digest },
    roots: [...options.roots],
    relatedWorkDepth: depthLimit,
    budget: { ...options.budget },
    inputItems:
      options.roots.length +
      snapshot.sources.length +
      snapshot.captures.length +
      snapshot.images.length,
    selected: { records: 0, edges: 0, images: 0, storedImages: 0, jsonBytes: 0, mediaBytes: 0 },
    coverage: { knowledge: 'not-evaluated', media: 'not-evaluated' },
    sources: [],
    storedImages: [],
    references: [],
    expandedWorks: [],
    excluded: [],
    limitations: [],
  };
  const reported = new Set<string>();
  const report = (limit: DatasetSelectionLimit) => {
    const key = JSON.stringify([limit.code, limit.at, limit.detail]);
    if (!reported.has(key)) {
      reported.add(key);
      manifest.limitations.push(limit);
    }
  };
  const refuse = (): DatasetSelectionResult => ({ status: 'refused', selection: null, manifest });
  const stop = Symbol('selection-budget');
  const bound = (name: keyof DatasetSelectionBudget, observed: number, at: string) => {
    if (observed <= options.budget[name]) return;
    report({
      code: 'budget-exceeded',
      affects: 'selection',
      at,
      budget: name,
      maximum: options.budget[name],
      observed,
      detail: `${name} requires at least ${observed}; selection was refused without truncation.`,
    });
    throw stop;
  };
  const jsonBytes = (value: unknown, at: string) => {
    manifest.selected.jsonBytes += Buffer.byteLength(JSON.stringify(value));
    bound('maxJsonBytes', manifest.selected.jsonBytes, at);
  };
  const budgetNames: (keyof DatasetSelectionBudget)[] = [
    'maxInputItems',
    'maxRecords',
    'maxEdges',
    'maxImages',
    'maxJsonBytes',
    'maxMediaBytes',
  ];
  for (const name of budgetNames) {
    const value = options.budget[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      report({
        code: 'invalid-input',
        affects: 'selection',
        at: `/options/budget/${name}`,
        detail: 'Selection budgets must be nonnegative safe integers.',
      });
      return refuse();
    }
  }
  if (!options.roots.length || !Number.isSafeInteger(depthLimit) || depthLimit < 0) {
    report({
      code: 'invalid-input',
      affects: 'selection',
      at: '/options',
      detail: 'Select at least one root and a nonnegative integer relatedWorkDepth.',
    });
    return refuse();
  }
  try {
    bound('maxInputItems', manifest.inputItems, '/');
    for (const [index, source] of snapshot.sources.entries()) {
      manifest.inputItems += source.records.length + source.edges.length + source.images.length;
      bound('maxInputItems', manifest.inputItems, `/sources/${index}`);
    }
    if (
      new Set(snapshot.sources.map((source) => source.provider)).size !== snapshot.sources.length
    ) {
      report({
        code: 'invalid-input',
        affects: 'selection',
        at: '/sources',
        detail: 'Duplicate dataset providers.',
      });
      return refuse();
    }
    const records = new Map<string, RecordLocation>();
    const adjacency = new Map<string, EdgeLocation[]>();
    const edges: EdgeLocation[] = [];
    const frontiers = snapshot.sources.map(capturedFrontier);
    const imagesByRecord = new Map<
      string,
      { image: DatasetImage; source: number; index: number }[]
    >();
    const imageRecords = new Map<string, string[]>();
    const addAdjacent = (key: string, item: EdgeLocation) => {
      const list = adjacency.get(key) ?? [];
      list.push(item);
      adjacency.set(key, list);
    };
    for (const [sourceIndex, source] of snapshot.sources.entries()) {
      for (const [index, record] of source.records.entries()) {
        if (records.has(record.key) || record.provider !== source.provider) {
          report({
            code: 'invalid-input',
            affects: 'selection',
            at: `/sources/${sourceIndex}/records/${index}`,
            detail: `Duplicate or mismatched source identity: ${record.key}`,
          });
          return refuse();
        }
        records.set(record.key, { record, source: sourceIndex, index });
        if (record.kind === 'image') {
          const list = imageRecords.get(record.sourceUrl) ?? [];
          list.push(record.key);
          imageRecords.set(record.sourceUrl, list);
        }
      }
      for (const [index, edge] of source.edges.entries()) {
        const item = { edge, source: sourceIndex, index, context: workContext(source, edge) };
        edges.push(item);
        for (const key of new Set([edge.from, edge.to, ...(item.context ? [item.context] : [])]))
          addAdjacent(key, item);
      }
      for (const [index, image] of source.images.entries()) {
        const list = imagesByRecord.get(image.record) ?? [];
        list.push({ image, source: sourceIndex, index });
        imagesByRecord.set(image.record, list);
      }
    }
    const rootKeys = new Set(options.roots);
    for (const key of rootKeys) {
      const item = records.get(key);
      if (!item || item.record.native !== 'work') {
        report({
          code: item ? 'root-is-not-work' : 'missing-root',
          affects: 'selection',
          at: '/options/roots',
          detail: `Selected root is ${item ? 'not a Work' : 'absent from the parent'}: ${key}`,
        });
      }
    }
    if (manifest.limitations.length) return refuse();

    const selected = new Map<string, number>(); // Infinity is a reference, finite depth expands.
    const chosenEdges = new Set<EdgeLocation>();
    const chosenImages = new Set<DatasetImage>();
    const visitedEdges = new Set<EdgeLocation>();
    // Required edges cost zero expansion steps. Finish each depth before the next
    // so shared endpoints are expanded once at their nearest selected root.
    const queues = new Map<number, string[]>();
    const sourceBytes = new Set<number>();
    jsonBytes(snapshot.captures, '/captures');
    function retain(key: string, depth: number, at: string): void {
      const item = records.get(key);
      if (!item) {
        report({
          code: 'missing-record',
          affects: 'knowledge',
          at,
          detail: `Required source endpoint is absent: ${key}`,
        });
        return;
      }
      const previous = selected.get(key);
      if (previous !== undefined && previous <= depth) return;
      if (previous === undefined) {
        manifest.selected.records++;
        bound('maxRecords', manifest.selected.records, at);
        jsonBytes(item.record, `/sources/${item.source}/records/${item.index}`);
        if (!sourceBytes.has(item.source)) {
          sourceBytes.add(item.source);
          jsonBytes(snapshot.sources[item.source]!.scope, `/sources/${item.source}/scope`);
        }
        selected.set(key, depth);
        for (const { image, source, index } of imagesByRecord.get(key) ?? []) {
          // The descriptor's occurrence is counted even if a caller reused its object.
          chosenImages.add(image);
          manifest.selected.images++;
          bound('maxImages', manifest.selected.images, `/sources/${source}/images/${index}`);
          jsonBytes(image, `/sources/${source}/images/${index}`);
          for (const imageKey of imageRecords.get(image.url) ?? [])
            if (records.get(imageKey)?.source === source)
              retain(imageKey, Infinity, `/sources/${source}/images/${index}`);
        }
      } else selected.set(key, depth);
      if (Number.isFinite(depth)) {
        const queue = queues.get(depth) ?? [];
        queue.push(key);
        queues.set(depth, queue);
        if (frontiers[item.source]!.has(key))
          report({
            code: 'source-frontier',
            affects: 'knowledge',
            at: `/sources/${item.source}/records/${item.index}`,
            detail: `The parent captured ${key} as a reference frontier; its own catalogue was not completely acquired.`,
          });
      }
    }
    function keep(item: EdgeLocation, depth: number, boundary = false): void {
      const at = `/sources/${item.source}/edges/${item.index}`;
      if (!chosenEdges.has(item)) {
        chosenEdges.add(item);
        manifest.selected.edges++;
        bound('maxEdges', manifest.selected.edges, at);
        jsonBytes(item.edge, at);
      }
      for (const key of [item.edge.from, item.edge.to])
        retain(key, boundary ? (selected.get(key) ?? Infinity) : depth, at);
    }
    const activeWork = (key: string) =>
      Number.isFinite(selected.get(key) ?? Infinity) && records.get(key)?.record.native === 'work';
    for (const key of rootKeys) retain(key, 0, '/options/roots');
    for (let depth = 0; depth <= Math.min(depthLimit, records.size); depth++) {
      const queue = queues.get(depth) ?? [];
      for (let offset = 0; offset < queue.length; offset++) {
        const key = queue[offset]!;
        if (selected.get(key) !== depth) continue;
        const owner = records.get(key)!.record;
        for (const item of adjacency.get(key) ?? []) {
          const { edge, context } = item,
            source = snapshot.sources[item.source]!;
          const at = `/sources/${item.source}/edges/${item.index}`;
          visitedEdges.add(item);
          if (contextual(source, edge)) {
            if (context && !activeWork(context)) continue;
            if (!context)
              report({
                code: 'missing-context',
                affects: 'knowledge',
                at,
                detail: 'Voice occurrence has no captured Work context; no context was inferred.',
              });
            keep(item, context ? selected.get(context)! : depth);
            if (source.provider === 'vndb' && typeof edge.data.cid === 'string')
              retain(
                `vndb:character:${edge.data.cid}`,
                context ? selected.get(context)! : depth,
                at,
              );
          } else if (relatedWork(edge)) {
            if (!activeWork(key)) continue;
            keep(item, depth, true);
            const target = edge.from === key ? edge.to : edge.from;
            if (depth < depthLimit) {
              const targetRecord = records.get(target)?.record;
              if (targetRecord?.native === 'work') retain(target, depth + 1, at);
              else if (targetRecord)
                report({
                  code: 'source-frontier',
                  affects: 'knowledge',
                  at,
                  detail: `Related Work expansion cannot be completed: ${target} was captured as ${targetRecord.native}, without its own Work catalogue.`,
                });
            }
          } else if (['appearance', 'release-of', 'quote-from'].includes(edge.kind)) {
            if (edge.to === key && activeWork(key)) {
              keep(item, depth);
              if (
                source.provider === 'vndb' &&
                edge.kind === 'appearance' &&
                typeof edge.data.rid === 'string'
              )
                retain(`vndb:release:${edge.data.rid}`, depth, at);
            } else if (edge.from === key && edge.kind !== 'appearance') keep(item, depth, true);
            else if (edge.from === key && activeWork(edge.to)) keep(item, selected.get(edge.to)!);
          } else if (edge.kind.startsWith('person-relation:')) {
            keep(item, depth, true);
          } else if (edge.from === key) {
            if (
              edge.kind === 'character-version' ||
              edge.kind === 'supersedes' ||
              (edge.kind === 'parent' && owner.kind === 'producer')
            )
              keep(item, depth, true);
            else if (forward(edge)) keep(item, depth);
            else {
              keep(item, depth, true);
              report({
                code: 'unknown-relationship',
                affects: 'knowledge',
                at,
                detail: `Retained ${edge.kind} and its endpoints; its closure rule is unknown.`,
              });
            }
          } else if (!forward(edge) && !['character-version', 'supersedes'].includes(edge.kind)) {
            keep(item, depth, true);
            report({
              code: 'unknown-relationship',
              affects: 'knowledge',
              at,
              detail: `Retained incoming ${edge.kind} and its endpoints; its closure rule is unknown.`,
            });
          }
        }
      }
    }

    const selectedSources: DatasetSource[] = [];
    for (const [sourceIndex, source] of snapshot.sources.entries()) {
      const indexes: DatasetSelectionManifest['sources'][number] = {
        source: sourceIndex,
        provider: source.provider,
        scope: source.scope,
        records: [],
        edges: [],
        images: [],
        omitted: { records: 0, edges: 0, images: 0 },
      };
      const selectedRecords = source.records.filter((record, index) => {
        if (!selected.has(record.key)) return false;
        indexes.records.push(index);
        if (selected.get(record.key) === Infinity) manifest.references.push(record.key);
        else if (record.native === 'work' && !rootKeys.has(record.key))
          manifest.expandedWorks.push(record.key);
        return true;
      });
      if (!selectedRecords.length) continue;
      const selectedEdges = edges
        .filter((item) => item.source === sourceIndex && chosenEdges.has(item))
        .map((item) => {
          indexes.edges.push(item.index);
          return item.edge;
        });
      const selectedImages = source.images.filter((image, index) => {
        if (!chosenImages.has(image)) return false;
        indexes.images.push(index);
        return true;
      });
      indexes.omitted = {
        records: source.records.length - indexes.records.length,
        edges: source.edges.length - indexes.edges.length,
        images: source.images.length - indexes.images.length,
      };
      manifest.sources.push(indexes);
      selectedSources.push({
        ...source,
        roots: [...rootKeys].filter((key) => records.get(key)?.source === sourceIndex),
        records: selectedRecords,
        edges: selectedEdges,
        images: selectedImages,
      });
    }
    for (const item of edges) {
      const at = `/sources/${item.source}/edges/${item.index}`;
      if (chosenEdges.has(item)) continue;
      if (visitedEdges.has(item) && (item.context || item.edge.kind === 'appearance'))
        manifest.excluded.push({ at, reason: 'other-work-context' });
      else if (selected.has(item.edge.from) || selected.has(item.edge.to))
        manifest.excluded.push({ at, reason: 'reference-neighbourhood' });
    }
    // Related Work edges themselves survive. Only their target neighbourhood is optional.
    for (const key of manifest.references) {
      const item = records.get(key)!;
      if (item.record.native === 'work')
        manifest.excluded.push({
          at: `/sources/${item.source}/records/${item.index}`,
          reason: 'related-work-expansion',
        });
    }

    const storedImages = snapshot.images.filter((image, index) => {
      if (!selected.has(image.record)) return false;
      manifest.storedImages.push(index);
      manifest.selected.storedImages++;
      bound(
        'maxImages',
        manifest.selected.images + manifest.selected.storedImages,
        `/images/${index}`,
      );
      jsonBytes(image, `/images/${index}`);
      return true;
    });
    const blobs = new Set<string>();
    const captures = new Set(
      snapshot.captures.map((capture) => JSON.stringify([capture.url, capture.digest])),
    );
    const available = new Set<string>();
    const imageIdentity = (image: DatasetImage) =>
      JSON.stringify([image.record, image.role, image.url]);
    const evidence = (image: DatasetImage, at: string) => {
      if (
        image.sourceEvidence &&
        !captures.has(
          JSON.stringify([image.sourceEvidence.captureUrl, image.sourceEvidence.recordDigest]),
        )
      )
        report({
          code: 'missing-evidence-capture',
          affects: 'media',
          at,
          detail: 'Image source evidence does not resolve to a retained parent capture.',
        });
    };
    for (const [position, image] of storedImages.entries()) {
      const at = `/images/${manifest.storedImages[position]}`;
      available.add(imageIdentity(image));
      evidence(image, at);
      if (!image.capture)
        report({
          code: image.unavailable ? 'image-unavailable' : 'image-not-captured',
          affects: 'media',
          at,
          detail: image.unavailable
            ? `Frozen image acquisition returned HTTP ${image.unavailable.status}.`
            : 'The parent retained no image bytes for this occurrence.',
        });
      else if (!blobs.has(image.capture.digest)) {
        blobs.add(image.capture.digest);
        manifest.selected.mediaBytes += image.capture.bytes;
        bound('maxMediaBytes', manifest.selected.mediaBytes, at);
      }
    }
    for (const item of manifest.sources) {
      const source = snapshot.sources[item.source]!;
      for (const index of item.images) {
        const image = source.images[index]!,
          at = `/sources/${item.source}/images/${index}`;
        evidence(image, at);
        if (!available.has(imageIdentity(image)))
          report({
            code: 'image-not-captured',
            affects: 'media',
            at,
            detail:
              'The source descriptor survives, but this parent has no stored image occurrence.',
          });
      }
    }
    manifest.coverage = {
      knowledge: manifest.limitations.some((limit) => limit.affects === 'knowledge')
        ? 'incomplete'
        : 'complete',
      media: manifest.limitations.some((limit) => limit.affects === 'media')
        ? 'incomplete'
        : 'complete',
    };
    return {
      status: manifest.limitations.length ? 'incomplete' : 'complete',
      selection: { sources: selectedSources, captures: snapshot.captures, images: storedImages },
      manifest,
    };
  } catch (error) {
    if (error !== stop) throw error;
    return refuse();
  }
}
