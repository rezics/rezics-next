import { expect, test } from 'bun:test';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openProviderCli, type Candidate } from './provider-cli-native-fixture.ts';

const externalId = '990411';
const sourceUrl = `https://bgm.tv/subject/${externalId}`;
const firstUrl = 'https://anime.example.jp/official/?from=bgm#staff';
const secondUrl = 'https://anime.example.jp/en?lang=ja#official';
const changedUrl = 'https://anime.example.jp/official/v2?lang=ja#staff';
const fencedUrl = 'https://anime.example.jp/official/v3?lang=ja#staff';
const subject = (website = firstUrl) => ({
  id: Number(externalId),
  type: 2,
  name: 'CLANNAD',
  infobox: `{{Infobox animanga/TVAnime
|官方网站=${website}
|官方网站=${secondUrl}
}}`,
});
const feed = (record: object) => `${JSON.stringify(record)}\n`;
const value = (candidate: Candidate) =>
  candidate.statement.value.type === 'value' ? candidate.statement.value.content : undefined;
type PublicView = {
  subject: {
    type: string;
    statements: Record<string, { value: { content: unknown }; references?: Candidate['statement']['references'] }[]>;
  };
};

test('ordinary Bangumi imports review and adopt an exact TVAnime website on its acknowledged TVSeries', async () => {
  const registration = createSourceRegistration('bangumi');
  const cli = await openProviderCli('bangumi', registration.converter_revision);
  const initialFeed = feed(subject());
  try {
    const first = await cli.invoke(initialFeed);
    expect(first.code, JSON.stringify(first)).toBe(0);
    const claim = await cli.claim(externalId);
    expect(claim).toHaveLength(1);
    const id = claim[0]!.subject_id;
    const commands = first.writes.flatMap(
      (exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands,
    );
    const bootstrap = commands.find((command) => command.op === 'create' && command.source.external_id === externalId)!;
    const acknowledgement = first.writes
      .flatMap((exchange) => (JSON.parse(exchange.responseBytes) as BatchWriteResult).results)
      .find((result) => result.key === bootstrap.key);
    expect(bootstrap.op === 'create' && bootstrap.subject.type).toBe('schema:TVSeries');
    expect(acknowledgement).toMatchObject({ value: { id } });

    const candidates = await cli.candidates(id, 'schema:url');
    const selected = candidates.find((candidate) => value(candidate) === firstUrl)!;
    expect(candidates.map(value).sort()).toEqual([firstUrl, secondUrl].sort());
    expect(selected.source).toMatchObject({
      source: 'bangumi',
      external_id: externalId,
      record_revision: 'unversioned',
      converter_revision: 'bangumi@12',
    });
    expect(selected.statement.references).toEqual([
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }] },
    ]);
    expect(value(selected)).not.toBe(sourceUrl);
    await cli.select(id, selected);

    const publicRead = (await cli.anonymous(id)) as unknown as PublicView;
    expect(publicRead.subject.type).toBe('schema:TVSeries');
    expect(publicRead.subject.statements['schema:url']?.map((statement) => statement.value.content)).toEqual([
      firstUrl,
    ]);
    expect(publicRead.subject.statements['schema:url']?.[0]?.references).toEqual(selected.statement.references);
    const beforeDigest = cli.inspect([externalId]).records[0]!.baseline!.digest;

    const reopened = await cli.invoke(initialFeed);
    expect(reopened.code).toBe(0);
    expect(reopened.writes).toEqual([]);
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });
    expect(
      ((await cli.anonymous(id)) as unknown as PublicView).subject.statements['schema:url']?.[0]?.value.content,
    ).toBe(firstUrl);

    const changed = await cli.invoke(feed(subject(changedUrl)));
    expect(changed.code, JSON.stringify(changed)).toBe(0);
    const afterDigest = cli.inspect([externalId]).records[0]!.baseline!.digest;
    expect(afterDigest).not.toBe(beforeDigest);
    const changedCommands = changed.writes.flatMap(
      (exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands,
    );
    expect(
      changedCommands.some((command) => command.op === 'create' && command.source.external_id === externalId),
    ).toBe(false);
    expect((await cli.candidates(id, 'schema:url')).map(value)).toContain(changedUrl);
    const beforeFence = (await cli.anonymous(id)) as unknown as PublicView;
    expect(beforeFence.subject.statements['schema:url']?.map((item) => item.value.content)).toEqual([firstUrl]);

    const fence = await cli.editor.http('/v1/sourceFences:takedown', {
      source: 'bangumi',
      externalId,
      fieldGroup: 'facts',
      reason: 'TVAnime official website source refresh fence',
    });
    expect(fence.status).toBe(200);
    const fenced = await cli.invoke(feed(subject(fencedUrl)));
    expect(fenced.code, JSON.stringify(fenced)).toBe(0);
    expect((await cli.candidates(id, 'schema:url')).map(value)).not.toContain(fencedUrl);
    const afterFence = (await cli.anonymous(id)) as unknown as PublicView;
    expect(afterFence.subject.statements['schema:url']?.map((item) => item.value.content)).toEqual([firstUrl]);
  } finally {
    await cli.close();
  }
}, 300_000);
