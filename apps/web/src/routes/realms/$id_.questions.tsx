import { createFileRoute } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { prepareQuestionManagementVisit } from '../../ratings/question-management/actions';
import { QuestionManagementPage } from '../../ratings/question-management/page';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import type { QuestionManagementVisit } from '../../ratings/question-management/types';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Search = { selectedQuestionId?: string; cursor?: string; invalidAddress?: true };

function searchAddress(input: Record<string, unknown>): Search {
  const selectedQuestionId = input.selectedQuestionId;
  const cursor = input.cursor;
  if (
    (selectedQuestionId !== undefined && (typeof selectedQuestionId !== 'string' || !idPattern.test(selectedQuestionId))) ||
    (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 4096))
  )
    return { invalidAddress: true };
  return {
    ...(typeof selectedQuestionId === 'string' ? { selectedQuestionId } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

export const Route = createFileRoute('/realms/$id/questions')({
  beforeLoad: requireSignedIn,
  validateSearch: searchAddress,
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }): Promise<QuestionManagementVisit> => {
    if (!idPattern.test(params.id) || 'invalidAddress' in deps)
      return {
        realmId: params.id,
        selectedQuestionId: null,
        cursor: null,
        locale: getLocale(),
        viewer: null,
        credentialEpisode: null,
        csrfEpisode: null,
        state: 'invalid-address',
      };
    return prepareQuestionManagementVisit({
      data: {
        realmId: params.id,
        ...('selectedQuestionId' in deps ? { selectedQuestionId: deps.selectedQuestionId } : {}),
        ...('cursor' in deps ? { cursor: deps.cursor } : {}),
      },
    });
  },
  head: ({ match }) =>
    pageHead({ title: m.realm_question_management_link(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: QuestionManagementRoute,
});

function QuestionManagementRoute() {
  const initial = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const locale = getLocale();
  const address = 'invalidAddress' in search
    ? null
    : {
        selectedQuestionId: search.selectedQuestionId ?? null,
        cursor: search.cursor ?? null,
      };
  return (
    <QuestionManagementPage
      key={JSON.stringify([initial.realmId, initial.viewer, initial.credentialEpisode, initial.csrfEpisode, locale, address])}
      initial={initial}
      address={address}
      locale={locale}
      navigate={(search) => void navigate({ search })}
    />
  );
}
