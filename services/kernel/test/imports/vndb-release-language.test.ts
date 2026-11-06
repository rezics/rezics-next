import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';

import { CrossMediaDumpFiles, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { importVndbReleaseLanguage } from '../../../importer/src/selected-import.ts';

const globalContext = GLOBAL_CONTEXT;

/** Authored COPY tables. These are not observed public dump evidence. */
async function authoredCopy(
  directory: string,
  languages: Record<string, string | null> = { r1: 'ja', r2: 'pt-br', r3: null, r4: 'simple' },
) {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const olang = (id: string) => (languages[id] === null || languages[id] === undefined ? '\\N' : languages[id]!);
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t1\t\\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work\t\\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25 00:00:00+00'],
    releases: [
      'id\treleased\tolang',
      [
        `r1\t20200229\t${olang('r1')}`,
        `r2\t20200300\t${olang('r2')}`,
        `r3\t20200400\t${olang('r3')}`,
        `r4\t20200500\t${olang('r4')}`,
      ].join('\n'),
    ],
    releases_titles: [
      'id\tlang\tmtl\ttitle\tlatin',
      [
        'r1\ten\tt\tHarbor Soft\t\\N',
        'r2\ten\tt\tHarbor Soft International\t\\N',
        'r3\ten\tt\tHarbor Soft Unknown\t\\N',
        'r4\ten\tt\tHarbor Soft Unsupported\t\\N',
      ].join('\n'),
    ],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr2\tv1\tcomplete\nr3\tv1\tcomplete\nr4\tv1\tcomplete'],
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

test('production operator imports authored VNDB release original languages through ordinary accept and current reads', async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-language-native-'));
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
    const first = await importVndbReleaseLanguage({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    const idOf = (row: (typeof first.readings)[number]) =>
      (row.subject as { subject?: { id: string } }).subject?.id ?? (row.subject as { id?: string }).id;
    const japaneseId = idOf(first.readings.find((row) => row.externalId === 'r1')!);
    const scriptId = idOf(first.readings.find((row) => row.externalId === 'r2')!);
    const unknownId = idOf(first.readings.find((row) => row.externalId === 'r3')!);
    const unsupportedId = idOf(first.readings.find((row) => row.externalId === 'r4')!);
    expect(japaneseId && scriptId && unknownId && unsupportedId).toBeTruthy();
    expect(new Set([japaneseId, scriptId, unknownId, unsupportedId]).size).toBe(4);
    async function acceptAdopt(subjectId: string, property: string) {
      const page = await editor.http(
        `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(page.status).toBe(200);
      const listing = page.body as { candidates: Candidate[]; adoption: { head: number } | null };
      for (const candidate of listing.candidates.filter((item) => item.source && !item.retracted)) {
        const latest = await editor.http(
          `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
        );
        const current = (latest.body as { candidates: Candidate[] }).candidates.find(
          (item) => item.id === candidate.id,
        )!;
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
    await acceptAdopt(japaneseId!, 'schema:inLanguage');
    await acceptAdopt(scriptId!, 'schema:inLanguage');
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
    const japanese = await read(japaneseId!);
    expect(japanese.subject.type).toBe('wd:Q20631656');
    expect(japanese.subject.statements['schema:inLanguage']?.map((item) => item.value.content)).toEqual(['ja']);
    expect(JSON.stringify(japanese.subject.statements['schema:inLanguage'])).toContain('https://vndb.org/r1');
    expect((await read(scriptId!)).subject.statements['schema:inLanguage']?.map((item) => item.value.content)).toEqual([
      'pt-BR',
    ]);
    expect((await read(unknownId!)).subject.statements['schema:inLanguage'] ?? []).toEqual([]);
    expect((await read(unsupportedId!)).subject.statements['schema:inLanguage'] ?? []).toEqual([]);
    const again = await importVndbReleaseLanguage({
      tables: await authoredCopy(directory),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(idOf(again.readings.find((row) => row.externalId === 'r1')!)).toBe(japaneseId);
    const changed = await importVndbReleaseLanguage({
      tables: await authoredCopy(directory, { r1: 'en', r2: 'pt-br', r3: null, r4: 'simple' }),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    expect(changed.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const languages = await editor.http(
      `/v1/subjects/${japaneseId}/candidates?${new URLSearchParams({ property: 'schema:inLanguage', context: globalContext, limit: '100' })}`,
    );
    expect(
      (languages.body as { candidates: Candidate[] }).candidates.some((item) => item.statement.value.content === 'en'),
    ).toBe(true);
    expect(
      (await read(japaneseId!)).subject.statements['schema:inLanguage']?.map((item) => item.value.content),
    ).toEqual(['ja']);
    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb,
      externalId: 'r1',
      fieldGroup: 'facts',
      reason: 'Rights complaint',
    });
    expect(fence.status).toBe(200);
    await importVndbReleaseLanguage({
      tables: await authoredCopy(directory, { r1: 'zh-Hans', r2: 'pt-br', r3: null, r4: 'simple' }),
      path,
      port: runtime.importTransport,
      bindings,
      destination: { origin: 'https://kernel.import.test' },
    });
    const fenced = await editor.http(
      `/v1/subjects/${japaneseId}/candidates?${new URLSearchParams({ property: 'schema:inLanguage', context: globalContext, limit: '100' })}`,
    );
    expect(
      (fenced.body as { candidates: Candidate[] }).candidates.some(
        (item) => item.statement.value.content === 'zh-Hans',
      ),
    ).toBe(false);
    expect(
      (await read(japaneseId!)).subject.statements['schema:inLanguage']?.map((item) => item.value.content),
    ).toEqual(['ja']);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
