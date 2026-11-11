import { BookOpen } from 'lucide-react';
import { m } from '../../paraglide/messages.js';
import type { NavigationContribution } from '../../shell/navigation';

export const bookCatalogueNavigation: NavigationContribution = {
  id: 'books.catalogue',
  kind: 'navigation',
  group: 'primary',
  order: 20,
  href: '/books',
  label: ({ locale }) => m.books_catalogue_title({}, { locale }),
  icon: BookOpen,
  match: 'prefix',
};
