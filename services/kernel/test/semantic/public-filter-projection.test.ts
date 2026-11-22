import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import anonymousPermissionRead from '../../src/access/permission-check-anonymous.sql';
import identityPoints from '../../src/semantic/public-filter-identity-points.sql';
import identityFloors from '../../src/semantic/public-filter-identity-floors.sql';
import installedFloors from '../../src/semantic/public-filter-installed-identity-floors.sql';
import { withConnection, withoutQueryAccounting, withQueryAccounting } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { prepareProjectionBuildSql } from '../../src/semantic/public-filter-projection-build-write.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { readPopulationProjection } from '../../src/search/public-filter-preparation-segment.ts';
import { readStatementAs } from '../../src/semantic/statement-disclosure.ts';
import { readRelease } from '../../src/semantic/definition-release-read.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { retainedPublicFilterProjectionDependenciesCurrent } from '../../src/semantic/public-filter-projection.ts';
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

test('native public Subject identity batches retain the same anchors without creating projection builds', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const subjects = [await f.create('schema:Book'), await f.create('schema:Person')];
    const source = publicFilterSource(f.config);
    const read = (ids: readonly string[], meaning = f.meaning) =>
      source.readPublicFilterSubjectIdentities!({
        subjects: ids,
        context: readContext(),
        meaning,
        inputLimit: 16,
      });
    const identities = await read(subjects);
    expect(identities.status).toBe('observed');
    if (identities.status !== 'observed') throw new Error('Subject identities were unavailable');
    expect(identities.cost.frontierWrites).toBe(0);
    expect(identities.cost.inputKeys).toBe(2);
    const digest = f.meaning.digest;
    const retained = await readRelease(f.db.pool, digest);
    if (!retained) throw new Error('The installed projection release is missing');
    expect((await read(subjects, { digest, release: retained })).status).toBe('observed');
    const copied = structuredClone(retained);
    expect((await read(subjects, { digest, release: copied })).status).toBe('observed');
    delete copied.types['schema:Book'];
    await expect(read(subjects, { digest, release: copied })).rejects.toThrow('Invalid native public identity request');
    await expect(read(subjects, { digest: 'sha256:' + '0'.repeat(64), release: retained })).rejects.toThrow(
      'Invalid native public identity request',
    );
    const builds = await f.db.pool.query(
      'SELECT 1 FROM semantic.public_filter_projection_build WHERE subject_id=ANY($1::uuid[])',
      [subjects],
    );
    expect(builds.rows).toHaveLength(0);
    const expected = [];
    for (const subject of subjects) {
      const page = await source.readPublicFilterProjectionPage({
        subject,
        meaning: f.meaning,
        context: readContext(),
        inputLimit: 16,
        frontier: null,
      });
      expect(page.status).toBe('complete');
      if (page.status !== 'complete') throw new Error('The native projection did not complete');
      const { terminal, partition, securityRevision, currentRelease } = page.source;
      expected.push({ subject, terminal, partition, securityRevision, currentRelease });
    }
    expect(identities.rows).toEqual(expected);
    const calls: string[] = [];
    const windows = await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        async query(sql, _values, dispatch) {
          calls.push(sql);
          return dispatch();
        },
      },
      () =>
        source.readPublicFilterSubjectIdentityWindows!(
          [subjects.toReversed(), [subjects[0]!, newId(160)]].map((ids) => ({
            subjects: ids,
            context: readContext(),
            meaning: f.meaning,
            inputLimit: ids.length,
          })),
        ),
    );
    expect(windows.map((window) => window.status)).toEqual(['observed', 'unready']);
    expect(windows[0]?.status === 'observed' && windows[0].rows).toEqual(expected.toReversed());
    expect(windows.reduce((n, window) => n + window.cost.inputKeys, 0)).toBe(3);
    expect(calls.filter((sql) => sql === identityPoints.sql)).toHaveLength(1);
    expect(calls.filter((sql) => sql === identityFloors.sql)).toHaveLength(1);
    expect(calls.filter((sql) => sql === anonymousPermissionRead['~standard'].query.text)).toHaveLength(1);
    const original = subjects[0]!;
    let prepared = 0;
    const changed = publicFilterSource({
      ...f.config,
      access: {
        ...f.config.access,
        async prepareReadDecisions(input) {
          prepared++;
          await withoutQueryAccounting(() =>
            f.post(`/v1/subjects/${original}:hide`, { reason: 'Reduce the original after its visibility floor' }),
          );
          return f.config.access.prepareReadDecisions!(input);
        },
      },
    });
    const phases: string[] = [];
    const reduced = await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        query(sql, _values, dispatch) {
          phases.push(sql);
          return dispatch();
        },
      },
      () =>
        changed.readPublicFilterSubjectIdentities!({
          subjects: [original],
          context: readContext(),
          meaning: { digest, release: retained },
          inputLimit: 1,
        }),
    );
    expect(prepared).toBe(1);
    expect(phases.filter((sql) => sql === installedFloors.sql)).toHaveLength(1);
    expect(phases.filter((sql) => sql === identityFloors.sql)).toHaveLength(0);
    expect(phases.filter((sql) => sql === identityPoints.sql)).toHaveLength(1);
    expect(phases.filter((sql) => sql === anonymousPermissionRead['~standard'].query.text)).toHaveLength(0);
    expect(reduced.status).toBe('observed');
    if (reduced.status === 'observed') {
      expect(reduced.rows.map((row) => row.subject)).toEqual([original]);
      expect(reduced.rows[0]!.securityRevision).not.toBe(identities.rows[0]!.securityRevision);
    }
    await withConnection(f.db.admin, async (writer) => {
      await writer.query('BEGIN');
      try {
        await writer.query('LOCK TABLE semantic.subject IN ACCESS EXCLUSIVE MODE');
        const blocked = await source.readPublicFilterSubjectIdentities!({
          subjects: [original],
          context: { deadline: Date.now() + 300 },
          meaning: { digest, release: retained },
          inputLimit: 1,
        });
        expect(blocked.status).toBe('unavailable');
        expect(blocked.cost).toMatchObject({ inputKeys: 1, accessPoints: 1, dependencyPoints: 1 });
      } finally {
        await writer.query('ROLLBACK');
      }
    });
  } finally {
    await f.close();
  }
}, 60_000);

test('concurrent first pages for one Book complete across a native serialization conflict', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const subject = await f.create('schema:Book');
    const source = publicFilterSource(f.config);
    const context = readContext();
    const read = () =>
      source.readPublicFilterProjectionPage({
        context,
        subject,
        meaning: f.meaning,
        inputLimit: 16,
        frontier: null,
      });
    const snapshots = Promise.withResolvers<void>();
    let attempts = 0;
    let conflicts = 0;
    const pages = await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        async query(sql, _values, dispatch) {
          try {
            const result = await dispatch();
            if (sql === prepareProjectionBuildSql) {
              if (++attempts === 2) snapshots.resolve();
              await snapshots.promise;
            }
            return result;
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === '40001') conflicts++;
            throw error;
          }
        },
      },
      () => Promise.all([read(), read()]),
    );
    expect(conflicts).toBe(1);
    expect(attempts).toBe(3);
    for (const page of pages) {
      expect(page.status).toBe('complete');
      if (page.status === 'complete') expect(page.source.subject).toBe(subject);
    }
  } finally {
    await f.close();
  }
}, 60_000);

test('a private population resumes the signed projection for the same pending candidate', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const authors = [];
    for (let i = 0; i < 8; i++) authors.push(await f.create());
    const subject = await f.create('schema:Book', {
      'schema:author': authors.map((author) => statement('schema:author', author)),
    });
    const request = () => ({ subject, meaning: f.meaning, context: readContext(), inputLimit: 4 });
    let progress = await readPopulationProjection(publicFilterSource(f.config), request(), 1117);
    if (!progress?.next) throw new Error(`Expected a partial native projection, got ${progress?.page.status}`);
    const original = progress.next;
    expect(await readPopulationProjection(publicFilterSource(f.config), request(), 1118, original)).toBeNull();
    expect(
      await readPopulationProjection(
        publicFilterSource(f.config),
        { ...request(), subject: authors[0]! },
        1117,
        original,
      ),
    ).toBeNull();
    const changed = await readPopulationProjection(publicFilterSource(f.config), request(), 1117, {
      ...original,
      frontier: { ...original.frontier, continuation: original.frontier.continuation + 'x' },
    });
    expect(changed?.page.status).toBe('changed');
    expect(changed?.next).toBeUndefined();
    for (let i = 0; progress?.next; i++) {
      if (i >= 64) throw new Error('Original bounded projection did not complete');
      progress = await readPopulationProjection(
        publicFilterSource(f.config),
        request(),
        1117,
        structuredClone(progress.next),
      );
    }
    expect(progress?.page).toMatchObject({ status: 'complete', source: { subject } });
  } finally {
    await f.close();
  }
}, 120_000);

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
    const statements = {
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
    };
    const item = { type: 'schema:Book', labels: { en: 'Native public filter' }, statements };
    const key = 'native-complete-public-facet';
    const oversized = await f.call('/v1/subjects', item, key);
    expect(oversized.status).toBe(400);
    expect(oversized.body).toMatchObject({ code: 'invalid_request', errors: [{ pointer: '', code: 'out_of_range' }] });
    // The first slot stays compact until the expansion assertion below. The rest
    // are selected through ordinary editorial writes within each receipt's bound.
    const compact = 180;
    const subject = await f.create(
      'schema:Book',
      { ...statements, 'schema:author': statements['schema:author'].slice(0, compact) },
      key,
    );
    for (const target of targets.slice(compact)) {
      const candidate = await f.propose(subject, target);
      await f.post(`/v1/subjects/${subject}/candidates/${candidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      });
      await f.post(`/v1/subjects/${subject}:adopt`, {
        context: GLOBAL_CONTEXT,
        property: 'schema:author',
        target,
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: null,
      });
    }
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
}, 300_000);

test('one immutable release projects each native subject type and keeps exact currentness without a meaning type', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    const person = await f.create('schema:Person');
    const book = await f.create('schema:Book', {
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    });
    const personProjection = await complete(f, source, person);
    const bookProjection = await complete({ ...f, meaning: structuredClone(f.meaning) }, source, book);
    expect(personProjection.records).toEqual([]);
    expect(bookProjection.records.map((record) => indexed(record))).toContainEqual(
      expect.objectContaining({ property: 'schema:inLanguage', value: 'ja' }),
    );
    const current = (page: typeof bookProjection.page) =>
      retainedPublicFilterProjectionDependenciesCurrent(
        f.db.pool,
        { page, meaning: { digest: f.meaning.digest } },
        readContext(),
      );
    expect(await current(personProjection.page)).toBe(true);
    expect(await current(bookProjection.page)).toBe(true);
    const obsoleteMeaning = { ...f.meaning, type: 'schema:Book' };
    await expect(
      source.readPublicFilterProjectionPage({
        subject: book,
        meaning: obsoleteMeaning,
        inputLimit: 16,
        frontier: null,
        context: readContext(),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await f.post(`/v1/subjects/${person}:hide`, { reason: 'Retire the exact native projection' });
    expect(await current(personProjection.page)).toBe(false);
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

test('native concrete public statements retain unknown qualifier values and foreign dependencies', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const source = publicFilterSource(f.config);
    for (const type of ['somevalue', 'novalue'] as const) {
      const target = await f.create();
      const qualifierTarget = await f.create('skos:Concept');
      const input = {
        ...snak('schema:author', target),
        qualifiers: [{ property: { id: 'ex:left' }, value: { type } }, snak('ex:right', qualifierTarget)],
      };
      const subject = await f.create('schema:Book', { 'schema:author': [input] });
      const projection = await complete(f, source, subject);
      expect(projection.records).toHaveLength(1);
      const record = projection.records[0]!;
      expect(record.indexed, 'Concrete main value cannot hide unresolved qualifier coverage').toBeNull();
      expect(record.statement.value).toEqual(input.value);
      expect(
        record.statement.qualifiers.map(({ property, value }) => ({ property: { id: property.id }, value })),
      ).toEqual(input.qualifiers);
      expect(record.candidate).toBe(record.statement.id);
      expect(record.release).toBe(f.meaning.digest);
      expect(record.statement.rezics).toEqual({ release: record.release, revision: record.revision });
      expect(record.dependencies.some((key) => key.kind === 'selection' && key.candidate === record.candidate)).toBe(
        true,
      );
      expect(record.dependencies.some((key) => key.kind === 'subject' && key.subject === qualifierTarget)).toBe(true);
      await f.post(`/v1/subjects/${qualifierTarget}:hide`, { reason: 'Concrete dependency beside unknown qualifier' });
      const hidden = await complete(f, source, subject);
      expect(hidden.records).toEqual([]);
      expect(hidden.repairLocators.some((locator) => locator.candidate === record.candidate)).toBe(true);
    }
  } finally {
    await f.close();
  }
});
