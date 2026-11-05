import { BookPlus } from 'lucide-react';
import type { NavigationContribution } from '../../shell/navigation';
import { m } from '../../paraglide/messages.js';

export const catalogueNavigation: readonly NavigationContribution[] = [
  {
    id: 'semantic.create-subject',
    kind: 'creation',
    group: 'create',
    order: 10,
    href: '/catalogue/new',
    signedIn: true,
    operation: 'subject.create',
    label: ({ locale }) => m.catalogue_create_title({}, { locale }),
    icon: BookPlus,
  },
];
