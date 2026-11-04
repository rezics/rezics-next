import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import type { Dump } from '../../../../specs/imports-api-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const context = GLOBAL_CONTEXT;
const gregorian = 'http://www.wikidata.org/entity/Q1985727';
type Candidate = {
  id: string;
  head: number | null;
  statement: {
    value: { content: unknown };
    rank?: 'normal' | 'preferred';
    references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
  };
  source?: unknown;
};

function infobox(total: string) {
  return `{{Infobox animanga/TVAnime\n|话数=${total}\n|放送开始=2024年4月7日\n|播放结束=2024年6月23日\n}}`;
}

function dump(total = '12'): Dump {
  const rows = [
    {
      id: 91001,
      type: 2,
      name: 'Clockwork Observatory',
      name_cn: '发条天文台',
      infobox: infobox(total),
      date: '2024-04-07',
    },
    {
      id: 91002,
      type: 2,
      name: 'Ongoing Series',
      infobox: '{{Infobox animanga/TVAnime\n|话数=*\n|放送开始=2024年4月\n|放送星期=星期五\n|自制字段=slot\n}}',
      date: '2024-04',
    },
  ];
  return {
    source: 'bangumi',
    snapshot: 'authored-television-run',
    converterRevision: converter_revision,
    bytes: new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
  };
}

test('imported TVAnime original run and episode count are independently adopted, current, cited, fenced and idempotent after reopen', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  try {
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
    expect((await runtime.run(dump())).outcome).toBe('complete');
    const workId = editor.subject('bangumi', '91001');
    const otherId = editor.subject('bangumi', '91002');
    expect(workId && otherId).toBeTruthy();
    const page = (id: string, property: string) =>
      editor.http(`/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`);
    const startPage = await page(workId!, 'schema:datePublished');
    const endPage = await page(workId!, 'schema:endDate');
    const countPage = await page(workId!, 'schema:numberOfEpisodes');
    expect(startPage.status).toBe(200);
    const start = (startPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    const end = (endPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    const count = (countPage.body as { candidates: Candidate[] }).candidates.find((item) => item.source)!;
    expect(start.statement.value.content).toEqual({
      time: '+2024-04-07T00:00:00Z',
      precision: 11,
      calendarmodel: gregorian,
    });
    expect(end.statement.value.content).toEqual({
      time: '+2024-06-23T00:00:00Z',
      precision: 11,
      calendarmodel: gregorian,
    });
    expect(count.statement.value.content).toEqual({ amount: '+12', unit: '1' });
    expect(
      [start, end, count].every((candidate) =>
        candidate.statement.references?.some((reference) =>
          reference.parts.some(
            (part) => part.property.id === 'schema:url' && part.value.content === 'https://bgm.tv/subject/91001',
          ),
        ),
      ),
    ).toBe(true);
    expect(((await page(otherId!, 'schema:numberOfEpisodes')).body as { candidates: Candidate[] }).candidates).toEqual(
      [],
    );

    for (const [property, candidate, listing] of [
      ['schema:datePublished', start, startPage.body],
      ['schema:endDate', end, endPage.body],
      ['schema:numberOfEpisodes', count, countPage.body],
    ] as const) {
      expect(
        (
          await editor.http(`/v1/subjects/${workId}/candidates/${candidate.id}:accept`, {
            context,
            expected_head: candidate.head,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${workId}:adopt`, {
            context,
            property,
            mode: 'replace',
            expected_head: (listing as { adoption: { head: number } | null }).adoption?.head ?? null,
            selection: [{ candidate: candidate.id, rank: candidate.statement.rank ?? 'normal' }],
          })
        ).status,
      ).toBe(200);
    }
    const read = async () => {
      const response = await editor.http(`/v1/subjects/${workId}?context=${context}`);
      expect(response.status).toBe(200);
      return response.body as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
    };
    const current = await read();
    expect(current.subject.statements['schema:datePublished']?.[0]?.value.content).toEqual(
      start.statement.value.content,
    );
    expect(current.subject.statements['schema:endDate']?.[0]?.value.content).toEqual(end.statement.value.content);
    expect(current.subject.statements['schema:numberOfEpisodes']?.[0]?.value.content).toEqual(
      count.statement.value.content,
    );

    await runtime.restart();
    expect((await runtime.run(dump())).outcome).toBe('complete');
    expect(editor.subject('bangumi', '91001')).toBe(workId);
    expect((await read()).subject.statements['schema:numberOfEpisodes']?.[0]?.value.content).toEqual(
      count.statement.value.content,
    );

    expect(
      (
        await editor.http('/v1/sourceFences:takedown', {
          source: 'bangumi',
          externalId: '91001',
          fieldGroup: 'facts',
          reason: 'Rights complaint',
        })
      ).status,
    ).toBe(200);
    expect((await runtime.run(dump('13'))).outcome).toBe('complete');
    const fenced = (await page(workId!, 'schema:numberOfEpisodes')).body as { candidates: Candidate[] };
    expect(fenced.candidates.some((item) => JSON.stringify(item.statement.value.content).includes('+13'))).toBe(false);
    expect((await read()).subject.statements['schema:numberOfEpisodes']?.[0]?.value.content).toEqual(
      count.statement.value.content,
    );
  } finally {
    await runtime.close();
  }
}, 180_000);
