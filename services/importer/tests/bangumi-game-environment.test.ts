import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/bangumi';
import { emptyCrossMediaPlan, seedCrossMedia, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import {
  bangumiGameEnvironmentReferenceKey,
  createShowcaseBangumiGameEnvironmentLookup,
} from '../src/showcase-bangumi-game-environment.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { Importer } from '../src/importer.ts';

const targetId = 990401;
/** Authored Game infobox; not an observation of a public Bangumi record. */
const authoredInfobox = `{{Infobox Game
|中文名=中文题名
|平台= {
[PC]
[PlayStation 4]
}
|游戏引擎=Unity
|游戏类型=AVG
}}`;
const target = () => ({
  id: targetId,
  type: 4,
  name: 'CLANNAD',
  name_cn: '中文题名',
  platform: '4001',
  infobox: authoredInfobox,
});

function selectedPlan() {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({ source: 'bangumi', key: String(targetId), revision: null, payload: target() });
  plan.members.push({
    source: 'bangumi',
    key: String(targetId),
    kind: 'work',
    membership: 'family',
    franchise: 'clannad',
  });
  return plan;
}

function environmentCommands(commands: readonly BatchCommand[]) {
  return commands.filter(
    (command) =>
      command.op === 'propose' &&
      command.source.external_id === String(targetId) &&
      ['schema:gamePlatform', 'wdt:P408'].includes(command.statement.property.id),
  );
}

function proposedValue(command: BatchCommand) {
  return command.op === 'propose' && command.statement.value.type === 'value'
    ? command.statement.value.content
    : undefined;
}

test('selected authored Game proposes reviewed platform and engine Concepts and withholds only concealed or wrong-source items', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bangumi-game-environment-state-'));
  const pc = randomUUID();
  const playstation = randomUUID();
  const unity = randomUUID();
  const known = new Map<string, object>([
    [
      pc,
      {
        subject: {
          id: pc,
          type: 'skos:Concept',
          statements: { 'schema:url': [{ value: { content: 'https://bgm.tv/info/platform/PC' } }] },
        },
      },
    ],
    [
      playstation,
      {
        subject: {
          id: playstation,
          type: 'skos:Concept',
          statements: { 'schema:url': [{ value: { content: 'https://bgm.tv/info/platform/PS4' } }] },
        },
      },
    ],
    [
      unity,
      {
        subject: {
          id: unity,
          type: 'skos:Concept',
          statements: { 'schema:url': [{ value: { content: 'https://bgm.tv/info/engine/Unity' } }] },
        },
      },
    ],
  ]);
  const sent: BatchCommand[] = [];
  const identities = new Map<string, string>();
  const metadata = sourceRecordMetadataFixture();
  const port: CrossMediaPort = {
    async batch(request) {
      sent.push(...structuredClone(request.commands));
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? (() => {
                  const id = identities.get(command.source.external_id) ?? randomUUID();
                  identities.set(command.source.external_id, id);
                  return { id, revision: 1 };
                })()
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
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return (known.get(id) ?? { subject: { id } }) as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
  const bindings = [
    { kind: 'platform' as const, item: 'PC', conceptId: pc, sourceUri: 'https://bgm.tv/info/platform/PC' },
    {
      kind: 'platform' as const,
      item: 'PlayStation 4',
      conceptId: playstation,
      sourceUri: 'https://bgm.tv/info/platform/PS4',
    },
    { kind: 'engine' as const, item: 'Unity', conceptId: unity, sourceUri: 'https://bgm.tv/info/engine/Unity' },
  ];
  try {
    expect(converter_revision).toBe('bangumi@11');
    const selected = selectedPlan();
    expect(selected.records.bangumi.map((row) => row.key)).toContain(String(targetId));
    const first = await seedCrossMedia(selected, join(stateDir, 'state.sqlite'), port, undefined, {
      providers: ['bangumi'],
      mediaDeadlineMs: 0,
      bangumiGameEnvironment: { bindings },
    });
    expect(first.runs.bangumi?.status).toBe('committed');
    const firstId = identities.get(String(targetId));
    expect(firstId).toBeTruthy();
    const proposed = environmentCommands(sent);
    expect(
      proposed.map((command) =>
        command.op === 'propose' ? [command.statement.property.id, proposedValue(command)] : [],
      ),
    ).toEqual([
      ['schema:gamePlatform', pc],
      ['schema:gamePlatform', playstation],
      ['wdt:P408', unity],
    ]);
    expect(JSON.stringify(proposed)).toContain(`https://bgm.tv/subject/${targetId}#`);
    expect(JSON.stringify(proposed)).toMatch(/\/infobox\//);
    expect(JSON.stringify(proposed)).toMatch(/平台|%E5%B9%B3%E5%8F%B0/);
    expect(JSON.stringify(proposed)).toMatch(/游戏引擎|%E6%B8%B8%E6%88%8F%E5%BC%95%E6%93%8E/);
    expect(proposed.every((command) => command.op === 'propose' && command.subject === firstId)).toBe(true);

    const ordinary = createSourceRegistration('bangumi').convert(
      { external_id: String(targetId), record_revision: null, record: target() },
      {
        source: 'bangumi',
        subjectId: firstId!,
        resolvedReferences: {
          [bangumiGameEnvironmentReferenceKey('schema:gamePlatform', 'PC')]: pc,
          [bangumiGameEnvironmentReferenceKey('schema:gamePlatform', 'PlayStation 4')]: playstation,
          [bangumiGameEnvironmentReferenceKey('wdt:P408', 'Unity')]: unity,
        },
      },
    );
    expect(ordinary.converter_revision).toBe('bangumi@11');
    expect(ordinary.diagnostics).toContainEqual({ pointer: '/platform', code: 'catalogue_has_no_platform_property' });
    expect(ordinary.diagnostics).toContainEqual({ pointer: '/infobox/游戏类型', code: 'unsupported_infobox_mapping' });

    known.set(pc, {
      subject: {
        id: pc,
        type: 'skos:Concept',
        statements: { 'schema:url': [{ value: { content: 'https://vndb.org/releases/platforms/win' } }] },
      },
    });
    known.delete(playstation);
    const before = sent.length;
    const withheld = await seedCrossMedia(selected, join(stateDir, 'state.sqlite'), port, undefined, {
      providers: ['bangumi'],
      mediaDeadlineMs: 0,
      bangumiGameEnvironment: { bindings },
    });
    expect(withheld.runs.bangumi?.status).toBe('committed');
    expect(identities.get(String(targetId))).toBe(firstId);
    const later = sent.slice(before);
    expect(environmentCommands(later)).toEqual([]);
    const retracted = later.filter((command) => command.op === 'retract' && command.source.field_group === 'facts');
    expect(retracted).toHaveLength(2);
    expect(JSON.stringify(retracted)).toMatch(/平台|%E5%B9%B3%E5%8F%B0/);
    expect(JSON.stringify(retracted)).not.toMatch(/游戏引擎|%E6%B8%B8%E6%88%8F%E5%BC%95%E6%93%8E/);
    const lookup = createShowcaseBangumiGameEnvironmentLookup({
      sourceAlias: 'bangumi',
      bindings,
      read: async (id) => (known.get(id) ?? null) as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>> | null,
    });
    const importer = new Importer({
      path: join(stateDir, 'ordinary.sqlite'),
      transport: {
        batchWrite: (request) => port.batch(request),
        setSourceRecordMetadata: metadata.setSourceRecordMetadata,
        async readFence() {
          return { fenced: false, securityRevision: null };
        },
      },
      identifierLookup: lookup,
    });
    try {
      const dump = `${JSON.stringify(target())}\n`;
      async function* bytes() {
        yield new TextEncoder().encode(dump);
      }
      expect((await importer.runDump(createSourceRegistration('bangumi'), bytes())).status).toBe('committed');
    } finally {
      await importer.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);
