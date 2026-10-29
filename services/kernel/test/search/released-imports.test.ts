import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { createDriverClient } from './support/driver-client.ts';

test('the normal importer commits and adopts the pinned Book in the same native Search world and anonymous default search finds its real aliases and disclosed properties without duplicate reimport effects', async () => {
  const fixtureBytes = await Bun.file(
    new URL('../../../../specs/fixtures/imports/wikidata/entity.json', import.meta.url),
  ).text();
  const fixture = JSON.parse(fixtureBytes);
  const client = createDriverClient();
  try {
    const driver = await client.init();
    const imported = await client.importReleasedBook({ version: 1 });
    expect(imported.fixtureHash).toBe(createHash('sha256').update(fixtureBytes).digest('hex'));
    expect(imported.initial.run.status).toBe('committed');
    expect(imported.initial.run.counts).toEqual({ new: 1, changed: 0, unchanged: 0, vanished: 0 });
    expect(imported.reopened.run.status).toBe('committed');
    expect(imported.reopened.run.counts).toEqual({ new: 0, changed: 0, unchanged: 1, vanished: 0 });
    expect(imported.reopened.binding).toEqual(imported.initial.binding);
    expect(imported.reopened.candidates).toEqual(imported.initial.candidates);
    expect(imported.reopened.batches).toEqual([]);
    expect(imported.initial.binding).toEqual({ state: 'bound', subject: imported.subjectId });
    expect(imported.initial.batches.length).toBeGreaterThan(0);
    expect(imported.replayed).toHaveLength(imported.initial.batches.length);
    const receiptCandidates: string[] = [];
    for (const [index, batch] of imported.initial.batches.entries()) {
      expect(batch.response.status).toBe(200);
      expect(new Headers(batch.response.headers).get('content-type')).toContain('application/json');
      expect(imported.replayed[index]!.status).toBe(200);
      expect(imported.replayed[index]!.body).toEqual(batch.response.body);
      expect(batch.response.body.results.map((result) => result.key)).toEqual(batch.request.commands.map((c) => c.key));
      for (const receipt of batch.response.body.results) {
        expect([200, 201]).toContain(receipt.status);
        if ('value' in receipt && 'candidate' in receipt.value) receiptCandidates.push(receipt.value.candidate);
      }
    }
    expect(imported.selected.map((c) => c.candidate).sort()).toEqual(receiptCandidates.sort());
    expect(new Set(receiptCandidates).size).toBe(receiptCandidates.length);
    for (const selected of imported.selected) {
      expect(selected.acceptance.status).toBe(200);
      expect(selected.adoption.status).toBe(200);
      expect(selected.source).toMatchObject({
        source: 'wikidata',
        external_id: fixture.id,
        record_revision: String(fixture.lastrevid),
        converter_revision: imported.converterRevision,
        field_group: 'facts',
      });
      expect(selected.source.digest).toMatch(/^[a-f0-9]{64}$/);
      const parts = selected.statement.references.flatMap((reference) => reference.parts);
      expect(parts).toContainEqual(
        expect.objectContaining({
          property: expect.objectContaining({ id: 'schema:url' }),
          value: { type: 'value', content: `https://www.wikidata.org/wiki/${fixture.id}?oldid=${fixture.lastrevid}` },
        }),
      );
    }
    const active = await driver.request('anonymous', 'GET', '/v1/definitions/active');
    expect(active.status).toBe(200);
    expect(active.body.digest).toBe(imported.release);
    const point = await driver.request('anonymous', 'GET', `/v1/subjects/${imported.subjectId}`);
    expect(point.status).toBe(200);
    const subject = point.body.subject as Subject;
    expect(subject.release).toBe(imported.release);
    expect(subject.type).toBe('schema:Book');
    expect(subject.labels).toEqual(
      Object.fromEntries(Object.entries(fixture.labels).map(([k, v]) => [k, (v as { value: string }).value])),
    );
    expect(subject.aliases).toEqual(
      Object.fromEntries(
        Object.entries(fixture.aliases).map(([k, v]) => [k, (v as { value: string }[]).map((a) => a.value)]),
      ),
    );
    expect(subject.descriptions).toEqual(
      Object.fromEntries(Object.entries(fixture.descriptions).map(([k, v]) => [k, (v as { value: string }).value])),
    );
    expect(subject.statements['schema:name']!.map((s) => s.value.content)).toEqual(
      expect.arrayContaining(
        Object.values(fixture.labels).map((v) => ({
          language: (v as { language: string }).language,
          text: (v as { value: string }).value,
        })),
      ),
    );
    expect(subject.statements['schema:url']!.map((s) => s.value.content)).toEqual([
      fixture.claims.P856[0].mainsnak.datavalue.value,
    ]);
    const date = fixture.claims.P577[0].mainsnak.datavalue.value;
    expect(subject.statements['schema:datePublished']!.map((s) => s.value.content)).toEqual([
      { time: date.time, precision: date.precision, calendarmodel: date.calendarmodel },
    ]);
    const authors = imported.selected.filter((c) => c.property === 'schema:author');
    expect(authors).toHaveLength(fixture.claims.P50.length);
    for (const [index, author] of fixture.claims.P50.entries()) {
      expect(
        authors.some(
          (c) =>
            c.statement.value.type === 'somevalue' &&
            c.statement.qualifiers.some(
              (q) =>
                q.property.id === 'schema:sameAs' &&
                q.value.type === 'value' &&
                q.value.content === `http://www.wikidata.org/entity/${author.mainsnak.datavalue.value.id}`,
            ),
        ),
      ).toBe(true);
      if (index === 0)
        expect(
          authors.some((c) =>
            c.statement.references.some((r) =>
              r.parts.some(
                (p) =>
                  p.property.id === 'schema:url' &&
                  p.value.content === fixture.claims.P50[0].references[0].snaks.P854[0].datavalue.value,
              ),
            ),
          ),
        ).toBe(true);
    }
    for (const selected of imported.selected) {
      const disclosed = subject.statements[selected.property]!.find((s) => s.id === selected.candidate);
      expect<unknown>(disclosed).toEqual(selected.statement);
    }
    expect(imported.afterReplay.body).toEqual(imported.beforeReplay.body);
    expect(imported.afterReplay.body).toEqual(point.body);
    const alias = fixture.aliases.en[0].value;
    const deadline = performance.now() + 15_000;
    let search;
    do {
      search = await driver.request('anonymous', 'POST', '/v1/subjects:search', { text: alias });
      if (search.status === 200 && (search.body.subjects as { id: string }[]).some((s) => s.id === subject.id)) break;
      expect([200, 202, 503]).toContain(search.status);
      await Bun.sleep(50);
    } while (performance.now() < deadline);
    expect(search!.status, JSON.stringify(search!.body)).toBe(200);
    const hits = search!.body.subjects as { id: string; labels: unknown }[];
    expect(hits.map((s) => s.id)).toEqual([subject.id]);
    expect(hits[0]!.labels).toEqual(subject.labels);
    for (const sentinel of [
      'USER_POST_SENTINEL',
      'PRIVATE_ACCOUNT_SENTINEL',
      'PRIVATE_TEXT_SENTINEL',
      'UNKNOWN_PROPERTY_SENTINEL',
    ]) {
      expect(JSON.stringify([point.body, search!.body, imported.selected])).not.toContain(sentinel);
    }
    expect(subject.statements).not.toHaveProperty('schema:wordCount');
    expect(subject.statements).not.toHaveProperty('schema:abstract');
    console.log(
      'Released Book native receipt',
      JSON.stringify({
        fixtureHash: imported.fixtureHash,
        converterRevision: imported.converterRevision,
        release: imported.release,
        subjectId: subject.id,
        candidates: receiptCandidates,
        receipts: imported.initial.batches.flatMap((b) => b.response.body.results),
        search: search!.body,
        reopened: imported.reopened.run.counts,
      }),
    );
  } finally {
    await client.close();
  }
}, 240_000);
