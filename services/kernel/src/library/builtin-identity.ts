import { derivedId, routeOf } from '../route/route.ts';

export type BuiltinCollectionKey =
  | Readonly<{ kind: 'everything' }>
  | Readonly<{ kind: 'state'; profileId: string; stateSetId: string; stateId: string }>;

function assertMetadataId(value: unknown): asserts value is string {
  // Require the absolute end of input, including rejecting a trailing newline.
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/.test(value))
    throw new RangeError('Builtin state metadata IDs must be 1 to 64 lowercase ASCII identifier characters');
}

export function builtinCollectionId(ownerAccountId: string, key: BuiltinCollectionKey): string {
  const route = routeOf(ownerAccountId);
  if (route === null || ownerAccountId.length !== 36)
    throw new RangeError('Builtin owner must be a lowercase routable UUID');

  switch (key.kind) {
    case 'everything':
      return derivedId(ownerAccountId, JSON.stringify(['library.collection.builtin', 1, 'everything']), route);
    case 'state': {
      const { profileId, stateSetId, stateId } = key;
      assertMetadataId(profileId);
      assertMetadataId(stateSetId);
      assertMetadataId(stateId);
      return derivedId(
        ownerAccountId,
        JSON.stringify(['library.collection.builtin', 1, 'state', profileId, stateSetId, stateId]),
        route,
      );
    }
    default:
      throw new RangeError('Invalid builtin collection kind');
  }
}
