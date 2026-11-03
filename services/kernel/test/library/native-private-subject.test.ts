import { expect, test } from 'bun:test';
import { createDynamicCollectionsDriver } from './support/native-dynamic-driver.ts';
import { createLibraryLabelsDriver } from './support/native-labels-driver.ts';

test('owner-scoped Semantic subjects require an Access grant for outsider reads', async () => {
  const driver = await createDynamicCollectionsDriver();
  try {
    const subject = await driver.provisionSubject('record', { ownerOnlyReadable: true });
    const path = `/v1/subjects/${subject.id}`;
    expect((await driver.request('owner', { method: 'GET', path })).status).toBe(200);
    expect((await driver.request('other', { method: 'GET', path })).status).toBe(404);
    expect((await driver.request('anonymous', { method: 'GET', path })).status).toBe(404);
    await driver.setSubjectReadability(subject.id, 'other', true);
    expect((await driver.request('other', { method: 'GET', path })).status).toBe(200);
  } finally {
    await driver.close();
  }
});

test('Semantic moderation conceals an owner subject from the owner and all other viewers', async () => {
  const driver = await createLibraryLabelsDriver();
  try {
    const subject = await driver.provisionSubject({ unprofiled: true, ownerReadable: false });
    for (const as of ['owner', 'other', 'anonymous'] as const)
      expect((await driver.readPersonalSubject(as, subject.id)).status).toBe(404);
  } finally {
    await driver.close();
  }
});
