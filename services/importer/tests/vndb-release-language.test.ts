import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { CrossMediaDumpFiles, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { importVndbReleaseLanguage, planVndbReleaseLanguage } from '../src/vndb-release-language.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

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
      [`r1\t20200229\t${olang('r1')}`, `r2\t20200300\t${olang('r2')}`, `r3\t20200400\t${olang('r3')}`, `r4\t20200500\t${olang('r4')}`].join(
        '\n',
      ),
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

function port(commands: BatchCommand[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return { subject: { id, type: id.startsWith('r') ? 'wd:Q20631656' : 'wd:Q689445' } } as Awaited<
        ReturnType<CrossMediaPort['readReviewedSubject']>
      >;
    },
  };
}

function languageContent(commands: BatchCommand[], externalId: string) {
  return commands.flatMap((command) =>
    command.op === 'propose' &&
    command.source.external_id === externalId &&
    command.statement.property.id === 'schema:inLanguage' &&
    command.statement.value.type === 'value'
      ? [command.statement.value.content]
      : [],
  );
}

test('selected-family COPY import retains distinct release original languages without using title language', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-language-'));
  try {
    const tables = await authoredCopy(directory);
    const plan = await planVndbReleaseLanguage(tables);
    expect(plan.entities.vndb.map((row) => row.key)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(plan.entities.vndb.map((row) => row.payload.olang)).toEqual(['ja', 'pt-br', null, 'simple']);
    const registration = createSourceRegistration('vndb', {
      source: 'vndb',
      converterRevision: converter_revision,
    });
    const bound = (id: string, olang: unknown, titles: string) =>
      registration.convert(
        {
          external_id: id,
          record_revision: null,
          record: {
            id,
            olang,
            releases_titles: [{ id, lang: 'en', mtl: true, title: titles, latin: null }],
          },
        },
        { source: registration.source, subjectId: '00000000-0000-4000-8000-000000000004' },
      );
    const japanese = bound('r1', 'ja', 'Harbor Soft');
    const region = bound('r2', 'pt-br', 'Harbor Soft International');
    const unknown = bound('r3', null, 'Harbor Soft Unknown');
    const unsupported = bound('r4', 'simple', 'Harbor Soft Unsupported');
    expect(languageContent([...japanese.proposals], 'r1')).toEqual(['ja']);
    expect(languageContent([...region.proposals], 'r2')).toEqual(['pt-BR']);
    expect(languageContent([...unknown.proposals], 'r3')).toEqual([]);
    expect(languageContent([...unsupported.proposals], 'r4')).toEqual([]);
    expect(unsupported.diagnostics).toEqual([{ pointer: '/olang', code: 'unadmitted_language' }]);
    expect(unknown.normalized).toMatchObject({ olang: null });
    expect(japanese.normalized).toMatchObject({ olang: 'ja' });
    expect(region.normalized).toMatchObject({ olang: 'pt-br' });
    expect(japanese.digest).not.toBe(region.digest);
    const cited = japanese.proposals.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:inLanguage',
    );
    expect(JSON.stringify(cited?.op === 'propose' ? cited.statement.references : undefined)).toContain(
      'https://vndb.org/r1',
    );
    expect(
      [...japanese.proposals, ...region.proposals].some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:inLanguage' &&
          command.statement.value.type === 'value' &&
          command.statement.value.content === 'en',
      ),
    ).toBe(false);
    const commands: BatchCommand[] = [];
    const first = await importVndbReleaseLanguage({
      tables,
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    });
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.converterRevision).toBe(converter_revision);
    expect(languageContent(commands, 'r1')).toEqual(['ja']);
    expect(languageContent(commands, 'r2')).toEqual(['pt-BR']);
    expect(languageContent(commands, 'r3')).toEqual([]);
    expect(languageContent(commands, 'r4')).toEqual([]);
    const count = commands.length;
    const again = await importVndbReleaseLanguage({
      tables: await authoredCopy(directory),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    const changed: BatchCommand[] = [];
    const successor = await importVndbReleaseLanguage({
      tables: await authoredCopy(directory, { r1: 'en', r2: 'pt-br', r3: null, r4: 'simple' }),
      path: join(directory, 'state.sqlite'),
      port: port(changed),
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    });
    expect(successor.runs.vndb?.counts.changed).toBeGreaterThan(0);
    expect(languageContent(changed, 'r1')).toEqual(['en']);
    expect(languageContent(changed, 'r2')).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
