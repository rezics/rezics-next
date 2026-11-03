import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useMemo, type ReactNode } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { readEditorialWorkspace, changeEditorialWorkspace } from './editorial-context-actions';
import { readEditorialSettingsChoices } from './context-settings-actions';
import { EditorialContextWorkspace } from './editorial-context-view';
import type { EditorialTransport } from './editorial-context';

export const EditorialContextSession = candidateSession(EditorialContextSessionLive);

function EditorialContextSessionLive({
  id,
  locale,
  reviewHref,
  createHref,
  children,
}: {
  id?: string;
  locale: string;
  reviewHref?: (id: string) => string;
  createHref?: string;
  children?: (id: string) => ReactNode;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const transport = useMemo<EditorialTransport>(
    () => ({
      read: (address) => readEditorialWorkspace({ data: editorRequest(address, editorWork), headers: csrfHeaders() }),
      submit: (command) =>
        changeEditorialWorkspace({ data: editorRequest(command, editorWork), headers: csrfHeaders() }),
      settings: {
        choices: (session) =>
          readEditorialSettingsChoices({
            data: editorRequest(session ? { session } : {}, editorWork),
            headers: csrfHeaders(),
          }),
        captured: (digest, session) =>
          readEditorialSettingsChoices({
            data: editorRequest({ digest, ...(session ? { session } : {}) }, editorWork),
            headers: csrfHeaders(),
          }),
      },
    }),
    [editorWork],
  );
  if (state !== 'signed-in')
    return (
      <p>
        {state === 'unavailable'
          ? m.editorial_unavailable({}, { locale: locale as never })
          : state === 'signed-out'
            ? m.account_sign_in({}, { locale: locale as never })
            : m.candidate_loading({}, { locale: locale as never })}
      </p>
    );
  return (
    <EditorialContextWorkspace
      key={`${id ?? 'new'}:${locale}`}
      {...(id ? { id } : {})}
      locale={locale}
      transport={transport}
      {...(reviewHref ? { reviewHref } : {})}
      {...(createHref ? { createHref } : {})}
      {...(children ? { children } : {})}
    />
  );
}
