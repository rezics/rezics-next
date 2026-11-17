/** Walk selected first-public Imports paths on one admitted dev-stack session.
 *
 *   bun services/auth/scripts/dev-stack.ts walk --import-catalogue -- bun services/importer/src/imports-public-journey.ts [--scope operators|catalogue|all] [--reopen-seed]
 *
 * Operators import licensed fixtures through the ordinary CLI, then separately accept/adopt and independently
 * read. Catalogue rows share one fresh seed. A row failure is recorded; independent rows continue.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import { walkStackAdmitted } from '../../../scripts/stack-run.ts';
import { createAccountTokenProvider, IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { runImportCli, type ImportCliOptions } from './cli.ts';
import { createImporter } from './importer.ts';
import { reviewedCatalogueProblem } from './http.ts';
import { createImportTransport, importTransportCause, ImportTransportError } from './import-client.ts';
import {
  readSeedRemainingRequest,
  remainingRequestFromPreparedJournal,
  type SeedRemainingRequest,
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

export type WalkSelection = { scope: 'operators' | 'catalogue' | 'all'; reopenSeed: boolean };

const operatorRows = ['I01', 'I02', 'I04', 'I03'] as const;

export function parseWalkSelection(args: readonly string[]): WalkSelection {
  const [flag, scope, ...rest] = args;
  const selectedScope =
    flag === '--scope' && (scope === 'operators' || scope === 'catalogue' || scope === 'all') ? scope : undefined;
  const flags = selectedScope ? rest : args;
  const reopenSeed = flags.length === 1 && flags[0] === '--reopen-seed';
  if ((flags.length > 0 && !reopenSeed) || (selectedScope === 'operators' && reopenSeed))
    throw new Error(
      'Usage: imports-public-journey.ts [--scope operators|catalogue|all] [--reopen-seed (catalogue or all)]',
    );
  return { scope: selectedScope ?? 'all', reopenSeed };
}

function isOperatorRow(id: FirstPublicImportRowId): id is (typeof operatorRows)[number] {
  return operatorRows.some((row) => row === id);
}

function selectedRow(selection: WalkSelection, id: FirstPublicImportRowId): boolean {
  return selection.scope === 'all' || isOperatorRow(id) === (selection.scope === 'operators');
}

export async function runWalkSelection<Seed>(
  selection: WalkSelection,
  actions: {
    operators(): Promise<void>;
    seed(): Promise<Seed | null>;
    catalogue(seed: Seed): Promise<void>;
    reopenSeed(seed: Seed): Promise<void>;
  },
): Promise<void> {
  if (selection.scope !== 'catalogue') await actions.operators();
  if (selection.scope === 'operators') return;
  const fresh = await actions.seed();
  if (fresh === null) return;
  await actions.catalogue(fresh);
  if (selection.reopenSeed) await actions.reopenSeed(fresh);
}

export type WalkRowResult = {
  id: FirstPublicImportRowId;
  path: string;
  result: 'passing' | 'failing' | 'unreached' | 'unselected';
  elapsedMs: number | null;
  cause: string | null;
  evidence: Record<string, unknown>;
};

type WalkPrerequisite = {
  stage: 'setup' | 'seed' | 'seed-reopen';
  elapsedMs: number;
  cause: string | null;
  manifest?: string;
  report?: string;
  remainingRequest?: SeedRemainingRequest;
};

type WalkRun = {
  command: string;
  revision: string;
  startedAt: string;
  selection: WalkSelection;
  prerequisites: WalkPrerequisite[];
  browserStageFailure?: string;
};

export type WalkInventory = WalkRun & {
  endedAt: string;
  passing: number;
  total: number;
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
    elapsedMs:
      row.result === 'failing' ? row.elapsedMs : complete && row.elapsedMs !== null ? row.elapsedMs + elapsedMs : null,
    result: row.result === 'passing' && !complete ? 'unreached' : row.result,
    cause:
      row.cause ??
      (complete ? null : browserFailure ? 'shared mounted stage failed' : 'Required mounted visits are incomplete'),
    evidence: {
      ...row.evidence,
      native: row.result,
      browser: complete ? 'passing' : browserFailure ? 'failing' : 'pending',
      browserVisits,
    },
  };
}

function inactiveWalkRow(
  id: FirstPublicImportRowId,
  result: 'unselected' | 'unreached',
  prerequisite?: WalkPrerequisite['stage'],
): WalkRowResult {
  return {
    id,
    path: firstPublicRow(id).path,
    result,
    elapsedMs: null,
    cause: prerequisite ? `shared ${prerequisite} failed` : null,
    evidence: prerequisite ? { prerequisite, fixture: rowFixture(id) } : {},
  };
}

function orderedWalkRows(selection: WalkSelection, rows: readonly WalkRowResult[]): WalkRowResult[] {
  const observed = new Map<FirstPublicImportRowId, WalkRowResult>();
  for (const row of rows) {
    if (!FIRST_PUBLIC_IMPORT_ROWS.some(({ id }) => id === row.id) || observed.has(row.id))
      throw new Error(`Invalid or duplicate walk observation for ${row.id}`);
    if (!['passing', 'failing', 'unreached', 'unselected'].includes(row.result))
      throw new Error(`Invalid walk result for ${row.id}`);
    if (selectedRow(selection, row.id) === (row.result === 'unselected'))
      throw new Error(`Walk observation for ${row.id} disagrees with selection ${selection.scope}`);
    if ((row.result === 'unselected' || row.result === 'unreached') && row.elapsedMs !== null)
      throw new Error(`Inactive walk row ${row.id} has an elapsed time`);
    observed.set(row.id, row);
  }
  return FIRST_PUBLIC_IMPORT_ROWS.map(({ id }) => {
    const row = observed.get(id);
    if (row) return row;
    if (!selectedRow(selection, id)) return inactiveWalkRow(id, 'unselected');
    throw new Error(`No returned walk observation for ${id}`);
  });
}

function slowestReachedFailure(rows: readonly WalkRowResult[]): WalkInventory['slowestFailing'] {
  const slowest = rows
    .filter((row) => row.result === 'failing' && row.elapsedMs !== null)
    .sort((left, right) => right.elapsedMs! - left.elapsedMs!)[0];
  return slowest && slowest.elapsedMs !== null
    ? { id: slowest.id, path: slowest.path, elapsedMs: slowest.elapsedMs, cause: slowest.cause ?? 'failed' }
    : null;
}

export function walkInventorySummary(inventory: WalkInventory): string {
  const unreached = inventory.rows.filter((row) => row.result === 'unreached').length;
  const unselected = inventory.rows.filter((row) => row.result === 'unselected').length;
  const failing = inventory.rows.filter((row) => row.result === 'failing').length;
  const slowest = slowestReachedFailure(inventory.rows);
  const failedPrerequisites = inventory.prerequisites
    .filter(({ cause }) => cause !== null)
    .map(({ stage, elapsedMs, cause }) => `; shared ${stage} failed after ${elapsedMs}ms: ${cause}`)
    .join('');
  return `${inventory.passing}/${inventory.total} passing; slowest failing ${
    slowest ? `${slowest.id} ${slowest.elapsedMs}ms ${slowest.cause}` : 'none'
  }; ${failing} failing${unreached ? `; ${unreached} unreached` : ''}${unselected ? `; ${unselected} unselected` : ''}${failedPrerequisites}`;
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
  if (row.result === 'unselected') return 'unselected';
  if (row.result === 'unreached') return markdownTableCell(`unreached; ${row.cause ?? 'prerequisite failed'}`);
  const detail = row.result === 'passing' ? currentReadEvidence(row.evidence) : (row.cause ?? 'failed');
  return markdownTableCell(
    `${row.result}; ${row.elapsedMs === null ? 'duration unknown' : `${row.elapsedMs}ms`}; ${detail}`,
  );
}

export function applyWalkInventoryToCapabilities(markdown: string, inventory: WalkInventory): string {
  let text = markdown;
  for (const row of inventory.rows) {
    if (row.result === 'unselected') continue;
    const pattern = new RegExp(`(\\| ${row.id}\\s+\\| [^|\\n]+\\| )[^|\\n]+`);
    if (!pattern.test(text)) throw new Error(`capabilities table is missing ${row.id}`);
    text = text.replace(pattern, (_match, prefix: string) => `${prefix}${capabilitiesResultCell(row)} `);
  }
  const slowest = slowestReachedFailure(inventory.rows);
  const heading =
    inventory.selection.scope === 'all'
      ? OBSERVED_WALK_HEADING
      : `${OBSERVED_WALK_HEADING} (${inventory.selection.scope})`;
  const record = [
    heading,
    '',
    `Command: \`${inventory.command}\`. Revision \`${inventory.revision}\`. Started ${inventory.startedAt}; ended ${inventory.endedAt}. ${inventory.passing}/${inventory.total} passing.`,
    slowest ? `Slowest failing: ${slowest.id} ${slowest.elapsedMs}ms ${slowest.cause}.` : 'No measured row failure.',
    ...inventory.prerequisites.map(
      ({ stage, elapsedMs, cause, manifest }) =>
        `Shared ${stage}: ${elapsedMs}ms. ${cause ?? (manifest ? `Published manifest \`${manifest}\`.` : 'Complete.')}`,
    ),
    ...(['unreached', 'unselected'] as const).flatMap((result) => {
      const ids = inventory.rows.filter((row) => row.result === result).map((row) => row.id);
      return ids.length ? [`${result === 'unreached' ? 'Unreached' : 'Unselected'}: ${ids.join(', ')}.`] : [];
    }),
    ...(inventory.browserStageFailure ? [`Mounted stage failure: ${inventory.browserStageFailure}.`] : []),
    '\n',
  ].join('\n');
  const start = text.indexOf(`${heading}\n`);
  if (start >= 0) {
    const body = start + heading.length + 1;
    const next = text.slice(body).search(/^(?:### |Books owner-grant)/m);
    text = text.slice(0, start) + record + (next < 0 ? '' : text.slice(body + next));
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
Elapsed: ${row.elapsedMs === null ? 'unknown' : `${row.elapsedMs}ms`}
Cause: ${row.cause}

Current public reads, rights and exact provenance decide success. Do not weaken the walk assertions or add a parallel driver.

## Required repair

Reproduce with the retained walk command on one admitted stack. Fix the owning module so this row's current-read evidence passes, then rerun the same driver.
`;
}

/** Remote returns are outputs: never declare the owner document or shared continuation directory. */
export async function writeWalkInventoryArtifacts(inventory: WalkInventory, repository = root): Promise<void> {
  const ordered = orderedWalkRows(inventory.selection, inventory.rows);
  if (
    inventory.total !== ordered.length ||
    inventory.rows.length !== ordered.length ||
    inventory.passing !== ordered.filter((row) => row.result === 'passing').length
  )
    throw new Error('Walk inventory counts do not match its observations');
  for (const row of ordered) {
    if (row.result !== 'unreached') continue;
    const blocked = inventory.prerequisites.some(
      (step) => step.cause !== null && step.stage === row.evidence.prerequisite,
    );
    const mounted = isMountedRow(row.id) && (row.evidence.browser === 'pending' || row.evidence.browser === 'failing');
    if (!blocked && !mounted) throw new Error(`No blocking prerequisite or incomplete visit for ${row.id}`);
  }
  const output = resolve(repository, '.temp/imports-walk');
  const capabilitiesPath = resolve(repository, 'docs/goals/imports.capabilities.md');
  const markdown = applyWalkInventoryToCapabilities(await readFile(capabilitiesPath, 'utf8'), inventory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(resolve(output, 'imports.capabilities.md'), markdown);
  const drafts = resolve(output, 'continuation');
  await mkdir(drafts, { recursive: true, mode: 0o700 });
  const startup = inventory.prerequisites.find(({ stage }) => stage === 'setup');
  if (startup?.cause) {
    await writeFile(
      resolve(drafts, 'imports-walk-shared-startup.md'),
      `# Shared walk startup

Goal: imports
Manager: semantic

Command: ${inventory.command}
Revision: ${inventory.revision}
Started: ${inventory.startedAt}; ended: ${inventory.endedAt}
Elapsed: ${startup.elapsedMs}ms
Affected rows: ${inventory.rows
        .filter((row) => row.evidence.prerequisite === 'setup')
        .map((row) => row.id)
        .join(', ')}
Cause: ${startup.cause}

Reproduce with the retained walk command on one admitted stack. Restore ordinary Auth persona setup before claiming any path passed. Preserve the existing assertions and independently read the current facts.
`,
    );
  }
  for (const { stage, cause, elapsedMs, remainingRequest } of inventory.prerequisites) {
    if (stage === 'setup' || cause === null) continue;
    const owner = /sourceFences/.test(remainingRequest?.path ?? cause) ? 'Content d66' : 'Semantic cf23';
    const first = stage === 'seed';
    await writeFile(
      resolve(drafts, `imports-walk-${stage}.md`),
      `# ${first ? 'Resume catalogue paths after shared seed failure' : 'Repair whole-seed reopen'}

Goal: imports
Manager: semantic

Command: ${inventory.command}
Revision: ${inventory.revision}
Started: ${inventory.startedAt}; ended: ${inventory.endedAt}
Elapsed seed work: ${elapsedMs}ms
${
  first
    ? `Affected rows: ${inventory.rows
        .filter((row) => row.evidence.prerequisite === 'seed')
        .map((row) => row.id)
        .join(', ')}`
    : 'Catalogue observations used the first published result.'
}
Cause: ${cause}

Existing owner: ${owner}. Proposal contention and sourceFences remain separate incidents. Operation/partition/server phase are available when present in the safe request evidence.${first ? ' No catalogue current read or browser path was exercised after the failed seed.' : ''}

Use the returned ${stage}.log and ${first ? 'remaining-request.json' : 'seed-reopen-remaining-request.json'} when present. Retain the exact prepared source tuple, native type, converter, method/path/status and any safe problem/correlation. Resume through ordinary APIs and the original sealed body/key. Rerun the recorded command with its original selection. Preserve exact id/type, public facts, provenance, separate acceptance/adoption and phone/desktop assertions.
`,
    );
  }
  for (const row of inventory.rows) {
    if (row.result !== 'failing') continue;
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
  run: WalkRun,
  rows: readonly WalkRowResult[],
  active: { id: FirstPublicImportRowId; startedAt: string },
  terminal: { finishedAt: string; cause: string; checkId: string; runElapsedMs: number },
): WalkInventory {
  if (!selectedRow(run.selection, active.id)) throw new Error(`Active walk row ${active.id} was unselected`);
  const observed = [...rows];
  const activeIndex = rows.findIndex(({ id }) => id === active.id);
  const activeRow = observed[activeIndex];
  if (!activeRow || (activeRow.evidence.native === 'passing' && activeRow.evidence.browser === 'pending')) {
    const interrupted: WalkRowResult = {
      id: active.id,
      path: firstPublicRow(active.id).path,
      result: 'failing',
      elapsedMs: null,
      cause: terminal.cause,
      evidence: {
        fixture: rowFixture(active.id),
        ...activeRow?.evidence,
        interrupted: true,
        activeStartedAt: active.startedAt,
        controllerFinishedAt: terminal.finishedAt,
        checkId: terminal.checkId,
        runElapsedMs: terminal.runElapsedMs,
        ...(activeRow ? {} : { currentRead: 'not reached' }),
      },
    };
    if (activeIndex < 0) observed.push(interrupted);
    else observed[activeIndex] = interrupted;
  }
  // The original selection accounts for unselected rows. Selected rows require returned observations.
  const ordered = orderedWalkRows(run.selection, observed);
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
const SEED_FAILURE_LINE =
  /^(?:Cross-media seed (?:import failed|publication incomplete|readiness failed|source failure|failed)|Import transport failed status=|Credential request failed )/;
const RESERVED_COVER_CONTINUATION =
  /^Cross-media seed import failed provider=bangumi kind=bulk-failed generation=([1-9][0-9]{0,19}) run\{phase=media reason=cover-pending keyDigest=([a-f0-9]{64}) mediaState=reserved\}[^\n]* finalization\{scope=record-import phase=bangumi-cover-continuation /m;

export function walkChildFailure(name: string, code: number, stderr: string): Error {
  const firstFailure = stderr.split('\n').find((line) => SEED_FAILURE_LINE.test(line));
  return new Error(`${name} exited ${code}${firstFailure ? `: ${firstFailure}` : ''}`);
}

export async function captureSeedStderr(
  stream: ReadableStream<Uint8Array>,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<string> {
  let stderr = '';
  let pending = '';
  const decoder = new TextDecoder();
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    stderr += chunk;
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (SEED_PHASE_LINE.test(line)) write(line);
    }
  }
  const final = decoder.decode();
  stderr += final;
  pending += final;
  if (SEED_PHASE_LINE.test(pending)) write(pending);
  return stderr;
}

async function command(name: 'seed' | 'seed-reopen', args: string[], env: NodeJS.ProcessEnv) {
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
      const input = {
        journal: resolve(root, '.temp/cross-media-seed/state.sqlite'),
        generation: reserved[1]!,
        keyDigest: reserved[2]!,
        account: env.REZICS_DEV_PERSONA_ACCOUNT!,
        databasePort: process.env.KERNEL_DATABASE_PORT!,
        kernelEnvironment: await parseEnv(resolve(root, 'services/kernel/.env')),
      };
      const reader = Bun.spawn([process.execPath, 'services/kernel/scripts/read-cover-continuation.ts'], {
        cwd: root,
        stdin: new Blob([JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 8_000,
      });
      const [value, status] = await Promise.all([new Response(reader.stdout).json(), reader.exited]);
      if (status !== 0 || value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Native cover status observation unavailable');
      evidence = value;
    } catch {
      evidence = { state: 'unavailable' };
    }
    const line = `Cover continuation diagnostic ${JSON.stringify(evidence)}`;
    console.error(line);
    diagnostic = `\n${line}\n`;
  }
  await writeFile(resolve(evidenceRoot, `${name}.log`), `${stdout}${stderr}${diagnostic}`, { mode: 0o600 });
  if (code !== 0) throw walkChildFailure(name, code, stderr);
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
      const problem = reviewedCatalogueProblem(await response.json().catch(() => undefined));
      return { status: response.status, text: problem.code ?? '' };
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

function rowFixture(id: FirstPublicImportRowId): string {
  if (!isOperatorRow(id)) return 'seed-result.json';
  const dump = operatorSpecs[id].dump;
  return dump ? relative(root, dump) : 'specs/fixtures/imports/vndb-tables/db (licensedVndbArchive)';
}

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

export function publishedWalkSeed(reportValue: unknown) {
  if (!isRecord(reportValue) || !isRecord(reportValue.showcase) || !Array.isArray(reportValue.showcase.published))
    throw new TypeError('Cross-media seed result has no published showcase identities');
  if (reportValue.showcase.status !== 'published')
    throw new TypeError('Cross-media seed did not publish the selected catalogue');
  if (
    !isRecord(reportValue.showcase.manifest) ||
    typeof reportValue.showcase.manifest.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reportValue.showcase.manifest.digest)
  )
    throw new TypeError('Cross-media seed result has no published manifest digest');
  const sourceDigests = reportValue.sourceDigests;
  if (
    !isRecord(sourceDigests) ||
    Object.keys(sourceDigests).length === 0 ||
    Object.values(sourceDigests).some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
  )
    throw new TypeError('Cross-media seed result has no exact source digests');
  const report = reportValue as unknown as CrossMediaSeedReport;
  const publication = report.showcase!;
  selectJourneyWorks(publication.published);
  return { report, publication };
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

type PublishedWalkSeed = ReturnType<typeof publishedWalkSeed>;

export function assertUnchangedSeedReopen(first: PublishedWalkSeed, reopened: PublishedWalkSeed): void {
  assert.equal(
    reopened.publication.manifest.digest,
    first.publication.manifest.digest,
    'unchanged seed reopen changed its manifest',
  );
  assert.deepEqual(
    samePublishedIdentities(reopened.publication),
    samePublishedIdentities(first.publication),
    'unchanged seed reopen changed its published Subject IDs or their provenance',
  );
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
  const fixture = rowFixture(id);
  const reached: Record<string, unknown> = { fixture };
  try {
    const evidence = await run(reached);
    row = {
      id,
      path: meta.path,
      result: 'passing',
      elapsedMs: Date.now() - started,
      cause: null,
      evidence: { ...evidence, fixture },
    };
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
  await rm(resolve(evidenceRoot, 'active-row.json'), { force: true });
  return row;
}

export async function runImportsPublicJourney(args: readonly string[] = []): Promise<WalkInventory> {
  const selection = parseWalkSelection(args);
  const commandLine = [retainedCommand, ...args].join(' ');
  if (process.env.REZICS_WALK_IMPORT_CATALOGUE !== '1' || !walkStackAdmitted(process.env, root))
    throw new Error('Use the admitted dev-stack.ts walk --import-catalogue fixture');

  const startedAt = new Date().toISOString();
  const revision = (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim();
  await retireWalkJournals();
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const rows: WalkRowResult[] = [];
  const prerequisites: WalkPrerequisite[] = [];
  const run: WalkRun = { command: commandLine, revision, startedAt, selection, prerequisites };
  const recordStage = async (
    stage: WalkPrerequisite['stage'] | 'operators' | 'catalogue-readback' | 'mounted' | 'complete',
  ) => {
    const path = resolve(evidenceRoot, 'run.json');
    const pending = `${path}.pending`;
    await writeFile(
      pending,
      JSON.stringify({
        ...run,
        stage,
        stageStartedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await rename(pending, path);
  };
  const recordInactive = async (row: WalkRowResult) => {
    await writeWalkRow(row);
    rows.push(row);
  };
  await recordStage('setup');
  const selected = FIRST_PUBLIC_IMPORT_ROWS.filter(({ id }) => selectedRow(selection, id));
  for (const { id } of FIRST_PUBLIC_IMPORT_ROWS)
    if (!selectedRow(selection, id)) await recordInactive(inactiveWalkRow(id, 'unselected'));

  const setupStarted = Date.now();
  let persona: SeedEnv;
  const runSeed = async (stage: 'seed' | 'seed-reopen', first?: PublishedWalkSeed) => {
    await recordStage(stage);
    const started = Date.now();
    const directory = resolve(root, '.temp/cross-media-seed');
    const result = resolve(directory, 'result.json');
    const reportName = `${stage}-result.json`;
    const artifact = resolve(evidenceRoot, reportName);
    let report: string | undefined;
    let remainingRequest: SeedRemainingRequest | undefined;
    try {
      const seedArgs = ['bun', 'scripts/datasets/cross-media-seed.ts', '--dev-catalogue'];
      try {
        await command(stage, seedArgs, walkSeedChildEnv(stackOrigins(), persona.file));
      } catch (error) {
        remainingRequest =
          (await readSeedRemainingRequest(directory)) ??
          remainingRequestFromPreparedJournal(resolve(directory, 'showcase.sqlite'));
        if (stage === 'seed') {
          // A publication refusal can still produce a report. The fresh journal has no stale result.
          report = await copyFile(result, artifact).then(
            () => reportName,
            () => undefined,
          );
        }
        throw error;
      }
      await copyFile(result, artifact);
      report = reportName;
      const seeded = publishedWalkSeed(JSON.parse(await readFile(artifact, 'utf8')));
      if (first) assertUnchangedSeedReopen(first, seeded);
      prerequisites.push({
        stage,
        elapsedMs: Date.now() - started,
        cause: null,
        report,
        manifest: seeded.publication.manifest.digest,
      });
      return seeded;
    } catch (error) {
      prerequisites.push({
        stage,
        elapsedMs: Date.now() - started,
        cause: walkFailureCause(error),
        ...(report ? { report } : {}),
        ...(remainingRequest ? { remainingRequest } : {}),
      });
      if (remainingRequest) {
        const name = stage === 'seed' ? 'remaining-request.json' : 'seed-reopen-remaining-request.json';
        await writeFile(resolve(evidenceRoot, name), JSON.stringify(remainingRequest), { mode: 0o600 });
      }
      return null;
    }
  };

  const catalogue = async ({ report: seeded, publication: published }: PublishedWalkSeed) => {
    await recordStage('catalogue-readback');
    const origins = stackOrigins();
    const api = origins.kernel;

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
    rows.push(await walkRow('I09', () => walkTags(api, published)));
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
    const nativeRows = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.result !== 'unselected' && isMountedRow(row.id));
    const browserStarted = Date.now();
    const recordMountedRows = async (cause?: string) => {
      for (const { row, index } of nativeRows) {
        if (rows[index]!.evidence.browser === 'passing') continue;
        const updated = mountedWalkRow(row, browserVisits, Date.now() - browserStarted, cause);
        await writeWalkRow(updated);
        rows[index] = updated;
      }
    };
    await recordStage('mounted');
    try {
      const frontends = await startWalkStackActions(
        ['pages', 'web'],
        [`${origins.issuer}/.well-known/openid-configuration`, origins.web],
      );
      try {
        await runBangumiJourney({
          skipPersona: true,
          seedReport: seeded,
          startFrontends: false,
          async onMountedStart(work) {
            const id = work.role === 'anime' ? 'I05' : (work.series ?? work.sourceKey) === '499' ? 'I11' : 'I12';
            await markActiveWalkRow(id, Date.now());
          },
          async onMountedVisit(visit) {
            browserVisits.push(visit);
            await recordMountedRows();
          },
        });
      } catch (error) {
        run.browserStageFailure = walkFailureCause(error);
      } finally {
        await frontends.stop();
      }
    } catch (error) {
      const cause = walkFailureCause(error);
      if (run.browserStageFailure) console.error(`mounted stage cleanup failed; ${cause}`);
      run.browserStageFailure ??= cause;
    }
    if (run.browserStageFailure) console.error(`mounted stage failed; ${run.browserStageFailure}`);
    await recordMountedRows(run.browserStageFailure);
    await rm(resolve(evidenceRoot, 'active-row.json'), { force: true });
  };

  try {
    // The admitted host provisions its persona before answering native readiness.
    persona = await readPersona();
    await grantOwner(persona);
    prerequisites.push({ stage: 'setup', elapsedMs: Date.now() - setupStarted, cause: null });
  } catch (error) {
    prerequisites.push({ stage: 'setup', elapsedMs: Date.now() - setupStarted, cause: walkFailureCause(error) });
    for (const { id } of selected) await recordInactive(inactiveWalkRow(id, 'unreached', 'setup'));
  }
  if (prerequisites[0]!.cause === null) {
    await runWalkSelection(selection, {
      async operators() {
        await recordStage('operators');
        // Bangumi precedes the bulk upload quota, and Open Library is the last operator.
        for (const id of operatorRows) rows.push(await walkRow(id, (reached) => runOperator(id, persona, reached)));
      },
      async seed() {
        const seeded = await runSeed('seed');
        if (!seeded) {
          for (const { id } of selected)
            if (!isOperatorRow(id)) await recordInactive(inactiveWalkRow(id, 'unreached', 'seed'));
        }
        return seeded;
      },
      catalogue,
      async reopenSeed(first) {
        await runSeed('seed-reopen', first);
      },
    });
  }
  await recordStage('complete');
  const ordered = orderedWalkRows(selection, rows);
  const endedAt = new Date().toISOString();
  const inventory: WalkInventory = {
    ...run,
    endedAt,
    passing: ordered.filter((row) => row.result === 'passing').length,
    total: FIRST_PUBLIC_IMPORT_ROWS.length,
    slowestFailing: slowestReachedFailure(ordered),
    rows: ordered,
  };
  await writeFile(resolve(evidenceRoot, 'inventory.json'), JSON.stringify(inventory, null, 2), { mode: 0o600 });
  await writeWalkInventoryArtifacts(inventory);
  console.log(walkInventorySummary(inventory));
  return inventory;
}

if (import.meta.main) {
  const inventory = await runImportsPublicJourney(Bun.argv.slice(2));
  if (
    inventory.rows.some(({ result }) => result === 'failing' || result === 'unreached') ||
    inventory.prerequisites.some(({ cause }) => cause !== null) ||
    inventory.browserStageFailure
  )
    process.exitCode = 1;
}
