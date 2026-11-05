import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { ConversionError } from '../../../../packages/conversion/src/index.ts';
import { convertVndb, converter_revision } from '../../../../packages/conversion/src/vndb.ts';
import { sourceDigest } from '../../../../packages/conversion/src/support.ts';
import {
  completed,
  latinDump,
  openLatinFixture,
  primary,
  registration,
  returnedSubject,
  romanized,
  staged,
  type LatinFixture,
} from './vndb-optional-latin-fixture.ts';

function phases(input: Awaited<ReturnType<typeof staged>>, id: string, latin: string | null) {
  const bootstrap = convertVndb(input);
  const resolved = convertVndb(input, { source: registration.source, subjectId: id });
  const registered = registration.convert(input, { source: registration.source, subjectId: id });
  expect(registered.normalized).toEqual(bootstrap.normalizedRecord);
  expect(registered.digest).toBe(bootstrap.digest);
  for (const output of [bootstrap, resolved]) {
    expect(output.normalizedRecord.vn_titles[0]!.latin).toBe(latin);
    expect(output.digest).toBe(sourceDigest(output.normalizedRecord));
    expect(output.digest).toBe(bootstrap.digest);
    expect(output.record_revision).toBe('19');
    expect(output.converter_revision).toBe(converter_revision);
    expect(output.sourceMetadata).toEqual({
      databaseLicense: 'ODbL-1.0',
      contentsLicense: 'LicenseRef-DbCL-1.0',
      attribution: 'VNDB',
    });
  }
  expect(bootstrap.proposals).toHaveLength(1);
  const create = bootstrap.proposals[0]!;
  if (create.op !== 'create') throw new Error('Expected real bootstrap');
  const expected = latin ? { ja: primary, 'ja-Latn': latin } : { ja: primary };
  expect(create.subject.labels).toEqual(expected);
  expect(create.subject.aliases ?? {}).toEqual({});
  expect(resolved.proposals.every((p) => p.op === 'propose' && p.subject === id)).toBe(true);
  const names = resolved.proposals.flatMap((p) =>
    p.op === 'propose' && p.statement.property.id === 'schema:name' && p.statement.value.type === 'value'
      ? [p.statement.value.content]
      : [],
  );
  expect(names).toEqual(
    latin
      ? [
          { language: 'ja', text: primary },
          { language: 'ja-Latn', text: latin },
        ]
      : [{ language: 'ja', text: primary }],
  );
  for (const p of resolved.proposals) {
    if (p.op !== 'propose') throw new Error('Expected resolved proposal');
    expect(
      p.statement.references
        ?.flatMap((r) => r.parts)
        .filter((part) => part.property.id === 'schema:url')
        .map((part) => (part.value.type === 'value' ? part.value.content : undefined)),
    ).toEqual(['https://vndb.org/v124.19']);
  }
  // A distinct registered converter revision changes command identity, never source data identity.
  expect(
    convertVndb(input, { subjectId: id }, { converterRevision: `${converter_revision}-digest-control` }).digest,
  ).toBe(bootstrap.digest);
  return bootstrap;
}

async function publicNames(f: LatinFixture, id: string, expected: { language: string; text: string }[]) {
  const view = await f.observer.read('vndb', 'v124');
  expect(view.subject?.id).toBe(id);
  expect(view.responses.every((r) => r.status === 200)).toBe(true);
  expect(
    Object.values(view.subject!.labels).every((label) => typeof label === 'string' && label.trim().length > 0),
  ).toBe(true);
  for (const aliases of Object.values(view.subject!.aliases ?? {}))
    expect(aliases.every((alias) => alias.trim().length > 0)).toBe(true);
  const active = view.proposals.filter((p) => p.kind === 'value' && !view.retracted.includes(p.id));
  expect(
    active.filter((p) => p.statement?.property.id === 'schema:name').map((p) => p.statement!.value.content),
  ).toEqual(expect.arrayContaining(expected));
  expect(active.filter((p) => p.statement?.property.id === 'schema:name')).toHaveLength(expected.length);
  for (const p of active) {
    expect(p.subjectId).toBe(id);
    expect(p.recordRevision).toBe('19');
    expect(p.converterRevision).toBe(converter_revision);
    expect(
      p.references
        .flatMap((r) => r.parts)
        .filter((part) => part.property.id === 'schema:url')
        .map((part) => part.value.content),
    ).toContain('https://vndb.org/v124.19');
  }
  return view;
}

async function replay(f: LatinFixture, dump: ReturnType<typeof latinDump>) {
  const effects = await f.observer.effects();
  const before = await f.observer.read('vndb', 'v124');
  await completed(f, await f.runtime.run(dump));
  await f.runtime.restart();
  await completed(f, await f.runtime.run(dump));
  expect(await f.observer.effects()).toEqual(effects);
  expect((await f.observer.read('vndb', 'v124')).proposals).toEqual(before.proposals);
}

test('observed NULL and nonempty title cells retain VNDB attribution and canonical Romanization', async () => {
  const f = await openLatinFixture();
  try {
    // Pinned vn_titles lines 1–2; only parent ID changes v1 -> v124 to use the bounded fixture shell.
    const dump = latinDump(
      null,
      "v124\ten\tt\tLet's Meow Meow!\t\\N\nv124\tja\tt\tみんなでニャンニャン\tMinna de Nyan Nyan\n",
    );
    const input = await staged(dump);
    expect(input.record.vn_titles.map((row) => row.latin)).toEqual([null, 'Minna de Nyan Nyan']);
    const run = await f.runtime.run(dump);
    await completed(f, run);
    const id = returnedSubject(run);
    await publicNames(f, id, [
      { language: 'en', text: "Let's Meow Meow!" },
      { language: 'ja', text: 'みんなでニャンニャン' },
      { language: 'ja-Latn', text: 'Minna de Nyan Nyan' },
    ]);
    const output = convertVndb(input, { subjectId: id });
    expect(output.sourceMetadata).toEqual({
      databaseLicense: 'ODbL-1.0',
      contentsLicense: 'LicenseRef-DbCL-1.0',
      attribution: 'VNDB',
    });
  } finally {
    await f.runtime.close();
  }
}, 600_000);

test('NULL and nonempty Latin preserve native primary names, citations and canonical language', async () => {
  const f = await openLatinFixture();
  try {
    for (const latin of [null, romanized]) {
      const dump = latinDump(latin);
      const input = await staged(dump);
      const run = await f.runtime.run(dump);
      await completed(f, run);
      const id = latin === null ? returnedSubject(run) : f.observer.subject('vndb', 'v124')!;
      phases(input, id, latin);
      await publicNames(
        f,
        id,
        latin
          ? [
              { language: 'ja', text: primary },
              { language: 'ja-Latn', text: latin },
            ]
          : [{ language: 'ja', text: primary }],
      );
    }
  } finally {
    await f.runtime.close();
  }
}, 600_000);

test('exact-empty final COPY cell imports only the primary title and replay/reopen has no duplicate effects', async () => {
  const f = await openLatinFixture();
  try {
    const dump = latinDump('');
    const input = await staged(dump);
    expect(input.record.vn_titles[0]!.latin).toBe('');
    const run = await f.runtime.run(dump);
    await completed(f, run);
    const id = returnedSubject(run);
    phases(input, id, '');
    await publicNames(f, id, [{ language: 'ja', text: primary }]);
    await replay(f, dump);
  } finally {
    await f.runtime.close();
  }
}, 600_000);

test('same-key NULL to exact-empty changes data digest while retaining subject and immutable bootstrap receipt bytes', async () => {
  const f = await openLatinFixture();
  try {
    const first = await f.runtime.run(latinDump(null));
    await completed(f, first);
    const id = returnedSubject(first);
    const old = first.exchanges.find((e) =>
      (e.request.body as { commands: BatchCommand[] }).commands.some((c) => c.op === 'create'),
    )!;
    expect(old).toBeDefined();
    const oldBytes = old.request.serializedBody;
    const oldReceipts = structuredClone(old.receipts);
    const bootstrapKey = old.request.keys[0]!;
    const journal = () =>
      f.runtime.importer.session.bindings.journal({ source: 'vndb', external_id: 'v124' }, bootstrapKey);
    const savedJournal = structuredClone(journal());
    expect(savedJournal).not.toBeNull();
    const nullInput = await staged(latinDump(null));
    const emptyInput = await staged(latinDump(''));
    const nullOutput = phases(nullInput, id, null);
    // Intentionally red until exact-empty projection is adopted and implemented.
    const emptyOutput = phases(emptyInput, id, '');
    expect(emptyOutput.digest).not.toBe(nullOutput.digest);
    expect(emptyInput.record.entry_meta).toEqual(nullInput.record.entry_meta);
    const refreshed = await f.runtime.run(latinDump(''));
    await completed(f, refreshed);
    const current = await publicNames(f, id, [{ language: 'ja', text: primary }]);
    for (const proposal of current.proposals.filter((p) => p.kind === 'value' && !current.retracted.includes(p.id)))
      expect(proposal.recordDigest).toBe(emptyOutput.digest);
    expect(f.observer.subject('vndb', 'v124')).toBe(id);
    expect(
      refreshed.exchanges
        .flatMap((e) => (e.request.body as { commands: BatchCommand[] }).commands)
        .every((c) => c.op !== 'create'),
    ).toBe(true);
    expect(journal()).toEqual(savedJournal);
    expect(old.request.serializedBody).toBe(oldBytes);
    for (const receipt of oldReceipts) expect(await f.runtime.receipt(receipt.key)).toBe(receipt.identity);
    const response = await f.runtime.replay(
      new Request(old.request.url, { method: old.request.method, headers: old.request.headers, body: oldBytes }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(old.response.body);
    for (const receipt of oldReceipts) expect(await f.runtime.receipt(receipt.key)).toBe(receipt.identity);
    await replay(f, latinDump(''));
  } finally {
    await f.runtime.close();
  }
}, 600_000);

test('whitespace Latin rejects before row effects and missing/type/primary errors retain exact converter paths', async () => {
  const f = await openLatinFixture();
  try {
    const initial = await f.runtime.run(latinDump(null));
    await completed(f, initial);
    const id = returnedSubject(initial);
    const baseline = f.runtime.importer.session.store.source('vndb');
    const effects = await f.observer.effects();
    const captures = f.runtime.captures.length;
    const blank = await staged(latinDump('   '));
    expect(blank.record.vn_titles[0]!.latin).toBe('   ');
    expect((await f.runtime.run(latinDump('   '))).outcome).toBe('invalid-input');
    expect(await f.observer.effects()).toEqual(effects);
    expect(f.runtime.importer.session.store.source('vndb')).toEqual(baseline);
    expect(
      f.runtime.captures.slice(captures).filter((c) => new URL(c.request.url).pathname === '/v1/subjects:batchWrite'),
    ).toHaveLength(0);
    const valid = await staged(latinDump(null));
    const bad: { field: 'latin' | 'title'; value?: unknown; missing?: boolean }[] = [
      { field: 'latin', value: '   ' },
      { field: 'latin', value: '\t\n' },
      { field: 'latin', missing: true },
      { field: 'latin', value: 42 },
      { field: 'latin', value: false },
      { field: 'latin', value: {} },
      { field: 'title', value: '' },
      { field: 'title', value: '   ' },
      { field: 'title', value: null },
    ];
    for (const entry of bad) {
      // COPY cannot represent missing/non-string cells. Mutate the actual staged payload only here.
      const input = structuredClone(valid);
      const title = input.record.vn_titles[0]! as unknown as Record<string, unknown>;
      if (entry.missing) delete title[entry.field];
      else title[entry.field] = entry.value;
      for (const subjectId of [undefined, id]) {
        let error: unknown;
        try {
          registration.convert(input, {
            source: registration.source,
            ...(subjectId === undefined ? {} : { subjectId }),
          });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(ConversionError);
        expect((error as ConversionError).pointer).toBe(`/vn_titles/0/${entry.field}`);
      }
    }
  } finally {
    await f.runtime.close();
  }
}, 600_000);

test('COPY acquisition rejects incomplete tables without promoting the prior sealed baseline', async () => {
  const f = await openLatinFixture();
  try {
    await completed(f, await f.runtime.run(latinDump(null)));
    const baseline = f.runtime.importer.session.store.source('vndb');
    const effects = await f.observer.effects();
    const valid = latinDump('');
    const incomplete = {
      ...valid,
      async *entries() {
        for await (const entry of valid.entries!()) if (entry.path !== 'db/entry_meta.header') yield entry;
      },
    };
    expect((await f.runtime.run(incomplete)).outcome).toBe('invalid-input');
    expect(f.runtime.importer.session.store.source('vndb')).toEqual(baseline);
    expect(await f.observer.effects()).toEqual(effects);
  } finally {
    await f.runtime.close();
  }
}, 600_000);
