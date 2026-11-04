import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import type { TermsCommand, TermsTransport } from './subject-terms';
import { SubjectTermsPage } from './subject-terms-page';
import { loadCatalogueTerms, readCatalogueTermsAuthority, saveCatalogueTerms } from './subject-terms-actions';
import { readCreateDefinitions } from './create-subject-actions';
import { editorRequest } from './editor-request';

export const SubjectTermsSession = candidateSession(function SubjectTermsSession({
  id,
  locale,
}: {
  id: string;
  locale: string;
}) {
  const work = useCatalogueLifetime('terms-transport');
  const { state, csrfToken } = useSession();
  const definitions = useQuery({
    queryKey: ['catalogue-create', 'definitions', locale],
    queryFn: () => readCreateDefinitions({ data: false }),
    retry: false,
  });
  const typeLabels = definitions.data?.ok
    ? Object.fromEntries(definitions.data.types.map((type) => [type.id, type.label]))
    : {};
  const transport = useMemo<TermsTransport>(
    () => ({
      read: (subject: string, session?: string) =>
        loadCatalogueTerms({
          data: { expectedReader: work.reader || null, id: subject, ...(session ? { session } : {}) },
        }),
      readAuthority: () => readCatalogueTermsAuthority({ data: { expectedReader: work.reader || null } }),
      submit: (command: TermsCommand) =>
        saveCatalogueTerms({ data: editorRequest(command, work), headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
    }),
    [csrfToken, work],
  );
  return <SubjectTermsPage id={id} locale={locale} session={state} typeLabels={typeLabels} transport={transport} />;
});
