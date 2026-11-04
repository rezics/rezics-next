import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  vndbReleaseMediumConceptUri,
  vndbReleaseMediumSchemeUri,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformConceptUri,
  vndbReleasePlatformSchemeUri,
  vndbReleasePlatformTaxonomy,
} from '../../../../packages/conversion/src/support.ts';
import { importVndbReleaseFidelity, readVndbReleaseBindings, type VndbReleaseBindingGroup } from '../../../importer/src/vndb-release-fidelity.ts';
import { CrossMediaDumpFiles, crossMediaAliases } from '../../../importer/src/cross-media-seed.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const source = 'authored-vndb-release';
const globalContext = GLOBAL_CONTEXT;
type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred'; references?: unknown[] };
  source?: { source: string; external_id: string } | null;
};

/** Authored COPY rows; they are not observed public dump evidence. */
async function authoredCopy(directory: string, platforms = ['win', 'mac'], title = 'Authored release') {
  const db = join(directory, 'db');
  await mkdir(db, { recursive: true });
  const files: Record<string, [string, string]> = {
    vn: ['id\tolang\tdevstatus\talias', 'v1\tja\t\N\t\N\nv2\tja\t\N\t\N'],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\tja\tt\tAuthored work one\t\N\nv2\tja\tt\tAuthored work two\t\N'],
    entry_meta: ['id\trevision\tlastmod', 'v1\t1\t2026-10-25\nv2\t1\t2026-10-25'],
    releases: ['id\treleased', 'r1\t20200101'],
    releases_titles: ['id\tlang\tmtl\ttitle\tlatin', `r1\tja\tt\t${title}\t\\N`],
    releases_vn: ['id\tvid\trtype', 'r1\tv1\tcomplete\nr1\tv2\tpartial'],
    releases_supersedes: ['id\trid', ''],
    releases_platforms: ['id\tplatform', platforms.map((code) => `r1\t${code}`).join('\n')],
    releases_media: ['id\tmedium\tqty', 'r1\tcd\t2\nr1\tdvd\t1'],
  };
  for (const [table, [header, rows]] of Object.entries(files)) {
    await writeFile(join(db, `${table}.header`), `${header}\n`);
    await writeFile(join(db, table), `${rows}\n`);
  }
  return new CrossMediaDumpFiles(join(directory, 'bangumi'), directory);
}

test('production operator imports release platforms and media through independent review and current reads', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try { return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 }); }
    finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'vndb-release-platforms-native-'));
  try {
    expect((await runtime.request(`/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`, { key: randomUUID(), tier: 'trusted' }, identitySupport(runtime.identity).managementBearer)).status).toBe(200);
    const editor = await openApiObserver(runtime);
    expect((await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'], valid: '(,)',
    })).status).toBe(201);
    const authored = (external_id: string, digest = 'a'.repeat(64)) => ({
      source, external_id, record_revision: 'unversioned', digest, converter_revision: 'authored@1', field_group: 'facts' as const,
    });
    async function create(key: string, type: string, label: string) {
      const result = await runtime.importTransport.batch({ commands: [{
        op: 'create', key, source: authored(key), subject: { type, labels: { en: label } },
      }] });
      expect(result.results[0]?.status).toBe(201);
      return (result.results[0] as { value: { id: string } }).value.id;
    }
    const specs = [
      { taxonomy: vndbReleasePlatformTaxonomy, uri: vndbReleasePlatformSchemeUri, codes: ['win', 'mac'] },
      { taxonomy: vndbReleaseMediumTaxonomy, uri: vndbReleaseMediumSchemeUri, codes: ['cd', 'dvd'] },
    ] as const;
    const groups: VndbReleaseBindingGroup[] = [];
    const claims: { id: string; property: string }[] = [];
    for (const spec of specs) {
      const schemeId = await create(`scheme-${spec.taxonomy}`, 'skos:ConceptScheme', `Authored ${spec.taxonomy}`);
      groups.push({ taxonomy: spec.taxonomy, uri: spec.uri, schemeId, concepts: [] });
      claims.push({ id: schemeId, property: 'schema:url' });
      for (const code of spec.codes) {
        const id = await create(`concept-${code}`, 'skos:Concept', `Authored ${code}`);
        groups.at(-1)!.concepts = [...groups.at(-1)!.concepts, { code, id }];
        claims.push({ id, property: 'schema:url' }, { id, property: 'skos:inScheme' });
      }
    }
    const references = (url: string) => [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: url } }] }];
    const claimsToPropose = specs.flatMap((spec, groupIndex) => {
      const group = groups[groupIndex]!;
      const schemeUrl = {
        op: 'propose' as const, key: `scheme-url-${spec.taxonomy}`, source: authored(spec.taxonomy), subject: group.schemeId,
        statement: { property: { id: 'schema:url' }, value: { type: 'value' as const, content: spec.uri }, references: references(spec.uri) },
      };
      return [schemeUrl, ...group.concepts.flatMap(({ code, id }) => {
        const url = spec.taxonomy === vndbReleasePlatformTaxonomy ? vndbReleasePlatformConceptUri(code) : vndbReleaseMediumConceptUri(code);
        const sourceEnvelope = authored(`concept-${code}`);
        return [
          { op: 'propose' as const, key: `concept-url-${code}`, source: sourceEnvelope, subject: id, statement: { property: { id: 'schema:url' }, value: { type: 'value' as const, content: url }, references: references(url) } },
          { op: 'propose' as const, key: `concept-scheme-${code}`, source: sourceEnvelope, subject: id, statement: { property: { id: 'skos:inScheme' }, value: { type: 'value' as const, content: group.schemeId }, references: references(url) } },
        ];
      })];
    });
    expect((await runtime.importTransport.batch({ commands: claimsToPropose })).results.every((row) => row.status === 201)).toBe(true);
    async function page(subject: string, property: string) {
      const response = await editor.http(`/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`);
      expect(response.status).toBe(200);
      return response.body as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function acceptAdopt(subject: string, property: string) {
      const accepted = new Set<string>();
      for (;;) {
        const listing = await page(subject, property);
        const candidate = listing.candidates.find((item) => item.source && !item.retracted && !accepted.has(item.id));
        if (!candidate) {
          const live = listing.candidates.filter((item) => item.source && !item.retracted);
          expect((await editor.http(`/v1/subjects/${subject}:adopt`, {
            context: globalContext, property, mode: 'replace', expected_head: listing.adoption?.head ?? null,
            selection: live.map((item) => ({ candidate: item.id, rank: item.statement.rank ?? 'normal' })),
          })).status).toBe(200);
          return live;
        }
        expect((await editor.http(`/v1/subjects/${subject}/candidates/${candidate.id}:accept`, {
          context: globalContext, expected_head: candidate.head,
        })).status).toBe(200);
        accepted.add(candidate.id);
      }
    }
    for (const claim of claims) await acceptAdopt(claim.id, claim.property);
    const bindings = await readVndbReleaseBindings(runtime.importTransport, groups);
    expect(bindings.concepts).toHaveLength(4);
    const path = join(directory, 'state.sqlite');
    const run = async (platforms = ['win', 'mac'], title = 'Authored release') => importVndbReleaseFidelity({
      tables: await authoredCopy(directory, platforms, title), path, port: runtime.importTransport,
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] }, bindingGroups: groups,
      destination: { origin: 'https://kernel.import.test' },
    });
    const first = await run();
    const release = first.readings.find((row) => row.externalId === 'r1');
    expect(release).toBeTruthy();
    const releaseId = (release!.subject as { subject?: { id: string } }).subject?.id ?? (release!.subject as { id?: string }).id;
    expect(releaseId).toBeTruthy();
    const platforms = await page(releaseId!, 'schema:gamePlatform');
    const media = await page(releaseId!, 'wdt:P437');
    expect(platforms.candidates.filter((item) => item.source && !item.retracted).map((item) => item.statement.value.content).sort()).toEqual(
      groups[0]!.concepts.map((item) => item.id).sort(),
    );
    expect(media.candidates.filter((item) => item.source && !item.retracted).map((item) => item.statement.value.content).sort()).toEqual(
      groups[1]!.concepts.map((item) => item.id).sort(),
    );
    expect(JSON.stringify([...platforms.candidates, ...media.candidates])).toContain('/releases_platforms/r1/platform');
    expect(JSON.stringify([...platforms.candidates, ...media.candidates])).toContain('/releases_media/r1/medium');
    await acceptAdopt(releaseId!, 'schema:gamePlatform');
    await acceptAdopt(releaseId!, 'wdt:P437');
    await acceptAdopt(releaseId!, 'schema:exampleOfWork');
    const read = async () => {
      const response = await editor.http(`/v1/subjects/${releaseId}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as { subject: { id: string; type: string; statements: Record<string, { value: { content: unknown } }[]> } };
    };
    const current = await read();
    expect(current.subject.type).toBe('wd:Q20631656');
    expect(current.subject.statements['schema:gamePlatform']?.map((item) => item.value.content).sort()).toEqual(groups[0]!.concepts.map((item) => item.id).sort());
    expect(current.subject.statements['wdt:P437']?.map((item) => item.value.content).sort()).toEqual(groups[1]!.concepts.map((item) => item.id).sort());
    expect(current.subject.statements['schema:exampleOfWork']).toHaveLength(2);

    const mac = groups[0]!.concepts.find((item) => item.code === 'mac')!;
    const macUrl = await page(mac.id, 'schema:url');
    expect((await editor.http(`/v1/subjects/${mac.id}:adopt`, {
      context: globalContext, property: 'schema:url', mode: 'replace',
      expected_head: macUrl.adoption?.head ?? null, selection: [],
    })).status).toBe(200);
    const changed = await run(['win', 'mac', 'lin'], 'Authored refreshed release');
    expect(changed.runs.vndb?.counts.changed).toBeGreaterThan(0);
    const currentBindings = await readVndbReleaseBindings(runtime.importTransport, groups);
    expect(currentBindings.concepts.some((item) => item.id === mac.id)).toBe(false);
    const refreshedPlatforms = await page(releaseId!, 'schema:gamePlatform');
    expect(
      refreshedPlatforms.candidates
        .filter((item) => item.source && !item.retracted)
        .map((item) => item.statement.value.content)
        .sort(),
    ).toEqual([groups[0]!.concepts.find((item) => item.code === 'win')!.id]);

    expect((await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.vndb, externalId: 'r1', fieldGroup: 'facts', reason: 'Authored tuple fence',
    })).status).toBe(200);
    await run(['win', 'lin'], 'Fenced authored release');
    const afterFence = await page(releaseId!, 'schema:name');
    expect(afterFence.candidates.some((item) => JSON.stringify(item.statement.value.content).includes('Fenced authored release'))).toBe(false);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
