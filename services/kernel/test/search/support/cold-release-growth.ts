import {
  releaseAdmission,
  releaseDigest,
  RELEASE_LIMITS,
  RELEASE_FORMAT,
  valueSchema,
  type Release,
} from '@rezics/definitions';
import canonicalize from 'canonicalize';
import { fileURLToPath } from 'node:url';
import { activeRelease, bootstrapRelease } from '../../../src/semantic/definitions.ts';
import {
  capture,
  costOf,
  openGrowthDatabase,
  settle,
  type Capture,
  type GrowthDatabase,
} from '../../support/growth.ts';

type Scenario = { kind: 'history'; rows: number } | { kind: 'payloads' };
type Cost = {
  statements: number;
  plans: number;
  examinedRows: number;
  removedRows: number;
  buffers: number;
  sharedHit: number;
  sharedRead: number;
  requestBytes?: number;
  responseBytes?: number;
  backgroundStatements?: number;
  backgroundRows?: number;
  backgroundBlocks?: number;
  backgroundCosts?: unknown;
  relations: unknown;
};
type Read = {
  digest: string;
  head: number;
  release: Release;
  bodyReads: number;
  bodyResponseBytes: number;
  cost: Cost;
  native: Capture;
};
type ReadSummary = Omit<Read, 'release'>;
type Sample = {
  digest: string;
  canonicalBytes: number;
  activationRows: number;
  releaseRows: number;
  cold: ReadSummary;
  warm: ReadSummary;
  warmReusesRelease: boolean;
  immutable: boolean;
};
type HistoryResult = Sample;
type PayloadResult = Sample & { payloadBytes: number };

const kernelDirectory = fileURLToPath(new URL('../../..', import.meta.url));
const fixedHistoryPayloadBytes = 64 * 1024;

function removedRows(plans: readonly unknown[]): number {
  let removed = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'Rows Removed by Filter' || key === 'Rows Removed by Index Recheck') && typeof child === 'number')
          removed += child;
        else visit(child);
      }
    }
  };
  visit(plans);
  return removed;
}

function release(version: string, payloadBytes = 0): Release {
  const description = 'x'.repeat(payloadBytes);
  return {
    format: RELEASE_FORMAT,
    catalogue: { id: 'https://rezics.com/catalogue/search-cold-release', version },
    generator: { name: 'rezics-search-cold-release-growth', version: '1' },
    prefixes: { schema: 'http://schema.org/' },
    types: {
      'schema:Person': {
        iri: 'http://schema.org/Person',
        labels: { en: 'person' },
        descriptions: { en: description },
        mappings: [],
        bases: [],
        properties: ['schema:url'],
        facets: [],
      },
    },
    properties: {
      'schema:url': {
        iri: 'http://schema.org/url',
        labels: { en: 'URL' },
        mappings: [],
        datatype: 'url',
        multivalued: false,
        qualifiers: [],
        value: valueSchema('url'),
      },
    },
  };
}

function canonicalBytes(value: Release): number {
  const body = canonicalize(value);
  if (body === undefined) throw new Error('Definition release did not have canonical JSON');
  return new TextEncoder().encode(body).byteLength;
}

async function readDefaultRelease(database: GrowthDatabase): Promise<Read> {
  const measured = await capture(database, () => activeRelease(database.pool), { includeBackends: true });
  if (!measured.value) throw new Error('The production active-release reader returned no active release');
  const native = measured.capture;
  const bodyIndexes = native.statements.flatMap((statement, index) =>
    /SELECT\s+body\s+FROM\s+semantic\.definition_release/i.test(statement) ? [index] : [],
  );
  if (native.responseBytes === undefined)
    throw new Error('The shared growth capture did not retain native response-byte diagnostics');
  const bodyResponseBytes = bodyIndexes.reduce((total, index) => {
    const bytes = native.responseBytes![index];
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error(`The shared growth capture omitted response bytes for release body statement ${index}`);
    return total + bytes;
  }, 0);
  const cost = costOf(native);
  return {
    digest: measured.value.digest,
    head: measured.value.head,
    release: measured.value.release as Release,
    bodyReads: bodyIndexes.length,
    bodyResponseBytes,
    cost: {
      statements: cost.statements,
      plans: cost.plans,
      examinedRows: cost.rows,
      removedRows: removedRows(native.plans),
      buffers: cost.blocks,
      sharedHit: cost.sharedHit,
      sharedRead: cost.sharedRead,
      ...(cost.requestBytes === undefined ? {} : { requestBytes: cost.requestBytes }),
      ...(cost.responseBytes === undefined ? {} : { responseBytes: cost.responseBytes }),
      ...(cost.backgroundStatements === undefined ? {} : { backgroundStatements: cost.backgroundStatements }),
      ...(cost.backgroundRows === undefined ? {} : { backgroundRows: cost.backgroundRows }),
      ...(cost.backgroundBlocks === undefined ? {} : { backgroundBlocks: cost.backgroundBlocks }),
      ...(cost.backgroundCosts === undefined ? {} : { backgroundCosts: cost.backgroundCosts }),
      relations: cost.relations,
    },
    native,
  };
}

async function seedActivationHistory(database: GrowthDatabase, rows: number): Promise<number> {
  const seeded = await database.admin.query(
    `INSERT INTO semantic.definition_activation (route, head, digest, recorded_transaction_id)
     SELECT 0, latest.head + series.step, latest.digest, gen_random_uuid()
     FROM (SELECT head, digest FROM semantic.definition_activation WHERE route = 0 ORDER BY head DESC LIMIT 1) AS latest,
          generate_series(1, $1::integer) AS series(step)`,
    [rows],
  );
  if (seeded.rowCount !== rows) throw new Error(`Seeded ${seeded.rowCount} activation rows; expected ${rows}`);
  return seeded.rowCount;
}

async function seedReleaseHistory(database: GrowthDatabase, rows: number, selectedDigest: string): Promise<number> {
  if (rows === 0) return 0;
  const values: string[] = [];
  const tuples: string[] = [];
  for (let index = 0; index < rows; index++) {
    const body = release(`history-${String(index).padStart(5, '0')}`);
    if (releaseAdmission(body).length) throw new Error('An unrelated fixture release exceeded definition admission');
    values.push(releaseDigest(body), JSON.stringify(body));
    const digestParameter = values.length - 1;
    tuples.push(`($${digestParameter}::text, $${digestParameter + 1}::jsonb)`);
  }
  values.push(selectedDigest);
  const selectedParameter = values.length;
  const seeded = await database.admin.query(
    `INSERT INTO semantic.definition_release (route, digest, body, recorded_transaction_id)
     SELECT 0, seed.digest, seed.body, selected.recorded_transaction_id
     FROM (VALUES ${tuples.join(',')}) AS seed(digest, body)
     CROSS JOIN (SELECT recorded_transaction_id FROM semantic.definition_release WHERE route = 0 AND digest = $${selectedParameter}::text) AS selected`,
    values,
  );
  if (seeded.rowCount !== rows) throw new Error(`Seeded ${seeded.rowCount} release rows; expected ${rows}`);
  return seeded.rowCount;
}

async function measureRelease(
  database: GrowthDatabase,
  selected: Release,
  activationRows: number,
  releaseRows: number,
) {
  if (releaseAdmission(selected).length) throw new Error('The selected definition release exceeds admission limits');
  const canonicalLength = canonicalBytes(selected);
  if (canonicalLength > RELEASE_LIMITS.bytes) throw new Error('The selected canonical release exceeds the byte limit');
  const digest = await bootstrapRelease(database.pool, selected);
  if (digest !== releaseDigest(selected)) throw new Error('Bootstrap activated a different definition digest');
  const seededReleaseRows = await seedReleaseHistory(database, releaseRows, digest);
  const seededActivationRows = await seedActivationHistory(database, activationRows);
  await settle(database, { analyze: true });

  const cold = await readDefaultRelease(database);
  const warm = await readDefaultRelease(database);
  if (cold.digest !== digest || warm.digest !== digest)
    throw new Error('A measured Search release read selected a different digest');
  return {
    digest,
    canonicalBytes: canonicalLength,
    activationRows: seededActivationRows,
    releaseRows: seededReleaseRows,
    cold: withoutRelease(cold),
    warm: withoutRelease(warm),
    warmReusesRelease: cold.release === warm.release,
    immutable:
      Object.isFrozen(cold.release) && Object.isFrozen(cold.release.types) && Object.isFrozen(cold.release.properties),
  };
}

function withoutRelease(read: Read): ReadSummary {
  const { release: _release, ...summary } = read;
  return summary;
}

async function executeScenario(scenario: Scenario): Promise<HistoryResult | { samples: PayloadResult[] }> {
  if (scenario.kind === 'history') {
    const database = await openGrowthDatabase();
    try {
      return await measureRelease(database, release('fixed', fixedHistoryPayloadBytes), scenario.rows, scenario.rows);
    } finally {
      await database.close();
    }
  }

  const baseBytes = canonicalBytes(release('payload', 0));
  const largestPayload = Math.min(1024 * 1024, RELEASE_LIMITS.bytes - baseBytes - 1024);
  if (largestPayload < 8192) throw new Error('The admitted definition release left too little room for payload growth');
  const payloadSizes = [Math.floor(largestPayload / 8), Math.floor(largestPayload / 2), largestPayload];
  const samples: PayloadResult[] = [];
  for (const payloadBytes of payloadSizes) {
    const database = await openGrowthDatabase();
    try {
      const sample = await measureRelease(database, release('payload', payloadBytes), 0, 0);
      samples.push({ ...sample, payloadBytes });
    } finally {
      await database.close();
    }
  }
  return { samples };
}

async function runIsolated(scenario: Scenario): Promise<HistoryResult | { samples: PayloadResult[] }> {
  const program = `
    import { runChildScenario } from "./test/search/support/cold-release-growth.ts";
    const result = await runChildScenario(${JSON.stringify(scenario)});
    console.log("COLD_RELEASE_RESULT:" + JSON.stringify(result));
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: kernelDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Cold release worker exited ${exitCode}: ${stderr}\n${stdout}`);
  const result = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('COLD_RELEASE_RESULT:'))
    ?.slice('COLD_RELEASE_RESULT:'.length);
  if (!result) throw new Error(`Cold release worker emitted no result: ${stderr}\n${stdout}`);
  return JSON.parse(result) as Awaited<ReturnType<typeof runChildScenario>>;
}

export async function runColdReleaseHistory(rows: number): Promise<HistoryResult> {
  const result = await runIsolated({ kind: 'history', rows });
  if ('samples' in result) throw new Error('The cold release worker returned payload samples for a history scale');
  return result;
}

export async function runColdReleasePayloads(): Promise<{ samples: PayloadResult[] }> {
  const result = await runIsolated({ kind: 'payloads' });
  if (!('samples' in result)) throw new Error('The cold release worker returned one history sample for payload growth');
  return result;
}

export async function runChildScenario(scenario: Scenario) {
  return executeScenario(scenario);
}
