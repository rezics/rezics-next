import { m } from '../paraglide/messages.js';
import type { PersonalShelfColumnId } from './settings-contract';

export function shelfColumnLabel(id: PersonalShelfColumnId): string {
  switch (id) {
    case 'cover':
      return m.library_column_cover();
    case 'title':
      return m.library_column_title();
    case 'type':
      return m.library_column_type();
    case 'status':
      return m.library_column_status();
    case 'progress':
      return m.library_entry_progress();
    case 'added':
      return m.library_sort_created();
    case 'finished':
      return m.library_sort_finished();
    case 'lastActivity':
      return m.library_sort_activity();
  }
}
