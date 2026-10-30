import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { classifyUnavailability } from '../../src/access/unavailable.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, accountAgentId } from '../../src/semantic/index.ts';
import { readListPresentationFacts } from '../../src/semantic/list-presentation.ts';
import { createListPresentationFixture } from './support/list-presentation-fixture.ts';

const quantity = (amount: string) => ({ amount, unit: '1' });
const date = { time: '+2024-01-01T00:00:00Z', precision: 11, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' };

test('100 raw inputs mix current Types, duplicates, sparse and unknown subjects without empty readiness substitutes', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const author = await f.create('schema:Person', {}, { en: 'Public author' });
    const book = await f.create('schema:Book', {
      'schema:author': author,
      'schema:wordCount': quantity('+123'),
      'schema:datePublished': date,
    });
    const film = await f.create('schema:Movie', {
      'schema:duration': { amount: '+5400', unit: 'http://www.wikidata.org/entity/Q11574' },
    });
    const recipe = await f.create('schema:Recipe', {
      'schema:cookTime': { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' },
    });
    const sparse = await f.create('schema:Book');
    const unknown = newId(routeOf(book)!);
    const originals = Array.from({ length: 100 }, (_, index) => [book, film, recipe, sparse, unknown][index % 5]!);
    const values = await readListPresentationFacts(await f.deps(), originals, { languages: ['en'] });
    expect(values.size).toBe(5);
    expect(values.get(book)).toEqual({
      id: book,
      facts: {
        'schema:author': [{ kind: 'item', id: author, labels: { en: 'Public author' } }],
        'schema:datePublished': [{ kind: 'time', year: 2024 }],
        'schema:wordCount': [{ kind: 'quantity', amount: 123, unit: '1' }],
      },
    });
    expect(values.get(film)?.facts['schema:duration']).toHaveLength(1);
    expect(values.get(recipe)?.facts['schema:cookTime']).toHaveLength(1);
    expect(values.get(sparse)).toEqual({ id: sparse, facts: {} });
    expect(values.get(unknown)).toBeNull();
    expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);

test('only current Type hints and the first three actual values are projected; old releases have no vertical fallback', async () => {
  const f = await createListPresentationFixture();
  try {
    const release = structuredClone(bundledRelease);
    release.types['schema:Book']!.listPresentation = {
      imageAspect: 'portrait',
      keyFacts: ['schema:author', 'schema:datePublished', 'schema:wordCount', 'schema:inLanguage'],
    };
    await f.publish(release);
    const authors = [];
    for (let i = 0; i < 4; i++) authors.push(await f.create('schema:Person', {}, { en: `Author ${i}` }));
    const id = await f.create('schema:Book', {
      'schema:author': authors,
      'schema:datePublished': date,
      'schema:wordCount': quantity('+123'),
      'schema:inLanguage': 'en',
    });
    const value = (await readListPresentationFacts(await f.deps(), [id])).get(id)!;
    expect(Object.keys(value.facts)).toEqual(release.types['schema:Book']!.listPresentation!.keyFacts);
    expect(value.facts['schema:author']).toHaveLength(3);
    expect(value.facts['schema:inLanguage']).toEqual([{ kind: 'code', value: 'en' }]);
    const old = structuredClone(release);
    for (const type of Object.values(old.types)) delete type.listPresentation;
    await f.publish(old);
    expect((await readListPresentationFacts(await f.deps(), [id])).get(id)).toEqual({ id, facts: {} });
  } finally {
    await f.close();
  }
}, 180_000);

test('native selected Global values replace creation facts while pending, private and retracted values stay absent', async () => {
  const f = await createListPresentationFixture();
  try {
    const id = await f.create('schema:Book', { 'schema:wordCount': quantity('+1') });
    const pending = await f.propose(id, 'schema:wordCount', quantity('+2'));
    expect((await readListPresentationFacts(await f.deps('editor'), [id])).get(id)?.facts['schema:wordCount']).toEqual([
      { kind: 'quantity', amount: 1, unit: '1' },
    ]);
    await f.adopt(id, 'schema:wordCount', [pending], 1);
    expect((await readListPresentationFacts(await f.deps(), [id])).get(id)?.facts['schema:wordCount']).toEqual([
      { kind: 'quantity', amount: 2, unit: '1' },
    ]);

    const release = structuredClone(bundledRelease);
    release.types['schema:Person']!.listPresentation = { imageAspect: 'portrait', keyFacts: ['rezics:penNameOf'] };
    await f.publish(release);
    await ensureAccountAgent(f.pool, { account: f.accounts.editor, kind: 'person', name: 'Private account name' });
    const holder = await f.create('schema:Person');
    const consent = await f.propose(holder, 'rezics:penNameOf', accountAgentId(f.accounts.editor), false);
    await f.drain();
    for (const persona of ['anonymous', 'editor'] as const)
      expect((await readListPresentationFacts(await f.deps(persona), [holder])).get(holder)).toEqual({
        id: holder,
        facts: {},
      });
    await f.checked('POST', `/v1/statements/${consent}/disclose`, {});
    await f.drain();
    expect(
      (await readListPresentationFacts(await f.deps(), [holder])).get(holder)?.facts['rezics:penNameOf'],
    ).toHaveLength(1);
    await f.checked('POST', `/v1/statements/${consent}/retract`, {});
    await f.drain();
    expect((await readListPresentationFacts(await f.deps(), [holder])).get(holder)).toEqual({ id: holder, facts: {} });
  } finally {
    await f.close();
  }
}, 180_000);

test('native related-item and exact source-tuple fences are reread without leaking IDs, labels or sibling values', async () => {
  const f = await createListPresentationFixture();
  try {
    const target = await f.create('schema:Person', {}, { en: 'Secret author' });
    const id = await f.create('schema:Book', { 'schema:author': target, 'schema:wordCount': quantity('+5') });
    expect((await readListPresentationFacts(await f.deps(), [id])).get(id)?.facts['schema:author']).toHaveLength(1);
    await f.hide(target);
    const concealed = (await readListPresentationFacts(await f.deps(), [id])).get(id)!;
    expect(concealed.facts['schema:author']).toBeUndefined();
    expect(JSON.stringify(concealed)).not.toContain(target);
    expect(JSON.stringify(concealed)).not.toContain('Secret author');
    expect(concealed.facts['schema:wordCount']).toHaveLength(1);
    const imported = await f.imported('schema:wordCount', quantity('+99'));
    expect(
      (await readListPresentationFacts(await f.deps(), [imported.id])).get(imported.id)?.facts['schema:wordCount'],
    ).toHaveLength(1);
    await f.checked('POST', '/v1/sourceFences:takedown', {
      source: imported.source.source,
      externalId: imported.source.external_id,
      fieldGroup: 'facts',
      reason: 'Exact tuple withheld',
    });
    const after = (await readListPresentationFacts(await f.deps(), [imported.id])).get(imported.id);
    expect(after).toEqual({ id: imported.id, facts: {} });
  } finally {
    await f.close();
  }
}, 180_000);

test('current account T removes consent disclosures but retains deidentified public contributions', async () => {
  const f = await createListPresentationFixture();
  try {
    const id = await f.create('schema:Book', { 'schema:wordCount': quantity('+7') });
    await ensureAccountAgent(f.pool, { account: f.accounts.editor, kind: 'person', name: 'Erased name' });
    const release = structuredClone(bundledRelease);
    release.types['schema:Person']!.listPresentation = { imageAspect: 'portrait', keyFacts: ['rezics:penNameOf'] };
    await f.publish(release);
    const holder = await f.create('schema:Person');
    const consent = await f.propose(holder, 'rezics:penNameOf', accountAgentId(f.accounts.editor), false);
    await f.checked('POST', `/v1/statements/${consent}/disclose`, {});
    await f.drain();
    expect(
      (await readListPresentationFacts(await f.deps(), [holder])).get(holder)?.facts['rezics:penNameOf'],
    ).toHaveLength(1);
    await f.erase();
    const values = await readListPresentationFacts(await f.deps(), [id, holder]);
    expect(values.get(id)?.facts['schema:wordCount']).toEqual([{ kind: 'quantity', amount: 7, unit: '1' }]);
    expect(values.get(holder)).toEqual({ id: holder, facts: {} });
    expect(JSON.stringify([...values])).not.toContain('Erased name');
  } finally {
    await f.close();
  }
}, 180_000);

test('native stale identity proof never becomes positive reuse and a hidden original conceals a public terminal', async () => {
  const f = await createListPresentationFixture();
  try {
    const first = await f.create('schema:Book', { 'schema:wordCount': quantity('+10') });
    const second = await f.create('schema:Book', { 'schema:wordCount': quantity('+20') });
    const [terminal, original] = [first, second].sort() as [string, string];
    expect((await readListPresentationFacts(await f.deps(), [original])).get(original)?.id).toBe(original);
    const deps = await f.deps();
    let preparations = 0;
    const access = deriveAccess(deps.access, {
      async prepare(actor, action, resource, context) {
        if (resource.id === original && ++preparations === 2)
          await f.checked('POST', '/v1/subjects:merge', { subjects: [original, terminal] });
        return deps.access.prepare!(actor, action, resource, context);
      },
    });
    await expect(readListPresentationFacts({ ...deps, access }, [original])).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
    // The actual current store refuses an unpublished native mapping; no fixture manufactures its publication.
    await expect(readListPresentationFacts(await f.deps(), [original])).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
    await f.hide(original);
    expect((await readListPresentationFacts(await f.deps(), [original])).get(original)).toBeNull();
    expect((await readListPresentationFacts(await f.deps(), [terminal])).get(terminal)?.id).toBe(terminal);
  } finally {
    await f.close();
  }
}, 180_000);

test('overflow including duplicates, invalid controls and expired deadlines perform no native work', async () => {
  const f = await createListPresentationFixture();
  try {
    const id = await f.create('schema:Book');
    const deps = await f.deps();
    let native = 0;
    const acquire = () => {
      native++;
    };
    f.pool.on('acquire', acquire);
    try {
      await expect(readListPresentationFacts(deps, Array(101).fill(id))).rejects.toBeInstanceOf(RangeError);
      await expect(readListPresentationFacts({ ...deps, deadline: NaN }, [id])).rejects.toBeInstanceOf(TypeError);
      await expect(readListPresentationFacts({ ...deps, routeKey: new Uint8Array() }, [id])).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(readListPresentationFacts(deps, [id], { languages: [] })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      let failure: unknown;
      try {
        await readListPresentationFacts({ ...deps, deadline: Date.now() - 1 }, [id]);
      } catch (error) {
        failure = error;
      }
      expect(classifyUnavailability(failure)).toBe('deadline');
      expect(native).toBe(0);
    } finally {
      f.pool.off('acquire', acquire);
    }
  } finally {
    await f.close();
  }
}, 180_000);

test('lossy quantities are omitted and exactly representable decimal quantities retain their native units', async () => {
  const f = await createListPresentationFixture();
  try {
    const release = structuredClone(bundledRelease);
    release.types['wd:Q95074']!.listPresentation = { imageAspect: 'portrait', keyFacts: ['schema:height'] };
    await f.publish(release);
    const unsafe = await f.create('schema:Book', { 'schema:wordCount': quantity('+9007199254740993') });
    const unit = 'http://www.wikidata.org/entity/Q11573';
    const rounded = await f.create('wd:Q95074', { 'schema:height': { amount: '+1.0000000000000001', unit } });
    const tiny = await f.create('wd:Q95074', { 'schema:height': { amount: '+0.0000001', unit } });
    const values = await readListPresentationFacts(await f.deps(), [unsafe, rounded, tiny]);
    for (const id of [unsafe, rounded]) expect(values.get(id)).toEqual({ id, facts: {} });
    expect(values.get(tiny)).toEqual({
      id: tiny,
      facts: {
        'schema:height': [{ kind: 'quantity', amount: 0.0000001, unit }],
      },
    });
  } finally {
    await f.close();
  }
}, 180_000);

test('suspended and revoked native bearers fail authentication while a finite anonymous read completes', async () => {
  const f = await createListPresentationFixture();
  try {
    const id = await f.create('schema:Book', { 'schema:wordCount': quantity('+31') });
    for (const persona of ['suspended', 'revoked'] as const) {
      await expect(f.deps(persona)).rejects.toThrow();
      expect((await f.call('GET', `/v1/subjects/${id}`, undefined, persona)).status).toBe(401);
    }
    expect((await readListPresentationFacts(await f.deps(), [id])).get(id)?.facts['schema:wordCount']).toEqual([
      { kind: 'quantity', amount: 31, unit: '1' },
    ]);
  } finally {
    await f.close();
  }
}, 180_000);

test('a blocked native point read keeps deadline classification and releases its home for a finite retry', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const id = await f.create('schema:Book', { 'schema:wordCount': quantity('+19') });
    const deps = await f.deps();
    const locker = await f.db.admin.connect();
    let failure: unknown;
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE semantic.subject IN ACCESS EXCLUSIVE MODE');
      try {
        await readListPresentationFacts({ ...deps, deadline: Date.now() + 100 }, [id]);
      } catch (error) {
        failure = error;
      }
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(classifyUnavailability(failure)).toBe('deadline');
    expect((await readListPresentationFacts(await f.deps(), [id])).get(id)?.facts['schema:wordCount']).toEqual([
      { kind: 'quantity', amount: 19, unit: '1' },
    ]);
    expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);
