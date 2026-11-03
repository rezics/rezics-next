import { compileCatalogue } from '@rezics/definitions/compile';
import type {
  DynamicCollectionsDriver,
  ProfileFixture,
  ProfileName,
} from '../../../../../specs/dynamic-collections-driver.ts';
import { createLibraryDriver } from './outcome-driver.ts';
import { mountCollectionInZone } from './native-zone-collection-fixture.ts';
import { profileSources, profileTypes } from './native-conformance-profiles.ts';
import {
  deleteAccount,
  grantSubjectRead,
  json,
  publish,
  setEntry,
  unavailable,
  write,
  type NativeConformanceWorld,
} from './native-conformance.ts';
import { provisionOwnerReadableSubject } from './native-private-subject.ts';
import { inspectNativeDynamicCollections } from './native-dynamic-inspection.ts';
import { replayProjectionEvents } from './native-dynamic-replay.ts';
import type { StateReferenceRepairLatch } from './native-state-reference-repair.ts';
import { createNativePrivateFactsFixture } from './native-private-facts-fixture.ts';

export type NativeDynamicCollectionsDriver = Omit<DynamicCollectionsDriver, 'holdStateReferenceRepair'> & {
  world: NativeConformanceWorld;
  holdStateReferenceRepair(): Promise<StateReferenceRepairLatch>;
};

/** Compile source declarations and use only the accepted release to describe a fixture's meaning. */
export async function createDynamicCollectionsDriver(
  installedWorld?: NativeConformanceWorld,
): Promise<NativeDynamicCollectionsDriver> {
  const world = installedWorld ?? (await createLibraryDriver());
  try {
    const input = profileSources('profile-v1');
    let release = await compileCatalogue(input);
    let digest = await publish(world, release);
    const fixture = (name: ProfileName): ProfileFixture => {
      const typeId = profileTypes[name];
      const reference = release.types[typeId]?.library;
      const profile = reference && release.libraryProfiles?.[reference.profileId];
      if (!profile?.entryStateSet) return unavailable(`accepted ${name} state profile`);
      return {
        typeId,
        profileId: profile.id,
        stateSetId: profile.entryStateSet.id,
        releaseDigest: digest,
        states: profile.entryStateSet.states.map((state) => ({
          id: state.id,
          labels: state.labels,
        })),
      };
    };
    const profiles = {
      game: fixture('game'),
      recipe: fixture('recipe'),
      record: fixture('record'),
    };
    const labels = new Map<string, string>();
    const privateFacts = createNativePrivateFactsFixture(world);
    const driver: NativeDynamicCollectionsDriver = {
      world,
      accounts: world.accounts,
      profiles,
      unknown: world.unknown,
      now: world.now,
      setTime: world.setTime,
      rotateListCursorKey: world.native.rotateCursorKeys,
      request: world.native.request,
      async provisionSubject(name, options) {
        const typeId = name === 'unprofiled' ? profileTypes.people : profileTypes[name];
        const subject = options?.ownerOnlyReadable
          ? await provisionOwnerReadableSubject(world, typeId)
          : await world.native.subject(typeId);
        return { id: subject.id, typeId, profileId: name === 'unprofiled' ? null : profiles[name].profileId };
      },
      async activateProfileRelease(name, change) {
        const schema = JSON.parse(input.schemas['fixture.yaml']!);
        const className = name === 'game' ? 'Parent' : name === 'recipe' ? 'Recipe' : 'Record';
        const declaration = schema.classes[className].annotations.library;
        declaration.entryStateSet.states = change.states.map((state) => ({
          id: state.id,
        }));
        for (const [key, source] of Object.entries(input.presentation)) {
          if (!key.startsWith('fixture/')) continue;
          const locale = key.slice('fixture/'.length);
          const presentation = JSON.parse(source);
          presentation.libraryProfiles[declaration.id].states = Object.fromEntries(
            change.states.map((state) => [state.id, state.labels[locale]]),
          );
          input.presentation[key] = JSON.stringify(presentation);
        }
        input.schemas['fixture.yaml'] = JSON.stringify(schema);
        release = await compileCatalogue(input);
        digest = await publish(world, release);
        for (const key of ['game', 'recipe', 'record'] as const) profiles[key] = fixture(key);
        return profiles[name];
      },
      async retireProfile(name) {
        const schema = JSON.parse(input.schemas['fixture.yaml']!);
        const className = name === 'game' ? 'Parent' : name === 'recipe' ? 'Recipe' : 'Record';
        const removed = [schema.classes[className].annotations.library.id];
        delete schema.classes[className].annotations.library;
        // Parent must not inherit Root's otherwise applicable profile after retirement.
        if (name === 'game') {
          removed.push(schema.classes.Root.annotations.library.id);
          delete schema.classes.Root.annotations.library;
        }
        for (const [key, source] of Object.entries(input.presentation)) {
          if (!key.startsWith('fixture/')) continue;
          const presentation = JSON.parse(source);
          for (const id of removed) delete presentation.libraryProfiles[id];
          input.presentation[key] = JSON.stringify(presentation);
        }
        input.schemas['fixture.yaml'] = JSON.stringify(schema);
        release = await compileCatalogue(input);
        digest = await publish(world, release);
      },
      setSubjectReadability: (id, viewer, readable) => grantSubjectRead(world, id, viewer, readable),
      setEntryState: (id, state) => setEntry(world, 'owner', id, state),
      clearEntryState: (id) => setEntry(world, 'owner', id, null),
      async addLabel(id, name) {
        let labelId = labels.get(name);
        if (!labelId) {
          const created = await json<{ label: { id: string } }>(
            await write(world, 'owner', 'POST', '/v1/libraryLabels', { name }),
            201,
          );
          labelId = created.label.id;
          labels.set(name, labelId);
        }
        return write(world, 'owner', 'POST', `/v1/libraryLabels/${labelId}:assign`, { subjectId: id });
      },
      async removeLabel(subjectId, name) {
        const labelId = labels.get(name);
        if (!labelId) throw new Error('No label was provisioned under this fixture name');
        return privateFacts.removeLabels(subjectId, labelId);
      },
      startProgressSession: (subjectId) =>
        write(world, 'owner', 'POST', '/v1/progressSessions', {
          subjectId,
          mode: 'scalar_amount',
          unit: 'minute',
        }),
      createHolding: (subjectId) =>
        write(world, 'owner', 'POST', '/v1/copies', {
          subjectId,
          kind: 'physical',
          status: 'owned',
        }),
      removeAllPrivateFacts: privateFacts.removeAllPrivateFacts,
      deleteAccount: () => deleteAccount(world),
      mountCollection: (collectionId) => mountCollectionInZone(world.native.request, collectionId),
      async exportCollection() {
        return unavailable('common Collection export command binding');
      },
      async runCollectionBulkAction() {
        return unavailable('production durable Library bulk command binding');
      },
      holdProjectionConsumer: world.native.hold,
      async resumeAndSettle() {
        await world.native.resume();
        await world.settle();
        return unavailable('native durable preparation step observations');
      },
      replayProjectionEvents: (order) => replayProjectionEvents(world, order),
      async seedUnrelatedFacts() {
        return unavailable('native independently shaped dynamic population fixture');
      },
      inspect: () => inspectNativeDynamicCollections(world),
      async measure(operation) {
        await world.native.capture(operation);
        return unavailable('native owner-plan, candidate and Search iterator observations');
      },
      async measureStateReference(operation) {
        await world.native.capture(operation);
        return unavailable('native opaque state-reference probe observations');
      },
      holdStateReferenceRepair: world.native.stateReferenceRepair.hold,
      async repairStateReferences() {
        const run = await world.native.stateReferenceRepair.start();
        await run.result;
      },
      close: world.close,
    };
    return driver;
  } catch (error) {
    await world.close();
    throw error;
  }
}
