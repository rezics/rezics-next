import type { NavigationContribution } from '../../shell/navigation';
import { m } from '../../paraglide/messages.js';

export const contextsNavigation: readonly NavigationContribution[] = [
  {
    id: 'semantic.contexts',
    kind: 'navigation',
    group: 'personal',
    order: 35,
    label: ({ locale }) => m.ctxw_title({}, { locale }),
    href: '/my/contexts',
    match: 'prefix',
    signedIn: true,
  },
  {
    id: 'semantic.create-context',
    kind: 'creation',
    group: 'create',
    order: 35,
    label: ({ locale }) => m.ctxw_create({}, { locale }),
    href: '/my/contexts/new',
    signedIn: true,
  },
];
