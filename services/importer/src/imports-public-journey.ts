/** Walk every first-public Imports path on one admitted dev-stack session.
 *
 *   bun services/auth/scripts/dev-stack.ts walk --import-catalogue -- bun services/importer/src/imports-public-journey.ts
 *
 * Operators import licensed fixtures through the ordinary CLI, then separately accept/adopt and independently
 * read. Catalogue rows share one fresh seed. A row failure is recorded; independent rows continue.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import { walkStackAdmitted } from '../../../scripts/stack-run.ts';
import { createAccountTokenProvider, IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { runImportCli, type ImportCliOptions } from './cli.ts';
import { createImporter } from './importer.ts';
import { reviewedCatalogueProblem } from './http.ts';
import { createImportTransport, importTransportCause, ImportTransportError } from './import-client.ts';
import {
  formatSeedFailure,
  mergeRemainingRequest,
  readSeedRemainingRequest,
  remainingRequestFromPreparedJournal,
} from './seed-remaining-request.ts';
import { importCorrelationId, MAX_IMPORT_DEADLINE_MS } from './import-fetch.ts';
import { ImportSession } from './import-session.ts';
import { sameStatementProvenance } from './statement-provenance.ts';
import {
  createPublicBulkClient,
  GLOBAL_CONTEXT,
  PublicSubjectGetUnavailable,
  ReviewedSubjectNotReady,
  selectedSynopsisQueryFromPublic,
} from './public-bulk-client.ts';
import { BOOK_OWNER_GRANT_ACTIONS, grantOrdinaryOwnerActions } from './ordinary-owner-grants.ts';
import {
  citedAnimeCreditTargets,
  journeyTargets,
  journeyViewports,
  runBangumiJourney,
  selectJourneyWorks,
  startWalkStackActions,
  type JourneyMountedVisit,
  type JourneyPublishedRow,
  type JourneyTarget,
} from './showcase-bangumi-journey.ts';
import type { CrossMediaSeedReport } from './cross-media-seed.ts';
import type { ShowcasePublicationResult } from './showcase-publication-contract.ts';

const root = resolve(import.meta.dir, '../../..');
const evidenceRoot = resolve(root, '.temp/imports-walk');

export const FIRST_PUBLIC_IMPORT_ROWS = [
  {
    id: 'I01',
    path: 'Bangumi operator',
    driver: 'ordinary CLI + licensed Bangumi JSONL fixture',
  },
  {
    id: 'I02',
    path: 'VNDB operator',
    driver: 'ordinary CLI + licensed VNDB COPY archive fixture',
  },
  {
    id: 'I03',
    path: 'Open Library Work/Edition operator',
    driver: 'ordinary CLI + licensed Open Library TSV fixture',
  },
  {
    id: 'I04',
    path: 'Wikidata operator',
    driver: 'ordinary CLI + licensed Wikidata JSONL fixture',
  },
  {
    id: 'I05',
    path: 'selected anime with episodes/staff/cast/Characters',
    driver: 'fresh seed + public Subject/links + phone/desktop pages',
  },
  {
    id: 'I06',
    path: 'Game/Release/counterpart',
    driver: 'fresh seed + current Game, Release and counterpart reads',
  },
  {
    id: 'I07',
    path: 'reviewed Person identity/credits',
    driver: 'fresh seed + current Person identifiers and credits',
  },
  {
    id: 'I08',
    path: 'typed franchise',
    driver: 'fresh seed + current typed franchise relations',
  },
  {
    id: 'I09',
    path: 'reviewed tags with independent property continuation',
    driver: 'fresh seed + current tag facts on the same handle',
  },
  {
    id: 'I10',
    path: 'Sources/selected synopsis',
    driver: 'fresh seed + independent selected-slot Sources read',
  },
  {
    id: 'I11',
    path: 'series499/volume26',
    driver: 'fresh seed + BookSeries 499 and volume 26 current reads',
  },
  {
    id: 'I12',
    path: 'series2815/volumes5329/10862',
    driver: 'fresh seed + BookSeries 2815 and volumes 5329/10862 current reads',
  },
] as const;

export type FirstPublicImportRowId = (typeof FIRST_PUBLIC_IMPORT_ROWS)[number]['id'];

export type WalkRowResult = {
  id: FirstPublicImportRowId;
  path: string;
  result: 'passing' | 'failing';
  elapsedMs: number | null;
  cause: string | null;
  evidence: Record<string, unknown>;
};

export type WalkInventory = {
  command: string;
  revision: string;
  startedAt: string;
  endedAt: string;
  passing: number;
  total: number;
  browserStageFailure?: string;
  slowestFailing: { id: FirstPublicImportRowId; path: string; elapsedMs: number; cause: string } | null;
  rows: WalkRowResult[];
};

const retainedCommand =
  'bun services/auth/scripts/dev-stack.ts walk --import-catalogue -- bun services/importer/src/imports-public-journey.ts';

function requiredOrigin(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run this command under dev-stack.ts walk`);
  return new URL(value).origin;
}

function stackOrigins() {
  return {
    web: requiredOrigin('REZICS_LOCAL_STACK_WEB_ORIGIN'),
    issuer: requiredOrigin('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
    native: requiredOrigin('REZICS_LOCAL_STACK_NATIVE_ORIGIN'),
    kernel: requiredOrigin('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
  };
}

/** Account-key calls use native Auth as transport and keep CSRF Origin plus audience on the issuer. */
export function walkSeedChildEnv(
  stack: { native: string; issuer: string; kernel: string },
  persona: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...persona,
    AUTH_ORIGIN: stack.native,
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: stack.issuer,
    KERNEL_ORIGIN: stack.kernel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type MountedRowId = 'I05' | 'I11' | 'I12';

function isMountedRow(id: FirstPublicImportRowId): id is MountedRowId {
  return id === 'I05' || id === 'I11' || id === 'I12';
}

export function mountedVisitsForRow<Visit extends JourneyTarget>(id: MountedRowId, visits: readonly Visit[]) {
  if (id === 'I05') return visits.filter((visit) => visit.role === 'anime');
  const series = id === 'I11' ? '499' : '2815';
  return visits.filter(
    (visit) => (visit.series ?? visit.sourceKey) === series || (id === 'I12' && visit.sourceKey === '233'),
  );
}

export function mountedWalkRow(
  row: WalkRowResult,
  visits: readonly JourneyMountedVisit[],
  elapsedMs = 0,
  browserFailure?: string,
): WalkRowResult {
  if (!isMountedRow(row.id)) return row;
  const browserVisits = mountedVisitsForRow(row.id, visits);
  const complete = mountedVisitsForRow(row.id, journeyTargets).every((target) =>
    Object.keys(journeyViewports).every((viewport) =>
      browserVisits.some((visit) => visit.sourceKey === target.sourceKey && visit.viewport === viewport),
    ),
  );
  return {
    ...row,
    elapsedMs: row.elapsedMs === null ? null : row.elapsedMs + elapsedMs,
    result: row.result === 'passing' && complete ? 'passing' : 'failing',
    cause: row.cause ?? (complete ? null : (browserFailure ?? 'Required mounted visits are incomplete')),
    evidence: {
      ...row.evidence,
      native: row.result,
      browser: complete ? 'passing' : browserFailure ? 'failing' : 'pending',
      browserVisits,
      ...(!complete && browserFailure ? { browserError: browserFailure } : {}),
    },
  };
}

function prerequisiteFailed(row: WalkRowResult): boolean {
  return row.result === 'failing' && (row.evidence.seed === true || row.evidence.sharedStartup === true);
}

function slowestReachedFailure(rows: readonly WalkRowResult[]): WalkInventory['slowestFailing'] {
  const slowest = rows
    .filter((row) => row.result === 'failing' && row.elapsedMs !== null && !prerequisiteFailed(row))
    .sort((left, right) => right.elapsedMs! - left.elapsedMs!)[0];
  return slowest && slowest.elapsedMs !== null
    ? { id: slowest.id, path: slowest.path, elapsedMs: slowest.elapsedMs, cause: slowest.cause ?? 'failed' }
    : null;
}

export function walkInventorySummary(inventory: WalkInventory): string {
  const unreached = inventory.rows.filter(prerequisiteFailed).length;
  const failing = inventory.rows.filter((row) => row.result === 'failing').length - unreached;
  const slowest = slowestReachedFailure(inventory.rows);
  return `${inventory.passing}/${inventory.total} passing; slowest failing ${
    slowest ? `${slowest.id} ${slowest.elapsedMs}ms ${slowest.cause}` : 'none'
  }; ${failing} failing${unreached ? `; ${unreached} unreached` : ''}`;
}

const OBSERVED_WALK_HEADING = '### Observed walk';

export const WALK_ROW_REPAIR_OWNERS: Record<FirstPublicImportRowId, { goal: string; manager: string }> = {
  I01: { goal: 'imports', manager: 'imports' },
  I02: { goal: 'imports', manager: 'imports' },
  I03: { goal: 'imports', manager: 'imports' },
  I04: { goal: 'imports', manager: 'imports' },
  I05: { goal: 'imports', manager: 'imports' },
  I06: { goal: 'imports', manager: 'imports' },
  I07: { goal: 'semantic', manager: 'semantic' },
  I08: { goal: 'imports', manager: 'imports' },
  I09: { goal: 'semantic', manager: 'semantic' },
  I10: { goal: 'semantic', manager: 'semantic' },
  I11: { goal: 'imports', manager: 'imports' },
  I12: { goal: 'imports', manager: 'imports' },
};

function markdownTableCell(value: string): string {
  return value.replaceAll('|', '/').replaceAll('\n', ' ').slice(0, 220);
}

function currentReadEvidence(evidence: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['id', 'series', 'canonical', 'sourceKey', 'type', 'kind']) {
    const value = evidence[key];
    if (typeof value === 'string') parts.push(`${key} ${value}`);
  }
  if (evidence.browser === 'passing' || evidence.browser === 'failing') parts.push(`browser ${evidence.browser}`);
  return parts.join(', ') || 'current read';
}

export function capabilitiesResultCell(row: WalkRowResult): string {
  if (prerequisiteFailed(row)) return markdownTableCell(`unreached; ${row.cause ?? 'prerequisite failed'}`);
  const detail = row.result === 'passing' ? currentReadEvidence(row.evidence) : (row.cause ?? 'failed');
  return markdownTableCell(
    `${row.result}; ${row.elapsedMs === null ? 'duration unknown' : `${row.elapsedMs}ms`}; ${detail}`,
  );
}

export function applyWalkInventoryToCapabilities(markdown: string, inventory: WalkInventory): string {
  let text = markdown;
  for (const row of inventory.rows) {
    const pattern = new RegExp(`(\\| ${row.id}\\s+\\| [^|\\n]+\\| )[^|\\n]+`);
    if (!pattern.test(text)) throw new Error(`capabilities table is missing ${row.id}`);
    text = text.replace(pattern, `$1${capabilitiesResultCell(row)} `);
  }
  const slowest = slowestReachedFailure(inventory.rows);
  const unreached = inventory.rows.filter(prerequisiteFailed).length;
  const record = [
    OBSERVED_WALK_HEADING,
    '',
    `Command: \`${inventory.command}\`. Revision \`${inventory.revision}\`. Started ${inventory.startedAt}; ended ${inventory.endedAt}. ${inventory.passing}/${inventory.total} passing.`,
    slowest ? `Slowest failing: ${slowest.id} ${slowest.elapsedMs}ms ${slowest.cause}.` : 'No measured row failure.',
    ...(unreached ? [`${unreached} rows were unreached after a prerequisite failed.`] : []),
    ...(inventory.browserStageFailure ? [`Mounted stage failure: ${inventory.browserStageFailure}.`] : []),
    '',
  ].join('\n');
  if (text.includes(OBSERVED_WALK_HEADING)) {
    text = text.replace(/### Observed walk\n(?:.*\n)*?(?=Books owner-grant)/, `${record}`);
  } else {
    text = text.replace('\nBooks owner-grant', `\n${record}Books owner-grant`);
  }
  return text;
}

export function walkRepairSkipReason(row: WalkRowResult): string | null {
  if (row.result !== 'failing' || row.cause === null) return null;
  if (row.id === 'I09' && /handle|continuation|erasur/i.test(row.cause))
    return 'Tags has a same-handle continuation; this walk records the independent property reread and does not duplicate that repair.';
  if (row.id === 'I10' && /erasur|contention|identity/i.test(row.cause))
    return 'Semantic owns concurrent Sources erasure and identity contention; this walk does not duplicate that repair.';
  return null;
}

export function walkRepairBrief(inventory: WalkInventory, row: WalkRowResult): string {
  const owner = WALK_ROW_REPAIR_OWNERS[row.id];
  return `# Repair: ${row.id} ${row.path}

Goal: ${owner.goal}
Manager: ${owner.manager}

## Observed failure

Command: \`${inventory.command}\`
Revision: \`${inventory.revision}\`
Elapsed: ${row.elapsedMs}ms
Cause: ${row.cause}

Current public reads, rights and exact provenance decide success. Do not weaken the walk assertions or add a parallel driver.

## Required repair

Reproduce with the retained walk command on one admitted stack. Fix the owning module so this row's current-read evidence passes, then rerun the same driver.
`;
}

/** Remote returns are outputs: never declare the owner document or shared continuation directory. */
export async function writeWalkInventoryArtifacts(inventory: WalkInventory, repository = root): Promise<void> {
  const output = resolve(repository, '.temp/imports-walk');
  const capabilitiesPath = resolve(repository, 'docs/goals/imports.capabilities.md');
  const markdown = applyWalkInventoryToCapabilities(await readFile(capabilitiesPath, 'utf8'), inventory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(resolve(output, 'imports.capabilities.md'), markdown);
  const drafts = resolve(output, 'continuation');
  await mkdir(drafts, { recursive: true, mode: 0o700 });
  const failing = inventory.rows.filter((row) => row.result === 'failing');
  const shared = failing.length === inventory.total && failing.every((row) => row.evidence.sharedStartup === true);
  if (shared && failing[0]) {
    await writeFile(
      resolve(drafts, 'imports-walk-shared-startup.md'),
      `# Shared walk startup

Goal: imports
Manager: semantic

Command: ${inventory.command}
Revision: ${inventory.revision}
Started: ${inventory.startedAt}; ended: ${inventory.endedAt}
All twelve rows failed before product paths ran: ${failing[0].cause}

Reproduce with the retained walk command on one admitted stack. Restore ordinary Auth persona setup before claiming any path passed. Preserve the existing assertions and independently read the current facts.
`,
    );
    return;
  }
  const seedRows = failing.filter((row) => row.evidence.seed === true);
  if (seedRows[0]) {
    const cause = seedRows[0].cause ?? 'seed unavailable';
    const owner = /sourceFences/.test(cause) ? 'Content d66' : 'Semantic cf23';
    await writeFile(
      resolve(drafts, 'imports-walk-seed.md'),
      `# Resume catalogue paths after shared seed failure

Goal: imports
Manager: semantic

Command: ${inventory.command}
Revision: ${inventory.revision}
Started: ${inventory.startedAt}; ended: ${inventory.endedAt}
Elapsed seed work: ${seedRows[0].elapsedMs}ms
Affected rows: ${seedRows.map((row) => row.id).join(', ')}
Cause: ${cause}

Existing owner: ${owner}. This is input for that repair, not a second implementation assignment. Proposal contention and sourceFences remain separate incidents. Operation/partition/server phase are unretained unless present in the safe request evidence. No catalogue current read or browser path was exercised after the failed seed.

Use the returned seed.log and remaining-request.json, retaining the exact prepared source tuple, native type, converter, method/path/status and any safe problem/correlation. Resume only through ordinary APIs and the original sealed body/key. The complete fresh manifest must finish before catalogue reads. Rerun this same twelve-row command; preserve exact id/type, public facts, provenance, separate acceptance/adoption and phone/desktop assertions. Tags' same-handle continuation and Semantic's concurrent Sources erasure keep their existing owners.
`,
    );
  }
  for (const row of failing) {
    if (row.evidence.seed === true) continue;
    const skip = walkRepairSkipReason(row);
    if (skip) continue;
    await writeFile(resolve(drafts, `imports-walk-${row.id.toLowerCase()}.md`), walkRepairBrief(inventory, row));
  }
}

/** Seal returned observations only after the controller confirms the owned run has ended.
 * An infrastructure termination has no row-local elapsed time. Keep it unknown rather than
 * subtracting clocks from different hosts or converting the entire run lifetime into row time.
 */
export function sealInterruptedWalkInventory(
  run: Pick<WalkInventory, 'command' | 'revision' | 'startedAt'>,
  rows: readonly WalkRowResult[],
  active: { id: FirstPublicImportRowId; startedAt: string },
  terminal: { finishedAt: string; cause: string; checkId: string; runElapsedMs: number },
): WalkInventory {
  const observed = new Map(rows.map((row) => [row.id, row]));
  const activeRow = observed.get(active.id);
  if (!activeRow || (activeRow.evidence.native === 'passing' && activeRow.evidence.browser === 'pending')) {
    observed.set(active.id, {
      id: active.id,
      path: firstPublicRow(active.id).path,
      result: 'failing',
      elapsedMs: null,
      cause: terminal.cause,
      evidence: {
        ...activeRow?.evidence,
        interrupted: true,
        activeStartedAt: active.startedAt,
        controllerFinishedAt: terminal.finishedAt,
        checkId: terminal.checkId,
        runElapsedMs: terminal.runElapsedMs,
        ...(activeRow ? {} : { currentRead: 'not reached' }),
      },
    });
  }
  // A returned partial directory cannot establish outcomes for unobserved rows.
  const missing = FIRST_PUBLIC_IMPORT_ROWS.filter((row) => !observed.has(row.id));
  if (missing.length) throw new Error(`No returned walk observation for ${missing.map((row) => row.id).join(', ')}`);
  const ordered = FIRST_PUBLIC_IMPORT_ROWS.map((row) => observed.get(row.id)!);
  return {
    ...run,
    endedAt: terminal.finishedAt,
    passing: ordered.filter((row) => row.result === 'passing').length,
    total: ordered.length,
    rows: ordered,
    slowestFailing: slowestReachedFailure(ordered),
  };
}

/** Apply returned output locally after the check settles; source inputs survive artifact cleanup. */
export async function receiveWalkInventoryArtifacts(repository = root): Promise<WalkInventory> {
  const output = resolve(repository, '.temp/imports-walk');
  const inventory: WalkInventory = JSON.parse(await readFile(resolve(output, 'inventory.json'), 'utf8'));
  await writeWalkInventoryArtifacts(inventory, repository);
  await writeFile(
    resolve(repository, 'docs/goals/imports.capabilities.md'),
    await readFile(resolve(output, 'imports.capabilities.md')),
  );
  const { readdir } = await import('node:fs/promises');
  const destination = resolve(repository, '.temp/continuation');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of await readdir(resolve(output, 'continuation')))
    await writeFile(resolve(destination, name), await readFile(resolve(output, 'continuation', name)));
  return inventory;
}

/** Current Character endpoints on a Work; only `wd:Q95074` identities count. */
export function currentAnimeCharacterIds(
  links: readonly { summary: { id: string; type: string }; property: string }[],
): string[] {
  const ids = [
    ...new Set(
      links
        .filter((link) => link.property === 'schema:character' && link.summary.type === 'wd:Q95074')
        .map((link) => link.summary.id),
    ),
  ];
  if (ids.length === 0) throw new Error('anime has no current Characters');
  return ids;
}

export function selectPublished<Row extends JourneyPublishedRow>(
  published: readonly Row[],
  provider: string,
  sourceKey: string,
): Row {
  const rows = published.filter((row) => row.provider === provider && row.sourceKey === sourceKey);
  if (rows.length !== 1) throw new Error(`published ${provider}:${sourceKey} has ${rows.length} rows`);
  return rows[0]!;
}

export function firstPublicRow(id: FirstPublicImportRowId) {
  return FIRST_PUBLIC_IMPORT_ROWS.find((row) => row.id === id)!;
}

const CHILD_ERROR_LINE = /^(?:error:|Error:|TypeError:|remote-check:.*failed|task: Failed)/;

export function walkFailureCause(error: unknown): string {
  return importTransportCause(error);
}

function isRetryableWalkTransport(error: unknown): boolean {
  if (error instanceof ImportTransportError)
    return error.status === 503 || error.phase === 'readiness' || error.phase === 'SubjectGET503';
  return false;
}

async function retryWalkTransport<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableWalkTransport(error) || attempt === 4) throw error;
      await Bun.sleep(200);
    }
  }
  throw new Error('walk transport retry exhausted');
}

export function walkChildFailure(name: string, code: number, stdout: string, stderr: string): Error {
  const lines = `${stdout}\n${stderr}`.split('\n');
  const marked = lines.find((line) => CHILD_ERROR_LINE.test(line.trim()));
  const fromStderr = stderr.split('\n').findLast((line) => line.trim().length > 0);
  const fromStdout = stdout.split('\n').findLast((line) => line.trim().length > 0);
  const error = marked?.trim() || fromStderr?.trim() || fromStdout?.trim();
  return new Error(`${name} exited ${code}${error ? `: ${error}` : ''}`);
}

/** Slot ports reuse a database URL after wipe; leftover native IDs cannot replay. Sibling seeded walks archive first. */
export async function retireWalkJournals(repository = root): Promise<void> {
  const archives = resolve(repository, '.temp/local-stack/seed-archives');
  await mkdir(archives, { recursive: true, mode: 0o700 });
  for (const name of ['cross-media-seed', 'imports-walk'] as const) {
    try {
      await rename(resolve(repository, '.temp', name), resolve(archives, `${name}-${randomUUID()}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

const SEED_PHASE_LINE =
  /^Cross-media seed finalization state=(?:started|completed|failed) scope=(?:seed|record-import|publication|books)(?: phase=[a-z-]+)? remaining=[a-z,-]+$/;
const RESERVED_COVER_CONTINUATION =
  /^Cross-media seed import failed provider=bangumi kind=bulk-failed generation=([1-9][0-9]{0,19}) run\{phase=media reason=cover-pending keyDigest=([a-f0-9]{64}) mediaState=reserved\}[^\n]* finalization\{scope=record-import phase=bangumi-cover-continuation /m;

export async function captureSeedStderr(
  stream: ReadableStream<Uint8Array>,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<string> {
  let stderr = '';
  let pending = '';
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    stderr += chunk;
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (SEED_PHASE_LINE.test(line)) write(line);
    }
  }
  if (SEED_PHASE_LINE.test(pending)) write(pending);
  return stderr;
}

async function command(name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  // The admitted walk owns this child's process group and its existing end-to-end budget.
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    captureSeedStderr(child.stderr),
    child.exited,
  ]);
  let diagnostic = '';
  const reserved = name === 'seed' && code !== 0 ? RESERVED_COVER_CONTINUATION.exec(stderr) : null;
  if (reserved) {
    // The admitted walk still owns PostgreSQL here. Keep the observation with the returned seed log.
    let evidence: object;
    try {
      const { readCoverContinuation } = await import('../../kernel/scripts/read-cover-continuation.ts');
      evidence = await readCoverContinuation({
        journal: resolve(root, '.temp/cross-media-seed/state.sqlite'),
        generation: reserved[1]!,
        keyDigest: reserved[2]!,
        account: env.REZICS_DEV_PERSONA_ACCOUNT!,
        databasePort: process.env.KERNEL_DATABASE_PORT!,
        kernelEnvironment: await parseEnv(resolve(root, 'services/kernel/.env')),
      });
    } catch {
      evidence = { state: 'unavailable' };
    }
    const line = `Cover continuation diagnostic ${JSON.stringify(evidence)}`;
    console.error(line);
    diagnostic = `\n${line}\n`;
  }
  await writeFile(resolve(evidenceRoot, `${name}.log`), `${stdout}${stderr}${diagnostic}`, { mode: 0o600 });
  if (code !== 0) throw walkChildFailure(name, code, stdout, stderr);
}

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups) values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function currentSubject(api: string, id: string) {
  const reader = createPublicBulkClient({ origin: api });
  const signal = AbortSignal.timeout(MAX_IMPORT_DEADLINE_MS);
  let body: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      body = await reader.readSubject(id, signal);
      break;
    } catch (error) {
      if (
        attempt === 5 ||
        (!(error instanceof ReviewedSubjectNotReady) && !(error instanceof PublicSubjectGetUnavailable))
      )
        throw error;
      await Bun.sleep(200);
    }
  }
  if (
    !isRecord(body) ||
    !isRecord(body.subject) ||
    typeof body.subject.id !== 'string' ||
    typeof body.subject.type !== 'string' ||
    !isRecord(body.subject.statements)
  )
    throw new TypeError(`Current Subject ${id} has an invalid response shape`);
  return body as {
    subject: { id: string; type: string; release?: string; context?: string; statements: Record<string, unknown[]> };
    summary?: unknown;
  };
}

async function currentLinks(api: string, id: string, property: string) {
  const response = await fetch(`${api}/v1/subjects/${id}/links?property=${encodeURIComponent(property)}&limit=100`);
  assert.equal(response.status, 200, `anonymous links ${id} ${property}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.links))
    throw new TypeError(`Current ${property} links for ${id} have an invalid response shape`);
  return body.links as { summary: { id: string; type: string }; property: string }[];
}

type SeedEnv = {
  account: string;
  accountKeyPath: string;
  client: string;
  auth: string;
  issuer: string;
  kernel: string;
  file: Record<string, string>;
};

async function readPersona(): Promise<SeedEnv> {
  const origins = stackOrigins();
  const seedEnv = await parseEnv(resolve(root, '.temp/local-stack/seed.env'));
  const {
    REZICS_DEV_PERSONA_ACCOUNT: account,
    REZICS_DEV_PERSONA_ACCOUNT_KEY: accountKeyPath,
    REZICS_DEV_PERSONA_CLIENT: client,
  } = seedEnv;
  if (!account || !accountKeyPath || !client) throw new Error('The admitted catalogue persona is incomplete');
  return {
    account,
    accountKeyPath,
    client,
    auth: origins.native,
    issuer: origins.issuer,
    kernel: origins.kernel,
    file: seedEnv,
  };
}

async function grantOwner(persona: SeedEnv) {
  const grantor = await createAccountTokenProvider({
    accountKeyPath: persona.accountKeyPath,
    account: persona.account,
    client: persona.client,
    authOrigin: persona.auth,
    issuerOrigin: persona.issuer,
    scopes: [...IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt', 'access:grant'],
  });
  await grantOrdinaryOwnerActions({
    accountId: persona.account,
    actions: BOOK_OWNER_GRANT_ACTIONS,
    post: async ({ path, body, idempotencyKey }) => {
      const response = await fetch(`${persona.kernel}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await grantor()}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(idempotencyKey),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
  });
}

type OperatorSpec = {
  source: 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata';
  dump?: string;
  stdin?: () => AsyncIterable<Uint8Array>;
  keys: readonly string[];
  property: string;
  scopes: readonly string[];
};

function tarEntry(name: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
  put(0, name);
  for (const offset of [100, 108, 116]) put(offset, '0000644\0');
  put(124, `${body.length.toString(8).padStart(11, '0')}\0`);
  put(136, '00000000000\0');
  put(148, '        ');
  put(156, '0');
  put(257, 'ustar\0');
  put(263, '00');
  put(
    148,
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
  );
  const padding = (512 - (body.length % 512)) % 512;
  const out = new Uint8Array(512 + body.length + padding);
  out.set(header);
  out.set(body, 512);
  return out;
}

export async function* licensedVndbArchive(): AsyncGenerator<Uint8Array> {
  const directory = resolve(root, 'specs/fixtures/imports/vndb-tables/db');
  for (const name of [
    'TIMESTAMP',
    'vn.header',
    'vn',
    'vn_titles.header',
    'vn_titles',
    'entry_meta.header',
    'entry_meta',
  ]) {
    const body =
      name === 'TIMESTAMP'
        ? new TextEncoder().encode('2026-10-25 00:00:00+00\n')
        : readFileSync(resolve(directory, name));
    yield tarEntry(name === 'TIMESTAMP' ? name : `db/${name}`, body);
  }
  yield new Uint8Array(1024);
}

const operatorSpecs: Record<'I01' | 'I02' | 'I03' | 'I04', OperatorSpec> = {
  I01: {
    source: 'bangumi',
    dump: resolve(root, 'specs/fixtures/imports/api/bangumi.jsonl'),
    keys: ['1'],
    property: 'schema:name',
    scopes: [...IMPORTER_SCOPES, 'subject:read'],
  },
  I02: {
    source: 'vndb',
    stdin: licensedVndbArchive,
    keys: ['v123'],
    property: 'schema:name',
    scopes: [...VNDB_IMPORTER_SCOPES, 'subject:read'],
  },
  I03: {
    source: 'openlibrary',
    dump: resolve(root, 'specs/fixtures/imports/dumps/openlibrary.tsv'),
    keys: ['/works/OL1W', '/books/OL2M'],
    property: 'schema:name',
    scopes: [...IMPORTER_SCOPES, 'subject:read'],
  },
  I04: {
    source: 'wikidata',
    dump: resolve(root, 'specs/fixtures/imports/api/wikidata.jsonl'),
    keys: ['Q1'],
    property: 'schema:name',
    scopes: [...IMPORTER_SCOPES, 'subject:read'],
  },
};

export async function operatorResponseEvidence(response: Response) {
  const payload: unknown =
    response.body && response.headers.get('content-type')?.includes('json')
      ? await response
          .clone()
          .json()
          .catch(() => undefined)
      : undefined;
  const problems =
    isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
          .filter(isRecord)
          .filter((row) => row.problem !== undefined)
          .map((row) => {
            const problem = isRecord(row.problem) ? row.problem : {};
            return reviewedCatalogueProblem({ ...problem, status: row.status ?? problem.status });
          })
      : response.status >= 400
        ? [reviewedCatalogueProblem(payload)]
        : [];
  return { status: response.status, problems, correlation: importCorrelationId(response) };
}

type OperatorRequest = { method: string; path: string } & Partial<Awaited<ReturnType<typeof operatorResponseEvidence>>>;
type OperatorTrace = {
  pass: 'import' | 'reopen';
  exitCode?: number;
  lastRequest?: OperatorRequest;
  firstRejection?: OperatorRequest;
  lastStartedRecord?: { phase: string; recordKey: string };
};

async function runOperator(
  id: 'I01' | 'I02' | 'I03' | 'I04',
  persona: SeedEnv,
  reached: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const spec = operatorSpecs[id];
  const directory = resolve(evidenceRoot, id.toLowerCase());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = resolve(directory, 'state.sqlite');
  const argv = [
    '--progress',
    'jsonl',
    '--source',
    spec.source,
    '--dump',
    spec.stdin ? '-' : spec.dump!,
    '--state',
    state,
    '--api',
    persona.kernel,
    '--auth',
    persona.auth,
    '--account-key',
    persona.accountKeyPath,
    '--account',
    persona.account,
    '--client',
    persona.client,
  ];
  let trace: OperatorTrace;
  const observedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const requestId = randomUUID();
    const currentTrace = trace;
    const exchange: OperatorRequest = { method: request.method, path: new URL(request.url).pathname };
    currentTrace.lastRequest = exchange;
    appendFileSync(
      resolve(directory, 'requests.jsonl'),
      `${JSON.stringify({
        requestId,
        event: 'start',
        at: new Date().toISOString(),
        ...exchange,
      })}\n`,
      { mode: 0o600 },
    );
    const response = await fetch(request);
    const evidence = await operatorResponseEvidence(response);
    Object.assign(exchange, evidence, { problems: evidence.problems.slice(0, 1) });
    if (evidence.status >= 400 || evidence.problems.length) currentTrace.firstRejection ??= exchange;
    appendFileSync(
      resolve(directory, 'requests.jsonl'),
      `${JSON.stringify({
        requestId,
        event: 'response',
        at: new Date().toISOString(),
        ...exchange,
        problems: evidence.problems,
      })}\n`,
      { mode: 0o600 },
    );
    return response;
  }) as typeof fetch;
  const cliOptions: ImportCliOptions = {
    fetch: observedFetch,
    createImporter(options) {
      return createImporter({
        ...options,
        observer: {
          ...options.observer,
          onRecordActive(phase, recordKey, active) {
            options.observer?.onRecordActive?.(phase, recordKey, active);
            if (active) trace.lastStartedRecord = { phase, recordKey };
            appendFileSync(
              resolve(directory, 'records.jsonl'),
              `${JSON.stringify({
                at: new Date().toISOString(),
                phase,
                recordKey,
                active,
              })}\n`,
              { mode: 0o600 },
            );
          },
        },
      });
    },
    progressSink: {
      write(frame: string) {
        appendFileSync(resolve(directory, 'progress.jsonl'), frame, { mode: 0o600 });
      },
    },
    testOrigin: persona.kernel,
  };
  const runCli = async (pass: OperatorTrace['pass']) => {
    trace = { pass };
    reached.cli = trace;
    const result = await runImportCli(argv, { ...cliOptions, ...(spec.stdin ? { stdin: spec.stdin() } : {}) });
    trace.exitCode = result.code;
    return result;
  };
  const first = await runCli('import');
  await writeFile(resolve(directory, 'cli-result.json'), JSON.stringify(first), { mode: 0o600 });
  assert.equal(
    first.code,
    0,
    `${spec.source} CLI ${first.stderr || first.stdout}; safe requests: ${id.toLowerCase()}/requests.jsonl`,
  );
  const session = new ImportSession(state);
  const subjects = new Map<string, string>();
  try {
    for (const key of spec.keys) {
      const claim = session.bindings.claim({ source: spec.source, external_id: key });
      assert.equal(claim?.state, 'bound', `${spec.source} ${key} is not bound`);
      if (claim?.state === 'bound') subjects.set(key, claim.subject);
    }
  } finally {
    session.close();
  }
  const denials: { method: string; path: string; status: number }[] = [];
  const review = createImportTransport({
    origin: persona.kernel,
    tokenProvider: await createAccountTokenProvider({
      accountKeyPath: persona.accountKeyPath,
      account: persona.account,
      client: persona.client,
      authOrigin: persona.auth,
      issuerOrigin: persona.issuer,
      scopes: [...spec.scopes, 'context:accept', 'context:adopt'],
    }),
    onDeniedResponse: async ({ method, path, response }) => {
      denials.push({ method, path, status: response.status });
    },
  });
  const adopted: { key: string; id: string; type: string; candidate: string; statement: unknown }[] = [];
  for (const [key, id] of subjects) {
    const page = await retryWalkTransport(() =>
      review.reviewedCandidates(id, {
        property: spec.property,
        context: GLOBAL_CONTEXT,
        limit: 100,
      }),
    );
    const candidate = page.candidates.find(
      (row) =>
        'statement' in row &&
        row.retracted === null &&
        row.source &&
        'external_id' in row.source &&
        row.source.external_id === key,
    );
    assert.ok(candidate && 'statement' in candidate, `${spec.source} ${key} has no current ${spec.property} candidate`);
    await retryWalkTransport(() =>
      review.acceptReviewedCandidate(
        id,
        candidate.id,
        { context: GLOBAL_CONTEXT, expected_head: null },
        `${id}:${candidate.id}:accept`,
      ),
    );
    await retryWalkTransport(() =>
      review.adoptReviewedCandidates(
        id,
        {
          context: GLOBAL_CONTEXT,
          property: spec.property,
          mode: 'replace',
          selection: [{ candidate: candidate.id, rank: 'normal' }],
          expected_head: null,
        },
        `${id}:${spec.property}:adopt`,
      ),
    );
    const read = await currentSubject(persona.kernel, id);
    assert.equal(read.subject.id, id);
    assertCurrentOperatorFact(read, spec.property, candidate.statement);
    adopted.push({ key, id, type: read.subject.type, candidate: candidate.id, statement: candidate.statement });
  }
  const again = await runCli('reopen');
  assert.equal(again.code, 0, `${spec.source} reopen ${again.stderr || again.stdout}`);
  const reread = new ImportSession(state);
  try {
    for (const [key, id] of subjects) {
      const claim = reread.bindings.claim({ source: spec.source, external_id: key });
      assert.equal(claim?.state, 'bound');
      if (claim?.state === 'bound') assert.equal(claim.subject, id, `${spec.source} ${key} identity moved on reopen`);
      const current = await currentSubject(persona.kernel, id);
      assert.equal(current.subject.id, id);
      const expected = adopted.find((row) => row.key === key)!;
      assert.equal(current.subject.type, expected.type);
      assertCurrentOperatorFact(current, spec.property, expected.statement);
    }
  } finally {
    reread.close();
  }
  return {
    source: spec.source,
    first: first.stdout.trim(),
    reopen: again.stdout.trim(),
    adopted,
    ...(denials.length > 0 ? { denials } : {}),
  };
}

async function loadSeedReport(): Promise<{
  report: CrossMediaSeedReport;
  publication: ShowcasePublicationResult;
}> {
  const reportValue: unknown = JSON.parse(await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8'));
  if (!isRecord(reportValue) || !isRecord(reportValue.showcase) || !Array.isArray(reportValue.showcase.published))
    throw new TypeError('Cross-media seed result has no published showcase identities');
  const report = reportValue as unknown as CrossMediaSeedReport;
  return { report, publication: report.showcase as ShowcasePublicationResult };
}

export function assertCurrentOperatorFact(
  read: { subject: { statements: Record<string, unknown[]> } },
  property: string,
  expected: unknown,
): void {
  assert.ok(
    (read.subject.statements[property] ?? []).some((statement) => sameStatementProvenance(statement, expected)),
    `anonymous current ${property} differs from the independently accepted/adopted statement and provenance`,
  );
}

function assertCurrentPublishedProperty(
  read: { subject: { statements: Record<string, unknown[]> } },
  record: ShowcasePublicationResult['published'][number],
  property: string,
): void {
  const assertions = record.assertions.filter((assertion) => assertion.property === property);
  assert.ok(assertions.length, `${record.provider}:${record.sourceKey} has no published ${property} assertion`);
  for (const assertion of assertions) {
    assert.ok(assertion.citations?.length, `${record.provider}:${record.sourceKey} ${property} has no source citation`);
    assertCurrentOperatorFact(read, property, assertion.readback);
  }
}

function assertBookSeriesSlots(record: ShowcasePublicationResult['published'][number]): void {
  assert.ok(
    record.assertions.every(
      (assertion) => assertion.property !== 'schema:author' && assertion.property !== 'schema:illustrator',
    ),
    'BookSeries publication included an unadmitted author or illustrator slot',
  );
}

function assertNoBookVolumeCredits(record: ShowcasePublicationResult['published'][number]): void {
  assert.ok(
    record.assertions.every(
      (assertion) =>
        assertion.property !== 'schema:author' &&
        assertion.property !== 'schema:illustrator' &&
        assertion.property !== 'schema:publisher',
    ),
    'Book volume publication included a creator credit slot',
  );
}

function statementContents(read: { subject: { statements: Record<string, unknown[]> } }, property: string): unknown[] {
  return (read.subject.statements[property] ?? []).map((row) =>
    isRecord(row) && isRecord(row.value) ? row.value.content : undefined,
  );
}

function currentStringValues(read: { subject: { statements: Record<string, unknown[]> } }, property: string): string[] {
  return (read.subject.statements[property] ?? []).flatMap((row) => {
    if (!isRecord(row) || row.rank === 'deprecated' || !isRecord(row.value) || row.value.type !== 'value') return [];
    const content = row.value.content;
    if (typeof content === 'string') return [content];
    if (!isRecord(content)) return [];
    if (typeof content.text === 'string') return [content.text];
    return typeof content.amount === 'string' ? [content.amount] : [];
  });
}

function assertCurrentValues(label: string, expected: readonly string[], current: readonly string[]): void {
  for (const value of expected) assert.ok(current.includes(value), `${label} is missing current value ${value}`);
}

function samePublishedIdentities(publication: ShowcasePublicationResult): string[] {
  return publication.published
    .map((row) => `${row.provider}\0${row.sourceKey}\0${row.nativeType}\0${row.subjectId}`)
    .sort();
}

function assertUnchangedSeedReopen(first: ShowcasePublicationResult, reopened: ShowcasePublicationResult): void {
  assert.equal(reopened.status, 'published', 'unchanged seed reopen did not finish publication');
  assert.equal(reopened.manifest.digest, first.manifest.digest, 'unchanged seed reopen changed its manifest');
  const firstIdentities = samePublishedIdentities(first);
  const reopenedIdentities = samePublishedIdentities(reopened);
  if (first.status === 'published') assert.deepEqual(reopenedIdentities, firstIdentities);
  else {
    for (const identity of firstIdentities)
      assert.ok(
        reopenedIdentities.includes(identity),
        `seed continuation dropped prior published identity ${identity}`,
      );
  }
}

async function walkGameReleaseCounterpart(api: string, publication: ShowcasePublicationResult) {
  const published = publication.published;
  const game =
    published.find((row) => row.nativeType === 'schema:VideoGame') ??
    published.find((row) => row.provider === 'bangumi' && row.sourceKey === '3154');
  assert.ok(game, 'seed published no Game identity');
  const gameRead = await currentSubject(api, game.subjectId);
  assert.equal(gameRead.subject.id, game.subjectId);
  assert.ok(
    gameRead.subject.type === 'schema:VideoGame' || gameRead.subject.type === game.nativeType,
    `Game ${game.sourceKey} current type ${gameRead.subject.type}`,
  );
  const vn = selectPublished(published, 'vndb', 'v2002');
  const vnRead = await currentSubject(api, vn.subjectId);
  assert.equal(vnRead.subject.id, vn.subjectId);
  const release = published.find(
    (row) =>
      row.provider === 'vndb' &&
      (row.nativeType === 'schema:VideoGame' ||
        row.nativeType.includes('Release') ||
        row.sourceKey.startsWith('r') ||
        row.assertions.some((assertion) => assertion.property === 'schema:gamePlatform')),
  );
  const counterpart = published.find((row) =>
    row.assertions.some((assertion) => assertion.property === 'rezics:crossMediaCounterpart'),
  );
  assert.ok(counterpart, 'seed published no counterpart assertion');
  const links = await currentLinks(api, counterpart.subjectId, 'rezics:crossMediaCounterpart');
  assert.ok(links.length > 0, 'counterpart has no current inverse or forward links');
  return {
    game: { sourceKey: game.sourceKey, id: game.subjectId, type: gameRead.subject.type },
    vn: { sourceKey: vn.sourceKey, id: vn.subjectId, type: vnRead.subject.type },
    release: release ? { sourceKey: release.sourceKey, id: release.subjectId, type: release.nativeType } : null,
    counterpart: { sourceKey: counterpart.sourceKey, id: counterpart.subjectId, links: links.length },
  };
}

async function walkPersonCredits(api: string, report: CrossMediaSeedReport, publication: ShowcasePublicationResult) {
  const bangumi = selectPublished(publication.published, 'bangumi', 'person:1916');
  const vndb = selectPublished(publication.published, 'vndb', 's224');
  const left = await currentSubject(api, bangumi.subjectId);
  const right = await currentSubject(api, vndb.subjectId);
  assert.equal(left.subject.type, 'schema:Person');
  assert.equal(right.subject.type, 'schema:Person');
  const merge = report.personMerge;
  if (merge?.state !== 'published') throw new Error('reviewed Person pair is not one current canonical Person');
  const canonical = merge.survivor;
  assert.equal(left.subject.id, canonical, 'Bangumi original does not read as the canonical Person');
  assert.equal(right.subject.id, canonical, 'VNDB original does not read as the canonical Person');
  assert.equal(left.subject.id, right.subject.id);
  assert.ok(merge.operation, 'reviewed Person merge operation was not observed');
  assert.ok(
    Number.isSafeInteger(merge.revision) && merge.revision > 0,
    'reviewed Person operation has no completed revision',
  );
  for (const externalId of ['person:1916', 's224']) {
    const identity = report.personIdentities.find((entry) => entry.identity.externalId === externalId);
    assert.ok(identity, `seed omitted current identity ${externalId}`);
    assert.equal(identity.currentSubjectId, canonical, `${externalId} was not reread after merge`);
    assert.equal(identity.boundSubjectId, externalId === 'person:1916' ? bangumi.subjectId : vndb.subjectId);
  }
  const combined = report.combinedCredits;
  assert.ok(combined, 'seed omitted independently reread combined Person credits');
  assert.equal(combined.canonicalPersonId, canonical);
  const originalEndpoints = new Set([bangumi.subjectId, vndb.subjectId]);
  assert.ok(originalEndpoints.has(merge.redirected), 'completed Person merge did not redirect an original endpoint');
  const creditWorks = [
    { externalId: '1851', row: selectPublished(publication.published, 'bangumi', '1851') },
    { externalId: 'v4', row: selectPublished(publication.published, 'vndb', 'v4') },
  ];
  for (const work of creditWorks) {
    const currentCredits: NonNullable<CrossMediaSeedReport['combinedCredits']>['credits'] = combined.credits.filter(
      (credit) => credit.workExternalId === work.externalId,
    );
    assert.ok(currentCredits.length, `${work.externalId} has no independently reread Person credit`);
    const currentWork = await currentSubject(api, work.row.subjectId);
    assert.equal(currentWork.subject.id, work.row.subjectId);
    for (const credit of currentCredits) {
      assert.equal(credit.workSubjectId, work.row.subjectId);
      assert.ok(
        originalEndpoints.has(credit.boundPersonId),
        `${work.externalId} credit lost its original Person endpoint`,
      );
      assert.equal(credit.canonicalPersonId, canonical);
      assert.ok(
        statementContents(currentWork, credit.property).includes(credit.boundPersonId),
        `${work.externalId} current credit no longer names its original Person endpoint`,
      );
    }
  }
  const credits = publication.published.filter((row) =>
    row.assertions.some((assertion) =>
      ['schema:author', 'schema:contributor', 'wdt:P725', 'schema:creator'].includes(assertion.property),
    ),
  );
  return {
    bangumi: bangumi.subjectId,
    vndb: vndb.subjectId,
    canonical,
    operation: merge.operation,
    completedRevision: merge.revision,
    redirected: merge.redirected,
    rereadCredits: combined.credits.length,
    creditedWorks: credits.map((row) => ({ sourceKey: row.sourceKey, type: row.nativeType })),
  };
}

async function walkAdoptedCharacters(api: string, report: CrossMediaSeedReport) {
  const currents = report.characterCurrents ?? [];
  assert.ok(currents.length, 'seed omitted independent adopted Character reads');
  let rightsCreditedMedia = 0;
  for (const current of currents) {
    const read = await currentSubject(api, current.currentSubjectId);
    assert.equal(read.subject.type, 'wd:Q95074');
    assertCurrentValues(
      `${current.identity.externalId} identity`,
      [current.identity.value],
      currentStringValues(read, current.identity.property),
    );
    assertCurrentValues(`${current.identity.externalId} names`, current.names, [
      ...currentStringValues(read, 'schema:name'),
      ...currentStringValues(read, 'schema:alternateName'),
    ]);
    assertCurrentValues(`${current.identity.externalId} traits`, current.traits, [
      ...currentStringValues(read, 'schema:gender'),
      ...currentStringValues(read, 'schema:keywords'),
      ...currentStringValues(read, 'wdt:P1853'),
    ]);
    assertCurrentValues(`${current.identity.externalId} measurements`, current.measurements, [
      ...currentStringValues(read, 'schema:height'),
      ...currentStringValues(read, 'schema:weight'),
      ...currentStringValues(read, 'schema:birthDate'),
    ]);
    assertCurrentValues(`${current.identity.externalId} source links`, current.sourceLinks, [
      ...currentStringValues(read, 'schema:url'),
      ...currentStringValues(read, 'schema:sameAs'),
    ]);

    if (current.image.state !== 'served') continue;
    assert.ok(
      isRecord(read.summary) && isRecord(read.summary.cover),
      'Character current read omitted its cover summary',
    );
    const cover = read.summary.cover;
    assert.equal(cover.media, current.image.mediaId);
    assert.ok(isRecord(cover.credit), 'served Character image has no rights credit');
    assert.ok(typeof cover.credit.rightsHolder === 'string' && cover.credit.rightsHolder.trim());
    assert.ok(isRecord(cover.credit.via));
    assert.equal(cover.credit.via.name, 'Bangumi');
    assert.equal(cover.credit.via.url, bangumiRecordUrl(current.identity.externalId));
    assert.equal(cover.credit.license, 'LicenseRef-unknown');
    assert.ok(Array.isArray(cover.variants), 'served Character image has no current variants');
    for (const expected of current.image.variants)
      assert.ok(
        cover.variants.some(
          (variant) => isRecord(variant) && variant.format === expected.format && variant.width === expected.width,
        ),
        `${current.identity.externalId} current media omitted ${expected.format}-${expected.width}`,
      );
    rightsCreditedMedia += 1;
  }
  assert.ok(rightsCreditedMedia > 0, 'no adopted Character image is currently served with rights credit');
  return { characters: currents.length, rightsCreditedMedia };
}

async function walkFranchise(api: string, publication: ShowcasePublicationResult) {
  const steins = selectPublished(publication.published, 'bangumi', '10380');
  const clannad = selectPublished(publication.published, 'bangumi', '51');
  const vn = selectPublished(publication.published, 'vndb', 'v2002');
  await currentSubject(api, steins.subjectId);
  await currentSubject(api, clannad.subjectId);
  await currentSubject(api, vn.subjectId);
  const relations = publication.vndbWorkRelations ?? [];
  const relation = relations.find((entry) => entry.publication === 'published');
  assert.ok(relation, 'typed franchise relations have no current published edge');
  assert.ok(relation.holderSubjectId && relation.targetSubjectId);
  assert.ok(relation.citation && relation.fields.length, 'typed franchise relation has no exact source provenance');
  const links = await currentLinks(api, relation.holderSubjectId, relation.property);
  assert.ok(
    links.some((link) => link.summary.id === relation.targetSubjectId),
    'published typed franchise edge is missing from current links',
  );
  const holder = publication.published.find(
    (row) =>
      row.provider === 'vndb' && row.sourceKey === relation.holderKey && row.subjectId === relation.holderSubjectId,
  );
  assert.ok(holder, 'typed franchise holder is missing from the published seed');
  assert.ok(
    holder.assertions.some(
      (assertion) =>
        assertion.candidateId === relation.candidateId &&
        assertion.property === relation.property &&
        assertion.target?.subjectId === relation.targetSubjectId &&
        assertion.citations?.includes(relation.citation!),
    ),
    'published typed franchise edge lost its supported citation or endpoint',
  );
  return {
    steins: steins.subjectId,
    clannad: clannad.subjectId,
    vn: vn.subjectId,
    relationCount: relations.length,
    currentRelation: {
      property: relation.property,
      holder: relation.holderSubjectId,
      target: relation.targetSubjectId,
    },
  };
}

async function walkTags(api: string, publication: ShowcasePublicationResult) {
  const tagged = publication.published.find((row) =>
    row.assertions.some(
      (assertion) => assertion.property === 'schema:genre' || assertion.property === 'schema:keywords',
    ),
  );
  assert.ok(tagged, 'seed published no reviewed tag assertion');
  const first = await currentSubject(api, tagged.subjectId);
  const genres = statementContents(first, 'schema:genre');
  const keywords = statementContents(first, 'schema:keywords');
  assert.ok(genres.length + keywords.length > 0, `${tagged.sourceKey} has no current tag facts`);
  const again = await currentSubject(api, tagged.subjectId);
  assert.equal(again.subject.id, first.subject.id);
  assert.deepEqual(statementContents(again, 'schema:genre'), genres);
  assert.deepEqual(statementContents(again, 'schema:keywords'), keywords);
  return {
    sourceKey: tagged.sourceKey,
    id: tagged.subjectId,
    genres: genres.length,
    keywords: keywords.length,
  };
}

async function walkSelectedSynopsis(api: string, publication: ShowcasePublicationResult) {
  const withAbstract = publication.published.find((row) =>
    row.assertions.some((assertion) => assertion.property === 'schema:abstract'),
  );
  assert.ok(withAbstract, 'seed published no selected synopsis');
  const read = await currentSubject(api, withAbstract.subjectId);
  const abstracts = read.subject.statements['schema:abstract'] ?? [];
  const statement = abstracts.find((row) => isRecord(row) && typeof row.id === 'string');
  assert.ok(
    statement && isRecord(statement) && typeof statement.id === 'string',
    'selected synopsis has no current statement',
  );
  const query = selectedSynopsisQueryFromPublic(read as never, statement.id);
  assert.ok(query, 'selected synopsis query cannot be built from the current Global statement');
  const selected = await fetch(`${api}/v1/subjects/${withAbstract.subjectId}?${query.query}`);
  assert.equal(selected.status, 200);
  const body: unknown = await selected.json();
  assert.ok(isRecord(body) && isRecord(body.selectedSynopsis), 'selectedSynopsis is absent');
  assert.equal(body.selectedSynopsis.kind, 'matched');
  return {
    sourceKey: withAbstract.sourceKey,
    id: withAbstract.subjectId,
    statement: statement.id,
    kind: body.selectedSynopsis.kind,
  };
}

async function writeWalkRow(row: WalkRowResult) {
  const path = resolve(evidenceRoot, `${row.id.toLowerCase()}-row.json`);
  const pending = `${path}.pending`;
  await writeFile(pending, JSON.stringify(row), { mode: 0o600 });
  await rename(pending, path);
}

function markActiveWalkRow(id: FirstPublicImportRowId, started: number) {
  return writeFile(
    resolve(evidenceRoot, 'active-row.json'),
    JSON.stringify({ id, path: firstPublicRow(id).path, startedAt: new Date(started).toISOString() }),
    { mode: 0o600 },
  );
}

async function walkRow(
  id: FirstPublicImportRowId,
  run: (reached: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<WalkRowResult> {
  const meta = firstPublicRow(id);
  const started = Date.now();
  await markActiveWalkRow(id, started);
  let row: WalkRowResult;
  const reached: Record<string, unknown> = {};
  try {
    const evidence = await run(reached);
    row = { id, path: meta.path, result: 'passing', elapsedMs: Date.now() - started, cause: null, evidence };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const cause = walkFailureCause(error);
    console.error(`${id} failing; ${elapsedMs}ms; ${cause}`);
    row = {
      id,
      path: meta.path,
      result: 'failing',
      elapsedMs,
      cause,
      evidence: { ...reached, error: cause },
    };
  }
  await writeWalkRow(mountedWalkRow(row, []));
  return row;
}

export async function runImportsPublicJourney(): Promise<WalkInventory> {
  if (process.env.REZICS_WALK_IMPORT_CATALOGUE !== '1' || !walkStackAdmitted(process.env, root))
    throw new Error('Use the admitted dev-stack.ts walk --import-catalogue fixture');

  const startedAt = new Date().toISOString();
  const revision = (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim();
  await retireWalkJournals();
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const origins = stackOrigins();
  const rows: WalkRowResult[] = [];
  const recordStage = async (stage: 'setup' | 'operators' | 'seed' | 'seed-reopen' | 'catalogue-readback') => {
    const path = resolve(evidenceRoot, 'run.json');
    const pending = `${path}.pending`;
    await writeFile(
      pending,
      JSON.stringify({
        command: retainedCommand,
        revision,
        startedAt,
        stage,
        stageStartedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await rename(pending, path);
  };
  let persona: SeedEnv | undefined;
  let sharedStartup: string | null = null;
  let browserStageFailure: string | undefined;
  await recordStage('setup');
  try {
    // The admitted host provisions its persona before answering native readiness.
    persona = await readPersona();
    await grantOwner(persona);
  } catch (error) {
    sharedStartup = walkFailureCause(error);
  }

  const operator = persona;
  const recordOperator = async (id: keyof typeof operatorSpecs) => {
    const row: WalkRowResult =
      !operator || sharedStartup
        ? {
            id,
            path: firstPublicRow(id).path,
            result: 'failing',
            elapsedMs: 0,
            cause: sharedStartup ?? 'persona unavailable',
            evidence: { sharedStartup: true },
          }
        : await walkRow(id, (reached) => runOperator(id, operator, reached));
    rows.push(row);
    await writeWalkRow(row);
  };

  // Finish independent operator evidence before the shared catalogue seed.
  // Bangumi precedes the bulk upload quota, and Open Library is the last operator.
  await recordStage('operators');
  for (const id of ['I01', 'I02', 'I04', 'I03'] as const) await recordOperator(id);

  const seedStarted = Date.now();
  let seedElapsedMs = 0;
  let seedCause: string | null = sharedStartup;
  let publication: ShowcasePublicationResult | undefined;
  let report: CrossMediaSeedReport | undefined;
  let seedReopenEvidence: Record<string, unknown> | undefined;
  if (!seedCause) {
    try {
      const seedArgs = ['bun', 'scripts/datasets/cross-media-seed.ts', '--dev-catalogue'];
      const seedEnv = walkSeedChildEnv(origins, persona?.file ?? {});
      await recordStage('seed');
      await command('seed', seedArgs, seedEnv);
      const first = await loadSeedReport();
      await recordStage('seed-reopen');
      await command('seed-reopen', seedArgs, seedEnv);
      const reopened = await loadSeedReport();
      assertUnchangedSeedReopen(first.publication, reopened.publication);
      seedReopenEvidence = {
        identityStable: true,
        priorComplete: first.publication.status === 'published',
        manifest: reopened.publication.manifest.digest,
        publishedIdentities: reopened.publication.published.length,
      };
      report = reopened.report;
      publication = reopened.publication;
      selectJourneyWorks(publication.published);
    } catch (error) {
      const directory = resolve(root, '.temp/cross-media-seed');
      const written = await readSeedRemainingRequest(directory);
      const journal = remainingRequestFromPreparedJournal(resolve(directory, 'showcase.sqlite'));
      const remaining = written ?? (journal ? mergeRemainingRequest(journal) : undefined);
      seedCause = remaining ? formatSeedFailure(error, remaining) : walkFailureCause(error);
    }
  }

  seedElapsedMs = Date.now() - seedStarted;
  if (seedCause) console.error(`shared seed failing; ${seedElapsedMs}ms; ${seedCause}`);
  const catalogueFromSeed = ['I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12'] as const;
  if (seedCause || !publication || !report) {
    for (const id of catalogueFromSeed)
      rows.push({
        id,
        path: firstPublicRow(id).path,
        result: 'failing',
        elapsedMs: seedElapsedMs,
        cause: seedCause ?? 'seed report unavailable',
        evidence: { sharedStartup: Boolean(sharedStartup), seed: true },
      });
  } else {
    await recordStage('catalogue-readback');
    const api = stackOrigins().kernel;
    const published = publication;
    const seeded = report;
    rows.push(
      await walkRow('I05', async () => {
        const works = selectJourneyWorks(published.published);
        const anime = works.find((work) => work.sourceKey === '233')!;
        const read = await currentSubject(api, anime.row.subjectId);
        assert.equal(read.subject.type, anime.row.nativeType);
        const episodes = await currentLinks(api, anime.row.subjectId, 'schema:isPartOf');
        assert.ok(episodes.length, 'anime 233 has no current episodes');
        const cited = read as Parameters<typeof citedAnimeCreditTargets>[0];
        const cast = citedAnimeCreditTargets(cited, '233', 'cast');
        const staff = citedAnimeCreditTargets(cited, '233', 'staff');
        assert.ok(cast.length, 'anime 233 has no current cited cast');
        assert.ok(staff.length, 'anime 233 has no current cited staff');
        const characterLinks = await currentLinks(api, anime.row.subjectId, 'schema:character');
        const characters = currentAnimeCharacterIds(characterLinks);
        for (const id of characters) {
          const character = await currentSubject(api, id);
          assert.equal(character.subject.type, 'wd:Q95074', `Character ${id} current type`);
        }
        const characterCurrent = await walkAdoptedCharacters(api, seeded);
        return {
          id: anime.row.subjectId,
          episodes: episodes.length,
          cast: cast.length,
          staff: staff.length,
          characters: characters.length,
          characterCurrent,
          citation: bangumiRecordUrl('233'),
        };
      }),
    );
    rows.push(await walkRow('I06', () => walkGameReleaseCounterpart(api, published)));
    rows.push(await walkRow('I07', () => walkPersonCredits(api, seeded, published)));
    rows.push(await walkRow('I08', () => walkFranchise(api, published)));
    rows.push(
      await walkRow('I09', async () => ({
        ...(await walkTags(api, published)),
        seedReopen: seedReopenEvidence,
      })),
    );
    rows.push(await walkRow('I10', () => walkSelectedSynopsis(api, published)));
    rows.push(
      await walkRow('I11', async () => {
        const series = selectPublished(published.published, 'bangumi', '499');
        const volume = selectPublished(published.published, 'bangumi', '26');
        const seriesRead = await currentSubject(api, series.subjectId);
        const volumeRead = await currentSubject(api, volume.subjectId);
        assert.equal(seriesRead.subject.type, 'schema:BookSeries');
        assert.equal(volumeRead.subject.type, 'schema:Book');
        assertCurrentPublishedProperty(seriesRead, series, 'schema:publisher');
        assertCurrentPublishedProperty(volumeRead, volume, 'wdt:P179');
        assertBookSeriesSlots(series);
        assertNoBookVolumeCredits(volume);
        return { series: series.subjectId, volume: volume.subjectId, type: seriesRead.subject.type };
      }),
    );
    rows.push(
      await walkRow('I12', async () => {
        const series = selectPublished(published.published, 'bangumi', '2815');
        const first = selectPublished(published.published, 'bangumi', '5329');
        const second = selectPublished(published.published, 'bangumi', '10862');
        const seriesRead = await currentSubject(api, series.subjectId);
        assert.equal(seriesRead.subject.type, 'schema:BookSeries');
        assertCurrentPublishedProperty(seriesRead, series, 'schema:publisher');
        assertBookSeriesSlots(series);
        for (const volume of [first, second]) {
          const read = await currentSubject(api, volume.subjectId);
          assert.equal(read.subject.type, 'schema:Book');
          assertCurrentPublishedProperty(read, volume, 'wdt:P179');
          assertNoBookVolumeCredits(volume);
        }
        const counterpart = await currentLinks(api, series.subjectId, 'rezics:crossMediaCounterpart');
        assert.ok(counterpart.length > 0, '2815 has no current anime counterpart');
        return {
          series: series.subjectId,
          volumes: [first.subjectId, second.subjectId],
          counterpart: counterpart.map((link) => link.summary.id),
        };
      }),
    );

    const browserVisits: JourneyMountedVisit[] = [];
    const nativeRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => isMountedRow(row.id));
    const browserStarted = Date.now();
    const recordMountedRows = async (cause?: string) => {
      for (const { row, index } of nativeRows) {
        if (rows[index]!.evidence.browser === 'passing') continue;
        const updated = mountedWalkRow(row, browserVisits, Date.now() - browserStarted, cause);
        await writeWalkRow(updated);
        rows[index] = updated;
      }
    };
    await markActiveWalkRow('I05', browserStarted);
    try {
      const frontends = await startWalkStackActions(
        ['pages', 'web'],
        [`${origins.issuer}/.well-known/openid-configuration`, origins.web],
      );
      try {
        await runBangumiJourney({
          skipPersona: true,
          skipSeed: true,
          startFrontends: false,
          async onMountedVisit(visit) {
            browserVisits.push(visit);
            await recordMountedRows();
          },
        });
      } catch (error) {
        browserStageFailure = walkFailureCause(error);
      } finally {
        await frontends.stop();
      }
    } catch (error) {
      const cause = walkFailureCause(error);
      if (browserStageFailure) console.error(`mounted stage cleanup failed; ${cause}`);
      browserStageFailure ??= cause;
    }
    if (browserStageFailure) console.error(`mounted stage failed; ${browserStageFailure}`);
    await recordMountedRows(browserStageFailure);
  }

  for (const row of rows) await writeWalkRow(row);

  rows.sort((left, right) => left.id.localeCompare(right.id));

  const endedAt = new Date().toISOString();
  const inventory: WalkInventory = {
    command: retainedCommand,
    revision,
    startedAt,
    endedAt,
    passing: rows.filter((row) => row.result === 'passing').length,
    total: FIRST_PUBLIC_IMPORT_ROWS.length,
    ...(browserStageFailure ? { browserStageFailure } : {}),
    slowestFailing: slowestReachedFailure(rows),
    rows,
  };
  await writeFile(resolve(evidenceRoot, 'inventory.json'), JSON.stringify(inventory, null, 2), { mode: 0o600 });
  await writeWalkInventoryArtifacts(inventory);
  console.log(walkInventorySummary(inventory));
  return inventory;
}

if (import.meta.main) {
  const inventory = await runImportsPublicJourney();
  if (inventory.passing < inventory.total || inventory.browserStageFailure) process.exitCode = 1;
}
