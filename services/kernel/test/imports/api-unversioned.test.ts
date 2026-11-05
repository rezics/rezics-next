import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { sourceDigest } from '../../../../packages/conversion/src/support.ts';
import type { WikidataConversion } from '../../../../packages/conversion/src/wikidata.ts';
import type { Dump, Proposal, Run } from '../../../../specs/imports-api-driver.ts';
import { openImportApiFixture } from './api-fixture.ts';

const converterRevision = 'wikidata-3';
const externalId = 'Q1';
const url = 'https://www.wikidata.org/wiki/Q1';
// Every field is in the native converter's normalized projection.
const entity = (title: string) => ({
  id: externalId,
  type: 'item',
  labels: { en: { language: 'en', value: title } },
  aliases: {},
  descriptions: {},
  claims: {
    P31: [
      {
        type: 'statement',
        rank: 'normal',
        mainsnak: {
          snaktype: 'value',
          property: 'P31',
          datatype: 'wikibase-item',
          datavalue: {
            type: 'wikibase-entityid',
            value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
          },
        },
      },
    ],
  },
});
const dump = (record: ReturnType<typeof entity>): Dump => ({
  source: 'wikidata',
  snapshot: 'fixture-label-only',
  converterRevision,
  bytes: new TextEncoder().encode(JSON.stringify(record) + '\n'),
});

function envelope(commands: readonly BatchCommand[], digest: string, revision = 'unversioned') {
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands)
    expect(command.source).toMatchObject({
      source: 'wikidata',
      external_id: externalId,
      record_revision: revision,
      converter_revision: converterRevision,
      digest,
    });
}
function proposals(rows: Proposal[], digest: string, subjectId: string) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toMatchObject({
      source: 'wikidata',
      externalId,
      subjectId,
      recordRevision: 'unversioned',
      recordDigest: digest,
      converterRevision,
    });
    const urls = row.references
      .flatMap((r) => r.parts)
      .filter((p) => p.property.id === 'schema:url')
      .map((p) => p.value.content);
    expect(urls).toContain(url);
    for (const cited of urls) expect(new URL(String(cited)).searchParams.has('oldid')).toBe(false);
  }
}

test('actual fixture preserves absent Wikidata revision through conversion, public import and reopen', async () => {
  const d = await openImportApiFixture({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const first = entity('First unversioned title');
    expect(Object.hasOwn(first, 'lastrevid')).toBe(false);
    const digest = sourceDigest(first);
    const versioned = { ...first, lastrevid: 101 };
    const control = (await d.convert('wikidata', versioned, converterRevision)).raw as WikidataConversion;
    envelope(control.proposals, sourceDigest(versioned), '101');
    expect(control.sourceMetadata.url).toBe(url + '?oldid=101');
    // Present invalid revisions must remain invalid; absence alone is supported.
    for (const lastrevid of [null, 0, -1, 1.5, '101', 'undefined', Number.MAX_SAFE_INTEGER + 1])
      await expect(d.convert('wikidata', { ...first, lastrevid }, converterRevision)).rejects.toThrow();

    const verifyRun = async (run: Run, expectedDigest: string) => {
      expect(run.outcome).toBe('complete');
      expect(run.exchanges.length).toBeGreaterThan(0);
      envelope(d.commands(run), expectedDigest);
      for (const exchange of run.exchanges) {
        expect(exchange.response.status).toBe(200);
        expect(exchange.receipts.length).toBe(exchange.request.keys.length);
        for (const receipt of exchange.receipts) {
          expect(receipt.identity).not.toBeNull();
          expect(await d.receipt(receipt.key)).toBe(receipt.identity);
        }
      }
    };
    await verifyRun(await d.run(dump(first)), digest);
    const view = await d.read('wikidata', externalId);
    expect(view.subject).not.toBeNull();
    const subjectId = view.subject!.id;
    proposals(view.proposals, digest, subjectId);
    const before = await d.effects();
    expect(before.subjects).toBe(1);
    expect(before.receipts).toBeGreaterThan(0);
    await d.restart();
    expect((await d.run(dump(first))).outcome).toBe('complete');
    expect(await d.effects()).toEqual(before);
    expect((await d.read('wikidata', externalId)).proposals).toEqual(view.proposals);

    const changed = entity('Changed unversioned title');
    const changedDigest = sourceDigest(changed);
    expect(changedDigest).not.toBe(digest);
    await verifyRun(await d.run(dump(changed)), changedDigest);
    const refreshed = await d.read('wikidata', externalId);
    expect(refreshed.subject?.id).toBe(subjectId);
    const newRows = refreshed.proposals.filter((p) => !view.proposals.some((old) => old.id === p.id));
    proposals(newRows, changedDigest, subjectId);
    expect(
      newRows.some(
        (p) =>
          p.statement?.property.id === 'schema:name' &&
          (p.statement.value.content as { text?: string }).text === changed.labels.en.value,
      ),
    ).toBe(true);

    const boundControl = (await d.convert('wikidata', versioned, converterRevision, { subjectId }))
      .raw as WikidataConversion;
    envelope(boundControl.proposals, sourceDigest(versioned), '101');
    expect(boundControl.proposals.every((c) => c.op === 'propose')).toBe(true);
    // Expected to reject here on the current fixture: String(undefined) mismatches "unversioned".
    for (const context of [undefined, { subjectId }]) {
      const converted = await d.convert('wikidata', first, converterRevision, context);
      const raw = converted.raw as WikidataConversion;
      expect(raw.normalizedRecord).toEqual(first);
      expect(raw.digest).toBe(digest);
      expect(raw.record_revision).toBe('unversioned');
      expect(raw.sourceMetadata.url).toBe(url);
      envelope(raw.proposals, digest);
      expect(raw.proposals.every((c) => c.op === (context ? 'propose' : 'create'))).toBe(true);
      if (context) {
        expect(converted.statements.length).toBeGreaterThan(0);
        for (const statement of converted.statements)
          expect(
            statement.references
              ?.flatMap((r) => r.parts)
              .filter((p) => p.property.id === 'schema:url')
              .map((p) => (p.value.type === 'value' ? p.value.content : undefined)),
          ).toContain(url);
      }
    }
  } finally {
    await d.close();
  }
}, 600_000);
