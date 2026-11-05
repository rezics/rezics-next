import type {
  DynamicCollectionsDriver,
  ProfileFixture,
  ProfileName,
} from '../../../../../specs/dynamic-collections-driver.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { json, setEntry, write, type NativeConformanceWorld, type NativePersona } from './native-conformance.ts';

export type GrowthAxis = NonNullable<Parameters<DynamicCollectionsDriver['seedUnrelatedFacts']>[1]>;
type Profiles = Record<ProfileName, ProfileFixture>;
type Row = { subjects: string[]; labels?: string[]; collectionId?: string };
const axes: GrowthAxis[] = ['population', 'matches', 'sparse', 'history', 'owner-pools', 'aliases'];

/** Fixture identities only. Membership, canonicalization and settlement belong to the native owners. */
export async function createDynamicGrowthFixture(
  world: NativeConformanceWorld,
  profiles: Profiles,
  sparseCapacity = 4096,
) {
  if (!Number.isSafeInteger(sparseCapacity) || sparseCapacity < 0 || sparseCapacity > 4096)
    throw new RangeError('Native sparse capacity must be an integer between 0 and 4096');
  const rows: Record<GrowthAxis, Row[]> = {
    population: [],
    matches: [],
    sparse: [],
    history: [],
    'owner-pools': [],
    aliases: [],
  };
  const preceding: string[] = [];
  // Semantic allocates time-ordered IDs. Allocate genuine catalogue nonmatches before callers create their
  // selected matches; the sparse axis later grows actual owner source facts, never reserved read budgets.
  for (let index = 0; index < sparseCapacity; index++)
    preceding.push((await world.native.subject(profiles.game.typeId)).id);

  const state = (name: ProfileName) => {
    const id = profiles[name].states[0]?.id;
    if (!id) throw new Error(`Accepted ${name} profile has no entry state`);
    return id;
  };
  async function subject(name: ProfileName) {
    return (await world.native.subject(profiles[name].typeId)).id;
  }
  async function label(persona: NativePersona, name: string) {
    return (
      await json<{ label: { id: string; revision: number } }>(
        await write(world, persona, 'POST', '/v1/libraryLabels', { name }),
        201,
      )
    ).label;
  }
  async function assign(persona: NativePersona, labelId: string, subjectId: string) {
    return (
      await json<{ assignment: { id: string; revision: number } }>(
        await write(world, persona, 'POST', `/v1/libraryLabels/${labelId}:assign`, { subjectId }),
      )
    ).assignment;
  }
  async function privateFacts(persona: 'owner' | 'other', subjectId: string, name: string) {
    await json(await setEntry(world, persona, subjectId, state('recipe')), 201);
    const created = await label(persona, name);
    await assign(persona, created.id, subjectId);
    await json(
      await write(world, persona, 'POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' }),
      201,
    );
    return created.id;
  }
  let aliasCollection: string | undefined;
  async function aliases() {
    if (!aliasCollection) {
      await json(await write(world, 'steward', 'POST', '/v1/platform/exposure/subject_identity:open'));
      await json(
        await write(world, 'steward', 'POST', '/v1/grants', {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: world.native.steward.id },
          actions: ['subject:merge'],
          valid: '(,)',
        }),
        201,
      );
      aliasCollection = (
        await json<{ collection: { id: string } }>(
          await write(world, 'owner', 'POST', '/v1/collections', {
            title: 'Unrelated native alias source',
            visibility: 'private',
          }),
          201,
        )
      ).collection.id;
    }
    const originals = [await subject('game'), await subject('game')];
    for (const subjectId of [originals[0]!, originals[1]!, originals[0]!])
      await json(await write(world, 'owner', 'POST', `/v1/collections/${aliasCollection}/members`, { subjectId }), 201);
    await json(await write(world, 'steward', 'POST', '/v1/subjects:merge', { subjects: originals }));
    return { subjects: originals, collectionId: aliasCollection };
  }
  async function history(index: number): Promise<Row> {
    const subjectId = await subject('recipe');
    const created = await label('owner', `Native growth history ${index}`);
    const assignment = await assign('owner', created.id, subjectId);
    const removal = { subjectId, assignmentId: assignment.id, revision: assignment.revision };
    await json(await write(world, 'owner', 'POST', `/v1/libraryLabels/${created.id}:unassign`, removal));
    // A distinct command with the old revision must actually be rejected, rather than replayed or modeled.
    await json(await write(world, 'owner', 'POST', `/v1/libraryLabels/${created.id}:unassign`, removal), 409);
    await json(await write(world, 'owner', 'DELETE', `/v1/libraryLabels/${created.id}?revision=${created.revision}`));
    await json(await write(world, 'owner', 'POST', `/v1/libraryLabels/${created.id}:assign`, { subjectId }), 404);
    return { subjects: [subjectId], labels: [created.id] };
  }
  async function seed(total: number, axis: GrowthAxis = 'population'): Promise<void> {
    if (!Number.isSafeInteger(total) || total < 0 || total > 4096)
      throw new RangeError('Native growth total must be an integer between 0 and 4096');
    if (!axes.includes(axis)) throw new RangeError(`Unknown native growth axis: ${axis}`);
    if (axis === 'sparse' && total > preceding.length)
      throw new RangeError('Native sparse total exceeds the catalogue population prepared before selected matches');
    // Do not mutate other axes or shrink/rewrite prior facts on repeated or lower targets.
    for (let index = rows[axis].length; index < total; index++) {
      let row: Row;
      switch (axis) {
        case 'population':
          row = { subjects: [(await world.native.subject('ex:Concept')).id] };
          break;
        case 'matches':
          // These match the accepted catalogue type filter, but receive no owner private facts.
          row = { subjects: [await subject('record')] };
          break;
        case 'sparse': {
          const subjectId = preceding[index]!;
          await json(await setEntry(world, 'owner', subjectId, state('game')), 201);
          row = { subjects: [subjectId] };
          break;
        }
        case 'history':
          row = await history(index);
          break;
        case 'owner-pools': {
          const own = await subject('recipe');
          const other = await subject('recipe');
          row = {
            subjects: [own, other],
            labels: [
              await privateFacts('owner', own, `Native growth owner ${index}`),
              await privateFacts('other', other, `Native growth other ${index}`),
            ],
          };
          break;
        }
        case 'aliases':
          row = await aliases();
          break;
      }
      rows[axis].push(row);
    }
    // Includes Semantic's actual identity work and Library duplicate invalidation; no canonical map or repair loop.
    await world.settle();
  }
  return { seed, rows, preceding };
}
