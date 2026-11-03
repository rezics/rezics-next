import { Compass, FolderPlus, Import } from 'lucide-react';
import type { NavigationContribution } from '../shell/navigation';
import { m } from '../paraglide/messages.js';

export const libraryNavigation: readonly NavigationContribution[] = [
  {
    id: 'library.discover-collections',
    kind: 'navigation',
    group: 'primary',
    order: 20,
    href: '/collections',
    label: ({ locale }) => m.collection_discovery_nav({}, { locale }),
    icon: Compass,
  },
  {
    id: 'library.import-mal',
    kind: 'navigation',
    group: 'personal',
    order: 16,
    href: '/library/import-mal',
    match: 'exact',
    signedIn: true,
    operation: 'library_entry.put',
    label: ({ locale }) => m.library_mal_nav({}, { locale }),
    icon: Import,
  },
  {
    id: 'library.create-collection',
    kind: 'creation',
    group: 'create',
    order: 30,
    href: '/collections/new',
    signedIn: true,
    operation: 'collection.create',
    label: ({ locale }) => m.library_collection_new({}, { locale }),
    icon: FolderPlus,
  },
];
