import { createFileRoute } from '@tanstack/react-router';
import { LiteraryProfileSession } from '../../features/catalogue/literary-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/literary')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.literary_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: LiteraryWorkPage,
});
function LiteraryWorkPage() {
  const { id } = Route.useParams();
  return <LiteraryProfileSession id={id} locale={getLocale()} />;
}
