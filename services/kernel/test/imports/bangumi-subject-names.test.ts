import { expect, test } from 'bun:test';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openProviderCli, type Candidate } from './provider-cli-native-fixture.ts';

const externalId = '990311';
const subject = (sourceAlias?: string, repaired = false) => ({
  id: Number(externalId),
  type: 2,
  name: 'CLANNAD',
  name_cn: '中文题名',
  infobox: `{{Infobox animanga/TVAnime
|中文名=中文题名
|别名=${repaired ? 'Recovered scalar' : 'Mixed scalar alias'}
${repaired ? '' : '* Mixed list alias\n'}|别名=
* クラナド
* Alternate title
${sourceAlias ? `* ${sourceAlias}\n` : ''}}}`,
});
const feed = (record: object) => `${JSON.stringify(record)}\n`;
const content = (candidate: Candidate) =>
  candidate.statement.value.type === 'value' ? candidate.statement.value.content : undefined;

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

test('ordinary Bangumi CLI proposes, adopts, reopens and facts-fences TVAnime names on the acknowledged subject', async () => {
  const registration = createSourceRegistration('bangumi');
  const cli = await openProviderCli('bangumi', registration.converter_revision);
  const initialFeed = feed(subject());
  try {
    const first = await cli.invoke(initialFeed);
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
      converter_revision: registration.converter_revision,
      state: 'present',
    });
    const commands = first.writes.flatMap(
      (exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands,
    );
    const bootstrap = commands.find((command) => command.op === 'create' && command.source.external_id === externalId)!;
    const acknowledgement = first.writes
      .flatMap((exchange) => (JSON.parse(exchange.responseBytes) as BatchWriteResult).results)
      .find((result) => result.key === bootstrap.key);
    expect(acknowledgement).toMatchObject({ value: { id } });

    const names = await cli.candidates(id, 'schema:name');
    const aliases = await cli.candidates(id, 'schema:alternateName');
    const chinese = names.find(
      (candidate) => JSON.stringify(content(candidate)) === JSON.stringify({ language: 'zh', text: '中文题名' }),
    )!;
    const alternate = aliases.find(
      (candidate) => JSON.stringify(content(candidate)) === JSON.stringify({ language: 'und', text: 'クラナド' }),
    )!;
    expect(names).toHaveLength(2);
    expect(aliases).toHaveLength(2);
    expect(
      aliases.some((candidate) =>
        ['Mixed scalar alias', 'Mixed list alias'].includes((content(candidate) as { text?: string })?.text ?? ''),
      ),
    ).toBe(false);
    for (const candidate of [...names, ...aliases]) {
      expect(candidate.source).toMatchObject({
        source: 'bangumi',
        external_id: externalId,
        record_revision: 'unversioned',
        converter_revision: registration.converter_revision,
      });
      expect(candidate.source.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.statement.references).toContainEqual(
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ value: { type: 'value', content: `https://bgm.tv/subject/${externalId}` } }),
          ]),
        }),
      );
    }

    const grant = await cli.editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: cli.runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await acceptAndAdopt(cli, id, 'schema:name', [chinese]);
    await acceptAndAdopt(cli, id, 'schema:alternateName', [alternate]);
    const adopted = await cli.runtime.importTransport.readReviewedSubject(id);
    expect(adopted.subject?.statements['schema:name']?.map((item) => item.value.content)).toContainEqual({
      language: 'zh',
      text: '中文题名',
    });
    expect(adopted.subject?.statements['schema:alternateName']?.map((item) => item.value.content)).toContainEqual({
      language: 'und',
      text: 'クラナド',
    });

    const reopened = await cli.invoke(initialFeed);
    expect(reopened.code).toBe(0);
    expect(reopened.writes).toEqual([]);
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(adopted);

    const recovered = await cli.invoke(feed(subject('New source alias', true)));
    expect(recovered.code, JSON.stringify(recovered)).toBe(0);
    expect(cli.inspect([externalId]).records[0]!.claim).toEqual({ state: 'bound', subject: id });
    const refreshedAliases = await cli.candidates(id, 'schema:alternateName');
    const recoveredScalar = refreshedAliases.find(
      (candidate) => (content(candidate) as { text?: string })?.text === 'Recovered scalar',
    )!;
    const recoveredSourceAlias = refreshedAliases.find(
      (candidate) => (content(candidate) as { text?: string })?.text === 'New source alias',
    )!;
    await acceptAndAdopt(
      cli,
      id,
      'schema:alternateName',
      [alternate, recoveredScalar, recoveredSourceAlias],
      [alternate],
    );
    const recoveredAdopted = await cli.runtime.importTransport.readReviewedSubject(id);
    expect(recoveredAdopted.subject?.statements['schema:alternateName']?.map((item) => item.value.content)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'クラナド' },
        { language: 'und', text: 'Recovered scalar' },
        { language: 'und', text: 'New source alias' },
      ]),
    );

    const fence = await cli.editor.http('/v1/sourceFences:takedown', {
      source: 'bangumi',
      externalId,
      fieldGroup: 'facts',
      reason: 'Bangumi TVAnime facts refresh fence',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const fenced = await cli.invoke(feed(subject('Fenced source alias', true)));
    expect(fenced.code, JSON.stringify(fenced)).toBe(0);
    expect(cli.inspect([externalId]).records[0]!.baseline!.digest).not.toBe(before.records[0]!.baseline!.digest);
    expect(
      (await cli.candidates(id, 'schema:alternateName')).some(
        (candidate) => (content(candidate) as { text?: string })?.text === 'Fenced source alias',
      ),
    ).toBe(false);
    expect(await cli.runtime.importTransport.readReviewedSubject(id)).toEqual(recoveredAdopted);
  } finally {
    await cli.close();
  }
}, 300_000);
