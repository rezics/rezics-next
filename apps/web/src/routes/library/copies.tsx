import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { CopiesPage } from '../../library/copies-page';
import { readCopiesPage } from '../../library/copies-actions';
import { copiesSubjectId } from '../../library/copies-query';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/copies')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => {
    const subjectId = copiesSubjectId(search.subjectId);
    return {
      ...(subjectId ? { subjectId } : {}),
      ...(typeof search.cursor === 'string' && search.cursor.length > 0 && search.cursor.length <= 2048
        ? { cursor: search.cursor }
        : {}),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readCopiesPage({ data: deps }),
  head: ({ match }) =>
    pageHead({ title: m.library_copy_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: CopiesRoute,
});

function CopiesRoute() {
  return <CopiesPage page={Route.useLoaderData()} />;
}
