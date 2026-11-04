import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openProviderCli, type Candidate } from './provider-cli-native-fixture.ts';

const externalId = '990321';
const fixturePath = resolve(import.meta.dir, '../../../importer/tests/fixtures/bangumi-game-names.jsonl');
const feed = (record: object) => `${JSON.stringify(record)}\n`;
const content = (candidate: Candidate) =>
  candidate.statement.value.type === 'value' ? candidate.statement.value.content : undefined;

async function game(alias: string): Promise<Record<string, unknown>> {
  const rows = (await readFile(fixturePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const record = rows.find((row) => row.id === Number(externalId));
  if (!record || typeof record.infobox !== 'string') throw new Error('Missing game fixture');
  record.infobox = record.infobox.replace('|别名=星海之旅', `|别名=${alias}`);
  return record;
}

async function acceptAndAdopt(
  cli: Awaited<ReturnType<typeof openProviderCli>>,
  id: string,
  property: string,
  candidates: Candidate[],
  alreadyAccepted: readonly Candidate[] = [],
) {
  const alreadyAcceptedIds = new Set(alreadyAccepted.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    if (alreadyAcceptedIds.has(candidate.id)) continue;
    const accepted = await cli.editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: candidate.head,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }
  const adopted = await cli.editor.http(`/v1/subjects/${id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property,
    mode: 'replace',
    expected_head: null,
    selection: candidates.map((candidate) => ({
      candidate: candidate.id,
      rank: candidate.statement.rank ?? 'normal',
    })),
  });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
}

test('ordinary Bangumi import proposes, adopts and refreshes Game names on the acknowledged VideoGame', async () => {
  const registration = createSourceRegistration('bangumi');
  expect(registration.converter_revision).toBe(bangumiRevision);
  const cli = await openProviderCli('bangumi', registration.converter_revision);
  const initial = await game('星海之旅');
  try {
    const first = await cli.invoke(feed(initial));
    expect(first.code, JSON.stringify(first)).toBe(0);
    const before = cli.inspect([externalId]);
    const claim = await cli.claim(externalId);
    expect(claim).toHaveLength(1);
    const id = claim[0]!.subject_id;
    expect(before.records[0]!.claim).toEqual({ state: 'bound', subject: id });
    expect(before.records[0]!.baseline).toMatchObject({
      source: 'bangumi',
      recordKey: externalId,
      recordRevision: 'unversioned',
      converter_revision: bangumiRevision,
      state: 'present',
    });
    const commands = first.writes.flatMap(
      (exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands,
    );
    const bootstrap = commands.find((command) => command.op === 'create' && command.source.external_id === externalId)!;
    expect(bootstrap).toMatchObject({
      op: 'create',
      subject: { type: 'schema:VideoGame', labels: { und: 'CLANNAD', zh: '古典中文题名' } },
    });
    const acknowledgement = first.writes
      .flatMap((exchange) => (JSON.parse(exchange.responseBytes) as BatchWriteResult).results)
      .find((result) => result.key === bootstrap.key);
    expect(acknowledgement).toMatchObject({ value: { id } });

    const names = await cli.candidates(id, 'schema:name');
    const aliases = await cli.candidates(id, 'schema:alternateName');
    expect(names).toHaveLength(3);
    expect(names.map(content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'CLANNAD' },
        { language: 'zh', text: '古典中文题名' },
        { language: 'zh', text: 'CLANNAD 中文名' },
      ]),
    );
    expect(aliases).toHaveLength(3);
    expect(aliases.map(content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: '星海之旅' },
        { language: 'und', text: 'クラナド' },
        { language: 'und', text: 'Moon Path' },
      ]),
    );
    expect(aliases.some((candidate) => (content(candidate) as { text?: string })?.text === '不予采纳')).toBe(false);
    for (const candidate of [...names, ...aliases]) {
      expect(candidate.source).toMatchObject({
        source: 'bangumi',
        external_id: externalId,
        record_revision: 'unversioned',
        converter_revision: bangumiRevision,
      });
      expect(candidate.source.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.statement.references).toEqual([
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: `https://bgm.tv/subject/${externalId}` },
            },
          ],
        },
      ]);
    }
    const beforeReview = await cli.runtime.importTransport.readReviewedSubject(id);
    expect(beforeReview.subject?.statements['schema:alternateName']).toBeUndefined();

    const grant = await cli.editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: cli.runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await acceptAndAdopt(cli, id, 'schema:name', names);
    await acceptAndAdopt(cli, id, 'schema:alternateName', aliases);
    const adopted = await cli.runtime.importTransport.readReviewedSubject(id);
    expect(adopted.subject?.statements['schema:name']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'CLANNAD' },
        { language: 'zh', text: '古典中文题名' },
        { language: 'zh', text: 'CLANNAD 中文名' },
      ]),
    );
    expect(adopted.subject?.statements['schema:alternateName']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: '星海之旅' },
        { language: 'und', text: 'クラナド' },
        { language: 'und', text: 'Moon Path' },
      ]),
    );
    expect(adopted.subject?.statements['schema:inLanguage']).toBeUndefined();

    const reopened = await cli.invoke(feed(initial));
    expect(reopened.code).toBe(0);
    expect(reopened.writes).toEqual([]);
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);

    const changed = await cli.invoke(feed(await game('新星海之旅')));
    expect(changed.code, JSON.stringify(changed)).toBe(0);
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });
    const refreshedAliases = await cli.candidates(id, 'schema:alternateName');
    const updated = refreshedAliases.find(
      (candidate) => (content(candidate) as { text?: string })?.text === '新星海之旅',
    )!;
    expect(updated.source.digest).not.toBe(aliases[0]!.source.digest);
    expect(aliases.every((candidate) => candidate.id !== updated.id)).toBe(true);
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);

    const fence = await cli.editor.http('/v1/sourceFences:takedown', {
      source: 'bangumi',
      externalId,
      fieldGroup: 'facts',
      reason: 'Bangumi Game names refresh fence',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const fenced = await cli.invoke(feed(await game('Fenced Game alias')));
    expect(fenced.code, JSON.stringify(fenced)).toBe(0);
    expect(cli.inspect([externalId]).records[0]!.baseline!.digest).not.toBe(before.records[0]!.baseline!.digest);
    expect(
      (await cli.candidates(id, 'schema:alternateName')).some(
        (candidate) => (content(candidate) as { text?: string })?.text === 'Fenced Game alias',
      ),
    ).toBe(false);
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);
  } finally {
    await cli.close();
  }
}, 300_000);
