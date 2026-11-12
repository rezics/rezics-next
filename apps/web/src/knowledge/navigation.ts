import { NotebookPen } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import type { NavigationContribution } from '../shell/navigation';

export const knowledgeNavigation = {
  id: 'knowledge.owned',
  kind: 'navigation',
  group: 'personal',
  order: 7,
  href: '/knowledge',
  label: ({ locale }) => m.knowledge_navigation_heading({}, { locale }),
  icon: NotebookPen,
  match: 'prefix',
  signedIn: true,
  operation: 'knowledge_notebook.owned_list',
} satisfies NavigationContribution;
