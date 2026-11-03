import { expect, test } from 'bun:test';
import { createLibraryShelvesDriver } from './support/native-shelves-driver.ts';
import { createNativeShelfTypePauses } from './support/native-shelf-type-pause.ts';

test('entry pause reaches the installed source observer and resumes the HTTP command', async () => {
  const driver = await createLibraryShelvesDriver();
  try {
    const subject = await driver.provisionSubject();
    const pause = await driver.pauseTypeWork({ workflow: 'entry', boundary: 'sourceObserved', subjectId: subject.id });
    let finished = false;
    const creating = driver
      .request('owner', {
        method: 'PUT',
        path: `/v1/libraryEntries/${subject.id}`,
        headers: { 'Idempotency-Key': `"${Bun.randomUUIDv7()}"` },
        body: { state: 'planned' },
      })
      .then((response) => {
        finished = true;
        return response;
      });
    const observed = await Promise.race([
      pause.reached,
      creating.then(async (response) => {
        throw new Error(
          `Entry command completed before its source observation: ${response.status} ${await response.text()}`,
        );
      }),
    ]);
    expect(observed.sourceId).toBe(subject.id);
    expect(typeof observed.stamp.position).toBe('bigint');
    expect(finished).toBe(false);
    expect((await driver.inspect()).entries).toHaveLength(0);
    await driver.settle({ exceptPaused: true });
    expect(finished).toBe(false);
    await pause.resume();
    expect(finished).toBe(true);
    expect((await creating).status).toBe(201);
    expect((await driver.inspect()).entries[0]?.sourceStamp).toEqual(observed.stamp);
  } finally {
    await driver.close();
  }
}, 240_000);

test('latches select one execution, isolate worlds and release on close or error', async () => {
  const world = createNativeShelfTypePauses(),
    other = createNativeShelfTypePauses();
  const selection = {
    workflow: 'entry',
    boundary: 'sourceObserved',
    subjectId: 'subject',
    accountId: 'owner',
  } as const;
  const observation = {
    accountId: 'owner',
    subjectId: 'subject',
    sourceId: 'survivor',
    stamp: { partition: 3, epoch: 7, position: 9007199254740993n },
  };
  const first = await world.pause(selection),
    second = await world.pause(selection);
  try {
    await other.run(() => other.observe(observation));
    await world.run(() => world.observe({ ...observation, accountId: 'other' }));
    let completed = 0;
    const one = world.run(async () => {
      await world.observe(observation);
      completed++;
    });
    expect(await first.reached).toEqual({ sourceId: observation.sourceId, stamp: observation.stamp });
    const two = world.run(async () => {
      await world.observe(observation);
      completed++;
    });
    await second.reached;
    await world.run(() => world.observe(observation)); // Already selected latches are one-shot.
    await first.resume();
    expect(completed).toBe(1);
    await world.settle({ exceptPaused: true });
    await world.close();
    await Promise.all([one, two]);
    expect(completed).toBe(2);
    const abandoned = await other.pause(selection);
    await expect(
      other.run(async () => {
        throw new Error('request failed');
      }),
    ).rejects.toThrow('request failed');
    await expect(abandoned.reached).rejects.toThrow('closed before reaching');
  } finally {
    await Promise.all([world.close(), other.close()]);
  }
});

test('absent projection producers name their exact remaining interfaces', async () => {
  const pauses = createNativeShelfTypePauses();
  for (const boundary of ['entryObserved', 'sourceObserved'] as const) {
    await expect(pauses.pause({ workflow: 'verify', boundary, subjectId: 'subject' })).rejects.toThrow(
      'verifyShelfEntryType(eventId: string, accountId: string, subjectId: string, dependencies: ShelfProjectionDependencies)',
    );
  }
  await expect(pauses.pause({ workflow: 'sync', boundary: 'sourceObserved', subjectId: 'subject' })).rejects.toThrow(
    'syncShelfSubjectType(change: ShelfTypeChange, dependencies: ShelfProjectionDependencies)',
  );
  await pauses.close();
});
