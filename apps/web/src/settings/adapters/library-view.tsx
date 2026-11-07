import type { ComponentProps } from 'react';
import { CollectionPrivacySection, CollectionPrivacyView } from '../collection-privacy';
import { ShelfPreferencesCard } from '../shelf-preferences';
import { readSettingsShelfTypes } from './library.ts';

/** Route composition binds Library type discovery into the existing Shelf editor. */
export function BoundShelfPreferencesCard(
  props: Omit<ComponentProps<typeof ShelfPreferencesCard>, 'readTypes'> & {
    readTypes?: ComponentProps<typeof ShelfPreferencesCard>['readTypes'];
  },
) {
  return <ShelfPreferencesCard {...props} readTypes={props.readTypes ?? readSettingsShelfTypes} />;
}

/** The same private owner inventory feeds the real Collection privacy UI. */
export function BoundCollectionPrivacySection() {
  return <CollectionPrivacySection />;
}

export function BoundCollectionPrivacyView(props: ComponentProps<typeof CollectionPrivacyView>) {
  return <CollectionPrivacyView {...props} />;
}
