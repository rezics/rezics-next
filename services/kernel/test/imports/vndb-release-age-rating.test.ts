import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVndbReleaseBindings } from '../../../importer/src/vndb-release-fidelity.ts';
import { CrossMediaDumpFiles, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { importVndbReleaseFidelity } from '../../../importer/src/selected-import.ts';

const context = GLOBAL_CONTEXT;
type Candidate = {
  id: string;
  head: number | null;
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
  };
  source?: unknown;
};

async function authoredCopy(directory: string, age = '15') {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t\\N\t\\N\nv2\tja\t\\N\t\\N'],
    vn_titles: [
      'id\tlang\tofficial\ttitle\tlatin',
      'v1\tja\tt\tAuthored work one\t\\N\nv2\tja\tt\tAuthored work two\t\\N',
    ],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00\nv2\t1\t2026-10-25 00:00:00+00'],
    releases: ['id\treleased\tminage', `r1\t\\N\t${age}`],
    releases_titles: ['id\tlang\tmtl\ttitle\tlatin', 'r1\tja\tt\tAuthored release\t\\N'],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr1\tv2\tpartial'],
    releases_supersedes: ['id\trid', ''],
  };
  for (const [name, [header, body]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${body}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

test('release age candidate is independently adopted, current, cited, fenced and idempotent after reopen', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-age-native-'));
  try {
    expect(
      (
        await runtime.request(
          `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
          { key: randomUUID(), tier: 'trusted' },
          identitySupport(runtime.identity).managementBearer,
        )
      ).status,
    ).toBe(200);
    const editor = await openApiObserver(runtime);
    expect(
      (
        await editor.http('/v1/grants', {
          resource: { route: 0, id: context },
          subject: { kind: 'account', id: runtime.identity.governance.accountId },
          actions: ['context:accept', 'context:adopt'],
          valid: '(,)',
        })
      ).status,
    ).toBe(201);
    const path = join(directory, 'state.sqlite');
    const bindings = await readVndbReleaseBindings(runtime.importTransport, []);
    const first = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const releaseId = idOf(first.readings.find((row) => row.externalId === 'r1')!);
    const workIds = ['v1', 'v2'].map((id) => idOf(first.readings.find((row) => row.externalId === id)!));
    expect(releaseId && workIds.every(Boolean)).toBeTruthy();
    const page = (id: string, property: string) =>
      editor.http(`/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`);
    const agePage = await page(releaseId!, 'wdt:P2899');
    expect(agePage.status).toBe(200);
    const candidate = (agePage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    expect(candidate.statement.value.content).toEqual({ amount: '+15', unit: 'http://www.wikidata.org/entity/Q577' });
    expect(
      candidate.statement.references?.some((reference) =>
        reference.parts.some(
          (part) => part.property.id === 'schema:url' && part.value.content === 'https://vndb.org/r1',
        ),
      ),
    ).toBe(true);
    const links = await page(releaseId!, 'schema:exampleOfWork');
    expect((links.body as { candidates: Candidate[] }).candidates.map((item) => item.statement.value.content)).toEqual(
      expect.arrayContaining(workIds),
    );
    expect(((await page(workIds[0]!, 'wdt:P2899')).body as { candidates: Candidate[] }).candidates).toEqual([]);

    const accepted = await editor.http(`/v1/subjects/${releaseId}/candidates/${candidate.id}:accept`, {
      context,
      expected_head: candidate.head,
    });
    expect(accepted.status).toBe(200);
    const listing = agePage.body as { adoption: { head: number } | null };
    expect(
      (
        await editor.http(`/v1/subjects/${releaseId}:adopt`, {
          context,
          property: 'wdt:P2899',
          mode: 'replace',
          expected_head: listing.adoption?.head ?? null,
          selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
        })
      ).status,
    ).toBe(200);
    const read = async () => {
      const response = await editor.http(`/v1/subjects/${releaseId}?context=${context}`);
      expect(response.status).toBe(200);
      return response.body as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
    };
    expect((await read()).subject.statements['wdt:P2899']?.[0]?.value.content).toEqual(
      candidate.statement.value.content,
    );

    const again = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(idOf(again.readings.find((row) => row.externalId === 'r1')!)).toBe(releaseId);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, '18'),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const finalCandidates = (await page(releaseId!, 'wdt:P2899')).body as { candidates: Candidate[] };
    expect(
      finalCandidates.candidates.some((item) => JSON.stringify(item.statement.value.content).includes('+18')),
    ).toBe(false);
    expect((await read()).subject.statements['wdt:P2899']?.[0]?.value.content).toEqual(
      candidate.statement.value.content,
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
