import type { NavigationContribution } from '../../../shell/navigation';
import { m } from '../../../paraglide/messages.js';

/** Static shell insertion entries; the destination always asks the backend for current authority. */
export const zonesNavigation: readonly NavigationContribution[] = [
  {
    id: 'semantic.my-zones',
    kind: 'navigation',
    group: 'personal',
    order: 40,
    label: ({ locale }) => m.zones_owner_title({}, { locale }),
    href: '/my/zones',
    signedIn: true,
    match: 'exact',
  },
  {
    id: 'semantic.create-zone',
    kind: 'creation',
    group: 'create',
    order: 40,
    label: ({ locale }) => m.zones_owner_create({}, { locale }),
    href: '/my/zones/new',
    signedIn: true,
  },
];
