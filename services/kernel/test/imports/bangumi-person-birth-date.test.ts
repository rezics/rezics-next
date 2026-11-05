import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/cross-media-entities.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { openProviderCli, type Candidate } from './provider-cli-native-fixture.ts';

const pinned = JSON.parse(
  readFileSync(new URL('../../../../specs/fixtures/imports/bangumi/person-birth-date.json', import.meta.url), 'utf8'),
) as {
  id: number;
  type: number;
  name: string;
  birth_year: number;
  birth_mon: number;
  birth_day: number;
  personURL: string;
};
const gregorian = {
  time: '+1974-11-08T00:00:00Z',
  precision: 11,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
};
const person = (overrides: Record<string, unknown> = {}) => ({
  id: pinned.id,
  type: pinned.type,
  name: pinned.name,
  career: ['mangaka'],
  birth_year: pinned.birth_year,
  birth_mon: pinned.birth_mon,
  birth_day: pinned.birth_day,
  ...overrides,
});
const feed = (record: object) => `${JSON.stringify(record)}\n`;
const value = (candidate: Candidate) =>
  candidate.statement.value.type === 'value' ? candidate.statement.value.content : undefined;

test('ordinary Bangumi person JSON is selected and read independently of a later date candidate', async () => {
  const registration = createSourceRegistration('bangumi');
  const cli = await openProviderCli('bangumi', registration.converter_revision);
  const initial = feed(person());
  try {
    const first = await cli.invoke(initial);
    expect(first.code, JSON.stringify(first)).toBe(0);
    const claim = await cli.claim('person:641');
    expect(claim).toHaveLength(1);
    const id = claim[0]!.subject_id;
    const commands = first.writes.flatMap(
      (exchange) => (JSON.parse(exchange.bytes!) as { commands: BatchCommand[] }).commands,
    );
    const birth = commands.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
    );
    expect(birth?.source.converter_revision).toBe(converter_revision);
    expect(birth?.op === 'propose' ? birth.statement.value : undefined).toEqual({
      type: 'value',
      content: gregorian,
    });
    expect(birth?.op === 'propose' ? birth.statement.references : undefined).toEqual([
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: pinned.personURL } }] },
    ]);

    const candidates = await cli.candidates(id, 'schema:birthDate');
    expect(candidates.map(value)).toEqual([gregorian]);
    await cli.select(id, candidates[0]!);
    const birthExchange = first.writes.find((exchange) => {
      const body = JSON.parse(exchange.bytes!) as { commands: BatchCommand[] };
      return body.commands.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
      );
    })!;
    const replay = await cli.runtime.replay(
      new Request(birthExchange.url, {
        method: birthExchange.method,
        headers: {
          authorization: birthExchange.headers.get('authorization')!,
          'content-type': 'application/json',
        },
        body: birthExchange.bytes,
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(birthExchange.responseBytes);
    const publicRead = await cli.anonymous(id);
    expect(publicRead.subject.type).toBe('schema:Person');
    expect(
      (publicRead.subject.statements as Record<string, { value: { content: unknown } }[]>)['schema:birthDate']?.[0]
        ?.value.content,
    ).toEqual(gregorian);

    const reopened = await cli.invoke(initial);
    expect(reopened.code).toBe(0);
    expect(reopened.writes).toEqual([]);
    expect(
      ((await cli.anonymous(id)).subject.statements as Record<string, { value: { content: unknown } }[]>)[
        'schema:birthDate'
      ]?.[0]?.value.content,
    ).toEqual(gregorian);

    const changed = await cli.invoke(feed(person({ birth_day: 9 })));
    expect(changed.code, JSON.stringify(changed)).toBe(0);
    expect((await cli.candidates(id, 'schema:birthDate')).map(value)).toContainEqual({
      ...gregorian,
      time: '+1974-11-09T00:00:00Z',
    });
    expect(
      ((await cli.anonymous(id)).subject.statements as Record<string, { value: { content: unknown } }[]>)[
        'schema:birthDate'
      ]?.[0]?.value.content,
    ).toEqual(gregorian);

    const organization = await cli.invoke(
      `${feed(person({ birth_day: 9 }))}${feed({
        id: 8102,
        type: 2,
        name: '制作室',
        career: ['producer'],
        birth_year: 1999,
        birth_mon: 1,
        birth_day: 1,
      })}`,
    );
    expect(organization.code, JSON.stringify(organization)).toBe(0);
    const organizationId = (await cli.claim('person:8102'))[0]?.subject_id;
    expect(organizationId).toBeDefined();
    expect(await cli.candidates(organizationId!, 'schema:birthDate')).toEqual([]);
  } finally {
    await cli.close();
  }
}, 300_000);
