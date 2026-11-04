import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  vndbReleaseMediumSchemeUri,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformSchemeUri,
  vndbReleasePlatformTaxonomy,
} from '../../../packages/conversion/src/support.ts';
import { CrossMediaDumpFiles, type CrossMediaPort } from '../src/cross-media-seed.ts';
import {
  importVndbReleaseFidelity,
  planVndbReleaseFidelity,
  readVndbReleaseBindings,
  type VndbReleaseBindingGroup,
} from '../src/vndb-release-fidelity.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

/** Authored COPY rows; they are not observations of a provider record. */
async function authoredTables(
  directory: string,
  platforms: readonly string[],
  media: readonly (readonly [string, string])[],
) {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t\N\t\N\nv2\tja\t\N\t\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work one\t\N\nv2\tja\tt\tAuthored work two\t\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25\nv2\t1\t2026-10-25'],
    releases: ['id\treleased', 'r1\t20200101'],
    releases_titles: ['id\tlang\tmtl\ttitle\tlatin', 'r1\tja\tt\tAuthored release\t\N'],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr1\tv2\tpartial'],
    releases_supersedes: ['id\trid', ''],
    releases_platforms: ['id\tplatform', platforms.map((code) => `r1\t${code}`).join('\n')],
    releases_media: ['id\tmedium\tqty', media.map(([code, qty]) => `r1\t${code}\t${qty}`).join('\n')],
  };
  for (const [name, [header, rows]] of Object.entries(files)) {
    await writeFile(join(db, `${name}.header`), `${header}\n`);
    await writeFile(join(db, name), `${rows}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

test('selected authored VNDB COPY release classifications preserve values, dedupe rows and refresh through current bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-platforms-'));
  try {
    const ids = new Map<string, string>();
    const groups: VndbReleaseBindingGroup[] = [
      { taxonomy: vndbReleasePlatformTaxonomy, uri: vndbReleasePlatformSchemeUri, schemeId: randomUUID(), concepts: [] },
      { taxonomy: vndbReleaseMediumTaxonomy, uri: vndbReleaseMediumSchemeUri, schemeId: randomUUID(), concepts: [] },
    ];
    const codes = [['win', 'mac', 'ios'], ['cd', 'dvd']] as const;
    for (const [index, group] of groups.entries()) {
      for (const code of codes[index]!) {
        const id = randomUUID();
        ids.set(code, id);
        (group.concepts as { code: string; id: string }[]).push({ code, id });
      }
    }
    const known = new Map<string, object>();
    for (const group of groups) {
      known.set(group.schemeId, {
        subject: {
          id: group.schemeId,
          type: 'skos:ConceptScheme',
          statements: { 'schema:url': [{ value: { content: group.uri } }] },
        },
      });
      for (const concept of group.concepts) {
        known.set(concept.id, {
          subject: {
            id: concept.id,
            type: 'skos:Concept',
            statements: {
              'schema:url': [{ value: { content: `${group.uri}/${concept.code}` } }],
              'skos:inScheme': [{ value: { content: group.schemeId } }],
            },
          },
        });
      }
    }
    const commands: BatchCommand[] = [];
    const metadata = sourceRecordMetadataFixture();
    const port: CrossMediaPort = {
      async batch(request) {
        commands.push(...request.commands);
        return {
          results: request.commands.map((command) => ({
            key: command.key,
            status: command.op === 'retract' ? (200 as const) : (201 as const),
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'retract'
                  ? { revision: 1 }
                  : { candidate: randomUUID(), revision: 1 },
          })),
        };
      },
      setSourceRecordMetadata: metadata.setSourceRecordMetadata,
      async fence() { return { fenced: false, securityRevision: null }; },
      async writeSourceStatistic() { throw new Error('No statistic in this authored fixture'); },
      async clearSourceStatistic() {},
      async readReviewedSubject(id) {
        return (known.get(id) ?? { subject: { id } }) as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      },
    };
    const propertyOf = (command: BatchCommand) => command.op === 'propose' ? command.statement.property.id : '';
    const targetOf = (command: BatchCommand) =>
      command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    const firstTables = await authoredTables(directory, ['mac', 'win', 'win', 'xyz'], [['dvd', '5'], ['cd', '1'], ['dvd', '2']]);
    const planned = await planVndbReleaseFidelity(firstTables);
    expect(planned.releasePlatforms.get('r1')).toMatchObject({
      platforms: [{ code: 'mac' }, { code: 'win' }],
      media: [{ code: 'cd' }, { code: 'dvd' }],
    });
    expect((await readVndbReleaseBindings(port, groups)).concepts.map((item) => item.id).sort()).toEqual(
      [...ids.values()].sort(),
    );
    const first = await importVndbReleaseFidelity({
      tables: firstTables,
      path: join(directory, 'state.sqlite'),
      port,
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      bindingGroups: groups,
    });
    const firstFacts = commands.filter((command) => ['schema:gamePlatform', 'wdt:P437'].includes(propertyOf(command)));
    expect(first.status === 'imported' || first.status === 'imported-with-gaps').toBe(true);
    expect(first.readings.some((row) => row.externalId === 'r1')).toBe(true);
    expect(firstFacts.map(targetOf).sort()).toEqual(['win', 'mac', 'cd', 'dvd'].map((code) => ids.get(code)!).sort());
    expect(JSON.stringify(first.gaps)).toContain('xyz');
    expect(firstFacts).toHaveLength(4);
    const citations = firstFacts.flatMap((command) => command.op === 'propose' ? command.statement.references ?? [] : []);
    expect(JSON.stringify(citations)).toContain('/releases_platforms/r1/platform');
    expect(JSON.stringify(citations)).toContain('/releases_media/r1/medium');

    const reordered = await authoredTables(directory, ['xyz', 'win', 'mac', 'mac'], [['dvd', '2'], ['cd', '1'], ['cd', '9']]);
    const repeat = await importVndbReleaseFidelity({
      tables: reordered,
      path: join(directory, 'state.sqlite'),
      port,
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      bindingGroups: groups,
    });
    expect(repeat.runs.vndb?.counts.unchanged).toBeGreaterThan(0);

    const beforeRefresh = commands.length;
    const changed = await importVndbReleaseFidelity({
      tables: await authoredTables(directory, ['win', 'lin', 'mac', 'ios', 'xyz'], [['cd', '1'], ['dvd', '1']]),
      path: join(directory, 'state.sqlite'),
      port,
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      bindingGroups: groups,
    });
    const refreshed = commands.slice(beforeRefresh).filter((command) => ['schema:gamePlatform', 'wdt:P437'].includes(propertyOf(command)));
    expect(changed.runs.vndb?.counts.changed).toBeGreaterThan(0);
    expect(refreshed.filter((command) => propertyOf(command) === 'schema:gamePlatform').map(targetOf).sort()).toEqual(
      [ids.get('ios'), ids.get('mac'), ids.get('win')].sort(),
    );
    expect(refreshed.filter((command) => propertyOf(command) === 'wdt:P437').map(targetOf).sort()).toEqual(
      [ids.get('cd'), ids.get('dvd')].sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
