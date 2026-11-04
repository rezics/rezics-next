import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { convertCrossMediaEntity } from '../../../../packages/conversion/src/cross-media-entities.ts';
import { importVndbReleaseFidelity } from '../../../importer/src/vndb-release-fidelity.ts';
import { CrossMediaDumpFiles, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(
  directory: string,
  titles = [
    'r9\ten\tf\tOther owner\t\\N',
    'r1\ten\tt\tHarbor Soft\t\\N',
    'r1\tja\tf\t港の題名\tMinato no Daimei',
    'r1\tja\tf\t港別題\t\\N',
  ],
  released = '20200229',
) {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00'],
    releases: ['id\treleased', `r1\t${released}\nr2\t20200300`],
    releases_titles: ['id\tlang\tmtl\ttitle\tlatin', titles.join('\n')],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr2\tv1\tcomplete'],
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

test('production operator imports authored VNDB release titles through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-names-native-'));
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
    const first = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const work = first.readings.find((row) => row.externalId === 'v1');
    const release = first.readings.find((row) => row.externalId === 'r1');
    const missing = first.readings.find((row) => row.externalId === 'r2');
    expect(work && release && missing).toBeTruthy();
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const workId = idOf(work!);
    const releaseId = idOf(release!);
    expect(workId && releaseId).toBeTruthy();
    expect(releaseId).not.toBe(workId);
    async function acceptAdoptAll(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const sourced = listing.candidates.filter((item) => item.source && !item.retracted);
      for (const candidate of sourced) {
        const latest = await editor.http(
          `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
        );
        const current = (latest.body as { candidates: Candidate[] }).candidates.find((item) => item.id === candidate.id)!;
        const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${candidate.id}:accept`, {
          context: globalContext,
          expected_head: current.head,
        });
        expect(accepted.status).toBe(200);
      }
      const after = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      const latestListing = after.body as { candidates: Candidate[]; adoption: { head: number } | null };
      const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: latestListing.adoption?.head ?? null,
        selection: latestListing.candidates
          .filter((item) => item.source && !item.retracted)
          .map((item) => ({ candidate: item.id, rank: item.statement.rank ?? 'normal' })),
      });
      expect(adopted.status).toBe(200);
    }
    await acceptAdoptAll(releaseId!, 'schema:name');
    await acceptAdoptAll(releaseId!, 'schema:alternateName');
    const read = async (id: string) => {
      const response = await editor.http(`/v1/subjects/${id}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: { id: string; type: string; statements: Record<string, { value: { content: unknown } }[]> };
      };
    };
    const view = await read(releaseId!);
    expect(view.subject.type).toBe('wd:Q20631656');
    expect(view.subject.statements['schema:name']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'en', text: 'Harbor Soft' },
        { language: 'ja', text: '港の題名' },
        { language: 'ja', text: '港別題' },
      ]),
    );
    expect(view.subject.statements['schema:alternateName']?.map((item) => item.value.content)).toEqual([
      { language: 'ja-Latn', text: 'Minato no Daimei' },
    ]);
    expect(view.subject.statements['schema:inLanguage'] ?? []).toEqual([]);
    const currentCreate = convertCrossMediaEntity(
      { external_id: 'r1', record_revision: null, record: { id: 'r1', title: 'Harbor Soft' } },
      { source: crossMediaAliases.vndb },
    );
    const legacy = convertCrossMediaEntity(
      { external_id: 'r1', record_revision: null, record: { id: 'r1', title: 'Harbor Soft' } },
      { source: crossMediaAliases.vndb },
      { converterRevision: 'cross-media-entities@2' },
    );
    expect(legacy.converter_revision).toBe('cross-media-entities@2');
    expect(legacy.digest).toBe(currentCreate.digest);
    expect(legacy.proposals[0]?.key).not.toBe(currentCreate.proposals[0]?.key);
    const again = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(idOf(again.readings.find((row) => row.externalId === 'r1')!)).toBe(releaseId);
    const changed = await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, [
        'r1\ten\tt\tHarbor Soft Revised\t\\N',
        'r1\tja\tf\t港の題名\tMinato no Daimei',
        'r1\tja\tf\t港別題\t\\N',
      ]),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(changed.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const names = await editor.http(
      `/v1/subjects/${releaseId}/candidates?${new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' })}`,
    );
    expect(
      (names.body as { candidates: Candidate[] }).candidates.some(
        (item) => JSON.stringify(item.statement.value.content) === JSON.stringify({ language: 'en', text: 'Harbor Soft Revised' }),
      ),
    ).toBe(true);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbReleaseFidelity({
      tables: await authoredCopy(directory, ['r1\ten\tt\tHarbor Soft Hidden\t\\N']),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const fenced = await editor.http(
      `/v1/subjects/${releaseId}/candidates?${new URLSearchParams({ property: 'schema:name', context: globalContext, limit: '100' })}`,
    );
    expect(
      (fenced.body as { candidates: Candidate[] }).candidates.some(
        (item) => JSON.stringify(item.statement.value.content) === JSON.stringify({ language: 'en', text: 'Harbor Soft Hidden' }),
      ),
    ).toBe(false);
    const current = await editor.http(`/v1/subjects/${releaseId}?context=${globalContext}`);
    expect(current.status).toBe(200);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
