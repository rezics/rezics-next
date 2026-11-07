/** Walk every first-public Imports path on one admitted dev-stack session.
 *
 *   bun services/auth/scripts/dev-stack.ts walk -- bun services/importer/src/imports-public-journey.ts
 *
 * Operators import licensed fixtures through the ordinary CLI, then separately accept/adopt and independently
 * read. Catalogue rows share one fresh seed. A row failure is recorded; independent rows continue.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import { createAccountTokenProvider, IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { runImportCli } from './cli.ts';
import { createImportTransport, importTransportCause, ImportTransportError } from './import-client.ts';
import {
  formatSeedFailure,
  mergeRemainingRequest,
  remainingRequestFromPreparedJournal,
  remainingRequestFromTransport,
} from './seed-remaining-request.ts';
import { ImportSession } from './import-session.ts';
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
import type { ShowcasePublicationResult } from './showcase-publication.ts';

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
  elapsedMs: number;
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

export const WALK_ROW_REPAIR_OWNERS: Record<
  FirstPublicImportRowId,
  { goal: string; manager: string }
> = {
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
  return markdownTableCell(`${row.result}; ${row.elapsedMs}ms; ${detail}`);
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

export async function writeWalkInventoryArtifacts(inventory: WalkInventory): Promise<void> {
  const capabilitiesPath = resolve(root, 'docs/goals/imports.capabilities.md');
  const markdown = applyWalkInventoryToCapabilities(await readFile(capabilitiesPath, 'utf8'), inventory);
  await writeFile(capabilitiesPath, markdown);
  await mkdir(resolve(root, '.temp/continuation'), { recursive: true, mode: 0o700 });
  const failing = inventory.rows.filter((row) => row.result === 'failing');
  const shared = failing.length === inventory.total && failing.every((row) => row.evidence.sharedStartup === true);
  if (shared && failing[0]) {
    await writeFile(
      resolve(root, '.temp/continuation/imports-walk-shared-startup.md'),
      `# Shared walk startup\n\nGoal: imports\nManager: imports\n\nAll twelve first-public rows failed before product paths ran: ${failing[0].cause}\n\nReproduce with the retained walk command. Persona/token sign-in must use the live Auth origin on an admitted stack.\n`,
    );
    return;
  }
  for (const row of failing) {
    const skip = walkRepairSkipReason(row);
    const name = `imports-walk-${row.id.toLowerCase()}.md`;
    const path = resolve(root, '.temp/continuation', name);
    if (skip) {
      await writeFile(path, `# ${row.id} ${row.path}\n\n${skip}\n`);
      continue;
    }
    await writeFile(path, walkRepairBrief(inventory, row));
  }
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
  const origins = stackOrigins();
  await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
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
  const cliOptions = {
    testOrigin: persona.kernel,
    ...(spec.stdin ? { stdin: spec.stdin() } : {}),
  };
  const first = await runImportCli(argv, cliOptions);
  assert.equal(first.code, 0, `${spec.source} CLI ${first.stderr || first.stdout}`);
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
  const adopted: { key: string; id: string; type: string; candidate: string }[] = [];
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
    assert.ok(candidate && 'id' in candidate, `${spec.source} ${key} has no current ${spec.property} candidate`);
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
    adopted.push({ key, id, type: read.subject.type, candidate: candidate.id });
  }
  const again = await runImportCli(argv, {
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
      assert.equal(current.subject.type, adopted.find((row) => row.key === key)!.type);
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
  try {
    const evidence = await run();
    return { id, path: meta.path, result: 'passing', elapsedMs: Date.now() - started, cause: null, evidence };
  } catch (error) {
    return {
      id,
      path: meta.path,
      result: 'failing',
      elapsedMs: Date.now() - started,
      cause: walkFailureCause(error),
      evidence: { error: walkFailureCause(error) },
    };
  }
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

  const operatorIds = ['I01', 'I02', 'I03', 'I04'] as const;
  if (!persona || sharedStartup) {
    for (const id of operatorIds)
      rows.push({
        id,
        path: firstPublicRow(id).path,
        result: 'failing',
        elapsedMs: 0,
        cause: sharedStartup ?? 'persona unavailable',
        evidence: { sharedStartup: true },
      });
  } else {
    for (const id of operatorIds) {
      const current = persona;
      rows.push(await walkRow(id, () => runOperator(id, current)));
    }
  }

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
      const journal = remainingRequestFromPreparedJournal(resolve(root, '.temp/cross-media-seed/showcase.sqlite'));
      const transport = error instanceof ImportTransportError ? remainingRequestFromTransport(error) : undefined;
      const remaining = journal || transport ? mergeRemainingRequest(journal, transport) : undefined;
      seedCause = remaining ? formatSeedFailure(error, remaining) : walkFailureCause(error);
    }
  }

  const catalogueFromSeed = ['I05', 'I06', 'I07', 'I08', 'I09', 'I10', 'I11', 'I12'] as const;
  if (seedCause || !publication || !report) {
    for (const id of catalogueFromSeed)
      rows.push({
        id,
        path: firstPublicRow(id).path,
        result: 'failing',
        elapsedMs: 0,
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

    const frontends = await startWalkStackActions(
      ['pages', 'web'],
      [`${origins.issuer}/.well-known/openid-configuration`, origins.web],
    );
    try {
      const browser = await walkRow('I05', async () => {
        await runBangumiJourney({ skipPersona: true, skipSeed: true, startFrontends: false });
        return { browser: 'passing' };
      });
      for (const id of ['I05', 'I11', 'I12'] as const) {
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) continue;
        const current = rows[index]!;
        rows[index] = {
          ...current,
          elapsedMs: current.elapsedMs + browser.elapsedMs,
          evidence: { ...current.evidence, browser: browser.result },
          ...(browser.result === 'failing' && current.result === 'passing'
            ? { result: 'failing' as const, cause: browser.cause }
            : {}),
        };
      }
    } finally {
      await frontends.stop();
    }
  }

  const endedAt = new Date().toISOString();
  const failing = rows.filter((row) => row.result === 'failing');
  const slowestFailing = failing.slice().sort((left, right) => right.elapsedMs - left.elapsedMs)[0];
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
          elapsedMs: slowestFailing.elapsedMs,
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
