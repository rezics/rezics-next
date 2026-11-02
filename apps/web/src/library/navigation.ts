import { FolderPlus } from 'lucide-react';
import type { NavigationContribution } from '../shell/navigation';
import { m } from '../paraglide/messages.js';

export const libraryNavigation: readonly NavigationContribution[] = [
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
