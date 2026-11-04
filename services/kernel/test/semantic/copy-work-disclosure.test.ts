import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { copyWorkDisclosureOverlay, copyWorkProperty } from '../../src/presentation/semantic-page.ts';
import {
  COPY_WORK_DISCLOSURE_MAX_RAW,
  COPY_WORK_PROPERTY,
  readCopyWorkDisclosure,
} from '../../src/semantic/copy-work-disclosure.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createListPresentationFixture } from './support/list-presentation-fixture.ts';

const nil = '00000000-0000-0000-0000-000000000000';

async function adoptWork(
  f: Awaited<ReturnType<typeof createListPresentationFixture>>,
  edition: string,
  work: string,
) {
  const candidate = await f.propose(edition, 'schema:exampleOfWork', work);
  await f.adopt(edition, 'schema:exampleOfWork', [candidate]);
}

async function locators(
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: { security: string; revision: number }[] }> },
  edition: string,
  works: readonly string[],
) {
  const route = routeOf(edition)!;
  const head = (
    await pool.query(
      `SELECT s.security_revision::text AS security, r.revision
       FROM semantic.subject s
       JOIN LATERAL (
         SELECT revision FROM semantic.revision
         WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1
       ) r ON true
       WHERE s.route=$1 AND s.subject_id=$2`,
      [route, edition],
    )
  ).rows[0]!;
  for (const [index, work] of works.entries()) {
    await pool.query(
      `INSERT INTO semantic.outbound_link (
         route, subject_id, context_id, property, filter_value, order_key, target_subject_id,
         statement_id, slot_id, relation, source_revision, source_security_revision, target_type, value,
         present, recorded_transaction_id
       ) VALUES (
         $1,$2,$3::uuid,'schema:exampleOfWork',$4::uuid,$5,$6,$7,$8,true,$9,$10,'schema:Book','value',true,$11
       )`,
      [
        route,
        edition,
        GLOBAL_CONTEXT,
        nil,
        `z${index + 2}`,
        work,
        newId(route),
        newId(route),
        head.revision,
        head.security,
        randomUUID(),
      ],
    );
  }
}

test('native Book edition disclosure returns selected work labels and exact empty withheld overflow and denied states', async () => {
  const f = await createListPresentationFixture({ poolMax: 2 });
  try {
    expect(copyWorkDisclosureOverlay(bundledRelease, 'bf:Instance', 'en')?.unavailable).toEqual([]);
    expect(copyWorkDisclosureOverlay(bundledRelease, 'schema:Book', 'en')).toBeUndefined();
    expect(COPY_WORK_PROPERTY).toBe(copyWorkProperty);

    const work = await f.create('schema:Book', {}, { en: 'Harbour', ja: '港' });
    const empty = await f.create('bf:Instance', {}, { en: 'Empty edition' });
    const edition = await f.create('bf:Instance', {}, { en: 'Harbour paperback' });
    await adoptWork(f, edition, work);
    const person = await f.create('schema:Person', {}, { en: 'Author' });
    const extra = [
      await f.create('schema:Book', {}, { en: 'Second' }),
      await f.create('schema:Book', {}, { en: 'Third' }),
      await f.create('schema:Book', {}, { en: 'Fourth' }),
    ];
    const overflow = await f.create('bf:Instance', {}, { en: 'Omnibus' });
    await adoptWork(f, overflow, work);
    await locators(f.pool, overflow, extra);
    const partial = await f.create('bf:Instance', {}, { en: 'Partial' });
    await adoptWork(f, partial, work);
    await locators(f.pool, partial, extra.slice(0, 1));

    const deps = { ...(await f.deps('anonymous')), deadline: Date.now() + 180_000 };
    let acquired = 0;
    const acquire = () => {
      acquired++;
    };
    f.pool.on('acquire', acquire);
    try {
      await expect(
        readCopyWorkDisclosure(deps, { identities: Array(COPY_WORK_DISCLOSURE_MAX_RAW + 1).fill(edition) }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(acquired).toBe(0);
    } finally {
      f.pool.off('acquire', acquire);
    }

    const duplicates = [edition, empty, edition, person];
    const observed = await readCopyWorkDisclosure(deps, { identities: duplicates, languages: ['zh-Hans'] });
    expect(observed.results.get(edition)).toEqual({
      state: 'available',
      works: [{ id: work, labels: { en: 'Harbour' } }],
    });
    expect(observed.results.get(empty)).toEqual({ state: 'available', works: [] });
    expect(observed.results.get(person)).toEqual({ state: 'scope' });
    expect(observed.results.size).toBe(3);
    expect(await observed.current()).toBe(true);

    const overflowed = await readCopyWorkDisclosure(deps, { identities: [overflow] });
    expect(overflowed.results.get(overflow)).toEqual({ state: 'unsupported' });
    expect(JSON.stringify(overflowed.results.get(overflow))).not.toContain(extra[2]);

    const hiddenMember = await readCopyWorkDisclosure(deps, { identities: [partial] });
    expect(hiddenMember.results.get(partial)).toEqual({ state: 'withheld' });
    expect(JSON.stringify(hiddenMember.results.get(partial))).not.toContain(extra[0]);
    expect(JSON.stringify(hiddenMember.results.get(partial))).not.toContain(work);

    const assemblyWork = await f.create('schema:Book', {}, { en: 'Assembly work' });
    const assemblyEdition = await f.create('bf:Instance', {}, { en: 'Assembly edition' });
    await adoptWork(f, assemblyEdition, assemblyWork);
    let hidDuringPrepare = false;
    const assemblyAccess = deriveAccess(deps.access, {
      async prepare(actor, action, resource, context) {
        if (!hidDuringPrepare && resource.id === assemblyWork) {
          hidDuringPrepare = true;
          await f.hide(assemblyWork);
        }
        return deps.access.prepare!(actor, action, resource, context);
      },
    });
    const during = await readCopyWorkDisclosure(
      { ...deps, access: assemblyAccess },
      { identities: [assemblyEdition], languages: ['en'] },
    );
    expect(['withheld', 'unavailable']).toContain(during.results.get(assemblyEdition)?.state);
    expect(JSON.stringify(during.results.get(assemblyEdition))).not.toContain(assemblyWork);

    const mergeWork = await f.create('schema:Book', {}, { en: 'Redirected work' });
    const survivor = await f.create('schema:Book', {}, { en: 'Survivor work' });
    const mergeEdition = await f.create('bf:Instance', {}, { en: 'Redirect edition' });
    await adoptWork(f, mergeEdition, mergeWork);
    const [redirected, kept] = [mergeWork, survivor].sort() as [string, string];
    await f.checked('POST', '/v1/subjects:merge', { subjects: [redirected, kept] });
    const merged = await readCopyWorkDisclosure(deps, { identities: [mergeEdition] });
    expect(JSON.stringify(merged.results.get(mergeEdition))).not.toContain(redirected);
    expect(['available', 'unavailable']).toContain(merged.results.get(mergeEdition)?.state);

    await f.hide(work);
    expect(await observed.current()).toBe(false);
    const afterHide = await readCopyWorkDisclosure(deps, { identities: [edition] });
    expect(afterHide.results.get(edition)).toEqual({ state: 'withheld' });
    expect(JSON.stringify(afterHide.results.get(edition))).not.toContain(work);

    const deniedAccess = deriveAccess(deps.access, {
      async prepare(actor, action, resource, context) {
        if (resource.id === empty) return async () => false;
        return deps.access.prepare!(actor, action, resource, context);
      },
    });
    const deniedRead = await readCopyWorkDisclosure({ ...deps, access: deniedAccess }, { identities: [empty] });
    expect(deniedRead.results.get(empty)).toEqual({ state: 'denied' });

    const missingId = newId(routeOf(edition)!);
    expect((await readCopyWorkDisclosure(deps, { identities: [missingId] })).results.get(missingId)).toEqual({
      state: 'missing',
    });

    const again = await readCopyWorkDisclosure(deps, { identities: duplicates, languages: ['zh-Hans'] });
    expect(again.results.get(empty)).toEqual({ state: 'available', works: [] });
    expect(again.results.get(person)).toEqual({ state: 'scope' });
  } finally {
    await f.close();
  }
}, 180_000);

test('native multi-valued disclosure keeps three works and an unsupported property distinct', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const release = structuredClone(bundledRelease);
    release.properties['schema:exampleOfWork']!.multivalued = true;
    await f.publish(release);
    const works = [
      await f.create('schema:Book', {}, { en: 'First' }),
      await f.create('schema:Book', {}, { en: 'Second' }),
      await f.create('schema:Book', {}, { en: 'Third' }),
    ];
    const edition = await f.create('bf:Instance', {}, { en: 'Native omnibus' });
    const candidates = [];
    for (const work of works) candidates.push(await f.propose(edition, 'schema:exampleOfWork', work));
    await f.adopt(edition, 'schema:exampleOfWork', candidates);
    const deps = { ...(await f.deps('anonymous')), deadline: Date.now() + 180_000 };
    const observed = await readCopyWorkDisclosure(deps, { identities: [edition], languages: ['en'] });
    const found = observed.results.get(edition);
    expect(found?.state).toBe('available');
    if (found?.state === 'available') {
      expect(found.works).toHaveLength(3);
      expect(found.works.map((item) => item.id).sort()).toEqual([...works].sort());
    }
    const broken = structuredClone(release);
    broken.properties['schema:exampleOfWork']!.relation = {
      ...broken.properties['schema:exampleOfWork']!.relation!,
      group: 'association',
    };
    await f.publish(broken);
    expect((await readCopyWorkDisclosure(deps, { identities: [edition] })).results.get(edition)).toEqual({
      state: 'unsupported',
    });
  } finally {
    await f.close();
  }
}, 180_000);
