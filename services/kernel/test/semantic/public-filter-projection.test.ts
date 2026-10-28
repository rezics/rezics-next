import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { readStatementAs } from '../../src/semantic/statement-disclosure.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capturedStep, complete, fixture, nativeProducer, snak, statement } from './support/public-filter-source.ts';

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
      source.readPublicFilterProjectionPage({ subject, meaning: f.meaning, inputLimit: 16, frontier: null }),
    );
    expect(first.status).toBe('progress');
    if (first.status !== 'progress') throw new Error('High-degree source must retain its bounded frontier');
    expect(first.cost.inputKeys).toBeLessThanOrEqual(16);
    const saved = { ...first.frontier };
    // New producer object has no process-local build state; replay cannot skip or duplicate identities.
    source = publicFilterSource(f.config);
    const replay = await source.readPublicFilterProjectionPage({
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: saved,
    });
    const replayAgain = await publicFilterSource(f.config).readPublicFilterProjectionPage({
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: saved,
    });
    expect(replayAgain).toEqual(replay);
    const tail = await complete(f, source, subject, saved);
    const records = [...first.records, ...tail.records];
    const authors = records.filter((record) => record.indexed.property === 'schema:author');
    expect(authors.map((record) => record.indexed.value).sort()).toEqual([...targets].sort());
    expect(new Set(authors.map((record) => record.candidate)).size).toBe(300);
    expect(
      records.some((record) => record.indexed.property === 'schema:inLanguage' && record.indexed.value === 'ja'),
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
        authors.map((record) => record.indexed),
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
    expect(expanded.records.map((record) => [record.candidate, record.indexed])).toEqual(
      records.map((record) => [record.candidate, record.indexed]),
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
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: null,
    });
    expect(start.status).toBe('progress');
    if (start.status !== 'progress') throw new Error('Expected retained build');
    await f.post(`/v1/subjects/${subject}/candidates/${pending}:hide`, { reason: 'Selection privacy reduction' });
    const changed = await source.readPublicFilterProjectionPage({
      subject,
      meaning: f.meaning,
      inputLimit: 16,
      frontier: start.frontier,
    });
    expect(['changed', 'unready']).toContain(changed.status);
    expect((await complete(f, source, subject)).records.some((record) => record.candidate === pending)).toBe(false);

    // Hide the long prefix: later surviving selected fact must still be reached, even past 32 witnesses.
    const survivingAuthors = (await complete(f, source, subject)).records.filter(
      (record) => record.indexed.property === 'schema:author',
    );
    const survivor = survivingAuthors.at(-1)!.indexed.value;
    for (const record of survivingAuthors.slice(0, -1))
      await f.post(`/v1/subjects/${record.indexed.value}:hide`, { reason: 'Hidden native key prefix' });
    expect(
      (await complete(f, source, subject)).records
        .filter((record) => record.indexed.property === 'schema:author')
        .map((record) => record.indexed.value),
    ).toEqual([survivor]);
    await f.post(`/v1/subjects/${survivor}:hide`, { reason: 'Last foreign target reduced' });
    const actor = await f.config.access.authenticate(f.real.bearer('editor'), {
      pool: f.db.pool,
      deadline: Date.now() + 2000,
    });
    const hidden = await readStatementAs(f.db.pool, f.config.access, actor, Date.now() + 2000, () =>
      complete(f, source, subject),
    );
    expect(hidden.records.filter((record) => record.indexed.property === 'schema:author')).toEqual([]);
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
      (record) => record.indexed.property === 'ex:credit',
    );
    expect(allWitnesses).toHaveLength(40);
    const lastWitness = allWitnesses.at(-1)!;
    for (const record of allWitnesses.slice(0, -1))
      await f.post(`/v1/subjects/${record.indexed.qualifiers![0]!.value}:hide`, {
        reason: 'Hidden qualifier witness prefix',
      });
    const later = (await complete(f, source, witnesses)).records.filter(
      (record) => record.indexed.property === 'ex:credit',
    );
    expect(later.map((record) => record.candidate)).toEqual([lastWitness.candidate]);
    expect(
      later[0]!.dependencies.some(
        (dependency) =>
          dependency.kind === 'subject' && dependency.subject === lastWitness.indexed.qualifiers![0]!.value,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
