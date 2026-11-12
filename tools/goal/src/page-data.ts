import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  watch as watchFs,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { processTreeMembers } from '../../../scripts/check-custody.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { matchesPath } from './briefs.ts';
import { defaultPolicy } from './policy.ts';
import type { Settings, Task } from './types.ts';
import { ensureFlow, recordFlow } from './flow.ts';
import type { ManagerInbox } from './contracts.ts';
import { CHECK_SLICE, WORKER_SCOPE_MEMORY_MAX, workerScopeArguments } from './worker-slice.ts';

export const PAGE_DATA_CLASSES = ['DATA', 'EMPTY', 'UNAUTHORIZED', 'UNAVAILABLE', 'API', 'WEB', 'SEED'] as const;
export type PageDataClass = (typeof PAGE_DATA_CLASSES)[number];
export const PAGE_DATA_DEFECTS: ReadonlySet<PageDataClass> = new Set(['API', 'WEB', 'SEED']);
const previousHealthy = new Set<PageDataClass>(['DATA', 'EMPTY', 'UNAUTHORIZED', 'UNAVAILABLE']);
const pageDataTaskId = 'page-data';

const pageDataSeedProducerFiles = [
  'scripts/datasets/cross-media-seed.ts',
  'services/importer/src/cross-media-seed.ts',
  'services/importer/src/showcase-*.ts',
  'services/importer/tests/showcase-*.test.ts',
  'services/importer/README.md',
  'services/importer/seed-diagnostics.md',
];

const subjectRelationNativePaths = new Set(['/v1/subjects/{subject}/relations', '/v1/subjects/{subject}/links']);
const subjectRelationProducerFiles = [
  'services/kernel/src/semantic/http/subjects.ts',
  'services/kernel/src/semantic/current-relations.ts',
  'services/kernel/src/semantic/current-relations-*.sql',
  'services/kernel/src/semantic/links.ts',
  'services/kernel/src/semantic/list-*-links*.sql',
  'services/kernel/test/semantic/context-relations.test.ts',
  'services/kernel/test/semantic/subjects-http.test.ts',
  'services/kernel/test/semantic/growth-relations.test.ts',
];

type PageDataPolicy = typeof defaultPolicy.pageData;
type PageManifest = {
  version: 1;
  pages: {
    id: string;
    path: string;
    seedIdentity?: { provider: 'bangumi' | 'vndb'; sourceKey: string; nativeType: string; namespace?: string };
    personas?: string[];
    sections: {
      id: string;
      name: string;
      personas?: string[];
      native: { path: string };
      sql?: { text: string };
    }[];
  }[];
};
export type PageDataSection = {
  page: string;
  persona: string;
  section: string;
  name: string;
  class: PageDataClass;
  goal: string;
  files: string[];
  nativePath?: string;
  firstErrorLine?: string;
  unrun?: PageDataUnrunEvidence;
  nativeProblem?: PageDataNativeProblem;
};
type PageDataNativeProblem = { code?: string; pointer?: string };
export type PageDataUnrunEvidence =
  | {
      version: 1;
      reason: 'member-authority-unavailable';
      scopes: string[];
      probes: { native: 'unrun' };
    }
  | PageDataSeedUnrunEvidence;
export type PageDataSeedUnrunEvidence = {
  version: 1;
  provider: 'bangumi' | 'vndb';
  sourceKey: string;
  nativeType: string;
  namespace?: string;
  artifact: string;
  collection?: string;
  reason:
    | 'artifact-missing'
    | 'artifact-invalid'
    | 'source-key-missing'
    | 'identity-missing'
    | 'identity-invalid'
    | 'ambiguous'
    | 'native-type-mismatch';
  probes: { web: 'unrun'; native: 'unrun'; sql: 'unrun' | 'not-declared' };
};
export type PageDataRun = {
  runId: number;
  at: string;
  head: string;
  classes: Record<PageDataClass, number>;
  sections: PageDataSection[];
  seed?: PageDataSeedStatus;
  coverage?: { status: 'incomplete' };
};
export type PageDataSeedPublicationStatus = { status: 'publication-incomplete'; omissions: number };
export type PageDataSeedStatus = PageDataSeedPublicationStatus | { status: 'admission-deferred' };
export type PageDataSeedExecution<T> = { status: 'completed'; value: T } | { status: 'admission-deferred' };
export type PageDataSeedAdmission = {
  isPaused: () => boolean;
  watch: (onChange: () => void) => () => void;
};
export type PageDataRepair = {
  repairKey: string;
  section: PageDataSection;
  previousClass: PageDataClass;
  owner?: Task;
  head: string;
  reconcileRiskRefusal?: true;
  additional?: { repairKey: string; section: PageDataSection; previousClass: PageDataClass }[];
};
export function pageDataRepairEvidence(repair: PageDataRepair): string {
  const additional = repair.additional ?? [];
  return [
    `page-data-repair-key: ${repair.repairKey}`,
    `Integrated head: ${repair.head}`,
    `Section: ${repair.section.page}/${repair.section.persona}/${repair.section.section}`,
    `Class: ${repair.section.class} (previously ${repair.previousClass})`,
    `First error line: ${repair.section.firstErrorLine ?? 'unavailable'}`,
    '',
    ...additional.flatMap((cause) => [
      `page-data-repair-key: ${cause.repairKey}`,
      `Section: ${cause.section.page}/${cause.section.persona}/${cause.section.section}`,
      `Class: ${cause.section.class} (previously ${cause.previousClass})`,
      `First error line: ${cause.section.firstErrorLine ?? 'unavailable'}`,
      '',
    ]),
    additional.length
      ? 'Repair these sections in the same task and continue the retained provider session.'
      : 'Repair this section in the same task and continue the retained provider session.',
    '',
  ].join('\n');
}

export function isPageDataRiskRefusal(reason: unknown): reason is string {
  return typeof reason === 'string' && /^declared paths touch undeclared risk area: [a-z0-9_-]+$/.test(reason);
}

export type PageDataRepairRoute =
  | 'resumed'
  | 'dispatched'
  | {
      status: 'refused';
      reason: string;
    };
type PageDataRepairTarget = Pick<PageDataSection, 'goal' | 'files'> & {
  producer?: 'cross-media-seed' | 'subject-relations';
};

/** Route known producer defects by the native probe contract while retaining the observed consumer. */
export function pageDataRepairTarget(section: PageDataSection): PageDataRepairTarget {
  if (section.class === 'SEED')
    return { goal: 'imports', files: pageDataSeedProducerFiles, producer: 'cross-media-seed' };
  if (section.class === 'API' && section.nativePath && subjectRelationNativePaths.has(section.nativePath))
    return { goal: 'semantic', files: subjectRelationProducerFiles, producer: 'subject-relations' };
  return section;
}

type PageDataStackResult = {
  output: string;
  exitCode: number;
  registry?: ReadonlyMap<string, SectionConfig>;
  stackOutput?: string;
  diagnostics?: string;
  seed?: PageDataSeedStatus;
  scopeLimitExceeded?: boolean;
  scopeKilled?: boolean;
};

export type PageDataOptions = {
  settings: Settings;
  db: Database;
  tasks: Pick<import('./store.ts').WorkerStore, 'tasks'>;
  inbox: Pick<ManagerInbox, 'deliver'>;
  routeDefect: (repair: PageDataRepair) => Promise<PageDataRepairRoute>;
  now?: () => Date;
  runStack?: (head: string, invocation: string) => Promise<PageDataStackResult>;
};

export type SectionConfig = Pick<
  PageDataSection,
  'page' | 'persona' | 'section' | 'name' | 'goal' | 'files' | 'nativePath'
>;
type CommitChange = { commit: string; position: number; files: string[] };
type StackConfig = {
  version: 1;
  databasePort: number;
  searchPort: number;
  webPort: number;
  issuerPort: number;
  nativePort: number;
  kernelPort: number;
  dependenciesHead?: string;
};
type StackFailurePhase = 'boot' | 'check';

export class PageDataStackError extends Error {
  constructor(
    readonly phase: StackFailurePhase,
    message: string,
    readonly firstErrorLine = safeLine(message),
    readonly output = '',
  ) {
    super(message);
    this.name = 'PageDataStackError';
  }
}

function assertPreparedPageDataHead(preparedHead: string, currentHead: string): void {
  if (preparedHead !== currentHead)
    throw new PageDataStackError(
      'boot',
      `Page-data Definitions source moved before reconciliation: prepared dev head=${preparedHead}; ` +
        `current dev head=${currentHead}; refusing stale activation`,
    );
}

/** Reconcile the exact prepared dev source before resuming a seeded stack or starting importer work. */
export async function runPageDataSeedBoundary<T>(
  preparedHead: string,
  preparedReleaseFile: string,
  captureCurrentRelease: () => Buffer,
  reconcile: (head: string) => Promise<void>,
  seedOrResume: () => Promise<T>,
): Promise<T> {
  let preparedRelease: Buffer;
  try {
    preparedRelease = readFileSync(preparedReleaseFile);
  } catch (error) {
    throw new PageDataStackError(
      'boot',
      `Page-data Definitions release input unavailable: prepared dev head=${preparedHead}; ` +
        `could not read ${preparedReleaseFile}: ${errorMessage(error)}`,
    );
  }

  let currentRelease: Buffer;
  try {
    currentRelease = captureCurrentRelease();
  } catch (error) {
    throw new PageDataStackError(
      'boot',
      `Page-data Definitions release input unavailable: prepared dev head=${preparedHead}; ` +
        `could not capture current dev release: ${errorMessage(error)}`,
    );
  }
  if (!preparedRelease.equals(currentRelease))
    throw new PageDataStackError(
      'boot',
      `Page-data Definitions release changed before reconciliation: prepared dev head=${preparedHead}; ` +
        `prepared sha256=${createHash('sha256').update(preparedRelease).digest('hex')}; ` +
        `current dev sha256=${createHash('sha256').update(currentRelease).digest('hex')}; refusing stale activation`,
    );

  await reconcile(preparedHead);
  return seedOrResume();
}

/** Run only the cross-media seed command under the existing host-admission brake. */
export async function runPageDataSeedWithAdmission<T>(
  admission: PageDataSeedAdmission,
  run: (signal: AbortSignal) => Promise<PageDataSeedExecution<T>>,
): Promise<PageDataSeedExecution<T>> {
  const controller = new AbortController();
  const check = () => {
    if (!controller.signal.aborted && admission.isPaused()) controller.abort();
  };
  const unwatch = admission.watch(check);
  try {
    check();
    if (controller.signal.aborted) return { status: 'admission-deferred' };
    return await run(controller.signal);
  } finally {
    unwatch();
  }
}

/** Follow the pressure state already maintained by launch admission; no timer or new admission loop is added. */
export function pageDataSeedAdmission(stateDirectory: string): PageDataSeedAdmission {
  const pressureFile = join(stateDirectory, 'capacity-pressure.json');
  return {
    isPaused: () => {
      try {
        const value = JSON.parse(readFileSync(pressureFile, 'utf8')) as { paused?: unknown };
        return value.paused === true;
      } catch {
        return false;
      }
    },
    watch: (onChange) => {
      const watcher = watchFs(stateDirectory, { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === 'capacity-pressure.json') onChange();
      });
      return () => watcher.close();
    },
  };
}

const seedArtifactHandoffPrefix = 'Cross-media seed artifact handoff ';
const pageDataArtifactLimit = 64 * 1024 * 1024;

/** Admit only the seed owner's post-write publication refusal for this cycle's expected result file. */
export function pageDataSeedStatus(
  exitCode: number,
  output: string,
  expectedArtifact: string,
): PageDataSeedPublicationStatus | undefined {
  const markers = output.split(/\r?\n/u).filter((line) => line.startsWith(seedArtifactHandoffPrefix));
  if (markers.length > 1)
    throw new PageDataStackError('boot', 'page-data seed emitted multiple artifact handoffs', undefined, output);
  let omissions: unknown;
  if (markers.length === 1) {
    let value: unknown;
    try {
      value = JSON.parse(markers[0]!.slice(seedArtifactHandoffPrefix.length));
    } catch {
      throw new PageDataStackError('boot', 'page-data seed emitted an invalid artifact handoff', undefined, output);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new PageDataStackError('boot', 'page-data seed emitted an invalid artifact handoff', undefined, output);
    const handoff = value as Record<string, unknown>;
    if (
      Object.keys(handoff).length !== 5 ||
      handoff.version !== 2 ||
      handoff.state !== 'publication-incomplete' ||
      handoff.artifact !== expectedArtifact ||
      typeof handoff.artifactSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(handoff.artifactSha256) ||
      !Number.isSafeInteger(handoff.omissions) ||
      Number(handoff.omissions) < 1
    )
      throw new PageDataStackError(
        'boot',
        'page-data seed artifact handoff did not match this fresh result',
        undefined,
        output,
      );
    omissions = handoff.omissions;
    const artifact = lstatSync(expectedArtifact);
    if (!artifact.isFile() || artifact.size > pageDataArtifactLimit)
      throw new PageDataStackError('boot', 'page-data seed artifact is not a bounded regular file', undefined, output);
    const artifactSha256 = createHash('sha256').update(readFileSync(expectedArtifact)).digest('hex');
    if (artifactSha256 !== handoff.artifactSha256)
      throw new PageDataStackError(
        'boot',
        'page-data seed artifact digest did not match its handoff',
        undefined,
        output,
      );
  }
  if (exitCode === 0) {
    if (markers.length)
      throw new PageDataStackError(
        'boot',
        'page-data seed completed with an incomplete artifact handoff',
        undefined,
        output,
      );
    return undefined;
  }
  if (exitCode !== 1 || markers.length !== 1)
    throw new PageDataStackError(
      'boot',
      `page-data seed exited ${exitCode} without an admitted publication-incomplete artifact handoff`,
      undefined,
      output,
    );
  return { status: 'publication-incomplete', omissions: Number(omissions) };
}

const sectionKey = (section: Pick<PageDataSection, 'page' | 'persona' | 'section'>) =>
  `${section.page}\t${section.persona}\t${section.section}`;

export function duePageDataRun(
  lastRunAt: string | undefined,
  now: number,
  intervalMs = defaultPolicy.pageData.intervalMs,
): boolean {
  if (!lastRunAt) return true;
  return now - Date.parse(lastRunAt) >= intervalMs;
}

export function pageDataClassCounts(
  sections: readonly Pick<PageDataSection, 'class'>[],
): Record<PageDataClass, number> {
  return Object.fromEntries(
    PAGE_DATA_CLASSES.map((value) => [value, sections.filter((section) => section.class === value).length]),
  ) as Record<PageDataClass, number>;
}

export function newlyDefectiveSections(previous: readonly PageDataSection[], current: readonly PageDataSection[]) {
  const before = new Map(previous.map((section) => [sectionKey(section), section]));
  return current.flatMap((section) => {
    if (!PAGE_DATA_DEFECTS.has(section.class)) return [];
    const old = before.get(sectionKey(section));
    return old && previousHealthy.has(old.class) ? [{ section, previousClass: old.class }] : [];
  });
}

export function latestSectionOwner(
  tasks: readonly Task[],
  changes: readonly CommitChange[],
  files: readonly string[],
): Task | undefined {
  const byCommit = new Map(changes.map((change) => [change.commit, change]));
  const owners = tasks.flatMap((task) => {
    if (!['integrated', 'merged'].includes(task.state)) return [];
    const commits = [
      ...new Set(
        [...(task.integratedCommits ?? []), task.integratedCommit ?? task.mergedCommit].filter(
          (value): value is string => !!value,
        ),
      ),
    ];
    const positions = commits.flatMap((commit) => {
      const change = byCommit.get(commit);
      return change && change.files.some((file) => matchesPath(file, files)) ? [change.position] : [];
    });
    return positions.length ? [{ task, position: Math.max(...positions) }] : [];
  });
  owners.sort((a, b) => b.position - a.position || b.task.sequence - a.task.sequence);
  return owners[0]?.task;
}

function readManifest(cwd: string): PageManifest {
  const path = join(cwd, 'scripts/page-data-sections.json');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('page-data manifest must be an object');
  const manifest = value as PageManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.pages))
    throw new Error('page-data manifest has an unsupported shape');
  for (const page of manifest.pages) {
    if (typeof page.id !== 'string' || typeof page.path !== 'string' || !Array.isArray(page.sections))
      throw new Error('page-data manifest contains an invalid page');
    for (const section of page.sections)
      if (
        typeof section.id !== 'string' ||
        typeof section.name !== 'string' ||
        typeof section.native?.path !== 'string' ||
        (section.personas !== undefined &&
          (!Array.isArray(section.personas) || section.personas.some((persona) => typeof persona !== 'string')))
      )
        throw new Error(`page-data manifest contains an invalid section on ${page.id}`);
  }
  return manifest;
}

function fallbackGoal(page: string, nativePath: string): string {
  if (nativePath.includes('search') || page === 'search') return 'search';
  if (
    nativePath.includes('library') ||
    nativePath.includes('collection') ||
    page === 'collections' ||
    page === 'library'
  )
    return 'commerce';
  if (nativePath.includes('board') || nativePath.includes('thread') || nativePath.includes('rating')) return 'content';
  return 'web';
}

function sectionFiles(page: string, section: string, nativePath: string, sqlText: string): string[] {
  const files = new Set<string>();
  if (page === 'home') {
    files.add('apps/web/src/routes/index.tsx');
    files.add('apps/web/src/features/pages/home-*.ts');
    files.add('apps/web/src/features/pages/home-*.tsx');
  } else if (['vn', 'anime', 'book', 'character', 'person', 'tag'].includes(page)) {
    files.add('apps/web/src/routes/subjects/**');
    files.add('apps/web/src/routes/zones/*.subjects.*');
    files.add('apps/web/src/features/pages/subject-*.ts');
    files.add('apps/web/src/features/pages/subject-*.tsx');
    files.add('apps/web/src/features/pages/subject-*/**');
  } else if (page === 'search') {
    files.add('apps/web/src/features/search/**');
    files.add('apps/web/src/features/pages/search-*.ts');
    files.add('apps/web/src/routes/search*.tsx');
  } else if (page === 'collections') {
    files.add('apps/web/src/features/pages/curat*.ts');
    files.add('apps/web/src/features/pages/curat*.tsx');
    files.add('apps/web/src/features/pages/collection-*.ts');
    files.add('apps/web/src/routes/collections/**');
  } else if (page === 'library') {
    files.add('apps/web/src/features/pages/subject-personal-reader.tsx');
    files.add('apps/web/src/features/pages/member-*.ts');
    files.add('apps/web/src/routes/library/**');
  }

  if (section.startsWith('connections-') || section.startsWith('related-')) {
    files.add('apps/web/src/features/pages/subject-connections*');
    files.add('apps/web/src/features/pages/subject-relations-preview.ts');
  }
  if (section === 'ratings') {
    files.add('apps/web/src/features/pages/subject-ratings*');
    files.add('apps/web/src/features/pages/rating-*.ts');
    files.add('apps/web/src/features/pages/rating-*.tsx');
  }
  if (section === 'reviews' || section === 'discussion') {
    files.add('apps/web/src/features/pages/subject-community*');
    files.add('apps/web/src/threads/**');
  }

  if (nativePath.includes('search') || page === 'search') files.add('services/kernel/src/search/**');
  else if (nativePath.includes('library') || nativePath.includes('collection') || sqlText.includes('library.')) {
    files.add('services/kernel/src/library/**');
    files.add('services/kernel/src/commerce/**');
    files.add('services/kernel/db/library/**');
  } else if (nativePath.includes('board') || nativePath.includes('thread') || nativePath.includes('rating')) {
    files.add('services/kernel/src/content/**');
    files.add('services/kernel/db/content/**');
  } else {
    files.add('services/kernel/src/semantic/**');
    files.add('services/kernel/db/semantic/**');
  }
  if (sqlText) files.add('scripts/datasets/**');
  return [...files];
}

function sectionRegistry(cwd: string): Map<string, SectionConfig> {
  const manifest = readManifest(cwd);
  const registry = new Map<string, SectionConfig>();
  const pagePersonas = (personas: string[] | undefined) => (personas?.length ? personas : ['anonymous', 'member']);
  for (const page of manifest.pages) {
    for (const persona of pagePersonas(page.personas)) {
      for (const section of page.sections) {
        if (!pagePersonas(section.personas).includes(persona)) continue;
        const item: SectionConfig = {
          page: page.id,
          persona,
          section: section.id,
          name: section.name,
          goal: fallbackGoal(page.id, section.native.path),
          nativePath: section.native.path,
          files: sectionFiles(page.id, section.id, section.native.path, section.sql?.text ?? ''),
        };
        const key = sectionKey(item);
        if (registry.has(key))
          throw new Error(`page-data manifest repeats ${item.page}/${item.persona}/${item.section}`);
        registry.set(key, item);
      }
    }
  }
  return registry;
}

const secretPattern =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|password[=:]\s*[^\s&]+|authorization:\s*[^\r\n]+)/gi;
function safeLine(value: string): string {
  return value
    .replace(secretPattern, '[redacted]')
    .split(/\r?\n/, 1)[0]!
    .replace(/[\t\0]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function safeOutput(value: string): string {
  return value.replace(secretPattern, '[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUnrunEvidence(token: string): PageDataUnrunEvidence {
  if (token.length > 4096) throw new Error('invalid page-data unrun provenance');
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(token)) as unknown;
  } catch {
    throw new Error('invalid page-data unrun provenance');
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.probes))
    throw new Error('invalid page-data unrun provenance');
  if (value.reason === 'member-authority-unavailable') {
    const readScopes = new Set(['feed_item:list', 'follow:list', 'library_entry:list', 'progress_session:list']);
    if (
      Object.keys(value).length !== 4 ||
      Object.keys(value.probes).length !== 1 ||
      value.probes.native !== 'unrun' ||
      !Array.isArray(value.scopes) ||
      !value.scopes.length ||
      value.scopes.length > readScopes.size ||
      new Set(value.scopes).size !== value.scopes.length ||
      value.scopes.some((scope) => !readScopes.has(scope))
    )
      throw new Error('invalid page-data unrun provenance');
    return value as PageDataUnrunEvidence;
  }
  const allowedReasons = [
    'artifact-missing',
    'artifact-invalid',
    'source-key-missing',
    'identity-missing',
    'identity-invalid',
    'ambiguous',
    'native-type-mismatch',
  ];
  if (
    (value.provider !== 'bangumi' && value.provider !== 'vndb') ||
    typeof value.sourceKey !== 'string' ||
    value.sourceKey.length === 0 ||
    value.sourceKey.length > 256 ||
    typeof value.nativeType !== 'string' ||
    value.nativeType.length === 0 ||
    value.nativeType.length > 128 ||
    typeof value.artifact !== 'string' ||
    value.artifact.length === 0 ||
    value.artifact.length > 512 ||
    (value.namespace !== undefined && (typeof value.namespace !== 'string' || value.namespace.length > 256)) ||
    (value.collection !== undefined && (typeof value.collection !== 'string' || value.collection.length > 256)) ||
    !allowedReasons.includes(value.reason as string) ||
    value.probes.web !== 'unrun' ||
    value.probes.native !== 'unrun' ||
    (value.probes.sql !== 'unrun' && value.probes.sql !== 'not-declared')
  )
    throw new Error('invalid page-data unrun provenance');
  return value as PageDataUnrunEvidence;
}

function parseNativeProblem(encoded: string): PageDataNativeProblem {
  const invalid = () => new Error('invalid page-data native problem evidence');
  if (encoded.length > 1024) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(encoded));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const { code, pointer, ...unknown } = parsed as Record<string, unknown>;
  if (
    Object.keys(unknown).length > 0 ||
    (code === undefined && pointer === undefined) ||
    (code !== undefined && (typeof code !== 'string' || code.length > 64 || !/^[a-z][a-z0-9_]*$/u.test(code))) ||
    (pointer !== undefined &&
      (typeof pointer !== 'string' ||
        pointer.length > 128 ||
        (pointer !== '' && !/^\/(?:[A-Za-z0-9_-]|~[01])+(?:\/(?:[A-Za-z0-9_-]|~[01])+){0,15}$/u.test(pointer))))
  )
    throw invalid();
  return { ...(typeof code === 'string' ? { code } : {}), ...(typeof pointer === 'string' ? { pointer } : {}) };
}

export function parsePageDataOutput(
  output: string,
  registry: ReadonlyMap<string, SectionConfig>,
  allowPartial = false,
): PageDataSection[] {
  const results: PageDataSection[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [page, persona, section, className, ...extra] = line.trim().split(/\s+/);
    if (!page || !persona || !section || !className) throw new Error(`invalid page-data output: ${safeLine(line)}`);
    const key = `${page}\t${persona}\t${section}`;
    const source = registry.get(key);
    if (!source) throw new Error(`page-data output named an unknown section: ${safeLine(line)}`);
    if (!PAGE_DATA_CLASSES.includes(className as PageDataClass))
      throw new Error(`page-data output has an unknown class: ${safeLine(line)}`);
    if (seen.has(key)) throw new Error(`page-data output repeated ${page}/${persona}/${section}`);
    let unrun: PageDataUnrunEvidence | undefined;
    let nativeProblem: PageDataNativeProblem | undefined;
    if (extra.length) {
      const evidence = extra[0]!;
      if (extra.length === 1 && evidence.startsWith('unrun=') && className === 'UNAVAILABLE')
        unrun = parseUnrunEvidence(evidence.slice('unrun='.length));
      else if (
        extra.length === 1 &&
        evidence.startsWith('nativeProblem=') &&
        ['API', 'UNAVAILABLE', 'UNAUTHORIZED'].includes(className)
      )
        nativeProblem = parseNativeProblem(evidence.slice('nativeProblem='.length));
      else throw new Error(`invalid page-data evidence for ${page}/${persona}/${section}`);
    }
    if (unrun?.reason === 'member-authority-unavailable' && persona !== 'member')
      throw new Error('invalid page-data member authority persona');
    seen.add(key);
    const classValue = className as PageDataClass;
    results.push({
      ...source,
      class: classValue,
      ...(unrun ? { unrun } : {}),
      ...(nativeProblem ? { nativeProblem } : {}),
      ...(PAGE_DATA_DEFECTS.has(classValue) ? { firstErrorLine: safeLine(line) } : {}),
    });
  }
  if (!allowPartial && seen.size !== registry.size)
    throw new Error(`page-data output covered ${seen.size} of ${registry.size} sections`);
  return results;
}

/** The child process must finish this invocation, not merely print plausible section rows. */
export function parsePageDataCompletion(
  output: string,
  registry: ReadonlyMap<string, SectionConfig>,
  invocation: string,
  exitCode: number,
  scopeLimitExceeded = false,
): { sections: PageDataSection[]; incomplete: boolean } {
  const prefix = 'Page-data completed ';
  const lines = output.split(/\r?\n/u).filter(Boolean);
  const markers = lines.filter((line) => line.startsWith(prefix));
  if (markers.length !== 1 || markers[0] !== lines.at(-1) || markers[0]!.length > 512)
    throw new Error(
      `page-data-check exited ${exitCode} without one final bounded completed-output marker: ${terminalErrorLine(output)}`,
    );
  const marker = JSON.parse(markers[0]!.slice(prefix.length)) as Record<string, unknown> | null;
  if (
    !marker ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 5 ||
    marker.version !== 1 ||
    marker.invocation !== invocation ||
    marker.sections !== registry.size ||
    !Number.isSafeInteger(marker.defects) ||
    typeof marker.incomplete !== 'boolean'
  )
    throw new Error('page-data completed-output marker did not match this invocation');
  const sections = parsePageDataOutput(lines.slice(0, -1).join('\n'), registry);
  const defects = sections.filter((section) => PAGE_DATA_DEFECTS.has(section.class)).length;
  const expectedExitCode = defects > 0 ? 1 : marker.incomplete ? 2 : 0;
  if (marker.defects !== defects || (!scopeLimitExceeded && exitCode !== expectedExitCode))
    throw new Error('page-data completed-output marker did not match the section results or exit code');
  return { sections, incomplete: marker.incomplete || scopeLimitExceeded };
}

function parseScopeLimitedPageDataOutput(
  output: string,
  registry: ReadonlyMap<string, SectionConfig>,
  invocation: string,
  exitCode: number,
): { sections: PageDataSection[]; incomplete: true } {
  if (output.split(/\r?\n/u).some((line) => line.startsWith('Page-data completed ')))
    return { ...parsePageDataCompletion(output, registry, invocation, exitCode, true), incomplete: true };
  try {
    return { sections: parsePageDataOutput(output, registry, true), incomplete: true };
  } catch (error) {
    if (!output || /(?:\r?\n)$/u.test(output)) throw error;
    const lines = output.split(/\r?\n/u);
    return { sections: parsePageDataOutput(lines.slice(0, -1).join('\n'), registry, true), incomplete: true };
  }
}

function readLastCycle(db: Database): { at: string } | undefined {
  const row = db
    .query(
      `SELECT at FROM flow_events WHERE task_id=? AND stage='verification'
       AND action IN ('page-data-run','page-data-boot-failure','page-data-check-failure')
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(pageDataTaskId) as { at: string } | null;
  return row ?? undefined;
}

export function readLatestPageDataRun(db: Database): PageDataRun | undefined {
  const row = db
    .query(
      `SELECT attempt,at,detail FROM flow_events WHERE task_id=? AND stage='verification' AND action='page-data-run'
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(pageDataTaskId) as { attempt: number; at: string; detail: string } | null;
  if (!row) return undefined;
  const metadata = JSON.parse(row.detail) as {
    head: string;
    classes: Record<PageDataClass, number>;
    seed?: PageDataSeedStatus;
    coverage?: PageDataRun['coverage'];
  };
  const sections = db
    .query(
      `SELECT detail FROM flow_events WHERE task_id=? AND attempt=? AND stage='verification' AND action='page-data-section'
       ORDER BY sequence`,
    )
    .all(pageDataTaskId, row.attempt) as { detail: string }[];
  return {
    runId: row.attempt,
    at: row.at,
    head: metadata.head,
    classes: metadata.classes,
    sections: sections.map((value) => JSON.parse(value.detail) as PageDataSection),
    ...(metadata.seed ? { seed: metadata.seed } : {}),
    ...(metadata.coverage ? { coverage: metadata.coverage } : {}),
  };
}

function projectChanges(cwd: string, base: string, head: string): CommitChange[] {
  const result = spawnSync('git', ['log', '--reverse', '--name-only', '--pretty=format:%H', `${base}..${head}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Could not read the page-data source interval');
  const changes: CommitChange[] = [];
  let current: CommitChange | undefined;
  for (const line of result.stdout.split('\n')) {
    if (/^[0-9a-f]{40,}$/.test(line)) {
      current = { commit: line, position: changes.length, files: [] };
      changes.push(current);
    } else if (line && current) current.files.push(line);
  }
  return changes;
}

function firstParent(cwd: string, branch: string): string {
  const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
    cwd,
    encoding: 'utf8',
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Missing integration branch ${branch}`);
  return result.stdout.trim();
}

function repairKey(section: PageDataSection, owner: Task | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify([sectionKey(section), section.class, section.firstErrorLine, owner?.id ?? section.goal]))
    .digest('hex');
}

function groupPageDataRepairs(repairs: PageDataRepair[]): PageDataRepair[][] {
  const groups = new Map<string, PageDataRepair[]>();
  for (const repair of repairs) {
    const { section } = repair;
    const target = pageDataRepairTarget(section);
    const owner = repair.owner?.id ?? target.goal;
    let key = repair.repairKey;
    if (target.producer === 'cross-media-seed') key = `seed:${owner}`;
    if (target.producer === 'subject-relations' && section.nativeProblem?.code)
      key = JSON.stringify([
        target.producer,
        owner,
        section.page,
        section.persona,
        section.nativeProblem.code,
        section.nativeProblem.pointer,
      ]);
    const group = groups.get(key) ?? [];
    group.push(repair);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function combinedPageDataRepair(group: PageDataRepair[]): PageDataRepair {
  const additional = group
    .slice(1)
    .map(({ repairKey, section, previousClass }) => ({ repairKey, section, previousClass }));
  return { ...group[0]!, ...(additional.length ? { additional } : {}) };
}

function pageDataRepairDetail(repair: PageDataRepair) {
  return {
    repairKey: repair.repairKey,
    section: repair.section,
    previousClass: repair.previousClass,
    ...(repair.owner ? { owner: repair.owner.id } : {}),
  };
}

function readRepairClaim(db: Database, key: string): { status: string; detail: string } | undefined {
  const row = db.query('SELECT status,detail FROM page_data_repairs WHERE repair_key=? LIMIT 1').get(key) as {
    status: string;
    detail: string;
  } | null;
  return row ?? undefined;
}

function claimRepair(db: Database, key: string, at: string, detail: string): void {
  db.query('INSERT OR IGNORE INTO page_data_repairs(repair_key,created_at,status,detail) VALUES (?,?,?,?)').run(
    key,
    at,
    'pending',
    detail,
  );
}

function finishRepair(db: Database, key: string): void {
  db.query("UPDATE page_data_repairs SET status='routed' WHERE repair_key=?").run(key);
}

function settleRepair(
  db: Database,
  key: string,
  status: 'routed' | 'refused',
  detail: string,
  event: Parameters<typeof recordFlow>[1],
): void {
  db.transaction(() => {
    db.query('UPDATE page_data_repairs SET status=?,detail=? WHERE repair_key=?').run(status, detail, key);
    recordFlow(db, event);
  }).immediate();
}

/** Recover only classification refusals from one retained run, without launching a browser or reclassifying its evidence. */
export async function reconcilePageDataRepairs(
  options: Pick<PageDataOptions, 'settings' | 'db' | 'tasks' | 'routeDefect' | 'now'>,
  runId: number,
): Promise<{ routed: number; unresolved: { key: string; reason: string }[] }> {
  const { db, settings } = options;
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Expected a retained page-data run ID');
  ensureFlow(db);
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'page-data.lease'), settings.policy?.leases);
  try {
    const run = db
      .query(
        "SELECT detail FROM flow_events WHERE task_id=? AND attempt=? AND stage='verification' AND action='page-data-run'",
      )
      .get(pageDataTaskId, runId) as { detail: string } | null;
    const head = run && (JSON.parse(run.detail) as { head?: string }).head;
    if (!head) throw new Error(`No retained page-data run ${runId}`);
    const claims = db
      .query(
        `SELECT claim.repair_key AS key, claim.detail FROM page_data_repairs claim
         JOIN flow_events event ON json_extract(event.detail, '$.repairKey')=claim.repair_key
         WHERE event.task_id=? AND event.attempt=? AND event.stage='verification' AND event.action='page-data-repair'
           AND claim.status='refused' AND json_extract(event.detail, '$.route')='refused'
         GROUP BY claim.repair_key, claim.detail ORDER BY min(event.sequence)`,
      )
      .all(pageDataTaskId, runId) as { key: string; detail: string }[];
    const tasks = options.tasks.tasks();
    const at = (options.now ?? (() => new Date()))().toISOString();
    const result: { routed: number; unresolved: { key: string; reason: string }[] } = { routed: 0, unresolved: [] };
    const pendingRepairs: PageDataRepair[] = [];
    for (const claim of claims) {
      const detail = JSON.parse(claim.detail) as {
        repairKey: string;
        section: PageDataSection;
        previousClass: PageDataClass;
        owner?: string;
        reason?: string;
      };
      if (!isPageDataRiskRefusal(detail.reason)) continue;
      const owner = detail.owner ? tasks.find((task) => task.id === detail.owner) : undefined;
      if ((detail.owner && !owner) || claim.key !== repairKey(detail.section, owner)) {
        result.unresolved.push({ key: claim.key, reason: 'The original repair identity could not be recovered' });
        continue;
      }
      pendingRepairs.push({
        repairKey: claim.key,
        section: detail.section,
        previousClass: detail.previousClass,
        ...(owner ? { owner } : {}),
        head,
        reconcileRiskRefusal: true,
      });
    }
    for (const group of groupPageDataRepairs(pendingRepairs)) {
      try {
        const route = await options.routeDefect(combinedPageDataRepair(group));
        if (typeof route === 'object') {
          result.unresolved.push(...group.map((cause) => ({ key: cause.repairKey, reason: route.reason })));
          continue;
        }
        for (const cause of group) {
          const repairedDetail = JSON.stringify({ ...pageDataRepairDetail(cause), route, reconciled: true });
          settleRepair(db, cause.repairKey, 'routed', repairedDetail, {
            taskId: pageDataTaskId,
            attempt: runId,
            stage: 'verification',
            action: 'page-data-repair',
            at,
            detail: repairedDetail,
          });
          result.routed++;
        }
      } catch (error) {
        result.unresolved.push(...group.map((cause) => ({ key: cause.repairKey, reason: errorMessage(error) })));
      }
    }
    return result;
  } finally {
    lock.release();
  }
}

function saveRun(db: Database, run: PageDataRun): void {
  const events = [
    {
      taskId: pageDataTaskId,
      attempt: run.runId,
      stage: 'verification' as const,
      action: 'page-data-run',
      at: run.at,
      detail: JSON.stringify({
        head: run.head,
        classes: run.classes,
        ...(run.seed ? { seed: run.seed } : {}),
        ...(run.coverage ? { coverage: run.coverage } : {}),
      }),
    },
    ...run.sections.map((section) => ({
      taskId: pageDataTaskId,
      attempt: run.runId,
      stage: 'verification' as const,
      action: 'page-data-section',
      at: run.at,
      detail: JSON.stringify(section),
    })),
  ];
  db.transaction(() => events.forEach((event) => recordFlow(db, event))).immediate();
}

function supermanagerNotice(
  options: PageDataOptions,
  action: 'boot' | 'check',
  head: string,
  line: string,
  logPath: string,
  at: string,
): void {
  const detail = safeLine(line) || `Page-data ${action} failed without an error line`;
  const prefix = `Page-data ${action} failed at ${head}: `;
  const suffix = `; output log: ${logPath}`;
  const available = Math.max(0, defaultPolicy.inbox.managerMessageCharacters - prefix.length - suffix.length);
  const summary = `${prefix}${detail.slice(0, available)}${suffix}`;
  recordFlow(options.db, {
    taskId: pageDataTaskId,
    attempt: Math.max(Date.parse(at), dbMaxPageDataAttempt(options.db) + 1),
    stage: 'verification',
    action: action === 'boot' ? 'page-data-boot-failure' : 'page-data-check-failure',
    at,
    detail: JSON.stringify({ head, firstErrorLine: detail, logPath }),
  });
  options.inbox.deliver({
    managerId: options.settings.integration.supermanager,
    kind: 'environment',
    summary,
  });
}

function writePageDataFailureLog(
  stateDirectory: string,
  runId: number,
  phase: StackFailurePhase,
  output: string,
): string {
  const directory = join(stateDirectory, 'page-data-failures');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${runId}-${phase}.log`);
  writeFileSync(path, safeOutput(output), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

function combineFailureOutput(stackOutput: string, commandOutput: string): string {
  if (!stackOutput) return commandOutput;
  if (!commandOutput || stackOutput === commandOutput) return stackOutput;
  return `=== page-data stack ===\n${stackOutput}\n=== page-data command ===\n${commandOutput}`;
}

function loadLastSuccessfulRun(db: Database): PageDataRun | undefined {
  return readLatestPageDataRun(db);
}

export async function runPageDataCycle(options: PageDataOptions): Promise<'skipped' | 'ran' | 'failed'> {
  const policy = options.settings.policy?.pageData ?? defaultPolicy.pageData;
  const now = options.now ?? (() => new Date());
  ensureFlow(options.db);
  let lock: ReturnType<typeof acquireDirectoryLease>;
  try {
    lock = acquireDirectoryLease(
      join(options.settings.stateDirectory, 'page-data.lease'),
      options.settings.policy?.leases,
    );
  } catch (error) {
    if (error instanceof LeaseHeldError) return 'skipped';
    throw error;
  }
  try {
    const lastCycle = readLastCycle(options.db);
    if (!duePageDataRun(lastCycle?.at, now().getTime(), policy.intervalMs)) return 'skipped';
    const at = now().toISOString();
    const latestAttempt = dbMaxPageDataAttempt(options.db);
    const runId = Math.max(Date.parse(at), latestAttempt + 1);
    const head = firstParent(options.settings.mainCheckout, options.settings.integrationBranch);
    let output = '';
    let stackOutput = '';
    let diagnostics = '';
    const invocation = randomUUID();
    let exitCode = -1;
    let scopeLimitExceeded = false;
    let scopeKilled = false;
    let seed: PageDataSeedStatus | undefined;
    let registryForRun: ReadonlyMap<string, SectionConfig> | undefined;
    try {
      const result = await (
        options.runStack ??
        ((sourceHead, checkInvocation) => runDedicatedPageDataStack(options.settings, sourceHead, checkInvocation))
      )(head, invocation);
      output = result.output;
      stackOutput = result.stackOutput ?? '';
      diagnostics = result.diagnostics ?? '';
      exitCode = result.exitCode;
      scopeLimitExceeded = result.scopeLimitExceeded ?? false;
      scopeKilled = result.scopeKilled ?? false;
      seed = result.seed;
      if (![0, 1, 2].includes(result.exitCode) && !scopeLimitExceeded && !scopeKilled) {
        const command = commandOutput(output, diagnostics);
        const line = command.trim() ? terminalErrorLine(command) : `page-data-check exited ${result.exitCode}`;
        throw new PageDataStackError('check', line, line, combineFailureOutput(stackOutput, command));
      }
      registryForRun = result.registry;
    } catch (error) {
      const failure =
        error instanceof PageDataStackError
          ? error
          : new PageDataStackError('boot', errorMessage(error), undefined, stackOutput);
      const transcript = failure.output || combineFailureOutput(stackOutput, output || failure.message);
      const logPath = writePageDataFailureLog(options.settings.stateDirectory, runId, failure.phase, transcript);
      supermanagerNotice(options, failure.phase, head, failure.firstErrorLine, logPath, at);
      return 'failed';
    }

    const registry = registryForRun ?? sectionRegistry(options.settings.mainCheckout);
    let sections: PageDataSection[];
    let incomplete: boolean;
    try {
      ({ sections, incomplete } =
        scopeLimitExceeded || scopeKilled
          ? parseScopeLimitedPageDataOutput(output, registry, invocation, exitCode)
          : parsePageDataCompletion(output, registry, invocation, exitCode));
    } catch (error) {
      const transcript = combineFailureOutput(stackOutput, commandOutput(output, diagnostics));
      const logPath = writePageDataFailureLog(options.settings.stateDirectory, runId, 'check', transcript);
      const detail = diagnostics.trim()
        ? `${errorMessage(error)}; ${terminalErrorLine(diagnostics)}`
        : errorMessage(error);
      supermanagerNotice(options, 'check', head, detail, logPath, at);
      return 'failed';
    }
    const previous = loadLastSuccessfulRun(options.db);
    const newDefects = newlyDefectiveSections(previous?.sections ?? [], sections);
    const newDefectBySection = new Map(newDefects.map((defect) => [sectionKey(defect.section), defect]));
    const run: PageDataRun = {
      runId,
      at,
      head,
      classes: pageDataClassCounts(sections),
      sections,
      ...(seed ? { seed } : {}),
      ...(incomplete ? { coverage: { status: 'incomplete' } } : {}),
    };
    saveRun(options.db, run);

    const changes = previous?.head ? projectChanges(options.settings.mainCheckout, previous.head, head) : [];
    const tasks = options.tasks.tasks();
    const pendingRepairs: PageDataRepair[] = [];
    for (const section of sections.filter((candidate) => PAGE_DATA_DEFECTS.has(candidate.class))) {
      if (seed?.status === 'admission-deferred' && section.class === 'SEED') continue;
      const target = pageDataRepairTarget(section);
      const candidates = target.producer ? tasks.filter((task) => task.brief.goal === target.goal) : tasks;
      const owner = latestSectionOwner(candidates, changes, target.files);
      const key = repairKey(section, owner);
      const claim = readRepairClaim(options.db, key);
      if (claim?.status === 'routed' || claim?.status === 'refused') continue;
      const transition = newDefectBySection.get(sectionKey(section));
      const previousClass =
        transition?.previousClass ??
        (claim ? (JSON.parse(claim.detail) as { previousClass?: PageDataClass }).previousClass : undefined);
      if (!previousClass) continue;
      const repairDetail = {
        repairKey: key,
        section,
        previousClass,
        ...(owner ? { owner: owner.id } : {}),
      };
      const detail = JSON.stringify(repairDetail);
      claimRepair(options.db, key, at, detail);
      const resumed = owner
        ? Boolean(
            options.db
              .query("SELECT 1 FROM worker_events WHERE task_id=? AND kind='page-data-repair' AND body LIKE ? LIMIT 1")
              .get(owner.id, `%${key}%`),
          )
        : false;
      const dispatched = options.tasks
        .tasks()
        .some(
          (task) =>
            task.state !== 'cancelled' &&
            (!target.producer || task.brief.goal === target.goal) &&
            task.brief.markdown.includes(`page-data-repair-key: ${key}`),
        );
      if (resumed || dispatched) {
        finishRepair(options.db, key);
        continue;
      }
      const repair: PageDataRepair = {
        repairKey: key,
        section,
        previousClass,
        ...(owner ? { owner } : {}),
        head,
      };
      pendingRepairs.push(repair);
    }
    for (const group of groupPageDataRepairs(pendingRepairs)) {
      const route = await options.routeDefect(combinedPageDataRepair(group));
      const refusal = typeof route === 'object' ? route : undefined;
      const routeName = refusal ? 'refused' : route;
      for (const cause of group) {
        const routeDetail = JSON.stringify({
          ...pageDataRepairDetail(cause),
          route: routeName,
          ...(refusal ? { reason: refusal.reason } : {}),
        });
        settleRepair(options.db, cause.repairKey, refusal ? 'refused' : 'routed', routeDetail, {
          taskId: pageDataTaskId,
          attempt: runId,
          stage: 'verification',
          action: 'page-data-repair',
          at,
          detail: routeDetail,
        });
      }
    }
    if (incomplete) {
      const transcript = combineFailureOutput(stackOutput, commandOutput(output, diagnostics));
      const logPath = writePageDataFailureLog(options.settings.stateDirectory, runId, 'check', transcript);
      supermanagerNotice(
        options,
        'check',
        head,
        `Incomplete page-data coverage: ${safeLine(diagnostics) || 'see section evidence'}`,
        logPath,
        at,
      );
    }
    return 'ran';
  } finally {
    lock.release();
  }
}

function dbMaxPageDataAttempt(db: Database): number {
  return (
    db
      .query(
        "SELECT coalesce(max(attempt),0) AS attempt FROM flow_events WHERE task_id=? AND stage='verification' AND action LIKE 'page-data-%'",
      )
      .get(pageDataTaskId) as { attempt: number }
  ).attempt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageDataSettings(settings: Settings): PageDataPolicy {
  return settings.policy?.pageData ?? defaultPolicy.pageData;
}

/** Prefer the final substantive error from a process that exited; resilient background retries appear earlier. */
export function terminalErrorLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const skipped = (line: string) =>
    line.startsWith('$ ') || /^task:\s/i.test(line) || line.startsWith('+ ') || /^task \S/.test(line);
  const candidates = lines.filter((line) => !skipped(line));
  const preferred = candidates.filter((line) => /\b(?:error|fatal|fail(?:ed|ure)?|panic|exception)\b/i.test(line));
  const chosen = preferred.at(-1) ?? candidates.at(-1);
  const logReference = [...candidates].reverse().find((line) => /^see\s+\S+/i.test(line));
  const combined = chosen && logReference && logReference !== chosen ? `${chosen}; ${logReference}` : chosen;
  return safeLine(combined ?? 'process failed without output');
}

/** Retained as the public name used by existing callers. */
export function firstSubstantiveErrorLine(value: string): string {
  return terminalErrorLine(value);
}

function externalErrorLine(value: string): string {
  return terminalErrorLine(value);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local page-data port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 65536;
}

async function stackConfiguration(
  settings: Settings,
): Promise<{ file: string; worktree: string; stack: StackConfig; names: { database: string; search: string } }> {
  mkdirSync(settings.stateDirectory, { recursive: true });
  mkdirSync(settings.worktreeRoot, { recursive: true });
  const identity = createHash('sha256').update(settings.stateDirectory).digest('hex').slice(0, 10);
  const file = join(settings.stateDirectory, 'page-data-stack.json');
  const worktree = join(settings.worktreeRoot, 'page-data-stack');
  const names = { database: `rezics-pagecheck-${identity}`, search: `rezics-pagecheck-search-${identity}` };
  let stack: StackConfig;
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as StackConfig).version !== 1 ||
      !['databasePort', 'searchPort', 'webPort', 'issuerPort', 'nativePort', 'kernelPort'].every((key) =>
        validPort((parsed as StackConfig)[key as keyof StackConfig]),
      )
    )
      throw new Error('Page-data stack configuration is invalid');
    stack = parsed as StackConfig;
  } else {
    const ports = new Set<number>();
    const allocate = async () => {
      let port = await freePort();
      while (ports.has(port)) port = await freePort();
      ports.add(port);
      return port;
    };
    stack = {
      version: 1,
      databasePort: await allocate(),
      searchPort: await allocate(),
      webPort: await allocate(),
      issuerPort: await allocate(),
      nativePort: await allocate(),
      kernelPort: await allocate(),
    };
    writeFileSync(file, `${JSON.stringify(stack, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  return { file, worktree, stack, names };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function runGitCapture(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function refreshWorktree(settings: Settings, worktree: string, head: string): void {
  if (!existsSync(worktree)) {
    runGit(settings.mainCheckout, ['worktree', 'add', '--detach', worktree, head]);
    return;
  }
  if (!existsSync(join(worktree, '.git')))
    throw new Error(`Page-data worktree path is not a Git worktree: ${worktree}`);
  runGit(worktree, ['reset', '--hard', head]);
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function stackEnvironment(
  worktree: string,
  stack: StackConfig,
  names: { database: string; search: string },
  mainCheckout: string,
): NodeJS.ProcessEnv {
  return {
    ...readEnvFile(join(mainCheckout, 'services/kernel/.env')),
    ...process.env,
    ...readEnvFile(join(worktree, 'services/kernel/.env')),
    KERNEL_DATABASE_CONTAINER: names.database,
    KERNEL_DATABASE_VOLUME: names.database,
    KERNEL_DATABASE_PORT: String(stack.databasePort),
    KERNEL_SEARCH_CONTAINER: names.search,
    KERNEL_SEARCH_VOLUME: names.search,
    KERNEL_SEARCH_PORT: String(stack.searchPort),
    REZICS_LOCAL_STACK_WEB_ORIGIN: `http://127.0.0.1:${stack.webPort}`,
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: `http://127.0.0.1:${stack.issuerPort}`,
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: `http://127.0.0.1:${stack.nativePort}`,
    REZICS_LOCAL_STACK_KERNEL_ORIGIN: `http://127.0.0.1:${stack.kernelPort}`,
    REZICS_PAGE_DATA_STACK: names.database,
    NODE_ENV: 'development',
  };
}

function boundedAppend(current: string, chunk: string, maximum: number): string {
  const next = current + chunk;
  const bytes = Buffer.from(next);
  return bytes.byteLength > maximum ? bytes.subarray(bytes.byteLength - maximum).toString('utf8') : next;
}

type ProcessResult = {
  exitCode: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  admissionDeferred?: true;
};
type ScopedPageDataResult = ProcessResult & { scopeLimitExceeded: boolean; scopeKilled: boolean };
export type PageDataCapture = {
  value: string;
  context?: Record<string, unknown>;
  events?: Record<string, unknown>[];
  firstCause?: string;
  teardown?: boolean;
};
type BoundedOutput = PageDataCapture;

function captureEvent(captured: PageDataCapture, event: Record<string, unknown>): void {
  const events = (captured.events ??= []);
  events.push({ sequence: Number(events.at(-1)?.sequence ?? 0) + 1, at: new Date().toISOString(), ...event });
  if (events.length > 48) events.shift();
}

export function pageDataCaptureOutput(captured: PageDataCapture, maximum: number): string {
  const events = [...(captured.events ?? [])];
  const serialize = () => JSON.stringify({ version: 1, ...captured.context, firstCause: captured.firstCause, events });
  let metadata = serialize();
  while (events.length && Buffer.byteLength(metadata) > maximum / 2) {
    events.shift();
    metadata = serialize();
  }
  const header = `page-data capture ${metadata}\n`;
  const remaining = Math.max(0, maximum - Buffer.byteLength(header));
  return Buffer.byteLength(header) <= maximum
    ? header + boundedAppend('', captured.value, remaining)
    : boundedAppend('', header, maximum);
}

function childTree(child: ChildProcess): unknown[] {
  if (!child.pid) return [];
  return processTreeMembers(child.pid)
    .slice(0, 32)
    .map((identity) => {
      try {
        const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
        const fields = stat
          .slice(stat.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/);
        return { ...identity, parent: Number(fields[1]), executable: readlinkSync(`/proc/${identity.pid}/exe`) };
      } catch (error) {
        if (['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return { ...identity, executable: 'unavailable' };
        throw error;
      }
    });
}

function launchContext(
  worktree: string,
  head: string,
  command: string[],
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const packages: Record<string, unknown> = {};
  for (const name of ['vite', '@cloudflare/vite-plugin', '@tanstack/react-start']) {
    try {
      const file = join(worktree, 'apps/web/node_modules', name, 'package.json');
      packages[name] = { path: realpathSync(file), version: JSON.parse(readFileSync(file, 'utf8')).version };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      packages[name] = 'unavailable';
    }
  }
  return {
    run: randomUUID(),
    source: head,
    command,
    cwd: worktree,
    executable: process.execPath,
    runtime: { bun: Bun.version, revision: Bun.revision },
    packages,
    flags: Object.fromEntries(
      [
        'NODE_ENV',
        'NODE_DISABLE_COMPILE_CACHE',
        'REZICS_TEST_RUNTIME',
        'REZICS_WALK_STACK_SLOT',
        'VITE_CACHE_DIR',
        'XDG_CACHE_HOME',
      ].map((name) => [name, env[name] ?? null]),
    ),
  };
}

function commandOutput(stdout: string, stderr: string): string {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}\n=== stderr ===\n${stderr}`;
}

export function pageDataCheckScopeUnit(invocation: string): string {
  return `rezics-page-data-${invocation}.scope`;
}

const PAGE_DATA_SCOPE_RUNNER = [
  'cgroup=',
  'while IFS=: read -r hierarchy controllers path; do',
  '  if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then cgroup=$path; break; fi',
  'done < /proc/self/cgroup',
  'REZICS_PAGE_DATA_SCOPE_CGROUP=$cgroup',
  'export REZICS_PAGE_DATA_SCOPE_CGROUP',
  '"$@"',
  'status=$?',
  'oom_kills=unavailable',
  'if [ -n "$cgroup" ] && [ -r "/sys/fs/cgroup$cgroup/memory.events" ]; then',
  '  oom_kills=0',
  '  while read -r key value rest; do',
  '    if [ "$key" = oom_kill ]; then oom_kills=$value; break; fi',
  '  done < "/sys/fs/cgroup$cgroup/memory.events"',
  'fi',
  'printf "REZICS_PAGE_DATA_SCOPE_OOM_KILLS=%s\\n" "$oom_kills" >&2',
  'exit "$status"',
].join('\n');

export function pageDataCheckScopeArguments(invocation: string, command: string, args: readonly string[]): string[] {
  return workerScopeArguments(
    pageDataCheckScopeUnit(invocation),
    '/bin/sh',
    ['-c', PAGE_DATA_SCOPE_RUNNER, 'page-data-check-scope', command, ...args],
    {
      slice: CHECK_SLICE,
      properties: ['OOMPolicy=continue'],
    },
  );
}

function takePageDataScopeOomStatus(stderr: string): { stderr: string; reported: boolean; oomKills?: number } {
  const lines = stderr.split(/\r?\n/u);
  const markers = lines.filter((line) => line.startsWith('REZICS_PAGE_DATA_SCOPE_OOM_KILLS='));
  if (markers.length === 0) return { stderr, reported: false };
  if (markers.length !== 1) throw new Error('page-data scope emitted multiple OOM counters');
  const match = /^REZICS_PAGE_DATA_SCOPE_OOM_KILLS=(unavailable|0|[1-9]\d*)$/u.exec(markers[0]!);
  if (!match) throw new Error('page-data scope emitted an invalid OOM counter');
  const count = match[1] === 'unavailable' ? undefined : Number(match[1]);
  if (count !== undefined && !Number.isSafeInteger(count))
    throw new Error('page-data scope emitted an invalid OOM counter');
  return {
    stderr: lines.filter((line) => line !== markers[0]).join('\n'),
    reported: true,
    ...(count !== undefined ? { oomKills: count } : {}),
  };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  phase: StackFailurePhase = 'boot',
  allowedExitCodes: readonly number[] = [0],
  killAfterMs = defaultPolicy.pageData.stopTimeoutMs,
  admissionSignal?: AbortSignal,
): Promise<ProcessResult> {
  if (admissionSignal?.aborted)
    return { exitCode: -1, signal: 'SIGTERM', stdout: '', stderr: '', output: '', admissionDeferred: true };
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let stopReason: 'timeout' | 'admission-pressure' | undefined;
  let processClosed = false;
  child.stdout?.on('data', (chunk: Buffer) => (stdout = boundedAppend(stdout, chunk.toString(), outputLimit)));
  child.stderr?.on('data', (chunk: Buffer) => (stderr = boundedAppend(stderr, chunk.toString(), outputLimit)));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      processClosed = true;
      resolve(code);
    });
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: 'timeout' | 'admission-pressure') => {
    if (stopReason || processClosed || child.exitCode !== null || child.signalCode !== null) return;
    stopReason = reason;
    signalGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), killAfterMs);
  };
  const onAdmissionPressure = () => stop('admission-pressure');
  if (admissionSignal) admissionSignal.addEventListener('abort', onAdmissionPressure, { once: true });
  const timeout = setTimeout(() => {
    stop('timeout');
  }, timeoutMs);
  let code: number | null;
  try {
    code = await closed;
  } catch (error) {
    const firstErrorLine = externalErrorLine(errorMessage(error));
    throw new PageDataStackError(
      phase,
      `${command} ${args.join(' ')} failed: ${firstErrorLine}`,
      firstErrorLine,
      commandOutput(stdout, stderr),
    );
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    admissionSignal?.removeEventListener('abort', onAdmissionPressure);
  }
  const output = commandOutput(stdout, stderr);
  const diagnostic = externalErrorLine(stderr || stdout);
  if (stopReason === 'timeout')
    throw new PageDataStackError(
      phase,
      `${command} ${args.join(' ')} timed out after ${timeoutMs} ms: ${diagnostic}`,
      diagnostic,
      output,
    );
  if (stopReason === 'admission-pressure' && code !== 0)
    return {
      exitCode: code ?? -1,
      signal: child.signalCode,
      stdout,
      stderr,
      output: stdout,
      admissionDeferred: true,
    };
  if (!allowedExitCodes.includes(code ?? -1))
    throw new PageDataStackError(
      phase,
      `${command} ${args.join(' ')} exited ${String(code)}: ${diagnostic}`,
      diagnostic,
      output,
    );
  return { exitCode: code ?? -1, signal: child.signalCode, stdout, stderr, output: stdout };
}

function systemctlUser(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): SpawnSyncReturns<string> {
  return spawnSync('systemctl', ['--user', ...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs });
}

function systemctlFailure(result: SpawnSyncReturns<string>, command: string): string | undefined {
  if (result.error) return `${command} failed: ${externalErrorLine(result.error.message)}`;
  if (result.status !== 0) {
    const detail = externalErrorLine(result.stderr || result.stdout || '');
    return `${command} exited with status ${result.status ?? result.signal ?? 'unknown'}${detail ? `: ${detail}` : ''}`;
  }
  return undefined;
}

function cleanupPageDataScope(
  unit: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string | undefined {
  const stopped = systemctlUser(['stop', unit], cwd, env, timeoutMs);
  const stopFailure = systemctlFailure(stopped, `systemctl stop ${unit}`);
  if (stopFailure) {
    const state = systemctlUser(['show', unit, '--property=LoadState', '--value'], cwd, env, timeoutMs);
    if (!systemctlFailure(state, `systemctl show ${unit}`) && state.stdout.trim() === 'not-found') return undefined;
    return stopFailure;
  }
  const reset = systemctlUser(['reset-failed', unit], cwd, env, timeoutMs);
  const resetFailure = systemctlFailure(reset, `systemctl reset-failed ${unit}`);
  if (resetFailure) {
    const state = systemctlUser(['show', unit, '--property=LoadState', '--value'], cwd, env, timeoutMs);
    if (!systemctlFailure(state, `systemctl show ${unit}`) && state.stdout.trim() === 'not-found') return undefined;
    return resetFailure;
  }
  return undefined;
}

async function runPageDataScopedCheck(
  invocation: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  killAfterMs: number,
): Promise<ScopedPageDataResult> {
  const unit = pageDataCheckScopeUnit(invocation);
  let result: ProcessResult | undefined;
  let scopeLimitExceeded = false;
  let scopeKilled = false;
  let failure: unknown;
  try {
    result = await runCommand(
      'systemd-run',
      pageDataCheckScopeArguments(invocation, command, args),
      cwd,
      env,
      timeoutMs,
      outputLimit,
      'check',
      [0, 1, 2, 137, -1],
      killAfterMs,
    );
    const oomStatus = takePageDataScopeOomStatus(result.stderr);
    result = { ...result, stderr: oomStatus.stderr };
    scopeLimitExceeded = (oomStatus.oomKills ?? 0) > 0;
    scopeKilled = result.exitCode === 137;
    if (!oomStatus.reported && !scopeKilled) {
      const missing = `Page-data systemd scope ${unit} did not report completion; launch or memory outcome is unknown`;
      const diagnostic = result.stderr.trim() ? externalErrorLine(result.stderr) : undefined;
      throw new PageDataStackError(
        'check',
        diagnostic ? `${missing}: ${diagnostic}` : missing,
        diagnostic ?? missing,
        commandOutput(result.stdout, result.stderr),
      );
    }
    if (!scopeLimitExceeded && !scopeKilled && ![0, 1, 2].includes(result.exitCode)) {
      const detail = result.stderr || result.stdout;
      const signal = result.signal ? ` (signal ${result.signal})` : '';
      const line = detail.trim() ? terminalErrorLine(detail) : `page-data-check exited ${result.exitCode}${signal}`;
      throw new PageDataStackError('check', line, line, commandOutput(result.stdout, result.stderr));
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailure = cleanupPageDataScope(unit, cwd, env, killAfterMs);
  if (cleanupFailure) {
    const detail = `Page-data systemd scope cleanup failed: ${cleanupFailure}`;
    if (failure instanceof PageDataStackError)
      throw new PageDataStackError(
        failure.phase,
        `${failure.message}; ${detail}`,
        failure.firstErrorLine,
        combineFailureOutput(failure.output, detail),
      );
    if (failure)
      throw new PageDataStackError(
        'check',
        `${errorMessage(failure)}; ${detail}`,
        safeLine(errorMessage(failure)),
        detail,
      );
    throw new PageDataStackError('check', detail, detail, commandOutput(result?.stdout ?? '', result?.stderr ?? ''));
  }
  if (failure) throw failure;
  return { ...result!, scopeLimitExceeded, scopeKilled };
}

/** Existing readiness seam; injectable time/probes let causal tests use an inert owned child. */
export async function waitForStack(
  child: ChildProcess,
  origins: string[],
  timeoutMs: number,
  outputLimit: number,
  stopTimeoutMs: number,
  captured: PageDataCapture,
  dependencies: {
    probe?: (input: string, init?: RequestInit) => Promise<Response>;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
    signal?: typeof signalGroup;
    tree?: typeof childTree;
  } = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const signal = dependencies.signal ?? signalGroup;
  const probe = dependencies.probe ?? fetch;
  let spawnFailure: Error | undefined;
  const partial = { stdout: '', stderr: '' };
  const observe = (text: string, stream: 'stdout' | 'stderr') => {
    for (const line of text.split(/\r?\n/)) {
      if (!captured.teardown && !captured.firstCause && /\b(?:error|fatal|failed|panic|exception)\b/i.test(line))
        captured.firstCause = safeLine(line);
      if (/stack:|paraglide|localization|vite|phase|config|listening/i.test(line))
        captureEvent(captured, { kind: 'producer', stream, line: safeLine(line) });
    }
  };
  const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = chunk.toString();
    captured.value = boundedAppend(captured.value, text, Math.floor(outputLimit / 2));
    const lines = (partial[stream] + text).split(/\r?\n/);
    partial[stream] = lines.pop()!.slice(-2048);
    observe(lines.join('\n'), stream);
  };
  const flush = () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      observe(partial[stream], stream);
      partial[stream] = '';
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnFailure = error;
      resolve(null);
    });
    child.once('close', (code, signal) => {
      flush();
      captureEvent(captured, { kind: 'exit', pid: child.pid, code, signal, afterTeardown: !!captured.teardown });
      resolve(code);
    });
  });
  const deadline = now() + timeoutMs;
  let lastFailure = '';
  let lastTree = '';
  const probeStates = new Map<string, string>();
  while (now() < deadline) {
    const tree = (dependencies.tree ?? childTree)(child);
    const identity = JSON.stringify(tree);
    if (identity !== lastTree) {
      captureEvent(captured, { kind: 'children', identities: tree });
      lastTree = identity;
    }
    if (spawnFailure || child.exitCode !== null || child.signalCode !== null) {
      await closed;
      const line =
        captured.firstCause ??
        (spawnFailure
          ? errorMessage(spawnFailure)
          : captured.value.trim()
            ? terminalErrorLine(captured.value)
            : `Local stack exited ${child.exitCode ?? child.signalCode}`);
      captured.firstCause = line;
      captureEvent(captured, { kind: 'terminal', reason: 'child-exit', cause: line });
      throw new PageDataStackError('boot', line, line, pageDataCaptureOutput(captured, outputLimit));
    }
    let ready = true;
    for (const origin of origins) {
      let state: string;
      try {
        const response = await probe(origin, { signal: AbortSignal.timeout(2000) });
        state = `HTTP ${response.status}`;
        if (response.status >= 400) {
          ready = false;
          lastFailure = `${origin} returned ${state}`;
        }
      } catch (error) {
        ready = false;
        state = errorMessage(error);
        lastFailure = `${origin} ${state}`;
      }
      if (probeStates.get(origin) !== state) {
        captureEvent(captured, { kind: 'probe', origin, result: state });
        probeStates.set(origin, state);
      }
    }
    if (ready) {
      captureEvent(captured, { kind: 'ready', origins });
      return;
    }
    await pause(500);
  }
  // Freeze the cause before signalling: teardown output is a separate observation.
  flush();
  const line = captured.firstCause ?? (lastFailure || 'Local stack did not become ready');
  captured.firstCause = line;
  captured.teardown = true;
  captureEvent(captured, {
    kind: 'teardown',
    reason: 'readiness-deadline',
    cause: line,
    pending: origins.filter((origin) => !/^HTTP [123]/.test(probeStates.get(origin) ?? '')),
  });
  if (child.exitCode === null && child.signalCode === null) signal(child, 'SIGTERM');
  await Promise.race([closed, pause(stopTimeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) signal(child, 'SIGKILL');
  await closed;
  throw new PageDataStackError('boot', line, line, pageDataCaptureOutput(captured, outputLimit));
}

async function stopStack(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  signalGroup(child, 'SIGTERM');
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!stopped) {
    signalGroup(child, 'SIGKILL');
    await closed;
  }
}

function declaredDependencyPatchFiles(cwd: string, revision: string): string[] {
  const result = spawnSync('git', ['show', `${revision}:package.json`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Could not read page-data dependency patches');
  const manifest = JSON.parse(result.stdout) as { patchedDependencies?: Record<string, string> };
  return Object.values(manifest.patchedDependencies ?? {});
}

export function dependencyFilesChanged(cwd: string, oldHead: string | undefined, head: string): boolean {
  if (!oldHead) return true;
  if (oldHead === head) return false;
  const patchFiles = [
    ...new Set([...declaredDependencyPatchFiles(cwd, oldHead), ...declaredDependencyPatchFiles(cwd, head)]),
  ];
  const result = spawnSync(
    'git',
    ['diff', '--name-only', `${oldHead}..${head}`, '--', 'bun.lock', 'package.json', '**/package.json', ...patchFiles],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: defaultPolicy.merge.gitBufferBytes,
      timeout: defaultPolicy.merge.commandTimeoutMs,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Could not compare page-data dependency inputs');
  return Boolean(result.stdout.trim());
}

async function prepareDedicatedPageDataStack(settings: Settings, head: string) {
  const policy = pageDataSettings(settings);
  const { file, worktree, stack, names } = await stackConfiguration(settings);
  refreshWorktree(settings, worktree, head);
  const bun = process.execPath;
  let config = stack;
  let env = stackEnvironment(worktree, config, names, settings.mainCheckout);
  if (dependencyFilesChanged(worktree, config.dependenciesHead, head)) {
    await runCommand(
      bun,
      ['install', '--frozen-lockfile', '--backend', 'copy'],
      worktree,
      env,
      policy.installTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    config = { ...config, dependenciesHead: head };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    env = stackEnvironment(worktree, config, names, settings.mainCheckout);
  }
  return { policy, worktree, config, env, names };
}

async function runDedicatedPageDataStack(
  settings: Settings,
  head: string,
  invocation: string,
): Promise<PageDataStackResult> {
  const { policy, worktree, config, names, env: preparedEnv } = await prepareDedicatedPageDataStack(settings, head);
  const bun = process.execPath;
  let env = preparedEnv;
  const seeded = join(settings.stateDirectory, 'page-data-seeded');
  const stackCapture: BoundedOutput = {
    value: '',
    context: launchContext(worktree, head, [bun, 'services/auth/scripts/dev-stack.ts', 'start'], env),
  };
  let child: ChildProcess | undefined;
  let checked: ScopedPageDataResult | undefined;
  let registry: ReadonlyMap<string, SectionConfig> | undefined;
  let seedStatus: PageDataSeedStatus | undefined;
  let failed = false;
  let failure: unknown;
  try {
    await runCommand(
      bun,
      ['run', '--cwd', 'services/kernel', 'db', 'up'],
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    env = stackEnvironment(worktree, config, names, settings.mainCheckout);
    await runCommand(
      bun,
      ['run', '--cwd', 'services/kernel', 'search', 'up'],
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    await runCommand(
      bun,
      ['services/auth/scripts/dev-stack.ts', 'setup'],
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    env = stackEnvironment(worktree, config, names, settings.mainCheckout);

    child = spawn(bun, ['services/auth/scripts/dev-stack.ts', 'start'], {
      cwd: worktree,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForStack(
      child,
      [
        `http://127.0.0.1:${config.webPort}/en`,
        `http://127.0.0.1:${config.issuerPort}/.well-known/openid-configuration`,
        `http://127.0.0.1:${config.nativePort}/.well-known/openid-configuration`,
        `http://127.0.0.1:${config.kernelPort}/health`,
      ],
      policy.bootTimeoutMs,
      policy.outputBytes,
      policy.stopTimeoutMs,
      stackCapture,
    );

    seedStatus = await runPageDataSeedBoundary(
      head,
      join(worktree, pageDataDefinitionsReleaseFile),
      () =>
        runGitCapture(settings.mainCheckout, [
          'show',
          `refs/heads/${settings.integrationBranch}:${pageDataDefinitionsReleaseFile}`,
        ]),
      async () => {
        await runCommand(
          bun,
          pageDataDefinitionsActivationCommand(),
          worktree,
          env,
          policy.commandTimeoutMs,
          policy.outputBytes,
          'boot',
          [0],
          policy.stopTimeoutMs,
        );
      },
      async () => {
        if (existsSync(seeded)) return undefined;
        await runCommand(
          bun,
          ['services/auth/scripts/dev-stack.ts', 'persona'],
          worktree,
          env,
          policy.seedTimeoutMs,
          policy.outputBytes,
          'boot',
          [0],
          policy.stopTimeoutMs,
        );
        env = { ...env, ...readEnvFile(join(worktree, '.temp/local-stack/seed.env')) };
        const execution = await runPageDataSeedWithAdmission(
          pageDataSeedAdmission(settings.stateDirectory),
          async (signal) => {
            const seedResult = await runCommand(
              bun,
              ['scripts/datasets/cross-media-seed.ts', '--dev'],
              worktree,
              env,
              policy.seedTimeoutMs,
              policy.outputBytes,
              'boot',
              [0, 1],
              policy.stopTimeoutMs,
              signal,
            );
            if (seedResult.admissionDeferred) return { status: 'admission-deferred' };
            const status = pageDataSeedStatus(
              seedResult.exitCode,
              commandOutput(seedResult.stdout, seedResult.stderr),
              resolve(worktree, '.temp/cross-media-seed/result.json'),
            );
            return { status: 'completed', value: status };
          },
        );
        if (execution.status === 'admission-deferred') {
          captureEvent(stackCapture, { kind: 'seed', status: execution.status });
          return { status: execution.status };
        }
        const status = execution.value;
        if (status)
          captureEvent(stackCapture, {
            kind: 'seed',
            status: status.status,
            omissions: status.omissions,
          });
        if (!status) {
          mkdirSync(join(worktree, '.temp/local-stack'), { recursive: true });
          writeFileSync(seeded, `${head}\n`, { flag: 'w' });
        }
        return status;
      },
    );

    checked = await runPageDataScopedCheck(
      invocation,
      bun,
      [
        'scripts/page-data-check.ts',
        '--invocation',
        invocation,
        '--base-url',
        `http://127.0.0.1:${config.webPort}`,
        '--kernel',
        `http://127.0.0.1:${config.kernelPort}`,
        '--auth-origin',
        `http://127.0.0.1:${config.issuerPort}`,
      ],
      worktree,
      env,
      policy.checkTimeoutMs,
      policy.outputBytes,
      policy.stopTimeoutMs,
    );
    registry = sectionRegistry(worktree);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (child) {
      if (!stackCapture.teardown)
        captureEvent(stackCapture, { kind: 'teardown', reason: failed ? 'failure' : 'checks-complete' });
      stackCapture.teardown = true;
      await stopStack(child, policy.stopTimeoutMs);
    }
  }
  if (failed) {
    if (failure instanceof PageDataStackError)
      throw new PageDataStackError(
        failure.phase,
        failure.message,
        failure.firstErrorLine,
        combineFailureOutput(
          pageDataCaptureOutput(stackCapture, policy.outputBytes),
          failure.output || failure.message,
        ),
      );
    const message = errorMessage(failure);
    throw new PageDataStackError(
      'boot',
      message,
      undefined,
      pageDataCaptureOutput(stackCapture, policy.outputBytes) || message,
    );
  }
  const result = checked!;
  const diagnostics = [
    result.stderr,
    ...(result.scopeLimitExceeded
      ? [`Page-data systemd scope exhausted MemoryMax=${WORKER_SCOPE_MEMORY_MAX}; coverage is incomplete`]
      : []),
    ...(result.scopeKilled && !result.scopeLimitExceeded
      ? ['Page-data check scope was killed; coverage is incomplete']
      : []),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    output: result.stdout,
    diagnostics,
    exitCode: result.exitCode,
    registry: registry!,
    stackOutput: pageDataCaptureOutput(stackCapture, policy.outputBytes),
    ...(seedStatus ? { seed: seedStatus } : {}),
    ...(result.scopeLimitExceeded ? { scopeLimitExceeded: true } : {}),
    ...(result.scopeKilled ? { scopeKilled: true } : {}),
  };
}

/** Use the dedicated local operator for page-data Definitions activation. */
function pageDataDefinitionsActivationCommand(): string[] {
  return ['services/auth/scripts/dev-stack.ts', 'page-data-definitions', '--activate'];
}

const pageDataDefinitionsReleaseFile = 'packages/definitions/release/rezics.json';

export async function reconcileDedicatedPageDataDefinitions(settings: Settings): Promise<void> {
  if (!existsSync(join(settings.stateDirectory, 'page-data-stack.json')))
    throw new Error('The dedicated page-data stack has not been created');
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'page-data.lease'), settings.policy?.leases);
  try {
    if (!existsSync(join(settings.worktreeRoot, 'page-data-stack/.git')))
      throw new Error('The dedicated page-data worktree is missing');
    const head = runGit(settings.mainCheckout, ['rev-parse', settings.integrationBranch]);
    const { policy, worktree, env } = await prepareDedicatedPageDataStack(settings, head);
    assertPreparedPageDataHead(
      head,
      runGit(settings.mainCheckout, ['rev-parse', '--verify', `refs/heads/${settings.integrationBranch}`]),
    );
    const result = await runCommand(
      process.execPath,
      pageDataDefinitionsActivationCommand(),
      worktree,
      env,
      policy.commandTimeoutMs,
      policy.outputBytes,
      'boot',
      [0],
      policy.stopTimeoutMs,
    );
    process.stdout.write(result.stdout);
  } finally {
    lock.release();
  }
}

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === 'reconcile-definitions') {
    const { loadSettings } = await import('./settings.ts');
    await reconcileDedicatedPageDataDefinitions(loadSettings());
  } else if (process.argv.length === 4 && process.argv[2] === 'reconcile-repairs' && /^\d+$/.test(process.argv[3]!)) {
    if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
      throw new Error('Workers cannot reconcile retained page-data repairs');
    const [{ createRuntime }, { createRuntimeRepairRouting }] = await Promise.all([
      import('./config.ts'),
      import('./runtime-repair-routing.ts'),
    ]);
    const runtime = createRuntime();
    try {
      const result = await reconcilePageDataRepairs(
        {
          db: runtime.db,
          settings: runtime.settings,
          tasks: runtime.store,
          routeDefect: createRuntimeRepairRouting(runtime).routePageDataRepair,
        },
        Number(process.argv[3]),
      );
      console.log(JSON.stringify(result));
      if (result.unresolved.length) process.exitCode = 1;
    } finally {
      runtime.close();
    }
  } else throw new Error('Usage: bun tools/goal/src/page-data.ts reconcile-definitions | reconcile-repairs <run-id>');
}
