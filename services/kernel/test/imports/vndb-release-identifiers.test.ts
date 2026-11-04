import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { importVndbReleaseIdentifiers } from '../../../importer/src/vndb-release-identifiers.ts';
import { CrossMediaDumpFiles, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
const supported = '4580123456789';
const changed = '4901234567894';

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(directory: string, gtin = supported) {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N\nv2\tja\t0\t\\N'],
    vn_titles: [
      'id\tlang\tofficial\ttitle\tlatin',
      'v1\tja\tt\tAuthored work\t\\N\nv2\tja\tt\tAuthored companion\t\\N',
    ],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00\nv2\t1\t2026-10-25 00:00:00+00'],
    releases: ['id\tgtin\treleased', `r1\t${gtin}\t20200229\nr2\t0\t20200300`],
    releases_titles: [
      'id\tlang\tmtl\ttitle\tlatin',
      'r1\tja\tt\tAuthored barcode release\t\\N\nr2\tja\tt\tAuthored unknown barcode\t\\N',
    ],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr1\tv2\tcomplete\nr2\tv1\tcomplete'],
    releases_supersedes: ['id\trid', ''],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred'; references?: unknown[] };
  source?: unknown;
};

test('A production COPY/operator import preserves a supported explicit release GTIN on the existing source Release through candidate inspection, independent native acceptance/adoption and current read. Unknown or invalid source values withhold only that fact; changed barcode, deliberate unchanged-input refresh, reopen and a facts fence preserve ordinary importer identity and delivery semantics.', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-identifiers-native-'));
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const bindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
    const path = join(directory, 'state.sqlite');
    const first = await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const release = first.readings.find((row) => row.externalId === 'r1');
    const unknown = first.readings.find((row) => row.externalId === 'r2');
    expect(release && unknown).toBeTruthy();
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const releaseId = idOf(release!);
    const unknownId = idOf(unknown!);
    expect(releaseId && unknownId).toBeTruthy();
    expect(releaseId).not.toBe(unknownId);
    async function candidates(subjectId: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property: 'schema:gtin', context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      return page.body as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    const listing = await candidates(releaseId!);
    const sourced = listing.candidates.filter((item) => item.source && !item.retracted);
    expect(sourced).toHaveLength(1);
    expect(sourced[0]?.statement.value.content).toBe(supported);
    expect(JSON.stringify(sourced[0]?.statement.references ?? [])).toContain('https://vndb.org/r1');
    const accepted = await editor.http(`/v1/subjects/${releaseId}/candidates/${sourced[0]!.id}:accept`, {
      context: globalContext,
      expected_head: sourced[0]!.head,
    });
    expect(accepted.status).toBe(200);
    const after = await candidates(releaseId!);
    const adopted = await editor.http(`/v1/subjects/${releaseId}:adopt`, {
      context: globalContext,
      property: 'schema:gtin',
      mode: 'replace',
      expected_head: after.adoption?.head ?? null,
      selection: [{ candidate: sourced[0]!.id, rank: sourced[0]!.statement.rank ?? 'normal' }],
    });
    expect(adopted.status).toBe(200);
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          id: string;
          type: string;
          statements: Record<string, { value: { content: unknown }; references?: unknown[] }[]>;
        };
      };
    };
    const view = await read(releaseId!);
    expect(view.subject.type).toBe('wd:Q20631656');
    expect(view.subject.statements['schema:gtin']?.map((item) => item.value.content)).toEqual([supported]);
    expect(JSON.stringify(view.subject.statements['schema:gtin'] ?? [])).toContain('https://vndb.org/r1');
    const unknownView = await read(unknownId!);
    expect(unknownView.subject.type).toBe('wd:Q20631656');
    expect(unknownView.subject.statements['schema:gtin'] ?? []).toEqual([]);
    const again = await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(idOf(again.readings.find((row) => row.externalId === 'r1')!)).toBe(releaseId);
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const successor = await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory, changed),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(successor.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const updated = await candidates(releaseId!);
    expect(updated.candidates.some((item) => item.statement.value.content === changed && item.source && !item.retracted)).toBe(
      true,
    );
    expect((await read(releaseId!)).subject.statements['schema:gtin']?.map((item) => item.value.content)).toEqual([
      supported,
    ]);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbReleaseIdentifiers({
      tables: await authoredCopy(directory, '00012345678905'),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const fenced = await candidates(releaseId!);
    expect(fenced.candidates.some((item) => item.statement.value.content === '00012345678905')).toBe(false);
    const current = await read(releaseId!);
    expect(current.subject.statements['schema:gtin']?.map((item) => item.value.content)).toEqual([supported]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
