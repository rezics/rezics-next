import { expect, test } from 'bun:test';
import type { CuratedMemberView } from '../../../../specs/dynamic-collections-driver.ts';
import { createDynamicCollectionsDriver } from './support/native-dynamic-driver.ts';
import { inspectNativeDynamicLibrary } from './support/native-dynamic-inspection.ts';
import { json, write } from './support/native-conformance.ts';
import { createLibraryDriver } from './support/outcome-driver.ts';

test('Dynamic inspection retains native occurrence order, private pins and original projection/event stamps', async () => {
  const world = await createLibraryDriver();
  try {
    const driver = await createDynamicCollectionsDriver(world);
    const subject = await driver.provisionSubject('game');
    const labelOnly = await driver.provisionSubject('unprofiled');
    expect((await driver.setEntryState(subject.id, driver.profiles.game.states[0]!.id)).ok).toBe(true);
    await json(await driver.startProgressSession(subject.id), 201);
    // Independent writes bypass every Dynamic driver seed map.
    await json(
      await write(world, 'owner', 'POST', '/v1/copies', {
        subjectId: subject.id,
        kind: 'physical',
        status: 'owned',
      }),
      201,
    );
    const { label } = await json<{ label: { id: string } }>(
      await write(world, 'owner', 'POST', '/v1/libraryLabels', { name: 'Independent' }),
      201,
    );
    await json(
      await write(world, 'owner', 'POST', `/v1/libraryLabels/${label.id}:assign`, {
        subjectId: labelOnly.id,
      }),
    );
    const { collection } = await json<{ collection: { id: string } }>(
      await write(world, 'owner', 'POST', '/v1/collections', { title: 'Observed', visibility: 'private' }),
      201,
    );
    const path = `/v1/collections/${collection.id}`;
    const { member: first } = await json<{ member: CuratedMemberView }>(
      await write(world, 'owner', 'POST', `${path}/members`, { subjectId: subject.id, note: 'original' }),
      201,
    );
    const { member: second } = await json<{ member: CuratedMemberView }>(
      await write(world, 'owner', 'POST', `${path}/members`, { subjectId: subject.id, after: null }),
      201,
    );
    const { collection: current } = await json<{ collection: { revision: number } }>(
      await driver.request('owner', { method: 'GET', path }),
    );
    await json(await write(world, 'owner', 'PATCH', path, { revision: current.revision, visibility: 'public' }));
    await world.settle();
    await driver.holdProjectionConsumer();

    const before = await world.inspect();
    const observed = await inspectNativeDynamicLibrary(world);
    expect(first.id).not.toBe(second.id);
    expect(observed.curatedOccurrences).toEqual(
      [second, first].map(({ id, subjectId, note }) => ({
        collectionId: collection.id,
        id,
        subjectId,
        note,
      })),
    );
    const header = observed.collections.find((row) => row.id === collection.id)!;
    expect(header).toMatchObject({
      curatorAccountId: driver.accounts.owner.id,
      membershipKind: 'curated',
      visibility: 'public',
      revision: current.revision + 1,
      frozen: false,
    });
    expect(header).not.toHaveProperty('builtinKey');
    const nativeHeader = (
      await world.native.reader.query(
        `SELECT source_generation::text AS "sourceGeneration", rule_revision::text AS "queryRevision"
         FROM library.collection WHERE collection_id=$1`,
        [collection.id],
      )
    ).rows[0];
    expect(header).toMatchObject(nativeHeader);
    expect(observed.collections.some((row) => row.builtinKey?.kind === 'everything')).toBe(true);
    expect(
      observed.collections.some(
        (row) => row.builtinKey?.kind === 'state' && row.builtinKey.profileId === driver.profiles.game.profileId,
      ),
    ).toBe(true);
    expect(observed.facts).toHaveLength(4);
    expect(observed.facts.filter((row) => row.subjectId === subject.id).map((row) => row.kind)).toEqual([
      'holding',
      'session',
      'state',
    ]);
    for (const fact of observed.facts.filter((row) => row.subjectId === subject.id)) {
      expect(fact.accountId).toBe(driver.accounts.owner.id);
      expect(fact.pin).toMatchObject({
        provenance: 'profile',
        profileId: driver.profiles.game.profileId,
        releaseDigest: driver.profiles.game.releaseDigest,
      });
    }
    expect(observed.facts.find((row) => row.subjectId === labelOnly.id)).toEqual({
      accountId: driver.accounts.owner.id,
      subjectId: labelOnly.id,
      kind: 'label',
      pin: null,
    });
    const source = (
      await world.native.reader.query(
        `SELECT basis.epoch AS "sourceEpoch", basis.position::text AS "sourcePosition"
         FROM library.collection c JOIN editorial.write_basis basis
           ON basis.partition_no=c.route>>4 AND basis.transaction_id=c.transaction_id
        WHERE c.collection_id=$1`,
        [collection.id],
      )
    ).rows[0];
    expect(source).toBeDefined();
    expect(observed.publicMembership).toEqual([
      {
        collectionId: collection.id,
        subjectId: subject.id,
        multiplicity: 2,
        ...source,
      },
    ]);
    const nativeEvents = (
      await world.native.reader.query(
        'SELECT id, type, epoch, position::text FROM core.outbox ORDER BY partition_no, position, event_seq',
      )
    ).rows;
    expect(nativeEvents.length).toBeGreaterThan(0);
    expect(observed.events).toEqual(
      nativeEvents.map(({ id, type, epoch, position }) => ({
        id,
        kind: type,
        sourceEpoch: epoch,
        sourcePosition: position,
      })),
    );
    const nativeVersions = (
      await world.native.reader.query(
        `SELECT collection_id, source_epoch, source_position::text
         FROM library.subject_collection_version ORDER BY route, collection_id, subject_id`,
      )
    ).rows;
    expect(nativeVersions.length).toBeGreaterThan(0);
    expect(observed.projections).toEqual(
      nativeVersions.map((row) => ({
        collectionId: row.collection_id,
        appliedEpoch: row.source_epoch,
        appliedPosition: row.source_position,
        terminal: false,
      })),
    );
    expect(observed.projections).toContainEqual({
      collectionId: collection.id,
      appliedEpoch: source.sourceEpoch,
      appliedPosition: source.sourcePosition,
      terminal: false,
    });
    expect(await inspectNativeDynamicLibrary(world)).toEqual(observed);
    expect(await world.inspect()).toEqual(before);

    // A missing complete snapshot must fail this suite. In particular, neither an
    // empty Search array nor Subject/public-membership rows prove Search exclusions.
    try {
      const complete = await driver.inspect();
      expect(observed.publicMembership).toEqual(complete.publicMembership);
      expect(complete.searchDocuments).toContainEqual({ subjectId: subject.id, source: 'catalogue' });
      expect(complete.searchDocuments.filter((row) => row.source === 'personal')).toEqual([]);
    } finally {
      expect(await inspectNativeDynamicLibrary(world)).toEqual(observed);
      expect(await world.inspect()).toEqual(before);
    }
  } finally {
    await world.close();
  }
}, 180_000);
