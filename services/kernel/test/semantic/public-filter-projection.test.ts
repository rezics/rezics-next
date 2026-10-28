import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { readStatementAs } from '../../src/semantic/statement-disclosure.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  capturedStep,
  complete,
  fixture,
  indexed,
  nativeProducer,
  readContext,
  snak,
  statement,
} from './support/public-filter-source.ts';

test('native complete selected public facet projection retains bounded frontier exact statement associations and current dependencies', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    let source = publicFilterSource(f.config);
    const targets: string[] = [];
    // Genuine native subjects and selected compact facts; no seeded truth/hints/projection rows.
    for (let index = 0; index < 300; index++) targets.push(await f.create());
    const [left, right, otherLeft, otherRight] = await Promise.all(
      Array.from({ length: 4 }, () => f.create('skos:Concept')),
    );
    const subject = await f.create('schema:Book', {
      'schema:author': targets.map((target, index) =>
        statement(
          'schema:author',
          target,
          index === 0
            ? [snak('ex:left', left), snak('ex:right', otherRight)]
            : index === 1
              ? [snak('ex:left', otherLeft), snak('ex:right', right)]
              : [],
        ),
      ),
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    });
    const first = await capturedStep(f.db, () =>
      source.readPublicFilterProjectionPage({
        context: readContext(),
        subject,
        meaning: f.meaning,
        inputLimit: 16,
        frontier: null,
      }),
    );
    expect(first.status).toBe('progress');
    if (first.status !== 'progress') throw new Error('High-degree source must retain its bounded frontier');
    expect(first.cost.inputKeys).toBeLessThanOrEqual(16);
    const saved = { ...first.frontier };
    // New producer object has no process-local build state; replay cannot skip or duplicate identities.
    source = publicFilterSource(f.config);
    const replay = await source.readPublicFilterProjectionPage({
      context: readContext(),
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: saved,
    });
    const replayAgain = await publicFilterSource(f.config).readPublicFilterProjectionPage({
      context: readContext(),
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: saved,
    });
    expect(replayAgain).toEqual(replay);
    const tail = await complete(f, source, subject, saved);
    const records = [...first.records, ...tail.records];
    const authors = records.filter((record) => indexed(record).property === 'schema:author');
    expect(authors.map((record) => indexed(record).value).sort()).toEqual([...targets].sort());
    expect(new Set(authors.map((record) => record.candidate)).size).toBe(300);
    expect(
      records.some((record) => indexed(record).property === 'schema:inLanguage' && indexed(record).value === 'ja'),
    ).toBe(true);
    for (const record of records) {
      expect(record.subject).toBe(subject);
      expect(record.candidate).toBe(record.statement.id);
      expect(record.release).toBe(record.statement.rezics.release);
      expect(record.statement.rank).toBe(record.rank);
      expect(record.dependencies).toContainEqual({
        kind: 'subject',
        route: (await import('../../src/route/route.ts')).routeOf(subject)!,
        subject,
      });
      expect(
        record.dependencies.some(
          (dependency) => dependency.kind === 'selection' && dependency.candidate === record.candidate,
        ),
      ).toBe(true);
    }
    expect(
      holdsCurrentStatements(
        authors.map((record) => indexed(record)),
        {
          facet: 'statement',
          property: 'schema:author',
          values: [targets[0]!, targets[1]!],
          qualifiers: [
            { property: 'ex:left', in: [left!] },
            { property: 'ex:right', in: [right!] },
          ],
        },
      ),
    ).toBe(false);
    expect(tail.inputKeys + first.cost.inputKeys, 'No all-history/whole-degree reread per step').toBeLessThanOrEqual(
      2 * records.length + 32,
    );

    // Expansion through real propose/accept/adopt preserves the selected compact value and identity.
    const pending = await f.propose(subject, targets[0]!);
    await f.post(`/v1/subjects/${subject}/candidates/${pending}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    const expanded = await complete(f, source, subject);
    expect(expanded.records.map((record) => [record.candidate, indexed(record)])).toEqual(
      records.map((record) => [record.candidate, indexed(record)]),
    );
    await f.post(`/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:author',
      target: targets[0],
      mode: 'replace',
      selection: [{ candidate: pending, rank: 'preferred' }],
      expected_head: 1,
    });
    expect((await complete(f, source, subject)).records.find((record) => record.candidate === pending)?.rank).toBe(
      'preferred',
    );

    // Old immutable accepted meaning remains usable after activating another release.
    const releaseB = structuredClone(f.meaning.release);
    releaseB.catalogue.version = '2';
    const digestB = releaseDigest(releaseB);
    await f.post('/v1/definitions/releases', { release: releaseB });
    const { activeRelease } = await import('../../src/semantic/definitions.ts');
    await f.post(`/v1/definitions/releases/${digestB}:activate`, {
      expected_head: (await activeRelease(f.db.pool))!.head,
    });
    expect((await complete(f, source, subject)).page.source.currentRelease).toBe(f.meaning.digest);

    const start = await source.readPublicFilterProjectionPage({
      context: readContext(),
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: null,
    });
    expect(start.status).toBe('progress');
    if (start.status !== 'progress') throw new Error('Expected retained build');
    await f.post(`/v1/subjects/${subject}/candidates/${pending}:hide`, { reason: 'Selection privacy reduction' });
    const changed = await source.readPublicFilterProjectionPage({
      context: readContext(),
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: start.frontier,
    });
    expect(['changed', 'unready']).toContain(changed.status);
    expect((await complete(f, source, subject)).records.some((record) => record.candidate === pending)).toBe(false);

    // Hide the long prefix: later surviving selected fact must still be reached, even past 32 witnesses.
    const survivingAuthors = (await complete(f, source, subject)).records.filter(
      (record) => indexed(record).property === 'schema:author',
    );
    const survivor = indexed(survivingAuthors.at(-1)!).value;
    for (const record of survivingAuthors.slice(0, -1))
      await f.post(`/v1/subjects/${indexed(record).value}:hide`, { reason: 'Hidden native key prefix' });
    expect(
      (await complete(f, source, subject)).records
        .filter((record) => indexed(record).property === 'schema:author')
        .map((record) => indexed(record).value),
    ).toEqual([survivor]);
    await f.post(`/v1/subjects/${survivor}:hide`, { reason: 'Last foreign target reduced' });
    const actor = await f.config.access.authenticate(f.real.bearer('editor'), {
      pool: f.db.pool,
      deadline: Date.now() + 2000,
    });
    const hidden = await readStatementAs(f.db.pool, f.config.access, actor, Date.now() + 2000, () =>
      complete(f, source, subject),
    );
    expect(hidden.records.filter((record) => indexed(record).property === 'schema:author')).toEqual([]);
    expect(hidden.page.status).toBe('complete');
    // Retain internal reverse routing even when public foreign values are all withheld.
    for (const record of survivingAuthors) {
      expect(
        hidden.repairLocators.some(
          (locator) =>
            locator.subject === subject &&
            locator.property === 'schema:author' &&
            locator.candidate === record.candidate,
        ),
      ).toBe(true);
    }
    const absent = await f.create('schema:Book');
    expect((await complete(f, source, absent)).records).toEqual([]);
    const witnessTarget = await f.create();
    const witnessKeys: string[] = [];
    for (let index = 0; index < 40; index++) witnessKeys.push(await f.create('skos:Concept'));
    const witnesses = await f.create('schema:Book', {
      'ex:credit': witnessKeys.map((key) => statement('ex:credit', witnessTarget, [snak('ex:left', key)])),
    });
    const allWitnesses = (await complete(f, source, witnesses)).records.filter(
      (record) => indexed(record).property === 'ex:credit',
    );
    expect(allWitnesses).toHaveLength(40);
    const lastWitness = allWitnesses.at(-1)!;
    for (const record of allWitnesses.slice(0, -1))
      await f.post(`/v1/subjects/${indexed(record).qualifiers![0]!.value}:hide`, {
        reason: 'Hidden qualifier witness prefix',
      });
    const later = (await complete(f, source, witnesses)).records.filter(
      (record) => indexed(record).property === 'ex:credit',
    );
    expect(later.map((record) => record.candidate)).toEqual([lastWitness.candidate]);
    expect(
      later[0]!.dependencies.some(
        (dependency) =>
          dependency.kind === 'subject' && dependency.subject === indexed(lastWitness).qualifiers![0]!.value,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('complete native public projection preserves unknowns and disclosure dependencies', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const target = await f.create();
    const qualifierTarget = await f.create('skos:Concept');
    const rich = statement('schema:author', target, [
      snak('ex:left', qualifierTarget),
      snak('wdt:P1114', { amount: '+1.25', unit: '1' }),
    ]);
    const unknown = { property: { id: 'schema:author' }, value: { type: 'somevalue' }, qualifiers: [] };
    const none = { property: { id: 'schema:author' }, value: { type: 'novalue' }, qualifiers: [] };
    const subject = await f.create('schema:Book', { 'schema:author': [unknown, none, rich] });
    const projection = await complete(f, source, subject);
    expect(projection.records).toHaveLength(3);
    expect(projection.records.map((record) => record.statement.value.type).sort()).toEqual([
      'novalue',
      'somevalue',
      'value',
    ]);
    for (const record of projection.records) {
      expect(record.indexed, 'No scalar cast, partial qualifier drop or sentinel').toBeNull();
      expect(record.candidate).toBe(record.statement.id);
      expect(record.release).toBe(f.meaning.digest);
      expect(record.statement.rezics).toEqual({ release: record.release, revision: record.revision });
      expect(record.source).toBeNull();
      expect(record.dependencies.some((key) => key.kind === 'selection' && key.candidate === record.candidate)).toBe(
        true,
      );
    }
    const concrete = projection.records.find((record) => record.statement.value.type === 'value')!;
    expect(concrete.statement.value).toEqual(rich.value);
    expect(concrete.statement.qualifiers.map(({ property, value }) => ({ property: property.id, value }))).toEqual([
      { property: 'ex:left', value: rich.qualifiers[0]!.value },
      { property: 'wdt:P1114', value: rich.qualifiers[1]!.value },
    ]);
    expect(concrete.statement.qualifiers[1]!.property.data_type).toBe('quantity');
    expect(concrete.dependencies.some((key) => key.kind === 'subject' && key.subject === qualifierTarget)).toBe(true);
    // Null coverage reaches the EXISTING Boolean grammar as unresolved, never as an empty false set.
    const { compileCurrentFilter } = await import('../../src/search/current-filter-plan.ts');
    const negative = compileCurrentFilter({ not: { statement: { property: 'schema:author', in: [target] } } });
    expect(negative.evaluate(['not_proven'])).toBe('not_proven');
    await f.post(`/v1/subjects/${qualifierTarget}:hide`, { reason: 'Rich qualifier dependency reduction' });
    const hidden = await complete(f, source, subject);
    expect(hidden.records.some((record) => record.candidate === concrete.candidate)).toBe(false);
    expect(hidden.repairLocators.some((locator) => locator.candidate === concrete.candidate)).toBe(true);
    // The selected unknowns survive; hidden qualifier data never becomes a negative-match witness.
    expect(hidden.records.map((record) => record.statement.value.type).sort()).toEqual(['novalue', 'somevalue']);
  } finally {
    await f.close();
  }
});
