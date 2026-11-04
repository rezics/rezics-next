import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { subjectChangesReturnForCorrection } from './subject-changes-navigation';
import { SubjectTermsPage } from './subject-terms-page';
import { loadCatalogueTerms, saveCatalogueTerms } from './subject-terms-actions';
import { readCreateDefinitions } from './create-subject-actions';
import { editorRequest } from './editor-request';
import { m } from '../../paraglide/messages.js';

export const SubjectTermsSession = candidateSession(function SubjectTermsSession({
  id,
  locale,
  returnToChanges,
}: {
  id: string;
  locale: string;
  returnToChanges?: boolean;
}) {
  const work = useCatalogueLifetime('terms-transport');
  const { state, csrfToken, subject: reader } = useSession();
  const returnHref =
    returnToChanges && state === 'signed-in' && reader
      ? subjectChangesReturnForCorrection({ kind: 'terms', subject: id }, reader)?.href
      : undefined;
  const definitions = useQuery({
    queryKey: ['catalogue-create', 'definitions', locale],
    queryFn: () => readCreateDefinitions({ data: false }),
    retry: false,
  });
  const typeLabels = definitions.data?.ok
    ? Object.fromEntries(definitions.data.types.map((type) => [type.id, type.label]))
    : {};
  return (
    <>
      {returnHref && (
        <div className="mx-auto w-full max-w-4xl px-6 pt-4">
          <Link
            className="inline-flex min-h-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            to={returnHref as never}
          >
            {m.changes_return_to_changes()}
          </Link>
        </div>
      )}
      <SubjectTermsPage
        id={id}
        locale={locale}
        session={state}
        typeLabels={typeLabels}
        transport={{
          read: (subject, session) =>
            loadCatalogueTerms({
              data: { expectedReader: work.reader || null, id: subject, ...(session ? { session } : {}) },
            }),
          submit: (command) =>
            saveCatalogueTerms({ data: editorRequest(command, work), headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
        }}
      />
    </>
  );
});
