import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DatasetApiError,
  localDatasetSession,
  type DatasetApi,
  type DatasetSession,
} from './auth.ts';
import { replayCommand } from '../lib/command-journal.ts';
import { atomicJson, canonical, sha256, verifiedBlob } from './store.ts';
import { checkedComponentState } from '../../services/main/src/modules/semantic/change.ts';
import { importedRightsAssessments } from '../../services/main/src/modules/rights/import-policy.ts';
import { acquireDatasetImportLock } from './lock.ts';
import { verifyCoverSourceCapture } from './snapshot.ts';
import { selectDatasetRoots, type DatasetSelectionManifest, type DatasetSelectionOptions } from './selection.ts';
import type { DatasetEdge, DatasetRecord, DatasetSnapshot } from './types.ts';
import { BANGUMI_USER_POST_FIELDS } from './bangumi.ts';

const SCHEMA = 'https://schema.org/';
const RV = 'https://rezics.com/vocab/';
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const short = (id: string) => id.slice(-36);
const clean = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .normalize('NFC')
    .trim();

/** A frozen snapshot is still input. Refuse community posts before retaining
 * bytes or issuing native writes, including snapshots made by older tooling. */
export function assertNoImportedUserPosts(records: readonly DatasetRecord[]): void {
  const userFields = new Set<string>(BANGUMI_USER_POST_FIELDS);
  const userKinds = new Set(['blog', 'blogs', 'post', 'posts', 'review', 'reviews', 'comment',
    'comments', 'user-post', 'user_post', 'discussion', 'thread', 'collection-comment']);
  const containsPost = (value: unknown): boolean => Array.isArray(value) ? value.some(containsPost)
    : value !== null && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
      userFields.has(key) || containsPost(child));
  for (const record of records) if (userKinds.has(record.kind.toLowerCase())
    || ['bangumi', 'vndb', 'open-library', 'project-gutenberg'].includes(record.provider) && containsPost(record.data)) {
    throw new Error('Dataset contains source user posts; capture only licensed catalogue records');
  }
}
/** Source language spelling belongs to provenance. Native typed labels use the
 * existing API's canonical BCP47 representation or explicitly undetermined. */
export function projectionLanguage(source: string): string {
  if (['', 'mul', 'other', 'unknown'].includes(source.toLowerCase())) return 'und';
  try {
    const canonical = Intl.getCanonicalLocales(source)[0];
    return canonical && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(canonical) ? canonical : 'und';
  } catch {
    return 'und';
  }
}
export interface ImportChunk {
  format: 'rezics-dataset-chunk-v1';
  digest: string;
  byteLength: number;
  index: number;
  count: number;
  encoding: 'base64';
  bytes: string;
}
/** Every retained part is independently valid JSON and below the existing intake ceiling.
 * Joining decoded bytes in index order recovers the exact canonical input, even across UTF-8 boundaries. */
export function intakeChunks(value: unknown): Buffer[] {
  const bytes = Buffer.from(canonical(value));
  if (bytes.length <= 65_536) return [bytes];
  const size = 47_000,
    count = Math.ceil(bytes.length / size),
    digest = sha256(bytes);
  return Array.from({ length: count }, (_, index) =>
    Buffer.from(
      canonical({
        format: 'rezics-dataset-chunk-v1',
        digest,
        byteLength: bytes.length,
        index,
        count,
        encoding: 'base64',
        bytes: bytes.subarray(index * size, (index + 1) * size).toString('base64'),
      } satisfies ImportChunk),
    ),
  );
}
export function reconstructIntake(chunks: readonly Uint8Array[]): unknown {
  if (!chunks.length) throw new Error('No retained source parts');
  const parsed = chunks.map(
    (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>,
  );
  if (parsed.length === 1 && parsed[0]!.format !== 'rezics-dataset-chunk-v1') return parsed[0];
  const first = parsed[0] as unknown as ImportChunk;
  if (first.count !== parsed.length) throw new Error('Incomplete retained source parts');
  const decoded = parsed.map((part, index) => {
    if (
      part.format !== first.format ||
      part.digest !== first.digest ||
      part.byteLength !== first.byteLength ||
      part.encoding !== 'base64' ||
      part.count !== first.count ||
      part.index !== index ||
      typeof part.bytes !== 'string'
    )
      throw new Error('Inconsistent retained source parts');
    const bytes = Buffer.from(part.bytes, 'base64');
    if (bytes.toString('base64') !== part.bytes)
      throw new Error('Invalid retained source encoding');
    return bytes;
  });
  const bytes = Buffer.concat(decoded);
  if (bytes.length !== first.byteLength || sha256(bytes) !== first.digest)
    throw new Error('Corrupt retained source parts');
  return JSON.parse(bytes.toString('utf8'));
}
export interface SemanticBatchItem {
  key: string;
  state: Record<string, unknown>;
}
/** Current API: 128 items, 8 pages of 16, 65,536 bytes/page and 524,288 total.
 * Elect a configurable bounded size; preparation and page bytes stay inside owner budgets.
 * Reserve envelope/allocation space before dispatch; no client-generated native IDs. */
export function nativeBatchSize(value = process.env.REZICS_DATASET_NATIVE_BATCH_ITEMS): number {
  if (value === undefined) return 16;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 128)
    throw new Error('REZICS_DATASET_NATIVE_BATCH_ITEMS must be an integer from 1 to 128');
  return Number(value);
}
export function semanticBatches(
  items: readonly SemanticBatchItem[],
  maximum = nativeBatchSize(),
): SemanticBatchItem[][] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 128)
    throw new Error('Native semantic batch size must be from 1 to 128');
  const batches: SemanticBatchItem[][] = [];
  let batch: SemanticBatchItem[] = [],
    pageBytes = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(canonical(item.state)) + 512;
    if (bytes > 60_000)
      throw new Error(`Native semantic item exceeds the existing page budget: ${item.key}`);
    if (batch.length === maximum || (batch.length % 16 !== 0 && pageBytes + bytes > 60_000)) {
      batches.push(batch);
      batch = [];
      pageBytes = 0;
    }
    if (batch.length % 16 === 0) pageBytes = 0;
    batch.push(item);
    pageBytes += bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
interface JournalEntry {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body: unknown;
  result?: Record<string, unknown>;
  /** Last Main response for a resumable media step, including refusals. */
  responseStatus?: number;
  phase?: 'cover-evidence' | 'cover-reserve' | 'cover-transfer' | 'cover-selection' | 'cover-read';
  /** Ordered source/child receipt keys bound to an atomic native batch. */
  itemKeys?: string[];
  receiptOnly?: boolean;
  cancelledProof?: {
    state?: string;
    admission: string | null;
    receipt?: string | null;
    dataEpoch?: string | null;
    stageCount: number;
    graphReceipt?: string;
    checkedAt?: string;
  };
  supersededBy?: string;
  rejectionProof?: {
    status: number;
    code: string;
    admission: null;
    stageCount: number;
    checkedAt: string;
  };
}
interface Journal {
  format: 'rezics-dataset-import-v1';
  snapshot: string;
  digest: string;
  mainOrigin: string;
  actingSubject: string;
  dataEpoch: string;
  entries: Record<string, JournalEntry>;
  native: Record<string, NativeRecord>;
  limitations: string[];
  completed: boolean;
}
interface NativeRecord {
  id: string;
  kind: string;
  receipt: Record<string, unknown>;
  urls: string[];
}
export interface DatasetImportOptions extends Partial<DatasetSession> {
  native?: boolean;
  nativeBatchItems?: number;
  locale?: string;
  progress?: (message: string) => void;
  /** Offline root closure, admitted in full before any public API command. */
  selection?: DatasetSelectionOptions;
  /** Legacy prefix limit when no root selection is requested. */
  maxRecords?: number;
  /** Project elected Work-to-Work graph evidence; every relationship is retained separately. */
  relationships?: boolean;
}
export interface DatasetImportResult {
  snapshot: string;
  dataEpoch: string;
  records: number;
  observations: number;
  nativeRecords: number;
  urlsFile: string;
  receiptFile: string;
  selectionFile?: string;
  selection?: DatasetSelectionManifest;
  limitations: string[];
  completed: boolean;
  nativeRelationships: number;
  /** Bounded outcomes for each elected cover; record is a stable hash, not a source URL. */
  coverResults: DatasetCoverImportResult[];
}

export class DatasetSelectionRefusedError extends Error {
  constructor(readonly manifest: DatasetSelectionManifest, readonly selectionFile: string) {
    super('Dataset root selection refused before public API commands');
    this.name = 'DatasetSelectionRefusedError';
  }
}

export type DatasetCoverImportStep =
  | 'target-work'
  | 'evidence-capture'
  | 'source-evidence'
  | 'reservation'
  | 'upload'
  | 'selection-read'
  | 'selection';

export type DatasetCoverImportReasonCode =
  | 'work-receipt-unavailable'
  | 'source-evidence-unavailable'
  | 'capture-unavailable'
  | 'cover-descriptor-invalid'
  | 'source-capture-invalid'
  | 'image-capture-invalid'
  | 'image-digest-mismatch'
  | 'holder-evidence-invalid'
  | 'source-evidence-too-large'
  | 'source-evidence-rejected'
  | 'source-evidence-invalid'
  | 'reservation-refused'
  | 'reservation-invalid'
  | 'upload-failed'
  | 'selection-intent-invalid'
  | 'selection-read-failed'
  | 'selection-refused'
  | 'fence-refused'
  | 'selection-receipt-invalid'
  | 'cover-api-unavailable';

export interface DatasetCoverImportResult {
  /** SHA-256 of the local record key; source identifiers and URLs stay out of diagnostics. */
  record: string;
  status: 'imported' | 'pending';
  step?: DatasetCoverImportStep;
  reasonCode?: DatasetCoverImportReasonCode;
  httpStatus?: number;
  /** Redacted problem type token, never the response URL or arbitrary response text. */
  problemType?: string;
}

async function request(
  api: DatasetApi,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  key?: string,
) {
  const response = await responseWithRetry(api, method, path,
    () => api.request(method, path, body, key));
  if (response.status === 202)
    throw new Error(`${method} ${path}: remains pending; rerun with the retained checkpoint`);
  if (response.status >= 300)
    throw new DatasetApiError(method, path, response.status, response.body);
  return response.body;
}

type ApiResponse = { status: number; body: Record<string, unknown> };

function responseCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    ? value
    : undefined;
}

/** Keep only the safe terminal token from a problem type; never persist or print its URL. */
function redactedProblemType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let token = value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      token = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    } else {
      token = value.split(':').at(-1) ?? '';
    }
  } catch {
    token = value.split(':').at(-1) ?? value;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token) ? token : undefined;
}

function refusalDetails(response?: ApiResponse): Pick<DatasetCoverImportResult, 'httpStatus' | 'problemType'> {
  if (!response || !Number.isInteger(response.status) || response.status < 300 || response.status > 599)
    return {};
  const problemType = redactedProblemType(response.body.type);
  return { httpStatus: response.status, ...(problemType ? { problemType } : {}) };
}

/** Retries uncertain replies with the same exact request identity and body. */
async function responseWithRetry(
  api: DatasetApi,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  send: () => Promise<ApiResponse>,
): Promise<ApiResponse> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let response: ApiResponse;
    try {
      response = await send();
    } catch (cause) {
      if (attempt === 7)
        throw new Error(`${method} ${path}: response lost; rerun to replay the recorded request`, {
          cause,
        });
      await (api.wait?.(100 * (attempt + 1)) ?? Bun.sleep(100 * (attempt + 1)));
      continue;
    }
    const movableRead =
      response.status === 409 &&
      (method === 'GET' || (method === 'POST' && path === '/v1/catalogue/candidates')) &&
      ['read_basis_changed', 'reading_position_moved'].includes(String(response.body.code));
    if (movableRead && attempt < 7) {
      await (api.wait?.(Math.min(4_000, 100 * 2 ** attempt)) ??
        Bun.sleep(Math.min(4_000, 100 * 2 ** attempt)));
      continue;
    }
    if ((response.status === 202 || response.status === 503) && attempt < 7) {
      await (api.wait?.(Math.min(4_000, 250 * 2 ** attempt)) ??
        Bun.sleep(Math.min(4_000, 250 * 2 ** attempt)));
      continue;
    }
    return response;
  }
  throw new Error(`${method} ${path}: remains pending; rerun with the retained checkpoint`);
}

async function transferWithRetry(api: DatasetApi, path: string, bytes: Uint8Array): Promise<ApiResponse> {
  if (!api.transfer) throw new Error('Dataset API has no bounded Main media transfer');
  return responseWithRetry(api, 'PUT', path, () => api.transfer!(path, bytes));
}

function responseReason(response: ApiResponse): string {
  const code = responseCode(response.body.code) ?? '';
  if (code === 'stale_head') return 'stale selection';
  if (/suppress|restrict|fenc/i.test(code)) return `restricted${code ? ` (${code})` : ''}`;
  if ([401, 403].includes(response.status)) return `denied${code ? ` (${code})` : ''}`;
  if ([502, 503, 504].includes(response.status)) return `owner unavailable${code ? ` (${code})` : ''}`;
  if (response.status === 413) return 'cover exceeds the Main upload limit';
  if (code) return `${code} (HTTP ${response.status})`;
  return `HTTP ${response.status}`;
}
function sourceEvidence(record: DatasetRecord) {
  if (record.provider === 'bangumi') return { basis: 'license' as const,
    note: `Bangumi contributors, ${record.sourceUrl}; CC BY-SA 3.0 https://creativecommons.org/licenses/by-sa/3.0/. Covers have separate rights; user posts are excluded.` };
  if (record.provider === 'vndb') return { basis: 'license' as const,
    note: `VNDB contributors, ${record.sourceUrl}; ODbL https://opendatacommons.org/licenses/odbl/1-0/ and DbCL https://opendatacommons.org/licenses/dbcl/1-0/. Field exceptions retained; descriptions and user posts are not published.` };
  return {
    basis: 'unknown' as const,
    note: `Frozen local development evidence from ${record.sourceUrl}; raw provider data and images retain their original rights. No redistribution permission is asserted.`,
  };
}
function nativeId(result: Record<string, unknown>, field: string): string {
  const value = result[field];
  if (typeof value !== 'string' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value)) {
    throw new Error(`Public API returned no valid ${field} identity`);
  }
  return value;
}
function nativeUrls(
  record: NativeRecord,
  main: string,
  web: string,
  locale: string,
  actor: string,
): string[] {
  const id = short(record.id),
    query = `?actingSubject=${encodeURIComponent(actor)}`;
  if (record.kind === 'work') return [`${web}/${locale}/w/${id}`, `${main}/v1/works/${id}${query}`];
  if (record.kind === 'agent') return [`${main}/v1/agents/${id}`];
  if (record.kind === 'concept')
    return [`${web}/${locale}/concepts/${id}`, `${main}/v1/concepts/${id}`];
  if (record.kind === 'release') return record.urls;
  return [
    `${web}/${locale}/e/${id}`,
    `${main}/v1/resources/${id}/page`,
    `${main}/v1/semantic/resources/${id}${query}`,
  ];
}
function receiptUrls(result: Record<string, unknown>, main: string, actor: string): string[] {
  const query = `?actingSubject=${encodeURIComponent(actor)}`,
    urls: string[] = [];
  if (typeof result.component === 'string') {
    urls.push(`${main}/v1/semantic/resources/${short(result.component)}${query}`);
    if (typeof result.revision === 'string')
      urls.push(
        `${main}/v1/semantic/resources/${short(result.component)}/revisions/${short(result.revision)}${query}`,
      );
  }
  if (typeof result.work === 'string' && typeof result.workRevision === 'string')
    urls.push(`${main}/v1/revisions/${short(result.workRevision)}${query}`);
  if (typeof result.mainVersion === 'string' && typeof result.mainRevision === 'string')
    urls.push(
      `${main}/v1/main-versions/${short(result.mainVersion)}/revisions/${short(result.mainRevision)}${query}`,
    );
  if (typeof result.occurrence === 'string')
    urls.push(`${main}/v1/relations/${short(result.occurrence)}${query}`);
  return urls;
}

function writeUrlIndex(
  root: string,
  snapshot: DatasetSnapshot,
  selected: DatasetRecord[],
  journal: Journal,
  session: DatasetSession,
  locale: string,
  context: string,
): string {
  const { mainOrigin, webOrigin, actingSubject } = session;
  const epoch = journal.dataEpoch;
  const urlsFile = join(root, 'urls.md');
  mkdirSync(root, { recursive: true });
  const lines = [
    `# Imported local dataset URLs`,
    '',
    `Snapshot: \`${snapshot.id}\``,
    '',
    `Product epoch: \`${epoch}\``,
    '',
    'Source observations require the importing Account. URLs use actual API-returned identities.',
    '',
    ...(journal.limitations.length
      ? ['## Mapping notes', '', ...journal.limitations.map((message) => `- ${message}`), '']
      : []),
  ];
  const observationsByRecord = new Map<string, string[]>();
  for (const [label, entry] of Object.entries(journal.entries)) {
    if (!label.startsWith('record:')) continue;
    const observation = entry.result?.observation as Record<string, unknown> | undefined;
    if (typeof observation?.observation !== 'string') continue;
    const key = label.slice('record:'.length, label.lastIndexOf(':part:'));
    const urls = observationsByRecord.get(key) ?? [];
    urls.push(`${mainOrigin}/v1/sources/observations/${short(observation.observation)}`);
    observationsByRecord.set(key, urls);
  }
  for (const record of selected) {
    if (!journal.native[record.key] && !observationsByRecord.has(record.key)) continue;
    lines.push(
      `### ${clean(record.title)
        .replace(/[#\[\]<>]/g, '')
        .replace(/\s+/g, ' ')} (${record.key})`,
      '',
    );
    const urls = new Set<string>([record.sourceUrl]);
    const mapped = journal.native[record.key];
    if (mapped) {
      for (const url of nativeUrls(mapped, mainOrigin, webOrigin, locale, actingSubject))
        urls.add(url);
      for (const url of receiptUrls(mapped.receipt, mainOrigin, actingSubject)) urls.add(url);
    }
    for (const url of observationsByRecord.get(record.key) ?? []) urls.add(url);
    for (const url of urls) lines.push(`- <${url}>`);
    lines.push('');
  }
  // Include independently created owner children/definitions and scope receipts.
  for (const [label, entry] of Object.entries(journal.entries).filter(
    ([label]) =>
      !label.startsWith('record:') &&
      !label.startsWith('native:') &&
      !label.startsWith('candidates:'),
  )) {
    const observation = entry.result?.observation as Record<string, unknown> | undefined;
    const urls = entry.result ? receiptUrls(entry.result, mainOrigin, actingSubject) : [];
    if (typeof entry.result?.component === 'string')
      urls.unshift(`${webOrigin}/${locale}/e/${short(entry.result.component)}`);
    if (observation && typeof observation.observation === 'string')
      urls.push(`${mainOrigin}/v1/sources/observations/${short(observation.observation)}`);
    if (urls.length) lines.push(`### ${clean(label)}`, '', ...urls.map((url) => `- <${url}>`), '');
  }
  const snapshotUrlsFile = join(root, `urls-${context}.md`);
  writeFileSync(snapshotUrlsFile, `${lines.join('\n')}\n`);
  const aggregated: string[] = [
    '# Imported local dataset URLs',
    '',
    'All captured snapshots imported into this API product epoch. Each section records its mapping limits.',
    '',
  ];
  for (const name of readdirSync(join(root, 'imports')).sort()) {
    if (!name.endsWith('.json')) continue;
    const retained = JSON.parse(readFileSync(join(root, 'imports', name), 'utf8')) as Journal;
    const index = join(root, `urls-${name.slice(0, -5)}.md`);
    if (
      retained.dataEpoch !== journal.dataEpoch ||
      retained.mainOrigin !== mainOrigin ||
      !existsSync(index)
    )
      continue;
    aggregated.push(
      `## Snapshot ${retained.snapshot}`,
      '',
      `[Per-import URL index](./urls-${name.slice(0, -5)}.md)`,
      '',
      readFileSync(index, 'utf8').replace(/^# Imported local dataset URLs\n/, ''),
    );
  }
  writeFileSync(urlsFile, `${aggregated.join('\n')}\n`);
  return urlsFile;
}

/** Optional, separate from seed. All product writes use mounted public HTTP contracts. */
export async function importDataset(
  root: string,
  snapshot: DatasetSnapshot,
  options: DatasetImportOptions = {},
): Promise<DatasetImportResult> {
  const parentRecords = snapshot.sources.flatMap((source) => source.records);
  assertNoImportedUserPosts(parentRecords);
  // A selection is a view, not a replacement snapshot. Refuse before session
  // lookup or even the catalogue read used to discover the product epoch.
  const selectionResult = options.selection ? selectDatasetRoots(snapshot, options.selection) : undefined;
  const selection = selectionResult?.manifest;
  const selectionFile = selection
    ? join(root, 'imports', 'selections', `${sha256(canonical(selection))}.json`) : undefined;
  if (selectionFile) atomicJson(selectionFile, selection);
  if (selectionResult?.status === 'refused')
    throw new DatasetSelectionRefusedError(selectionResult.manifest, selectionFile!);
  const view = selectionResult?.selection;
  const sources = view?.sources ?? snapshot.sources;
  const records = sources.flatMap((source) => source.records);
  const session =
    options.api && options.mainOrigin && options.webOrigin && options.actingSubject
      ? (options as DatasetSession)
      : await localDatasetSession();
  const { api, mainOrigin, actingSubject } = session;
  const locale = options.locale ?? 'zh-Hant';
  const allEdges = sources.flatMap((source) => source.edges);
  // Parent identities and envelopes keep their existing journal intent even
  // when a later call selects another view of the same frozen snapshot.
  const byKey = new Map(parentRecords.map((record) => [record.key, record]));
  const imagesByRecord = new Map<string, DatasetSnapshot['images']>();
  for (const image of snapshot.images) {
    const listed = imagesByRecord.get(image.record) ?? [];
    listed.push(image);
    imagesByRecord.set(image.record, listed);
  }
  const outgoing = new Map<string, DatasetEdge[]>(),
    neighbors = new Map<string, string[]>();
  for (const edge of snapshot.sources.flatMap((source) => source.edges))
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  for (const edge of allEdges) {
    if (!byKey.has(edge.from) || !byKey.has(edge.to))
      throw new Error(`Dataset has a missing relationship endpoint: ${edge.from} -> ${edge.to}`);
    neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
    neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
  }
  // The public catalogue read returns the current product epoch. A reset therefore
  // gets independent receipts, while reruns in the same epoch retain exact intent.
  const basis = await request(api, 'POST', '/v1/catalogue/candidates', {
    profile: 'catalogue-candidates-v1',
    originalTitle: { value: 'Local dataset import', language: 'en' },
    aliases: [],
    romanizations: [],
    creators: [],
    dates: [],
    identifiers: [],
  });
  const epoch = (basis.sourcePosition as { dataEpoch?: unknown } | undefined)?.dataEpoch;
  if (typeof epoch !== 'string') throw new Error('Public catalogue returned no product epoch');
  const context = sha256(
    canonical([mainOrigin, actingSubject, epoch, snapshot.id, snapshot.digest]),
  );
  const releaseLock = acquireDatasetImportLock(context);
  try {
    const receiptFile = join(root, 'imports', `${context}.json`);
    let journal: Journal = existsSync(receiptFile)
      ? (JSON.parse(readFileSync(receiptFile, 'utf8')) as Journal)
      : {
          format: 'rezics-dataset-import-v1',
          snapshot: snapshot.id,
          digest: snapshot.digest,
          mainOrigin,
          actingSubject,
          dataEpoch: epoch,
          entries: {},
          native: {},
          limitations: [],
          completed: false,
        };
    if (
      journal.digest !== snapshot.digest ||
      journal.dataEpoch !== epoch ||
      journal.mainOrigin !== mainOrigin ||
      journal.actingSubject !== actingSubject
    ) {
      throw new Error('Dataset import checkpoint belongs to another snapshot or API instance');
    }
    const entryDirectory = join(root, 'imports', context, 'requests');
    mkdirSync(entryDirectory, { recursive: true });
    for (const file of readdirSync(entryDirectory)) {
      if (!file.endsWith('.json')) continue;
      const saved = JSON.parse(readFileSync(join(entryDirectory, file), 'utf8')) as {
        label: string;
        entry: JournalEntry;
      };
      // Older interrupted clients could have cached a 202 reconciliation body.
      // It is an operation status, never an allocated native/source receipt.
      if (
        saved.entry.result?.status === 'reconciling' ||
        saved.entry.result?.status === 'pending'
      ) {
        delete saved.entry.result;
        atomicJson(join(entryDirectory, file), saved);
      }
      journal.entries[saved.label] = saved.entry;
    }
    // Each exact request has its own durable checkpoint. Rewriting a growing
    // full-payload journal after every one of tens of thousands of writes would
    // make routine preparation quadratic in bytes written.
    let dirty = 0;
    const save = (force = false) => {
      if (!force && ++dirty < 100) return;
      dirty = 0;
      atomicJson(receiptFile, {
        ...journal,
        entries: {},
        requestCount: Object.keys(journal.entries).length,
      });
    };
    const saveEntry = (label: string, entry: JournalEntry) =>
      atomicJson(join(entryDirectory, `${sha256(label)}.json`), { label, entry });
    journal.completed = false;
    save(true);
    const note = (message: string) => {
      if (!journal.limitations.includes(message)) {
        journal.limitations.push(message);
        save();
      }
    };
    const command = (label: string, method: 'GET' | 'POST' | 'PUT', path: string,
      body?: unknown, itemKeys?: string[]): Promise<Record<string, unknown>> => {
      const key = `dataset:${sha256(`${context}:${label}`)}`;
      // The first persisted request binds child IDs and search receipts before dispatch.
      return replayCommand<JournalEntry, Record<string, unknown>>({
        read: () => journal.entries[label],
        write: entry => { journal.entries[label] = entry; saveEntry(label, entry); },
      }, { method, path, body: body ?? null, outcome: 'result', changed: `Dataset request changed: ${label}`,
        ...(itemKeys ? { fields: { itemKeys } } : {}) },
      entry => request(api, entry.method, entry.path, entry.body ?? undefined,
        entry.method === 'GET' ? undefined : key));
    };
    /** Cover writes use the same immutable request journal, but are always replayed
     * against current owner fences before their prior receipt is accepted. */
    const coverCall = async (label: string, phase: JournalEntry['phase'],
      method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<ApiResponse> => {
      let entry = journal.entries[label];
      if (entry) {
        if (entry.method !== method || entry.path !== path
          || canonical(entry.body ?? null) !== canonical(body ?? null)) {
          throw new Error(`Dataset cover checkpoint changed: ${label}`);
        }
      } else {
        entry = { method, path, body: body ?? null, phase };
        journal.entries[label] = entry;
        saveEntry(label, entry);
        save(true);
      }
      entry.phase = phase;
      const key = method === 'GET' ? undefined : `dataset:${sha256(`${context}:${label}`)}`;
      const response = await responseWithRetry(api, method, path,
        () => api.request(method, path, body, key));
      entry.responseStatus = response.status;
      entry.result = response.body;
      saveEntry(label, entry);
      save(true);
      return response;
    };
    /** Transfer entries checkpoint only a local blob reference and digest. */
    const coverTransfer = async (label: string, path: string, digest: string,
      byteLength: number): Promise<ApiResponse> => {
      const intent = { blobDigest: digest, blobReference: `raw/blobs/${digest}`, byteLength };
      let entry = journal.entries[label];
      if (entry) {
        if (entry.method !== 'PUT' || entry.path !== path
          || canonical(entry.body ?? null) !== canonical(intent)) {
          throw new Error(`Dataset cover transfer checkpoint changed: ${label}`);
        }
      } else {
        entry = { method: 'PUT', path, body: intent, phase: 'cover-transfer' };
        journal.entries[label] = entry;
        saveEntry(label, entry);
        save(true);
      }
      entry.phase = 'cover-transfer';
      const bytes = verifiedBlob(root, digest);
      if (bytes.byteLength !== byteLength || sha256(bytes) !== digest)
        throw new Error(`Frozen cover bytes changed: ${digest}`);
      const response = await transferWithRetry(api, path, bytes);
      entry.responseStatus = response.status;
      entry.result = response.body;
      saveEntry(label, entry);
      save(true);
      return response;
    };
    const retained = async (label: string, record: DatasetRecord, value: unknown) => {
      const parts = intakeChunks(value),
        ids: string[] = [];
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        const response = await command(`${label}:part:${index}`, 'POST', '/v1/sources/intakes', {
          profile: 'source-manual-intake-v1',
          provider: record.provider,
          namespace: parts.length > 1 ? `${record.kind}-dataset-part` : record.kind,
          externalId: parts.length > 1 ? `${record.externalId}:part:${index}` : record.externalId,
          sourceRevision: snapshot.digest,
          mediaType: 'application/json',
          retention: 'retained',
          rawBytesBase64: part.toString('base64'),
          coverage: {
            scope:
              parts.length > 1
                ? 'complete-json-part-of-frozen-dataset-record'
                : 'exact-frozen-dataset-record-with-outgoing-relations',
            complete: parts.length === 1,
            omittedFields: [],
          },
          rightsEvidence: sourceEvidence(record),
        });
        const observation = response.observation as Record<string, unknown>;
        ids.push(nativeId(observation, 'observation'));
      }
      return ids;
    };
    const nativeRecord = (
      record: DatasetRecord,
      kind: string,
      result: Record<string, unknown>,
      field: string,
      urls: string[] = [],
    ) => {
      const mapped = { id: nativeId(result, field), kind, receipt: result, urls };
      journal.native[record.key] = mapped;
      save();
      return mapped;
    };
    // Child IDs are recoverable from the ordered atomic bulk receipt even if
    // the process stopped before writing individual registry entries.
    const registerBulkChildren = (entry: JournalEntry) => {
      if (!entry.result || !entry.itemKeys) return;
      const items = entry.result.items as Record<string, unknown>[];
      if (!Array.isArray(items) || items.length !== entry.itemKeys.length)
        throw new Error('Native bulk receipt has incomplete ordered identities');
      for (const [index, key] of entry.itemKeys.entries()) {
        const item = items[index]!;
        const result = {
          component: nativeId(item, 'component'),
          revision: nativeId(item, 'revision'),
          receipt: entry.result.receipt,
          sourcePosition: entry.result.sourcePosition,
          replayed: entry.result.replayed,
        };
        journal.entries[key] = {
          method: 'POST',
          path: '/v1/semantic/changes/bulk',
          body: null,
          receiptOnly: true,
          result,
        };
        saveEntry(key, journal.entries[key]!);
        if (key.startsWith('native:')) {
          const original = byKey.get(key.slice('native:'.length));
          if (original) nativeRecord(original, 'resource', result, 'component');
        }
      }
    };
    for (const [label, entry] of Object.entries(journal.entries)) {
      if (label.startsWith('native-bulk:') || label.startsWith('relationship-bulk:'))
        registerBulkChildren(entry);
    }
    const projectBulk = async (prefix: string, items: SemanticBatchItem[]) => {
      let effectiveMaximum = options.nativeBatchItems ?? nativeBatchSize();
      // Resolve every previous atomic request before repartitioning. A smaller
      // batch must never recreate an item from an ambiguous earlier activation.
      for (const [label, entry] of Object.entries(journal.entries)) {
        if (
          label.startsWith(`${prefix}:`) &&
          (entry.itemKeys?.length ?? 0) > 16 &&
          entry.cancelledProof?.state === 'cancelled' &&
          entry.cancelledProof.dataEpoch === epoch
        ) {
          effectiveMaximum = Math.min(effectiveMaximum, 16);
        }
        if (
          !label.startsWith(`${prefix}:`) ||
          entry.result ||
          !entry.itemKeys ||
          entry.supersededBy
        )
          continue;
        const key = `dataset:${sha256(`${context}:${label}`)}`;
        const status = await api.bulkStatus?.(key);
        if (status?.state === 'cancelled' && status.dataEpoch === epoch && status.receipt) {
          if (entry.itemKeys.length > 16) effectiveMaximum = Math.min(effectiveMaximum, 16);
          entry.cancelledProof = status;
          entry.supersededBy = 'retry-after-sealed-cancellation';
          saveEntry(label, entry);
          note(
            'A native bulk request was retried only after its same-Account owner receipt proved a sealed cancellation; the failed request and proof remain in the checkpoint.',
          );
        } else {
          try {
            await command(label, 'POST', '/v1/semantic/changes/bulk', entry.body, entry.itemKeys);
            registerBulkChildren(entry);
          } catch (error) {
            // The exact replay can seal an expired admission as cancelled. Read
            // that terminal outcome before replacing an intent; a timeout alone
            // never permits another creation key.
            const settled = await api.bulkStatus?.(key);
            const invalidProjection =
              error instanceof DatasetApiError &&
              error.status === 400 &&
              [
                'invalid_semantic_value',
                'invalid_semantic_change',
                'unsupported_semantic_value',
              ].includes(String(error.detail.code));
            if (
              invalidProjection &&
              settled?.state === 'unknown' &&
              settled.admission === null &&
              settled.stageCount === 0
            ) {
              entry.rejectionProof = {
                status: 400,
                code: String(error.detail.code),
                admission: null,
                stageCount: 0,
                checkedAt: new Date().toISOString(),
              };
              entry.supersededBy = 'retry-after-unadmitted-invalid-projection';
              saveEntry(label, entry);
              note(
                'Native label language codes are canonicalized for the existing API; source spelling remains unchanged. Rejected projection requests are retained and replaced only after HTTP400 and no owner admission/stage proof.',
              );
              continue;
            }
            if (settled?.state !== 'cancelled' || settled.dataEpoch !== epoch || !settled.receipt)
              throw error;
            if (entry.itemKeys.length > 16) effectiveMaximum = Math.min(effectiveMaximum, 16);
            entry.cancelledProof = settled;
            entry.supersededBy = 'retry-after-sealed-cancellation';
            saveEntry(label, entry);
          }
        }
      }
      const remaining = items.filter((item) => !journal.entries[item.key]?.result);
      for (const batch of semanticBatches(remaining, effectiveMaximum)) {
        for (const item of batch) checkedComponentState(item.state);
        const keys = batch.map((item) => item.key),
          fingerprint = sha256(canonical(keys));
        let label = `${prefix}:${fingerprint}`;
        if (journal.entries[label]?.supersededBy)
          label = `${prefix}:retry-v1:${fingerprint}:${sha256(canonical(batch.map((item) => item.state)))}`;
        await command(
          label,
          'POST',
          '/v1/semantic/changes/bulk',
          {
            profile: 'semantic-change-bulk-v1',
            actingSubject,
            items: batch.map((item) => item.state),
          },
          keys,
        );
        registerBulkChildren(journal.entries[label]!);
        save(true);
        options.progress?.(
          `Activated ${batch.length} source-qualified native resources in one atomic API batch`,
        );
      }
    };
    const selected =
      selection || options.maxRecords === undefined ? records : records.slice(0, options.maxRecords);
    const urlsFile = join(root, 'urls.md');
    const coverResults = new Map<string, DatasetCoverImportResult>();
    try {
      options.progress?.(
        `Retaining ${selected.length} source records and their complete outgoing relationships through the public intake API`,
      );
      // Source owner writes are independent PostgreSQL observations, so a small
      // bounded batch shortens intake without competing graph activation writes.
      for (let offset = 0; offset < selected.length; offset += 4) {
        const settled = await Promise.allSettled(
          selected.slice(offset, offset + 4).map((record) =>
            retained(`record:${record.key}`, record, {
              format: 'rezics-dataset-record-v1',
              snapshot: snapshot.id,
              digest: snapshot.digest,
              record,
              edges: outgoing.get(record.key) ?? [],
              images: imagesByRecord.get(record.key) ?? [],
            }),
          ),
        );
        const failed = settled.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        const completed = Math.min(offset + 4, selected.length);
        if (completed % 100 === 0 || completed === selected.length) {
          options.progress?.(`Retained ${completed}/${selected.length} records`);
          save(true);
        }
      }
      for (const source of snapshot.sources) {
        const record = source.records[0];
        if (record)
          await retained(
            `scope:${source.provider}:snapshot-manifest-v1`,
            { ...record, kind: 'dataset-scope', externalId: snapshot.id },
            {
              format: 'rezics-dataset-scope-v1',
              snapshot: snapshot.id,
              digest: snapshot.digest,
              provider: source.provider,
              roots: source.roots,
              scope: source.scope,
              intendedRecords: source.records.map((item) => item.key),
              totalRecords: source.records.length,
            },
          );
      }
      if (options.native !== false) {
        options.progress?.(
          'Mapping works and source-labelled people, organizations, characters and catalogue resources through existing owner APIs',
        );
        const workRecords = selected.filter((item) => item.native === 'work');
        let mappedWorks = workRecords.filter((record) => journal.native[record.key]).length;
        // Reconcile every retained import group before choosing fresh chunks.
        // Stable per-record keys make regrouped retries independent of batch size.
        const registerCatalogueItems = (entry: JournalEntry) => {
          const rows = entry.result?.items as { key: string; status: string; receipt?: Record<string, unknown> }[] | undefined;
          if (!rows || !entry.itemKeys || rows.length !== entry.itemKeys.length)
            throw new Error('Catalogue bulk result has incomplete ordered items');
          for (const [index, label] of entry.itemKeys.entries()) {
            const row = rows[index]!;
            if (row.key !== `dataset:${sha256(`${context}:${label}`)}`) throw new Error('Catalogue result item key differs from request');
            if (row.status !== 'succeeded' || !row.receipt) continue;
            const record = byKey.get(label.slice('native:'.length));
            if (!record) throw new Error('Catalogue result has no frozen source record');
            nativeRecord(record, 'work', row.receipt, 'work');
          }
          if (rows.some(row => row.status === 'pending')) {
            entry.result = undefined;
            throw new Error('Catalogue import has pending items; rerun the same retained request');
          }
          if (rows.some(row => row.status !== 'succeeded'))
            throw new Error('Catalogue import has rejected items; review the retained per-item outcomes');
        };
        for (const [label, entry] of Object.entries(journal.entries)) {
          if (!label.startsWith('catalogue-bulk:')) continue;
          try {
            if (!entry.result) await command(label, 'POST', '/v1/work-imports/bulk');
            registerCatalogueItems(entry);
          } finally { saveEntry(label, entry); }
        }
        const freshWorks = workRecords.filter(record => !journal.native[record.key] && !journal.entries[`native:${record.key}`]);
        const maximum = options.nativeBatchItems ?? nativeBatchSize();
        for (let start = 0; start < freshWorks.length; start += maximum) {
          const valid = freshWorks.slice(start, start + maximum).filter(record => {
            const title = clean(record.title);
            if (title && title.length <= 200) return true;
            note(`${record.key}: title exceeds the native Work bound; complete source retained`);
            return false;
          });
          if (!valid.length) continue;
          const itemKeys = valid.map(record => `native:${record.key}`);
          const label = `catalogue-bulk:${sha256(canonical(itemKeys))}`;
          const items = valid.map(record => ({
            key: `dataset:${sha256(`${context}:native:${record.key}`)}`,
            input: { profile: 'work-catalogue-import-v1', expectedWorkHead: null,
              title: clean(record.title), language: projectionLanguage(record.language),
              ...(record.provider === 'bangumi' && typeof record.data.summary === 'string'
                && clean(record.data.summary) && clean(record.data.summary).length <= 4000
                ? { description: { value: clean(record.data.summary), language: 'zh-Hans' } } : {}),
              evidence: `frozen-dataset:${snapshot.digest}:${record.key}`, aliases: [],
              semanticTypes: record.semanticTypes ?? [], credits: [], classifications: [] },
          }));
          try {
            await command(label, 'POST', '/v1/work-imports/bulk', { actingSubject, items }, itemKeys);
            registerCatalogueItems(journal.entries[label]!);
          } finally { saveEntry(label, journal.entries[label]!); }
          mappedWorks += valid.length;
          options.progress?.(`Mapped ${mappedWorks}/${workRecords.length} native Works`);
        }
        // Earlier journals retain their original candidate search/create request;
        // an uncertain old command is never replaced by the new import operation.
        for (const record of workRecords) {
          if (journal.native[record.key]) continue;
          const title = clean(record.title),
            language = projectionLanguage(record.language);
          if (!title || title.length > 200) {
            note(`${record.key}: title exceeds the native Work bound; complete source retained`);
            continue;
          }
          const label = `native:${record.key}`;
          let body = journal.entries[label]?.body;
          if (!body) {
            const search = await command(
              `candidates:${record.key}`,
              'POST',
              '/v1/catalogue/candidates',
              {
                profile: 'catalogue-candidates-v1',
                originalTitle: { value: title, language },
                aliases: [],
                romanizations: [],
                creators: [],
                dates: [],
                identifiers: [],
              },
            );
            body = {
              profile: 'metadata-only-v1',
              title,
              language,
              grain: 'new-creative-scope',
              actingSubject,
              candidateReceipt: search.candidateReceipt,
              ...(record.semanticTypes?.length ? { semanticTypes: record.semanticTypes } : {}),
            };
          }
          const result = await command(label, 'POST', '/v1/works', body);
          nativeRecord(record, 'work', result, 'work');
          mappedWorks++;
          if (mappedWorks % 25 === 0 || mappedWorks === workRecords.length)
            options.progress?.(`Mapped ${mappedWorks}/${workRecords.length} native Works`);
        }
        // Run on resumed journals too: a Work is not a completed import until
        // every display/export use retains the source's credit and licence.
        for (const record of workRecords) {
          const mapped = journal.native[record.key];
          if (!mapped || (record.provider !== 'bangumi' && record.provider !== 'vndb')) continue;
          const assessments = importedRightsAssessments({ provider: record.provider, url: record.sourceUrl },
            mapped.id, record.provider === 'bangumi' && typeof record.data.summary === 'string'
              && Boolean(clean(record.data.summary)) && clean(record.data.summary).length <= 4000);
          for (const [index, assessment] of assessments.entries()) {
            const label = `rights:${record.key}:${index}`;
            await command(label, 'POST', '/v1/rights/use-assessments', {
              profile: 'rights-use-assessment-v1', actingSubject, ...assessment,
              idempotencyKey: `dataset:${sha256(`${context}:${label}`)}`,
            });
          }
        }
        const sourceWorkKeys = new Map(
          Object.entries(journal.native)
            .filter(([, value]) => value.kind === 'work')
            .map(([key, value]) => [value.id, key]),
        );
        const linkedWorks = (key: string): string[] => {
          const visited = new Set([key]),
            pending = [key],
            found = new Set<string>();
          for (let depth = 0; depth < 3 && pending.length && !found.size; depth++) {
            const current = pending.splice(0);
            for (const node of current)
              for (const adjacent of neighbors.get(node) ?? []) {
                const mapped = journal.native[adjacent];
                if (mapped?.kind === 'work') found.add(mapped.id);
                else if (!visited.has(adjacent)) {
                  visited.add(adjacent);
                  pending.push(adjacent);
                }
              }
          }
          return [...found].sort((left, right) => {
            const leftKey = sourceWorkKeys.get(left) ?? left;
            const rightKey = sourceWorkKeys.get(right) ?? right;
            return leftKey.localeCompare(rightKey);
          });
        };
        const resourceItems: SemanticBatchItem[] = [];
        for (const record of selected.filter((item) =>
          ['character', 'concept', 'episode', 'release', 'person', 'organization'].includes(
            item.native,
          ),
        )) {
          if (journal.native[record.key]) continue;
          const title = clean(record.title);
          if (!title || title.length > 8_000) {
            note(`${record.key}: no admitted native label; complete source retained`);
            continue;
          }
          const works = linkedWorks(record.key);
          if (!works.length) {
            note(`${record.key}: no captured Work correspondence; complete source retained`);
            continue;
          }
          const televisionEpisode =
            record.native === 'episode' &&
            (neighbors.get(record.key) ?? []).some((key) =>
              byKey.get(key)?.semanticTypes?.includes(`${SCHEMA}TVSeries`),
            );
          const type =
            record.native === 'character'
              ? `${RV}Character`
              : record.native === 'concept'
                ? `${SCHEMA}DefinedTerm`
                : record.native === 'episode'
                  ? televisionEpisode
                    ? `${SCHEMA}TVEpisode`
                    : `${RV}SourceDatasetEpisode`
                  : record.native === 'person'
                    ? `${SCHEMA}Person`
                    : record.native === 'organization'
                      ? `${SCHEMA}Organization`
                      : `${SCHEMA}PublicationEvent`;
          const properties: unknown[] = [
            {
              predicate: `${SCHEMA}name`,
              value: {
                kind: 'language-string',
                language: projectionLanguage(record.language),
                lexical: title,
              },
            },
            {
              predicate: `${SCHEMA}identifier`,
              value: {
                kind: 'external',
                provider: record.provider,
                namespace: record.kind,
                key: record.externalId,
              },
            },
            { predicate: `${SCHEMA}url`, value: { kind: 'string', lexical: record.sourceUrl } },
            ...works
              .slice(0, 1)
              .map((ref) => ({ predicate: `${RV}semanticWork`, value: { kind: 'resource', ref } })),
          ];
          resourceItems.push({
            key: `native:${record.key}`,
            state: { component: 'resource', lifecycle: 'active', types: [type], properties },
          });
          if (record.native === 'concept')
            note(
              'Source tags/traits are descriptive DefinedTerm resources, preserving source labels and identity. Accepted native vocabulary/classification is not asserted by this import.',
            );
          if (record.native === 'release')
            note(
              'Source release records are descriptive PublicationEvent resources. Exact source platforms, versions, languages and release coverage remain in retained evidence; no native release/realization equivalence is asserted.',
            );
          if (works.length > 1)
            note(
              'Generic source resources use one representative Work solely as a visibility anchor, selected by source identity. Every actual source relationship and qualifier remains complete in retained source evidence; additional visibility anchors are not emitted as relationship claims.',
            );
        }
        await projectBulk('native-bulk', resourceItems);
        if (options.relationships !== false) {
          const graphEdges = allEdges.filter(
            (edge) =>
              journal.native[edge.from]?.kind === 'work' &&
              journal.native[edge.to]?.kind === 'work',
          );
          options.progress?.(
            `Projecting ${graphEdges.length} source-qualified relationships into native resources`,
          );
          const relationshipItems: SemanticBatchItem[] = [];
          for (const edge of graphEdges) {
            const label = `relationship:${sha256(canonical(edge))}`;
            if (journal.entries[label]?.result) continue;
            const owner =
              journal.native[edge.from]?.kind === 'work'
                ? journal.native[edge.from]!.id
                : journal.native[edge.to]?.kind === 'work'
                  ? journal.native[edge.to]!.id
                  : (linkedWorks(edge.from)[0] ?? linkedWorks(edge.to)[0]);
            if (!owner) continue;
            const endpoint = (key: string) => {
              const mapped = journal.native[key],
                original = byKey.get(key)!;
              // Source-only endpoints retain their provider identity.
              return mapped && mapped.kind !== 'agent'
                ? { kind: 'resource', ref: mapped.id }
                : {
                    kind: 'external',
                    provider: original.provider,
                    namespace: original.kind,
                    key: original.externalId,
                  };
            };
            relationshipItems.push({
              key: label,
              state: {
                component: 'resource',
                lifecycle: 'active',
                types: [`${RV}DatasetSourceRelation`],
                properties: [
                  { predicate: `${SCHEMA}name`, value: { kind: 'string', lexical: edge.kind } },
                  { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: owner } },
                  { predicate: `${RV}datasetSourceFrom`, value: endpoint(edge.from) },
                  { predicate: `${RV}datasetSourceTo`, value: endpoint(edge.to) },
                  {
                    predicate: `${RV}datasetSourceKind`,
                    value: { kind: 'string', lexical: edge.kind },
                  },
                  {
                    predicate: `${RV}datasetEvidenceDigest`,
                    value: { kind: 'string', lexical: sha256(canonical(edge)) },
                  },
                  {
                    predicate: `${RV}datasetSnapshot`,
                    value: { kind: 'string', lexical: snapshot.id },
                  },
                  {
                    predicate: `${RV}datasetSourceQualifiers`,
                    value: {
                      kind: 'string',
                      lexical:
                        Buffer.byteLength(canonical(edge.data)) <= 7_500
                          ? canonical(edge.data)
                          : `retained-source-json-sha256:${sha256(canonical(edge.data))}`,
                    },
                  },
                ],
              },
            });
          }
          await projectBulk('relationship-bulk', relationshipItems);
        }
        note(
          'Elected Work-to-Work relationships are labelled evidence resources, preserving direction, source identity and qualifiers. Accepted classifications, cross-provider merges, native episode compositions and exact realizations require their existing review/owner flows. Every remaining relationship is retained as complete source evidence; it is not expanded into artificial native graph records.',
        );
      }
      const selectedKeys = new Set(selected.map(record => record.key));
      for (const image of view?.images ?? snapshot.images) {
        if (image.captureRole !== 'cover') continue;
        const record = byKey.get(image.record);
        if (!record || !selectedKeys.has(image.record)) continue;
        const recordDigest = sha256(record.key);
        const pending = (reason: string, step: DatasetCoverImportStep,
          reasonCode: DatasetCoverImportReasonCode, response?: ApiResponse) => {
          const details = refusalDetails(response);
          coverResults.set(record.key, { record: recordDigest, status: 'pending', step, reasonCode, ...details });
          const log = `Imported cover ${recordDigest.slice(0, 16)} pending step=${step} reason=${reasonCode}`
            + (details.httpStatus ? ` HTTP ${details.httpStatus}` : '')
            + (details.problemType ? ` problem=${details.problemType}` : '');
          (options.progress ?? console.info)(log);
          note(`cover pending ${recordDigest.slice(0, 16)} (${reason})`);
        };
        const mapped = journal.native[image.record];
        if (mapped?.kind !== 'work' || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(mapped.id)) {
          pending('native Work receipt unavailable', 'target-work', 'work-receipt-unavailable');
          continue;
        }
        const source = image.sourceEvidence;
        if (!source) {
          pending('source evidence unavailable', 'source-evidence', 'source-evidence-unavailable');
          continue;
        }
        const capture = image.capture;
        if (image.missing || image.unavailable || !capture) {
          pending(image.missing ? 'capture missing' : 'capture unavailable', 'evidence-capture', 'capture-unavailable');
          continue;
        }
        if (!SHA256.test(snapshot.digest) || !SHA256.test(capture.digest) || !SHA256.test(source.recordDigest)
          || typeof source.provider !== 'string' || !source.provider
          || typeof source.namespace !== 'string' || !source.namespace
          || typeof source.externalId !== 'string' || !source.externalId
          || typeof source.sourceName !== 'string' || !source.sourceName
          || typeof source.field !== 'string' || (!source.field.startsWith('/') && source.field !== '')
          || /~(?![01])/.test(source.field) || typeof source.sourceUrl !== 'string'
          || !/^https:\/\//.test(source.sourceUrl)
          || (source.revision !== null && typeof source.revision !== 'string')
          || typeof source.captureUrl !== 'string' || typeof image.url !== 'string'
          || !/^https:\/\//.test(source.captureUrl) || !/^https:\/\//.test(image.url)
          || capture.url !== image.url
          || typeof capture.mediaType !== 'string' || !capture.mediaType.startsWith('image/')
          || !Number.isSafeInteger(capture.bytes) || capture.bytes < 1
          || capture.bytes > MAX_COVER_BYTES) {
          pending(capture.bytes > MAX_COVER_BYTES ? 'capture exceeds the Work cover limit' : 'cover descriptor is invalid',
            'evidence-capture', capture.bytes > MAX_COVER_BYTES ? 'image-capture-invalid' : 'cover-descriptor-invalid');
          continue;
        }
        try {
          verifyCoverSourceCapture(root, snapshot.captures, image);
        } catch {
          pending('source record capture is unavailable or corrupt', 'evidence-capture', 'source-capture-invalid');
          continue;
        }
        let frozenBytes: Buffer;
        try {
          frozenBytes = verifiedBlob(root, capture.digest);
        } catch {
          pending('frozen capture is unavailable or corrupt', 'evidence-capture', 'image-capture-invalid');
          continue;
        }
        if (frozenBytes.byteLength !== capture.bytes || sha256(frozenBytes) !== capture.digest) {
          pending('frozen capture digest differs', 'evidence-capture', 'image-digest-mismatch');
          continue;
        }
        const holderEvidence = source.holder
          ? { name: source.holder.name, fieldLocator: source.holder.field }
          : null;
        if (holderEvidence && (typeof holderEvidence.name !== 'string' || !holderEvidence.name
          || typeof holderEvidence.fieldLocator !== 'string'
          || (!holderEvidence.fieldLocator.startsWith('/') && holderEvidence.fieldLocator !== '')
          || /~(?![01])/.test(holderEvidence.fieldLocator))) {
          pending('holder evidence is invalid', 'evidence-capture', 'holder-evidence-invalid');
          continue;
        }
        const envelope = {
          profile: 'source-cover-evidence-v1',
          source: {
            provider: source.provider,
            namespace: source.namespace,
            externalId: source.externalId,
            sourceRevision: source.revision,
            component: null,
            datasetSnapshotDigest: snapshot.digest,
            recordDigest: source.recordDigest,
            fieldLocator: source.field,
            displayName: source.sourceName,
            href: source.sourceUrl,
          },
          image: {
            captureUrl: capture.url,
            captureDigest: capture.digest,
            byteLength: capture.bytes,
            mediaType: capture.mediaType,
          },
          holderEvidence,
        };
        const envelopeBytes = Buffer.from(canonical(envelope));
        if (envelopeBytes.byteLength > 65_536) {
          pending('cover evidence exceeds the Source intake limit', 'source-evidence', 'source-evidence-too-large');
          continue;
        }
        const candidate = sha256(canonical({
          record: image.record,
          provider: source.provider,
          namespace: source.namespace,
          externalId: source.externalId,
          field: source.field,
          captureDigest: capture.digest,
        }));
        const label = `cover:${candidate}:${mapped.id}`;
        const evidenceBody = {
          profile: 'source-manual-intake-v1',
          provider: source.provider,
          namespace: source.namespace,
          externalId: source.externalId,
          sourceRevision: source.revision,
          mediaType: 'application/json',
          retention: 'retained',
          rawBytesBase64: envelopeBytes.toString('base64'),
          coverage: { scope: 'cover-evidence', complete: false, omittedFields: ['description'] },
          rightsEvidence: sourceEvidence(record),
        };
        let activeStep: DatasetCoverImportStep = 'source-evidence';
        try {
          const evidenceReply = await coverCall(`${label}:evidence`, 'cover-evidence', 'POST',
            '/v1/sources/intakes', evidenceBody);
          if (evidenceReply.status >= 300) {
            pending(responseReason(evidenceReply), 'source-evidence', 'source-evidence-rejected', evidenceReply);
            continue;
          }
          const retained = evidenceReply.body.observation as Record<string, unknown> | undefined;
          if (!retained || typeof retained.byteDigest !== 'string'
            || retained.byteDigest !== sha256(envelopeBytes)) {
            pending('Source did not return the retained cover evidence digest', 'source-evidence', 'source-evidence-invalid');
            continue;
          }
          const sourceRecordId = nativeId(retained, 'record');
          const sourceObservationId = nativeId(retained, 'observation');
          const provenance = {
            format: 'media-imported-cover-v1',
            targetWork: mapped.id,
            source: {
              record: sourceRecordId,
              component: null,
              observation: sourceObservationId,
              provider: source.provider,
              namespace: source.namespace,
              externalId: source.externalId,
              sourceRevision: source.revision,
              observationDigest: retained.byteDigest,
              datasetSnapshotDigest: snapshot.digest,
              recordDigest: source.recordDigest,
              fieldLocator: source.field,
              displayName: source.sourceName,
              href: source.sourceUrl,
            },
            image: {
              captureUrl: capture.url,
              captureDigest: capture.digest,
              byteLength: capture.bytes,
              mediaType: capture.mediaType,
            },
            originalDigest: capture.digest,
            holderEvidence,
          };
          const reserveBody = {
            profile: 'media-image-upload-v1',
            asset: null,
            mediaType: capture.mediaType,
            byteLength: capture.bytes,
            sha256: capture.digest,
            disclosure: 'public',
            actingSubject,
            importedCover: provenance,
          };
          activeStep = 'reservation';
          const reserve = await coverCall(`${label}:reserve`, 'cover-reserve', 'POST',
            '/v1/media/uploads', reserveBody);
          if (reserve.status >= 300) {
            pending(responseReason(reserve), 'reservation', 'reservation-refused', reserve);
            continue;
          }
          const asset = reserve.body.asset;
          const upload = reserve.body.upload;
          const uploadUrl = reserve.body.uploadUrl;
          if (typeof asset !== 'string' || !UUID.test(asset)
            || typeof upload !== 'string' || !UUID.test(upload)
            || uploadUrl !== `/v1/media/uploads/${upload}/bytes`) {
            pending('Main returned an invalid upload reservation', 'reservation', 'reservation-invalid');
            continue;
          }
          activeStep = 'upload';
          const transferred = await coverTransfer(`${label}:transfer`, uploadUrl, capture.digest, capture.bytes);
          if (transferred.status >= 300 || transferred.body.status !== 'activated'
            || transferred.body.clearance === 'rejected'
            || typeof transferred.body.representation !== 'string') {
            pending(responseReason(transferred), 'upload', 'upload-failed', transferred);
            continue;
          }
          const selectionLabel = `${label}:selection`;
          const priorSelection = journal.entries[selectionLabel];
          let selectionBody: Record<string, unknown>;
          if (priorSelection) {
            if (!priorSelection.body || typeof priorSelection.body !== 'object'
              || Array.isArray(priorSelection.body)) {
              pending('saved cover selection intent is invalid', 'selection', 'selection-intent-invalid');
              continue;
            }
            selectionBody = priorSelection.body as Record<string, unknown>;
            if (selectionBody.profile !== 'resource-avatar-selection-v1'
              || selectionBody.asset !== asset || selectionBody.actingSubject !== actingSubject
              || (selectionBody.expectedSelection !== null
                && (typeof selectionBody.expectedSelection !== 'string' || !UUID.test(selectionBody.expectedSelection)))) {
              pending('saved cover selection intent does not match its asset or target', 'selection', 'selection-intent-invalid');
              continue;
            }
          } else {
            activeStep = 'selection-read';
            const read = await coverCall(`${label}:read`, 'cover-read', 'GET',
              `/v1/resources/${short(mapped.id)}?actingSubject=${encodeURIComponent(actingSubject)}`);
            if (read.status >= 300 || read.body.status !== 'available') {
              pending(read.status >= 300 ? responseReason(read) : 'Work summary unavailable', 'selection-read',
                'selection-read-failed', read.status >= 300 ? read : undefined);
              continue;
            }
            const avatar = read.body.avatar as Record<string, unknown> | undefined;
            let expectedSelection: string | null;
            if (avatar?.kind === 'fallback') expectedSelection = null;
            else if (avatar?.kind === 'image' && typeof avatar.selection === 'string'
              && UUID.test(avatar.selection)) expectedSelection = avatar.selection;
            else {
              pending('current Work cover selection is unavailable', 'selection-read', 'selection-read-failed');
              continue;
            }
            selectionBody = {
              profile: 'resource-avatar-selection-v1',
              expectedSelection,
              asset,
              actingSubject,
            };
          }
          activeStep = 'selection';
          const selectedCover = await coverCall(selectionLabel, 'cover-selection', 'PUT',
            `/v1/resources/${short(mapped.id)}/avatar`, selectionBody);
          if (selectedCover.status === 409 && selectedCover.body.code === 'stale_head') {
            pending('stale selection; the current editor cover was preserved', 'selection', 'fence-refused', selectedCover);
            continue;
          }
          if (selectedCover.status >= 300 || typeof selectedCover.body.selection !== 'string') {
            pending(selectedCover.status >= 300 ? responseReason(selectedCover) : 'Main returned no selection receipt',
              'selection', selectedCover.status >= 300 ? 'selection-refused' : 'selection-receipt-invalid',
              selectedCover.status >= 300 ? selectedCover : undefined);
          } else {
            coverResults.set(record.key, { record: recordDigest, status: 'imported' });
          }
        } catch {
          pending('cover API unavailable', activeStep, 'cover-api-unavailable');
        }
      }
      journal.completed = selected.length === records.length;
      save(true);
    } finally {
      save(true);
      writeUrlIndex(root, snapshot, selected, journal, session, locale, context);
    }
    const result: DatasetImportResult = {
      snapshot: snapshot.id,
      dataEpoch: epoch,
      records: selected.length,
      observations: Object.values(journal.entries).filter((entry) => entry.result?.observation)
        .length,
      nativeRecords: Object.keys(journal.native).length,
      nativeRelationships: Object.entries(journal.entries).filter(
        ([label, entry]) => label.startsWith('relationship:') && entry.result,
      ).length,
      urlsFile,
      receiptFile,
      ...(selectionFile ? { selectionFile, selection } : {}),
      limitations: journal.limitations,
      completed: journal.completed,
      coverResults: [...coverResults.values()],
    };
    atomicJson(join(root, 'import-latest.json'), result);
    return result;
  } finally {
    releaseLock();
  }
}
