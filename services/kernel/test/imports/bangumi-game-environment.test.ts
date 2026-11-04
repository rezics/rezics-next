import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { createShowcaseBangumiGameEnvironmentLookup } from '../../../importer/src/showcase-bangumi-game-environment.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';

const context = GLOBAL_CONTEXT;
const externalId = '990401';
type Candidate = {
  id: string;
  head: number | null;
  retracted: number | null;
  statement: { value: { content: unknown }; rank?: 'normal' | 'preferred'; references?: unknown[] };
  source?: { source: string; external_id: string } | null;
};

/** Authored Game infobox; not a verified public Bangumi observation. */
function authoredGame() {
  return {
    id: Number(externalId),
    type: 4,
    name: 'CLANNAD',
    name_cn: '中文题名',
    infobox: `{{Infobox Game
|平台= {
[PC]
[PlayStation 4]
}
|游戏引擎=Unity
}}`,
  };
}

test('imported Game platform and engine Concepts are independently adopted, current, and withheld per concealed or wrong-source binding', async () => {
  const previous = process.env.TMPDIR;
  let runtime: ApiRuntime | undefined;
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-environment-native-'));
  try {
    process.env.TMPDIR = tmpdir();
    runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    const tierKey = randomUUID();
    expect(
      (
        await runtime.request(
          `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
          { key: tierKey, tier: 'trusted' },
          identitySupport(runtime.identity).managementBearer,
          tierKey,
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
    const authored = (external_id: string) => ({
      source: 'bangumi',
      external_id,
      record_revision: 'unversioned',
      digest: 'a'.repeat(64),
      converter_revision,
      field_group: 'facts' as const,
    });
    async function create(key: string, type: string, label: string) {
      const result = await runtime!.importTransport.batch({
        commands: [{ op: 'create', key, source: authored(key), subject: { type, labels: { en: label } } }],
      });
      expect(result.results[0]?.status).toBe(201);
      return (result.results[0] as { value: { id: string } }).value.id;
    }
    const specs = [
      { item: 'PC', kind: 'platform' as const, url: 'https://bgm.tv/info/platform/PC' },
      { item: 'PlayStation 4', kind: 'platform' as const, url: 'https://bgm.tv/info/platform/PS4' },
      { item: 'Unity', kind: 'engine' as const, url: 'https://bgm.tv/info/engine/Unity' },
    ];
    const concepts = [];
    for (const spec of specs) {
      const id = await create(`concept-${spec.item}`, 'skos:Concept', spec.item);
      concepts.push({ ...spec, id });
    }
    const references = (url: string) => [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: url } }] },
    ];
    expect(
      (
        await runtime.importTransport.batch({
          commands: concepts.map((row) => ({
            op: 'propose' as const,
            key: `url-${row.item}`,
            source: authored(`concept-${row.item}`),
            subject: row.id,
            statement: {
              property: { id: 'schema:url' },
              value: { type: 'value' as const, content: row.url },
              references: references(row.url),
            },
          })),
        })
      ).results.every((row) => row.status === 201),
    ).toBe(true);
    async function page(subject: string, property: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
      );
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
          expect(
            (
              await editor.http(`/v1/subjects/${subject}:adopt`, {
                context,
                property,
                mode: 'replace',
                expected_head: listing.adoption?.head ?? null,
                selection: live.map((item) => ({ candidate: item.id, rank: item.statement.rank ?? 'normal' })),
              })
            ).status,
          ).toBe(200);
          return live;
        }
        expect(
          (
            await editor.http(`/v1/subjects/${subject}/candidates/${candidate.id}:accept`, {
              context,
              expected_head: candidate.head,
            })
          ).status,
        ).toBe(200);
        accepted.add(candidate.id);
      }
    }
    for (const row of concepts) await acceptAdopt(row.id, 'schema:url');
    const lookup = createShowcaseBangumiGameEnvironmentLookup({
      sourceAlias: 'bangumi',
      bindings: concepts.map((row) => ({ kind: row.kind, item: row.item, conceptId: row.id, sourceUri: row.url })),
      read: (id) => runtime!.importTransport.readReviewedSubject(id),
    });
    const importer = new Importer({
      path: join(directory, 'state.sqlite'),
      destination: { origin: 'https://kernel.import.test' },
      identifierLookup: lookup,
      transport: {
        batchWrite: (body) => runtime!.importTransport.batch(body),
        setSourceRecordMetadata: (input, signal) => runtime!.importTransport.setSourceRecordMetadata(input, signal),
        readFence: (tuple) =>
          runtime!.importTransport.fence({
            source: tuple.source,
            externalId: tuple.external_id,
            fieldGroup: tuple.field_group,
          }),
      },
    });
    async function* dump() {
      yield new TextEncoder().encode(`${JSON.stringify(authoredGame())}\n`);
    }
    expect(converter_revision).toBe('bangumi@10');
    expect((await importer.runDump(createSourceRegistration('bangumi'), dump())).status).toBe('committed');
    const claim = importer.session.bindings.claim({ source: 'bangumi', external_id: externalId });
    expect(claim?.state).toBe('bound');
    const workId = claim?.state === 'bound' ? claim.subject : undefined;
    expect(workId).toBeTruthy();
    const platformPage = await page(workId!, 'schema:gamePlatform');
    const enginePage = await page(workId!, 'wdt:P408');
    expect(
      platformPage.candidates
        .filter((item) => item.source && !item.retracted)
        .map((item) => item.statement.value.content)
        .sort(),
    ).toEqual([concepts[0]!.id, concepts[1]!.id].sort());
    expect(
      enginePage.candidates.filter((item) => item.source && !item.retracted).map((item) => item.statement.value.content),
    ).toEqual([concepts[2]!.id]);
    expect(JSON.stringify([...platformPage.candidates, ...enginePage.candidates])).toContain('/infobox/');
    await acceptAdopt(workId!, 'schema:gamePlatform');
    await acceptAdopt(workId!, 'wdt:P408');
    const current = await editor.http(`/v1/subjects/${workId}?context=${context}`);
    expect(current.status).toBe(200);
    const statements = (
      current.body as { subject: { type: string; statements: Record<string, { value: { content: unknown } }[]> } }
    ).subject;
    expect(statements.type).toBe('schema:VideoGame');
    expect(statements.statements['schema:gamePlatform']?.map((item) => item.value.content).sort()).toEqual(
      [concepts[0]!.id, concepts[1]!.id].sort(),
    );
    expect(statements.statements['wdt:P408']?.map((item) => item.value.content)).toEqual([concepts[2]!.id]);

    const pcUrl = await page(concepts[0]!.id, 'schema:url');
    expect(
      (
        await editor.http(`/v1/subjects/${concepts[0]!.id}:adopt`, {
          context,
          property: 'schema:url',
          mode: 'replace',
          expected_head: pcUrl.adoption?.head ?? null,
          selection: [],
        })
      ).status,
    ).toBe(200);
    expect((await importer.runDump(createSourceRegistration('bangumi'), dump())).status).toBe('committed');
    const refreshed = await page(workId!, 'schema:gamePlatform');
    expect(
      refreshed.candidates
        .filter((item) => item.source && !item.retracted)
        .map((item) => item.statement.value.content)
        .sort(),
    ).toEqual([concepts[1]!.id]);
    expect(importer.session.bindings.claim({ source: 'bangumi', external_id: externalId })).toMatchObject({
      state: 'bound',
      subject: workId,
    });
    await importer.close();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
