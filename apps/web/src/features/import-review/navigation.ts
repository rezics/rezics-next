import { ListChecks } from 'lucide-react';
import type { NavigationContribution } from '../../shell/navigation';
import { m } from '../../paraglide/messages.js';

export const importReviewNavigation: readonly NavigationContribution[] = [
  {
    id: 'semantic.provider-review',
    kind: 'navigation',
    group: 'personal',
    order: 38,
    href: '/imports/review',
    signedIn: true,
    operation: 'provider_review.list',
    label: ({ locale }) => m.prq_title({}, { locale }),
    icon: ListChecks,
  },
];
