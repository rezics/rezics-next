import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openProviderCli, type Candidate } from './provider-cli-native-fixture.ts';

const externalId = '990411';
const workUrl = 'https://catalogue.example/anime/CLANNAD?lang=ja#work';
const changedUrl = 'https://catalogue.example/anime/CLANNAD?lang=en#work';
const repairedUrl = 'https://archive.example/series/CLANNAD?copy=1';
const fencedUrl = 'https://catalogue.example/anime/CLANNAD?edition=3';
const notice = '© 2007 Key / Visual Arts. All rights reserved.';
const changedNotice = '© 2008 Key / Visual Arts. All rights reserved.';
const fencedNotice = '© 2009 Key / Visual Arts. All rights reserved.';
const badLink = '[[https://untrusted.example/series|Display title]]';
const subject = (version = 0) => ({
  id: Number(externalId),
  type: 2,
  name: 'CLANNAD',
  infobox: `{{Infobox animanga/TVAnime
|官方网站=https://official.example/clannad
|链接=
* ${version === 0 ? workUrl : version === 1 ? changedUrl : fencedUrl}
|Copyright=${version === 0 ? notice : version === 1 ? changedNotice : fencedNotice}
|链接=${version === 0 ? badLink : repairedUrl}
}}`,
});
const feed = (record: object) => `${JSON.stringify(record)}\n`;
const content = (candidate: Candidate) =>
  candidate.statement.value.type === 'value' ? candidate.statement.value.content : undefined;
const evidenceProperties = ['wdt:P973', 'schema:copyrightNotice'] as const;
type ProviderCli = Awaited<ReturnType<typeof openProviderCli>>;
type CliResult = Awaited<ReturnType<ProviderCli['invoke']>>;

function commands(result: CliResult) {
  return result.writes.flatMap((exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands);
}

function evidenceCommands(commandList: readonly BatchCommand[]) {
  return commandList.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && evidenceProperties.some((property) => property === command.statement.property.id),
  );
}

async function acceptAndAdopt(
  cli: Awaited<ReturnType<typeof openProviderCli>>,
  id: string,
  property: string,
  candidates: Candidate[],
) {
  for (const candidate of candidates) {
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

test('ordinary Bangumi import reviews and adopts cited TVAnime work evidence without gaining content rights', async () => {
  const registration = createSourceRegistration('bangumi');
  const cli = await openProviderCli('bangumi', registration.converter_revision);
  const initialFeed = feed(subject());
  try {
    const first = await cli.invoke(initialFeed);
    expect(first.code, JSON.stringify(first)).toBe(0);
    const claim = await cli.claim(externalId);
    expect(claim).toHaveLength(1);
    const id = claim[0]!.subject_id;
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });

    const links = await cli.candidates(id, 'wdt:P973');
    const notices = await cli.candidates(id, 'schema:copyrightNotice');
    expect(links).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(content(links[0]!)).toBe(workUrl);
    expect(content(notices[0]!)).toBe(notice);
    expect(
      evidenceCommands(commands(first))
        .map((command) => command.statement.property.id)
        .sort(),
    ).toEqual(['schema:copyrightNotice', 'wdt:P973']);
    for (const candidate of [links[0]!, notices[0]!]) {
      expect(candidate.source).toMatchObject({
        source: 'bangumi',
        external_id: externalId,
        record_revision: 'unversioned',
        converter_revision: registration.converter_revision,
      });
      expect(candidate.source.digest).toMatch(/^[a-f0-9]{64}$/u);
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
      expect(candidate.source).not.toHaveProperty('license');
    }
    expect(evidenceCommands(commands(first)).every((command) => !Object.hasOwn(command, 'rights'))).toBe(true);

    const conversion = registration.convert(
      { external_id: externalId, record_revision: null, record: subject() },
      { source: 'bangumi', subjectId: id },
    );
    expect(conversion.sourceMetadata).toEqual({
      recordUrl: `https://bgm.tv/subject/${externalId}`,
      summary: { language: 'und', takedownEligible: true },
      cover: { role: 'cover', creditLine: '(c) rights holder via Bangumi', takedownEligible: true },
    });
    expect(conversion.mediaImportIntents).toEqual([]);
    expect(
      conversion.proposals.some(
        (command) =>
          command.op === 'propose' && ['schema:abstract', 'schema:image'].includes(command.statement.property.id),
      ),
    ).toBe(false);

    await acceptAndAdopt(cli, id, 'wdt:P973', links);
    await acceptAndAdopt(cli, id, 'schema:copyrightNotice', notices);
    const adopted = await cli.runtime.importTransport.readReviewedSubject(id);
    expect(adopted.subject?.type).toBe('schema:TVSeries');
    expect(adopted.subject?.statements['wdt:P973']?.map((item) => item.value.content)).toEqual([workUrl]);
    expect(adopted.subject?.statements['schema:copyrightNotice']?.map((item) => item.value.content)).toEqual([notice]);
    for (const property of evidenceProperties) {
      expect(adopted.subject?.statements[property]?.[0]?.references?.[0]?.parts).toContainEqual({
        property: { id: 'schema:url' },
        value: { type: 'value', content: `https://bgm.tv/subject/${externalId}` },
      });
    }

    const reopened = await cli.invoke(initialFeed);
    expect(reopened.code, JSON.stringify(reopened)).toBe(0);
    expect(reopened.writes).toEqual([]);
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);

    const changed = await cli.invoke(feed(subject(1)));
    expect(changed.code, JSON.stringify(changed)).toBe(0);
    const changedEvidence = evidenceCommands(commands(changed));
    expect(
      changedEvidence
        .map((command) => ({
          property: command.statement.property.id,
          value: command.statement.value.type === 'value' ? command.statement.value.content : null,
        }))
        .sort((left, right) => `${left.property}:${left.value}`.localeCompare(`${right.property}:${right.value}`)),
    ).toEqual([
      { property: 'schema:copyrightNotice', value: changedNotice },
      { property: 'wdt:P973', value: changedUrl },
      { property: 'wdt:P973', value: repairedUrl },
    ]);
    expect(changedEvidence.every((command) => command.source.digest !== links[0]!.source.digest)).toBe(true);
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);

    const fence = await cli.editor.http('/v1/sourceFences:takedown', {
      source: 'bangumi',
      externalId,
      fieldGroup: 'facts',
      reason: 'Bangumi TVAnime work evidence refresh fence',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const fenced = await cli.invoke(feed(subject(2)));
    expect(fenced.code, JSON.stringify(fenced)).toBe(0);
    expect(evidenceCommands(commands(fenced))).toEqual([]);
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);
  } finally {
    await cli.close();
  }
}, 300_000);
