import { expect, test } from 'bun:test';
import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { converter_revision, type WikidataConversion } from '../../../../packages/conversion/src/wikidata.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

type Candidate = {
  id: string;
  statement: BatchStatement & { id: string };
  source: Source | null;
  revision: number;
  retracted: number | null;
  head: number | null;
};
type Propose = Extract<BatchCommand, { op: 'propose' }>;
const owner = { source: 'wikidata', external_id: entity.id };
const citation = (revision: number) => `https://www.wikidata.org/wiki/Q571?oldid=${revision}`;
const identity = (id: string) => `http://www.wikidata.org/entity/${id}`;
const part = (property: string, content: unknown) => ({
  property: expect.objectContaining({ id: property }),
  value: { type: 'value', content },
});
const commands = (run: Run) => run.exchanges.flatMap((e) => (e.request.body as { commands: BatchCommand[] }).commands);
const proposals = (run: Run) => commands(run).filter((c): c is Propose => c.op === 'propose');
function dump(record: typeof entity): Dump {
  return {
    source: 'wikidata',
    snapshot: 'synthetic-native-book',
    converterRevision: converter_revision,
    bytes: new TextEncoder().encode(`${JSON.stringify(record)}\n`),
  };
}
function completed(run: Run) {
  expect(run.outcome).toBe('complete');
  for (const exchange of run.exchanges) {
    expect(exchange.response.status, JSON.stringify(exchange.response.body)).toBe(200);
    for (const result of (exchange.response.body as BatchWriteResult).results) {
      expect(result.status, JSON.stringify(result)).toBeLessThan(400);
      expect(exchange.receipts.find((r) => r.key === result.key)?.identity).toBeString();
    }
  }
}
function result(run: Run, key: string) {
  const row = run.exchanges.flatMap((e) => (e.response.body as BatchWriteResult).results).find((r) => r.key === key);
  if (!row || !('value' in row)) throw new Error(`Missing successful native result for ${key}`);
  return row.value;
}
function claimed(runtime: ApiRuntime, run: Run) {
  const create = commands(run).find((c) => c.op === 'create');
  expect(create).toBeDefined();
  const value = result(run, create!.key);
  if (!('id' in value)) throw new Error('Create response lacks actual subject');
  expect(runtime.importer.session.bindings.claim(owner)).toEqual({ state: 'bound', subject: value.id });
  return value.id;
}
function cited(candidate: Candidate, revision: number) {
  expect(candidate.source).toMatchObject({
    ...owner,
    record_revision: String(revision),
    converter_revision,
    field_group: 'facts',
  });
  expect(candidate.source!.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(candidate.statement.references).toContainEqual(
    expect.objectContaining({
      parts: expect.arrayContaining([expect.objectContaining(part('schema:url', citation(revision)))]),
    }),
  );
}
async function open() {
  // The shared runtime uses os.tmpdir() for its SQLite journal; no .temp override.
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    async function page(id: string, property: string, context: string, sameAs?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property,
          context,
          limit: '100',
          ...(sameAs ? { sameAs } : {}),
        })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body as unknown as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function select(id: string, property: string, context: string, ids: string[], sameAs?: string) {
      const listing = await page(id, property, context, sameAs);
      const selected = ids.map((id) => {
        const retrieved = listing.candidates.find((c) => c.id === id);
        if (!retrieved) throw new Error('Selection must use a retrieved candidate');
        return retrieved;
      });
      for (const candidate of selected) {
        const accepted = await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
          context,
          expected_head: candidate.head,
        });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      }
      const adopted = await editor.http(`/v1/subjects/${id}:adopt`, {
        context,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: selected.map((c) => ({ candidate: c.id, rank: c.statement.rank ?? 'normal' })),
        ...(sameAs ? { sameAs } : {}),
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    }
    const links = linkProjection(runtime.database.pool);
    async function anonymous(id: string, context: string) {
      // Subject relation previews consume the real relay, even without a composed page.
      let caughtUp = false;
      for (let batch = 0; batch < 16; batch++) {
        const delivered = await links.run(partitionOf(routeOf(id)!));
        expect(delivered.status).not.toBe('stopped');
        if (delivered.status === 'busy') {
          await Bun.sleep(5);
          continue;
        }
        if (delivered.status === 'read' && delivered.envelopes === 0) {
          caughtUp = true;
          break;
        }
      }
      expect(caughtUp).toBe(true);
      const response = await runtime.request(`/v1/subjects/${id}?context=${context}`);
      expect(response.status).toBe(200);
      return (await response.json()) as {
        subject: { id: string; type: string; statements: Record<string, Candidate['statement'][]> };
      };
    }
    return { runtime, editor, page, select, anonymous };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

test('Wikidata synthetic native Book rich fields retain ranks qualifiers references and CC0 metadata through real editor selection', async () => {
  const { runtime, editor, page, select, anonymous } = await open();
  try {
    const run = await runtime.run(dump(structuredClone(entity)));
    completed(run);
    const id = claimed(runtime, run);
    expect(proposals(run)).toHaveLength(6);
    const captures = run.conversions as readonly WikidataConversion[];
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(capture.sourceMetadata).toEqual({
        license: 'CC0-1.0',
        attribution: 'Wikidata contributors',
        url: citation(entity.lastrevid),
      });
      expect(capture.assets).toEqual([]);
    }
    for (const command of commands(run)) {
      expect(command.source).toMatchObject({
        ...owner,
        field_group: 'facts',
        record_revision: '24681012',
        converter_revision,
      });
      expect(command).not.toHaveProperty('rights');
    }
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const retrieved: Candidate[] = [];
    for (const [property, sameAs] of [
      ['schema:name'],
      ['schema:datePublished'],
      ['schema:url'],
      ['schema:author', identity('Q42')],
      ['schema:author', identity('Q999999999')],
    ]) {
      const rows = (await page(id, property!, GLOBAL_CONTEXT, sameAs)).candidates;
      expect(rows).toHaveLength(property === 'schema:name' ? 2 : 1);
      for (const candidate of rows) {
        cited(candidate, entity.lastrevid);
        const command = proposals(run).find((c) => {
          const value = result(run, c.key);
          return 'candidate' in value && value.candidate === candidate.id;
        });
        expect(command).toBeDefined();
        expect(candidate.statement).toMatchObject(command!.statement);
      }
      retrieved.push(...rows);
      await select(
        id,
        property!,
        GLOBAL_CONTEXT,
        rows.map((c) => c.id),
        sameAs,
      );
    }
    const fields = (property: string) => retrieved.filter((c) => c.statement.property.id === property);
    expect(fields('schema:name').map((c) => c.statement.value)).toEqual(
      expect.arrayContaining([
        { type: 'value', content: { language: 'en', text: 'The Example Book' } },
        { type: 'value', content: { language: 'en-GB', text: 'Example Book' } },
      ]),
    );
    expect(fields('schema:datePublished')[0]!.statement.value).toEqual({
      type: 'value',
      content: {
        time: '+2001-02-03T00:00:00Z',
        precision: 11,
        calendarmodel: identity('Q1985727'),
      },
    });
    expect(fields('schema:url')[0]!.statement.value).toEqual({
      type: 'value',
      content: 'https://books.example.org/example',
    });
    const authors = fields('schema:author');
    expect(authors.map((c) => c.statement.rank).sort()).toEqual(['normal', 'preferred']);
    for (const [index, qid] of ['Q42', 'Q999999999'].entries()) {
      const author = authors[index]!.statement;
      expect(author.value).toEqual({ type: 'somevalue' });
      expect(author.qualifiers).toContainEqual(expect.objectContaining(part('schema:sameAs', identity(qid))));
      expect(author.references[0]!.parts).toContainEqual(expect.objectContaining(part('schema:sameAs', identity(qid))));
      expect(runtime.importer.session.bindings.claim({ source: 'wikidata', external_id: qid })).toBeNull();
    }
    const preferred = authors.find((c) => c.statement.rank === 'preferred')!.statement;
    expect(preferred.qualifiers).toContainEqual(expect.objectContaining(part('schema:position', '1')));
    expect(preferred.references).toContainEqual(
      expect.objectContaining({
        parts: [expect.objectContaining(part('schema:url', 'https://catalogue.example.org/books/example'))],
      }),
    );
    expect(authors.find((c) => c.statement.rank === 'normal')!.statement.qualifiers).not.toContainEqual(
      expect.objectContaining({ property: expect.objectContaining({ id: 'schema:position' }) }),
    );
    const publicView = await anonymous(id, GLOBAL_CONTEXT);
    expect(publicView.subject.type).toBe('schema:Book');
    for (const property of ['schema:name', 'schema:datePublished', 'schema:url', 'schema:author'])
      expect(publicView.subject.statements[property]!.map((s) => s.id).sort()).toEqual(
        fields(property)
          .map((c) => c.id)
          .sort(),
      );
    for (const candidate of retrieved) {
      const statement = publicView.subject.statements[candidate.statement.property.id]!.find(
        (s) => s.id === candidate.id,
      );
      expect(statement).toMatchObject({
        value: candidate.statement.value,
        rank: candidate.statement.rank,
        qualifiers: candidate.statement.qualifiers,
        references: candidate.statement.references,
      });
    }
    const bytes = JSON.stringify([commands(run), captures, publicView]);
    for (const forbidden of [
      'P999999',
      'UNKNOWN_PROPERTY_SENTINEL',
      'USER_POST_SENTINEL',
      'PRIVATE_ACCOUNT_SENTINEL',
      'PRIVATE_TEXT_SENTINEL',
    ])
      expect(bytes).not.toContain(forbidden);
    expect(await editor.effects()).toMatchObject({ subjects: 1, receipts: 7 });
  } finally {
    await runtime.close();
  }
}, 600_000);

test('Wikidata synthetic native revision refresh preserves independent adoption history receipts and restart idempotence', async () => {
  const { runtime, editor, page, select, anonymous } = await open();
  try {
    const record = structuredClone(entity);
    const first = await runtime.run(dump(record));
    completed(first);
    const id = claimed(runtime, first);
    const created = await editor.http('/v1/contexts', { labels: { en: 'Independent Wikidata review' } });
    expect(created.status).toBe(201);
    const context = (created.body.context as { id: string }).id;
    const old = (await page(id, 'schema:url', context)).candidates[0]!;
    cited(old, record.lastrevid);
    const oldCommand = proposals(first).find((c) => c.statement.property.id === 'schema:url')!;
    const oldReceipt = await runtime.receipt(oldCommand.key);
    expect(oldReceipt).toBeString();
    await select(id, 'schema:url', context, [old.id]);
    expect((await anonymous(id, context)).subject.statements['schema:url']![0]!.id).toBe(old.id);

    record.lastrevid = 24681013;
    record.claims.P856[0]!.mainsnak.datavalue.value = 'https://books.example.org/revised';
    const refresh = await runtime.run(dump(record));
    completed(refresh);
    expect(runtime.importer.session.bindings.claim(owner)).toEqual({ state: 'bound', subject: id });
    expect(commands(refresh).some((c) => c.op === 'create')).toBe(false);
    const freshCommand = proposals(refresh).find((c) => c.statement.property.id === 'schema:url')!;
    expect(freshCommand).toBeDefined();
    expect(freshCommand.source.digest).not.toBe(old.source!.digest);
    expect(freshCommand.key).not.toBe(oldCommand.key);
    const freshReceipt = await runtime.receipt(freshCommand.key);
    expect(freshReceipt).toBeString();
    expect(freshReceipt).not.toBe(oldReceipt);
    const rows = (await page(id, 'schema:url', context)).candidates;
    expect(rows).toHaveLength(2);
    const value = result(refresh, freshCommand.key);
    if (!('candidate' in value)) throw new Error('Refresh lacks native candidate response');
    const fresh = rows.find((c) => c.id === value.candidate)!;
    expect(fresh).toBeDefined();
    expect(fresh.id).not.toBe(old.id);
    cited(fresh, record.lastrevid);
    expect(fresh.statement.value).toEqual({ type: 'value', content: 'https://books.example.org/revised' });
    const retained = rows.find((c) => c.id === old.id)!;
    expect(retained.statement).toEqual(old.statement);
    expect(retained.source).toEqual(old.source);
    expect(retained.retracted).not.toBeNull();
    cited(retained, entity.lastrevid);
    expect(await runtime.receipt(oldCommand.key)).toBe(oldReceipt);
    expect((await anonymous(id, context)).subject.statements['schema:url']![0]!.id).toBe(old.id);
    await select(id, 'schema:url', context, [fresh.id]);
    expect((await anonymous(id, context)).subject.statements['schema:url']![0]).toMatchObject({
      id: fresh.id,
      value: fresh.statement.value,
    });
    const revisions = await editor.http(`/v1/subjects/${id}/revisions?limit=100`);
    expect(revisions.status).toBe(200);
    expect(revisions.body.next).toBeNull();
    expect(revisions.body.revisions).toContainEqual(expect.objectContaining({ revision: old.revision }));
    const effects = await editor.effects();
    const before = (await page(id, 'schema:url', context)).candidates;
    await runtime.restart();
    const repeated = await runtime.run(dump(record));
    completed(repeated);
    expect(repeated.exchanges).toEqual([]);
    expect(runtime.importer.session.bindings.claim(owner)).toEqual({ state: 'bound', subject: id });
    expect((await page(id, 'schema:url', context)).candidates).toEqual(before);
    for (const exchange of refresh.exchanges) {
      const replay = await runtime.replay(
        new Request(exchange.request.url, {
          method: exchange.request.method,
          headers: exchange.request.headers,
          body: exchange.request.serializedBody,
        }),
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(exchange.response.body);
    }
    expect(await editor.effects()).toEqual(effects);
    expect(await runtime.receipt(oldCommand.key)).toBe(oldReceipt);
    expect(await runtime.receipt(freshCommand.key)).toBe(freshReceipt);
    expect((await page(id, 'schema:url', context)).candidates).toEqual(before);
    expect((await anonymous(id, context)).subject.statements['schema:url']![0]!.id).toBe(fresh.id);
  } finally {
    await runtime.close();
  }
}, 600_000);
