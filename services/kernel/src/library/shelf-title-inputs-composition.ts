import { createHash } from 'node:crypto';
import type { AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';
import type { ContentShelfTitleInputs } from './shelf-title-content-source.ts';
import { titleLanguages, type ShelfTitleLabels } from './shelf-title-source.ts';

type CurrentVersion = { status: 'unavailable' } | { status: 'current'; version: string };
type CurrentDecision = { subjectId: string; allowed: boolean };
type CurrentAccessSession = {
  status: 'current';
  version: string;
  decide(
    subjects: readonly string[],
  ): Promise<{ status: 'unavailable' } | { status: 'current'; version: string; decisions: readonly CurrentDecision[] }>;
  currentVersion(): Promise<CurrentVersion>;
};

/**
 * Content's Semantic observation contract: its bounded whole-source version covers labels, original languages,
 * identities, redirects and source ownership independently of requested IDs, and stays stable across Library-only
 * writes. An empty subjects list reads only that basis; an exact subjects list returns every requested original with
 * its resolved source identity. Each call releases its native snapshots before resolving, and never scans or reads
 * one Subject per requested ID.
 */
export interface ContentShelfTitleNativeObserver {
  observe(input: {
    owner: ShelfOwner;
    languages: readonly string[];
    viewer: AccountActor;
    subjects: readonly string[];
    deadline: number;
  }): Promise<{ status: 'unavailable' } | { status: 'current'; version: string; entries: readonly ShelfTitleLabels[] }>;
}

/**
 * Current Access observation for one owner and viewer. `begin` captures disclosure for the complete title source
 * regardless of requested IDs and stays stable across Library-only writes. Each decision batch applies current
 * `subject:read` authority and returns that same complete version; callers may pass at most 64 exact IDs per batch.
 * Every method releases its native snapshots before resolving.
 */
export interface ContentShelfTitleCurrentAccess {
  begin(input: {
    owner: ShelfOwner;
    viewer: AccountActor;
    deadline: number;
  }): Promise<CurrentAccessSession | { status: 'unavailable' }>;
}

const unavailable = { status: 'unavailable' as const };
const maxOriginals = 100;
const accessBatchSize = 64;
const validVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

type Request = {
  owner: ShelfOwner;
  languages: string[];
  viewer: AccountActor;
  subjects: string[];
  deadline: number;
};

function ownerAndViewer(input: Request) {
  return {
    owner: { ...input.owner },
    // Access authentication binds proof to this exact actor object.
    viewer: input.viewer,
  };
}

function titleInput(input: Request, subjects = input.subjects) {
  return {
    ...ownerAndViewer(input),
    languages: [...input.languages],
    subjects: [...subjects],
    deadline: input.deadline,
  };
}

function request(input: {
  owner: ShelfOwner;
  languages: readonly string[];
  viewer: AccountActor;
  subjects: readonly string[];
  deadline: number;
}): Request {
  if (
    !input.owner ||
    typeof input.owner.accountId !== 'string' ||
    routeOf(input.owner.accountId) !== input.owner.route ||
    !input.viewer ||
    input.viewer.kind !== 'account' ||
    input.viewer.accountId !== input.owner.accountId
  )
    throw new TypeError('Invalid Content shelf title owner');
  if (!Number.isFinite(input.deadline)) throw new TypeError('Content shelf titles require the request deadline');
  if (
    !Array.isArray(input.subjects) ||
    input.subjects.length > maxOriginals ||
    new Set(input.subjects).size !== input.subjects.length ||
    input.subjects.some((id) => typeof id !== 'string' || routeOf(id) === null)
  )
    throw new RangeError('Content shelf titles require at most 100 exact subjects');
  return {
    owner: { ...input.owner },
    languages: titleLanguages(input.languages),
    // Preserve the native authenticated identity through Access proof preparation.
    viewer: input.viewer,
    subjects: [...input.subjects],
    deadline: input.deadline,
  };
}

function versionBinding(input: Request, titleVersion: string, accessVersion: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'content-composed-shelf-title-v1',
        input.owner,
        input.languages,
        input.viewer.accountId,
        input.viewer.clientId,
        input.viewer.requestedBy,
        input.viewer.authnEpoch,
        [...input.viewer.scopes].sort(),
        titleVersion,
        accessVersion,
      ]),
    )
    .digest('hex');
}

function exactRows(subjects: readonly string[], rows: readonly ShelfTitleLabels[]): ShelfTitleLabels[] | undefined {
  if (!Array.isArray(rows) || rows.length !== subjects.length) return undefined;
  const expected = new Set(subjects);
  const bySubject = new Map<string, ShelfTitleLabels>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.subjectId !== 'string' ||
      !expected.delete(row.subjectId) ||
      typeof row.sourceId !== 'string' ||
      routeOf(row.sourceId) === null ||
      !validVersion(row.sourceBasis) ||
      !row.labels ||
      typeof row.labels !== 'object' ||
      Array.isArray(row.labels) ||
      Object.values(row.labels).some((value) => typeof value !== 'string') ||
      (row.originalLanguage !== undefined && row.originalLanguage !== null && typeof row.originalLanguage !== 'string')
    )
      return undefined;
    const copy: ShelfTitleLabels = {
      subjectId: row.subjectId,
      sourceId: row.sourceId,
      sourceBasis: row.sourceBasis,
      labels: { ...row.labels },
      ...(row.originalLanguage === undefined ? {} : { originalLanguage: row.originalLanguage }),
    };
    bySubject.set(copy.subjectId, copy);
  }
  return expected.size === 0 ? subjects.map((id) => bySubject.get(id)!) : undefined;
}

function exactDecisions(
  subjects: readonly string[],
  rows: readonly CurrentDecision[],
): Map<string, boolean> | undefined {
  if (!Array.isArray(rows) || rows.length !== subjects.length) return undefined;
  const expected = new Set(subjects);
  const bySubject = new Map<string, boolean>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.subjectId !== 'string' ||
      !expected.delete(row.subjectId) ||
      typeof row.allowed !== 'boolean'
    )
      return undefined;
    bySubject.set(row.subjectId, row.allowed);
  }
  return expected.size === 0 ? bySubject : undefined;
}

/** Compose released native title observations with complete current Access authority for Library's receiving port. */
export function composeContentShelfTitleInputs(
  titles: ContentShelfTitleNativeObserver,
  access: ContentShelfTitleCurrentAccess,
): ContentShelfTitleInputs {
  return {
    async observe(untrustedInput) {
      const input = request(untrustedInput);
      try {
        // The Access interval starts before the native title read and remains open through all batched decisions.
        const accessSession = await access.begin({
          ...ownerAndViewer(input),
          deadline: input.deadline,
        });
        if (
          accessSession.status !== 'current' ||
          !validVersion(accessSession.version) ||
          typeof accessSession.decide !== 'function' ||
          typeof accessSession.currentVersion !== 'function'
        )
          return unavailable;

        const title = await titles.observe(titleInput(input));
        if (title.status !== 'current' || !validVersion(title.version)) return unavailable;
        const rows = exactRows(input.subjects, title.entries);
        if (!rows) return unavailable;

        const decisionSubjects = [...new Set(rows.flatMap((row) => [row.subjectId, row.sourceId]))];
        for (let offset = 0; offset < decisionSubjects.length; offset += accessBatchSize) {
          const batch = decisionSubjects.slice(offset, offset + accessBatchSize);
          const observed = await accessSession.decide([...batch]);
          if (
            observed.status !== 'current' ||
            !validVersion(observed.version) ||
            observed.version !== accessSession.version
          )
            return unavailable;
          const decisions = exactDecisions(batch, observed.decisions);
          if (!decisions || batch.some((id) => decisions.get(id) !== true)) return unavailable;
        }

        // Finish the complete title/provenance check before the final Access clock read. That clock
        // also covers Content source-fence invalidations, so it is the observation's last native read.
        const titleEnd = await titles.observe(titleInput(input, []));
        if (
          titleEnd.status !== 'current' ||
          !validVersion(titleEnd.version) ||
          titleEnd.version !== title.version ||
          titleEnd.entries.length !== 0
        )
          return unavailable;
        const accessEnd = await accessSession.currentVersion();
        if (accessEnd.status !== 'current' || accessEnd.version !== accessSession.version) return unavailable;

        return {
          status: 'current' as const,
          version: versionBinding(input, title.version, accessSession.version),
          entries: rows.map((row) => ({ state: 'disclosed' as const, ...row })),
        };
      } catch {
        // Every injected observation owns and releases its own snapshot before resolving or rejecting.
        return unavailable;
      }
    },
  };
}
