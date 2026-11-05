import { expect, test } from 'bun:test';
import { createDynamicCollectionsFixture } from './support/native-dynamic-driver.ts';
import { json, setEntry, write } from './support/native-conformance.ts';
import type { GrowthAxis } from './support/native-dynamic-growth-fixture.ts';

test('native dynamic growth reaches totals independently, retains originals and settles real aliases', async () => {
  const { driver, world, growth } = await createDynamicCollectionsFixture(3);
  try {
    const { profiles } = driver;
    const selected = (await world.native.subject(profiles.record.typeId)).id;
    await json(await setEntry(world, 'owner', selected, profiles.record.states[0]!.id), 201);
    const { label } = await json<{ label: { id: string } }>(
      await write(world, 'owner', 'POST', '/v1/libraryLabels', { name: 'Independent selected label' }),
      201,
    );
    await json(await write(world, 'owner', 'POST', `/v1/libraryLabels/${label.id}:assign`, { subjectId: selected }));
    await world.settle();
    const entry = () =>
      world.native.request('owner', { method: 'GET', path: `/v1/libraryEntries/${selected}` }).then(json);
    const original = await entry();
    async function counts() {
      const result = await world.native.pool.query<Record<string, number>>(`SELECT
        (SELECT count(*)::int FROM semantic.revision WHERE kind='create') AS subjects,
        (SELECT count(*)::int FROM library.entry) AS entries,
        (SELECT count(*)::int FROM library.personal_label) AS labels,
        (SELECT count(*)::int FROM library.label_assignment) AS assignments,
        (SELECT count(*)::int FROM library.label_assignment WHERE deleted_at IS NOT NULL) AS inactive,
        (SELECT count(*)::int FROM library.copy) AS holdings,
        (SELECT count(*)::int FROM semantic.redirect) AS redirects,
        (SELECT count(*)::int FROM library.collection_member) AS occurrences`);
      return result.rows[0]!;
    }
    const changes: Record<GrowthAxis, Record<string, number>> = {
      population: { subjects: 1 },
      matches: { subjects: 1 },
      sparse: { entries: 1 },
      history: { subjects: 1, labels: 1, assignments: 1, inactive: 1 },
      'owner-pools': { subjects: 2, entries: 2, labels: 2, assignments: 2, holdings: 2 },
      aliases: { subjects: 2, redirects: 1, occurrences: 3 },
    };
    for (const axis of Object.keys(changes) as GrowthAxis[]) {
      const before = await counts();
      const otherAxes = structuredClone(growth.rows);
      for (const total of [1, 3]) {
        await driver.seedUnrelatedFacts(total, axis);
        expect(await counts()).toEqual(
          Object.fromEntries(
            Object.entries(before).map(([key, value]) => [key, value + total * (changes[axis][key] ?? 0)]),
          ),
        );
        expect(growth.rows[axis]).toHaveLength(total);
      }
      const grown = await counts();
      await driver.seedUnrelatedFacts(3, axis);
      await driver.seedUnrelatedFacts(1, axis);
      expect(await counts()).toEqual(grown);
      for (const other of Object.keys(changes) as GrowthAxis[])
        if (other !== axis) expect(growth.rows[other]).toEqual(otherAxes[other]);
      expect(await entry()).toEqual(original);
    }
    const catalogueMatches = growth.rows.matches.flatMap((row) => row.subjects);
    const privateMatches = await world.native.pool.query(
      `SELECT subject_id FROM library.entry WHERE subject_id=ANY($1::uuid[])
       UNION ALL SELECT subject_id FROM library.label_assignment WHERE subject_id=ANY($1::uuid[])
       UNION ALL SELECT subject_id FROM library.copy WHERE subject_id=ANY($1::uuid[])`,
      [catalogueMatches],
    );
    expect(privateMatches.rows).toEqual([]);
    const actualOrder = await world.native.pool.query<{ subject_id: string }>(
      'SELECT subject_id FROM library.entry WHERE account_id=$1 ORDER BY subject_id',
      [world.accounts.owner.id],
    );
    expect(actualOrder.rows.slice(0, 3).map((row) => row.subject_id)).toEqual(growth.preceding);
    expect(actualOrder.rows[3]!.subject_id).toBe(selected);
    for (const row of growth.rows['owner-pools']) {
      const owners = await world.native.pool.query<{ account_id: string }>(
        'SELECT account_id FROM library.entry WHERE subject_id=ANY($1::uuid[]) ORDER BY account_id',
        [row.subjects],
      );
      expect(owners.rows.map((owner) => owner.account_id)).toEqual(
        [world.accounts.owner.id, world.accounts.other.id].sort(),
      );
    }
    for (const row of growth.rows.aliases) {
      const redirect = await world.native.pool.query<{ target: string }>(
        'SELECT target FROM semantic.redirect WHERE subject_id=$1',
        [row.subjects[1]],
      );
      expect(redirect.rows).toEqual([{ target: row.subjects[0]! }]);
      const originals = await world.native.pool.query<{ subject_id: string }>(
        'SELECT subject_id FROM library.collection_member WHERE collection_id=$1 ORDER BY ordinal_key',
        [row.collectionId],
      );
      // Each real merged pair retains x/y/x occurrences; no driver rewrites stored references.
      expect(
        originals.rows.filter((member) => row.subjects.includes(member.subject_id)).map((member) => member.subject_id),
      ).toEqual([row.subjects[0]!, row.subjects[1]!, row.subjects[0]!]);
    }
    expect(
      (
        await world.native
          .request('owner', {
            method: 'GET',
            path: `/v1/libraryLabelAssignments?subjectId=${selected}`,
          })
          .then(json<{ assignments: { labelId: string }[] }>)
      ).assignments.map((assignment) => assignment.labelId),
    ).toEqual([label.id]);
    const unchanged = await counts();
    await driver.seedUnrelatedFacts(0);
    for (const total of [-1, 1.5, 4097]) await expect(driver.seedUnrelatedFacts(total)).rejects.toThrow(RangeError);
    await expect(driver.seedUnrelatedFacts(4, 'sparse')).rejects.toThrow(RangeError);
    expect(await counts()).toEqual(unchanged);
  } finally {
    await world.close();
  }
}, 300000);
