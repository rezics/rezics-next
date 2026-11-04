import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
const key = () => randomUUID();
let native: NativeProfileFixture;
let commands: ReturnType<typeof createCopyCommands>;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let subjectId: string;

test('native copies preserve old absent condition operands and reject writes without released admission', async () => {
  native = await createProfileEntryFixture();
  try {
    const release = await compileCatalogue(
      fixture({
        id: 'fixture.condition-holdings',
        copies: {
          kinds: [
            { id: 'physical', statuses: [{ id: 'owned' }] },
            { id: 'digital', statuses: [{ id: 'owned' }] },
          ],
        },
      }),
    );
    await native.activate(await native.publish(release));
    owner = await native.identity(scopes);
    commands = createCopyCommands({ pool: native.pool, access: native.access, tokens: native.tokens });
    subjectId = await native.createSubject('game');

    const requestKey = key();
    const input = { subjectId, kind: 'physical', status: 'owned' };
    const created = await commands.createCopy(owner.actor, input, requestKey);
    expect(created.value.conditionFacts).toBeUndefined();
    expect((await commands.createCopy(owner.actor, input, requestKey)).replayed).toBe(true);
    await expect(
      commands.createCopy(owner.actor, { ...input, mediaCondition: 'mint' }, requestKey),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const detail = await commands.readPresentedCopy(owner.actor, created.value.id);
    expect(detail.presentation).toMatchObject({
      mediaCondition: { state: 'not_recorded' },
      packagingCondition: { state: 'not_recorded' },
      conditionEditing: { state: 'unavailable' },
    });

    await expect(
      commands.createCopy(owner.actor, { ...input, mediaCondition: 'unknown' }, key()),
    ).rejects.toBeInstanceOf(ProblemError);
    await expect(
      commands.createCopy(owner.actor, { ...input, packagingCondition: null }, key()),
    ).rejects.toBeInstanceOf(ProblemError);
    await expect(
      commands.createCopy(owner.actor, { ...input, kind: 'digital', mediaCondition: 'mint' }, key()),
    ).rejects.toBeInstanceOf(ProblemError);
    await expect(
      commands.updateCopy(owner.actor, created.value.id, { revision: 1, mediaCondition: 'mint' }, key()),
    ).rejects.toBeInstanceOf(ProblemError);
    await expect(
      commands.updateCopy(owner.actor, created.value.id, { revision: 1, packagingCondition: null }, key()),
    ).rejects.toBeInstanceOf(ProblemError);
    expect((await commands.readCopy(owner.actor, created.value.id)).revision).toBe(1);
  } finally {
    await native.close();
  }
}, 120_000);
