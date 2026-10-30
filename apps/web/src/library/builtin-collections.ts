import { dynamicCollectionTitle, type DynamicBuiltinKind } from './dynamic-collection';

export type BuiltinCollectionRecord = {
  id: string;
  title?: string | null;
  membershipKind?: string;
  builtinKind?: DynamicBuiltinKind;
  builtinLabels?: Record<string, string>;
};

export type BuiltinCollectionDestination = {
  id: string;
  title: string;
  kind: 'everything' | 'liked';
};

/** Use only the built-in identities returned by the owner's Collection list. */
export function builtinCollectionDestinations(
  collections: readonly BuiltinCollectionRecord[],
  locale = 'en',
): BuiltinCollectionDestination[] {
  return collections.flatMap((collection) => {
    if (
      collection.membershipKind !== 'dynamic' ||
      (collection.builtinKind !== 'everything' && collection.builtinKind !== 'liked')
    )
      return [];
    const kind = collection.builtinKind as 'everything' | 'liked';
    return [
      {
        id: collection.id,
        title: dynamicCollectionTitle(
          {
            builtinKind: kind,
            title: collection.title ?? null,
            ...(collection.builtinLabels ? { builtinLabels: collection.builtinLabels } : {}),
          },
          locale,
        ),
        kind,
      },
    ];
  });
}
