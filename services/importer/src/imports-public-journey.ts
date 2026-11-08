/** Walk every first-public Imports path on one admitted dev-stack session.
 *
 *   bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts
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
import { ImportSession } from './import-session.ts';
import { sameStatementProvenance } from './statement-provenance.ts';
import { GLOBAL_CONTEXT, selectedSynopsisQueryFromPublic } from './public-bulk-client.ts';
import { BOOK_OWNER_GRANT_ACTIONS, grantOrdinaryOwnerActions } from './ordinary-owner-grants.ts';
import {
  citedAnimeCreditTargets,
  runBangumiJourney,
  selectJourneyWorks,
  startWalkStackActions,
  type JourneyPublishedRow,
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
  slowestFailing: { id: FirstPublicImportRowId; path: string; elapsedMs: number; cause: string } | null;
  rows: WalkRowResult[];
};

const retainedCommand =
  'bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts';

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

export function walkInventorySummary(inventory: WalkInventory): string {
  const failing = inventory.rows.filter((row) => row.result === 'failing');
  const slowest = inventory.slowestFailing;
  return `${inventory.passing}/${inventory.total} passing; slowest failing ${
    slowest ? `${slowest.id} ${slowest.elapsedMs}ms ${slowest.cause}` : 'none'
  }; ${failing.length} failing`;
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
  if (evidence.sharedStartup === true) parts.push('shared startup not exercised');
  if (evidence.seed === true) parts.push('catalogue seed not exercised');
  return parts.join(', ') || 'current read';
}

export function capabilitiesResultCell(row: WalkRowResult): string {
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
  const record = [
    OBSERVED_WALK_HEADING,
    '',
    `Command: \`${inventory.command}\`. Revision \`${inventory.revision}\`. Started ${inventory.startedAt}; ended ${inventory.endedAt}. ${inventory.passing}/${inventory.total} passing.`,
    inventory.slowestFailing
      ? `Slowest failing: ${inventory.slowestFailing.id} ${inventory.slowestFailing.elapsedMs}ms ${inventory.slowestFailing.cause}.`
      : 'No failing journey.',
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
  if (!observed.has(active.id)) {
    observed.set(active.id, {
      id: active.id,
      path: firstPublicRow(active.id).path,
      result: 'failing',
      elapsedMs: null,
      cause: terminal.cause,
      evidence: {
        interrupted: true,
        activeStartedAt: active.startedAt,
        controllerFinishedAt: terminal.finishedAt,
        checkId: terminal.checkId,
        runElapsedMs: terminal.runElapsedMs,
        currentRead: 'not reached',
      },
    });
  }
  // A returned partial directory cannot establish outcomes for unobserved rows.
  const missing = FIRST_PUBLIC_IMPORT_ROWS.filter((row) => !observed.has(row.id));
  if (missing.length) throw new Error(`No returned walk observation for ${missing.map((row) => row.id).join(', ')}`);
  const ordered = FIRST_PUBLIC_IMPORT_ROWS.map((row) => observed.get(row.id)!);
  const slowest = ordered
    .filter((row) => row.result === 'failing' && row.elapsedMs !== null)
    .sort((left, right) => right.elapsedMs! - left.elapsedMs!)[0];
  return {
    ...run,
    endedAt: terminal.finishedAt,
    passing: ordered.filter((row) => row.result === 'passing').length,
    total: ordered.length,
    rows: ordered,
    slowestFailing: slowest
      ? {
          id: slowest.id,
          path: slowest.path,
          elapsedMs: slowest.elapsedMs!,
          cause: slowest.cause!,
        }
      : null,
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

export function selectPublished(
  published: readonly JourneyPublishedRow[],
  provider: string,
  sourceKey: string,
): JourneyPublishedRow {
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

async function command(name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  // The admitted walk owns this child's process group and its existing end-to-end budget.
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await writeFile(resolve(evidenceRoot, `${name}.log`), `${stdout}${stderr}`, { mode: 0o600 });
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
  let last = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${api}/v1/subjects/${id}`);
    last = response.status;
    if (response.status === 503) {
      if (attempt === 4) break;
      await Bun.sleep(200);
      continue;
    }
    assert.equal(response.status, 200, `anonymous Subject ${id}`);
    const body: unknown = await response.json();
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
    };
  }
  throw new Error(`anonymous Subject ${id} returned ${last}`);
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

async function loadPersona(): Promise<SeedEnv> {
  await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
  return readPersona();
}

async function readPersona(): Promise<SeedEnv> {
  const origins = stackOrigins();
  const seedEnv = await parseEnv(resolve(root, '.temp/local-stack/seed.env'));
  return {
    account: seedEnv.REZICS_DEV_PERSONA_ACCOUNT!,
    accountKeyPath: seedEnv.REZICS_DEV_PERSONA_ACCOUNT_KEY!,
    client: seedEnv.REZICS_DEV_PERSONA_CLIENT!,
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

async function runOperator(id: 'I01' | 'I02' | 'I03' | 'I04', persona: SeedEnv): Promise<Record<string, unknown>> {
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
  const observedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const requestId = randomUUID();
    appendFileSync(
      resolve(directory, 'requests.jsonl'),
      `${JSON.stringify({
        requestId,
        event: 'start',
        at: new Date().toISOString(),
        method: request.method,
        path: new URL(request.url).pathname,
      })}\n`,
      { mode: 0o600 },
    );
    const response = await fetch(request);
    const payload: unknown = response.headers.get('content-type')?.includes('json')
      ? await response.clone().json()
      : undefined;
    const problems =
      isRecord(payload) && Array.isArray(payload.results)
        ? payload.results
            .filter(isRecord)
            .filter((row) => row.problem !== undefined)
            .map((row) => reviewedCatalogueProblem(row.problem))
        : response.status >= 400
          ? [reviewedCatalogueProblem(payload)]
          : [];
    appendFileSync(
      resolve(directory, 'requests.jsonl'),
      `${JSON.stringify({
        requestId,
        event: 'response',
        at: new Date().toISOString(),
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        problems,
        correlation: response.headers.get('x-request-id'),
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
    ...(spec.stdin ? { stdin: spec.stdin() } : {}),
  };
  const first = await runImportCli(argv, cliOptions);
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
  const again = await runImportCli(argv, {
    ...cliOptions,
    testOrigin: persona.kernel,
    ...(spec.stdin ? { stdin: spec.stdin() } : {}),
  });
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

function statementContents(read: { subject: { statements: Record<string, unknown[]> } }, property: string): unknown[] {
  return (read.subject.statements[property] ?? []).map((row) =>
    isRecord(row) && isRecord(row.value) ? row.value.content : undefined,
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
  assert.ok(left.subject.id === canonical || right.subject.id === canonical);
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
    creditedWorks: credits.map((row) => ({ sourceKey: row.sourceKey, type: row.nativeType })),
  };
}

async function walkFranchise(api: string, publication: ShowcasePublicationResult) {
  const steins = selectPublished(publication.published, 'bangumi', '10380');
  const clannad = selectPublished(publication.published, 'bangumi', '51');
  const vn = selectPublished(publication.published, 'vndb', 'v2002');
  await currentSubject(api, steins.subjectId);
  await currentSubject(api, clannad.subjectId);
  await currentSubject(api, vn.subjectId);
  const relations = publication.vndbWorkRelations ?? [];
  assert.ok(
    relations.length > 0 || publication.published.some((row) => row.sourceKey === 'v17102'),
    'typed franchise relations are missing',
  );
  return {
    steins: steins.subjectId,
    clannad: clannad.subjectId,
    vn: vn.subjectId,
    relationCount: relations.length,
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

async function walkRow(
  id: FirstPublicImportRowId,
  run: () => Promise<Record<string, unknown>>,
): Promise<WalkRowResult> {
  const meta = firstPublicRow(id);
  const started = Date.now();
  await writeFile(
    resolve(evidenceRoot, 'active-row.json'),
    JSON.stringify({
      id,
      path: meta.path,
      startedAt: new Date(started).toISOString(),
    }),
    { mode: 0o600 },
  );
  let row: WalkRowResult;
  try {
    const evidence = await run();
    row = { id, path: meta.path, result: 'passing', elapsedMs: Date.now() - started, cause: null, evidence };
  } catch (error) {
    console.error(`${id} failing; ${Date.now() - started}ms; ${walkFailureCause(error)}`);
    row = {
      id,
      path: meta.path,
      result: 'failing',
      elapsedMs: Date.now() - started,
      cause: walkFailureCause(error),
      evidence: { error: walkFailureCause(error) },
    };
  }
  await writeFile(resolve(evidenceRoot, `${id.toLowerCase()}-row.json`), JSON.stringify(row), { mode: 0o600 });
  return row;
}

export async function runImportsPublicJourney(): Promise<WalkInventory> {
  const startedAt = new Date().toISOString();
  const revision = (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim();
  await retireWalkJournals();
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const origins = stackOrigins();
  const rows: WalkRowResult[] = [];
  let persona: SeedEnv | undefined;
  let sharedStartup: string | null = null;
  try {
    persona = await loadPersona();
    await grantOwner(persona);
  } catch (error) {
    sharedStartup = walkFailureCause(error);
  }

  await writeFile(
    resolve(evidenceRoot, 'run.json'),
    JSON.stringify({
      command: retainedCommand,
      revision,
      startedAt,
    }),
    { mode: 0o600 },
  );

  const seedStarted = Date.now();
  let seedElapsedMs = 0;
  let seedCause: string | null = sharedStartup;
  let publication: ShowcasePublicationResult | undefined;
  let report: CrossMediaSeedReport | undefined;
  if (!seedCause) {
    try {
      await command(
        'seed',
        ['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'],
        walkSeedChildEnv(origins, persona?.file ?? {}),
      );
      const loaded = await loadSeedReport();
      report = loaded.report;
      publication = loaded.publication;
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
        return {
          id: anime.row.subjectId,
          episodes: episodes.length,
          cast: cast.length,
          staff: staff.length,
          characters: characters.length,
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
        assert.ok(statementContents(volumeRead, 'wdt:P179').includes(series.subjectId));
        assert.ok(statementContents(seriesRead, 'schema:publisher').length > 0);
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
        for (const volume of [first, second]) {
          const read = await currentSubject(api, volume.subjectId);
          assert.equal(read.subject.type, 'schema:Book');
          assert.ok(statementContents(read, 'wdt:P179').includes(series.subjectId));
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

    const browser = await walkRow('I05', async () => {
      const frontends = await startWalkStackActions(
        ['pages', 'web'],
        [`${origins.issuer}/.well-known/openid-configuration`, origins.web],
      );
      try {
        await runBangumiJourney({ skipPersona: true, skipSeed: true, startFrontends: false });
        return { browser: 'passing' };
      } finally {
        await frontends.stop();
      }
    });
    for (const id of ['I05', 'I11', 'I12'] as const) {
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index]!;
      rows[index] = {
        ...current,
        elapsedMs: current.elapsedMs! + browser.elapsedMs!,
        evidence: { ...current.evidence, browser: browser.result },
        ...(browser.result === 'failing' && current.result === 'passing'
          ? { result: 'failing' as const, cause: browser.cause }
          : {}),
      };
    }
  }

  for (const row of rows)
    await writeFile(resolve(evidenceRoot, `${row.id.toLowerCase()}-row.json`), JSON.stringify(row), { mode: 0o600 });

  // These callers share the ordinary account/source authority. Keep native writes serial.
  // Open Library is last so its unresolved operation cannot hide the other observations.
  for (const id of ['I01', 'I02', 'I04', 'I03'] as const) {
    const row: WalkRowResult =
      !persona || sharedStartup
        ? {
            id,
            path: firstPublicRow(id).path,
            result: 'failing',
            elapsedMs: 0,
            cause: sharedStartup ?? 'persona unavailable',
            evidence: { sharedStartup: true },
          }
        : await walkRow(id, () => runOperator(id, persona!));
    rows.push(row);
    await writeFile(resolve(evidenceRoot, `${id.toLowerCase()}-row.json`), JSON.stringify(row), { mode: 0o600 });
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));

  const endedAt = new Date().toISOString();
  const failing = rows.filter((row) => row.result === 'failing');
  const slowestFailing = failing
    .filter((row) => row.elapsedMs !== null)
    .sort((left, right) => right.elapsedMs! - left.elapsedMs!)[0];
  const inventory: WalkInventory = {
    command: retainedCommand,
    revision,
    startedAt,
    endedAt,
    passing: rows.filter((row) => row.result === 'passing').length,
    total: FIRST_PUBLIC_IMPORT_ROWS.length,
    slowestFailing: slowestFailing
      ? {
          id: slowestFailing.id,
          path: slowestFailing.path,
          elapsedMs: slowestFailing.elapsedMs!,
          cause: slowestFailing.cause!,
        }
      : null,
    rows,
  };
  await writeFile(resolve(evidenceRoot, 'inventory.json'), JSON.stringify(inventory, null, 2), { mode: 0o600 });
  await writeWalkInventoryArtifacts(inventory);
  console.log(walkInventorySummary(inventory));
  return inventory;
}

if (import.meta.main) {
  const inventory = await runImportsPublicJourney();
  if (inventory.passing < inventory.total) process.exitCode = 1;
}
