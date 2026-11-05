import { parseLiteraryCurrentVisit } from '../../features/catalogue/literary-current-visit';
import { createFileRoute } from '@tanstack/react-router';
import { LiteraryProfileSession } from '../../features/catalogue/literary-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/literary')({
  staticData: { publicCache: false },
  loader: ({ params, location }) => ({ visit: parseLiteraryCurrentVisit(location.searchStr, params.id, getLocale()) }),
  head: () => ({ meta: [{ title: m.literary_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: LiteraryWorkPage,
});
function LiteraryWorkPage() {
  const { id } = Route.useParams();
  const { visit } = Route.useLoaderData();
  return <LiteraryProfileSession id={id} locale={getLocale()} visit={visit} address={JSON.stringify(visit)} />;
}
