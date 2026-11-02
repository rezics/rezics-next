import { Globe } from 'lucide-react';
import type { NavigationContribution } from '../shell/navigation';
import { m } from '../paraglide/messages.js';

export const communityNavigation: readonly NavigationContribution[] = [
  {
    id: 'community.create-realm',
    kind: 'creation',
    group: 'create',
    order: 20,
    href: '/realms/new',
    signedIn: true,
    operation: 'realm.create',
    label: ({ locale }) => m.space_setup_heading({}, { locale }),
    icon: Globe,
  },
];
