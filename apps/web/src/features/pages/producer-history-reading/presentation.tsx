import type { ProducerHistoryMeaning } from '../../catalogue/producer-history';
import { m } from '../../../paraglide/messages.js';

export const actionClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] px-3 py-2';
export const linkClass =
  'inline-flex min-h-11 max-w-full items-center py-2 font-sans font-semibold underline [overflow-wrap:anywhere]';
export const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function meaningLabel(meaning: ProducerHistoryMeaning, locale: string) {
  const o = { locale: locale as never };
  return meaning === 'parent'
    ? m.producer_history_parent({}, o)
    : meaning === 'predecessor'
      ? m.producer_history_predecessor({}, o)
      : meaning === 'successor'
        ? m.producer_history_successor({}, o)
        : meaning === 'subsidiary'
          ? m.producer_history_subsidiary({}, o)
          : m.producer_history_credited_role({}, o);
}
