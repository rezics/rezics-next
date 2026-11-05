import type { Anchor } from '../../../../../specs/library-driver.ts';
import { json, write, type NativeConformanceWorld } from './native-conformance.ts';

async function expectSubjectStatus(
  world: NativeConformanceWorld,
  as: 'owner' | 'other' | 'anonymous',
  id: string,
  expected: number,
) {
  const response = await world.native.request(as, { method: 'GET', path: `/v1/subjects/${id}` });
  const body = await response.text();
  if (response.status !== expected)
    throw new Error(`Native subject ${id} returned HTTP ${response.status} for ${as}, expected ${expected}: ${body}`);
}

async function expectConcealedFromNonOwners(world: NativeConformanceWorld, id: string) {
  await expectSubjectStatus(world, 'other', id, 404);
  await expectSubjectStatus(world, 'anonymous', id, 404);
}

/** Create through Semantic as the Library owner and verify real owner-only Access visibility. */
export async function provisionOwnerReadableSubject(world: NativeConformanceWorld, type: string): Promise<Anchor> {
  const subject = await world.native.subject(type, 'owner');
  await expectSubjectStatus(world, 'owner', subject.id, 200);
  await expectConcealedFromNonOwners(world, subject.id);
  return subject;
}

/** Apply Semantic moderation to a real owner subject when a fixture needs it concealed from everyone. */
export async function provisionOwnerUnreadableSubject(world: NativeConformanceWorld, type: string): Promise<Anchor> {
  const subject = await provisionOwnerReadableSubject(world, type);
  const result = await json<{ subject: string; visibility: string }>(
    await write(world, 'steward', 'POST', `/v1/subjects/${subject.id}:hide`, {
      reason: 'Native Library fixture requires a concealed subject',
    }),
    200,
  );
  if (result.subject !== subject.id || result.visibility !== 'hidden')
    throw new Error(`Semantic moderation did not hide native subject ${subject.id}`);
  await expectSubjectStatus(world, 'owner', subject.id, 404);
  await expectConcealedFromNonOwners(world, subject.id);
  return subject;
}
