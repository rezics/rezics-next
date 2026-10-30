import { useMemo, type ReactNode } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { readEditorialWorkspace, changeEditorialWorkspace } from './editorial-context-actions';
import { EditorialContextWorkspace } from './editorial-context-view';
import type { EditorialTransport } from './editorial-context';

export function EditorialContextSession({ id, locale, reviewHref, createHref, children }: {
  id?: string;
  locale: string;
  reviewHref?: (id: string) => string;
  createHref?: string;
  children?: (id: string) => ReactNode;
}) {
  const { state } = useSession();
  const transport = useMemo<EditorialTransport>(() => ({
    read: (address) => readEditorialWorkspace({ data: address, headers: csrfHeaders() }),
    submit: (command) => changeEditorialWorkspace({ data: command, headers: csrfHeaders() }),
  }), []);
  if (state !== 'signed-in') return <p>{state === 'unavailable' ? m.editorial_unavailable({}, { locale: locale as never }) : state === 'signed-out' ? m.relation_sign_in({}, { locale: locale as never }) : m.candidate_loading({}, { locale: locale as never })}</p>;
  return <EditorialContextWorkspace key={`${id ?? 'new'}:${locale}`} {...(id ? { id } : {})} locale={locale} transport={transport}
    {...(reviewHref ? { reviewHref } : {})} {...(createHref ? { createHref } : {})} {...(children ? { children } : {})} />;
}
