import { PanelsTopLeft } from 'lucide-react';
import type { NavigationContribution } from '../shell/navigation';
import { m } from '../paraglide/messages.js';

export const threadsNavigation: readonly NavigationContribution[] = [
  {
    id: 'content.boards',
    kind: 'navigation',
    group: 'primary',
    order: 20,
    href: '/boards',
    match: 'prefix',
    label: ({ locale }) => m.board_directory_heading({}, { locale }),
    icon: PanelsTopLeft,
  },
];
