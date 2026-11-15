import { createContext } from 'react';
import type { OverviewValue } from './overview';
import { subjectViewHref } from '../../subject/load-subject';

/** Page-section context lives in this leaf so data components can read it without joining the overview cycle. */
export const OverviewContext = createContext<OverviewValue | null>(null);

export function viewHref(value: OverviewValue, view: string, property?: string): string | null {
  if (
    value.agentBase !== undefined &&
    property === undefined &&
    (view === 'posts' || view === 'reviews' || view === 'collections')
  )
    return `${value.agentBase}/${view}`;
  const href = value.subject
    ? subjectViewHref(
        { id: value.subject, label: value.subjectLabel || value.unlabelled },
        value.locale,
        view,
        property === undefined ? '' : `?property=${encodeURIComponent(property)}`,
      )
    : null;
  const realm = value.realm ?? (value.context?.population.kind === 'realm' ? value.context.population.id : undefined);
  if (!href || !realm) return href;
  return `${href}${href.includes('?') ? '&' : '?'}realm=${encodeURIComponent(realm)}`;
}
