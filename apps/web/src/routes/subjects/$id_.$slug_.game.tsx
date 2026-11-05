import { pickText } from '@rezics/composition';
import { encodedBytes } from '../../features/catalogue/release-fidelity/model';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { parseGameVisit, gameVisitSearch, gameVisitLimit } from '../../features/catalogue/game-current-visit';
import { GameVisitNotice } from '../../features/catalogue/game-current-visit-view';
import { GameProfileSession } from '../../features/catalogue/game-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalGame = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      input.search.length > gameVisitLimit ||
      new TextEncoder().encode(input.search).byteLength > gameVisitLimit
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const intent = parseGameVisit(data.search, data.id, data.locale);
    if (!intent.valid) return { id: data.id, intent };
    const { kernelClient } = await import('../../kernel/client');
    const current = await kernelClient(data.locale).subjects({ id: data.id }).get({
      query: { context: intent.visit.context },
      fetch: { redirect: 'manual' },
    });
    if ([403, 404, 308].includes(current.status)) throw notFound();
    if (current.status !== 200 || !current.data) throw new Error('Game reading unavailable');
    if (encodedBytes(current.data) > 2 * 1024 * 1024) throw new Error('Game reading unavailable');
    const subject = current.data.subject;
    if (subject.id !== data.id || subject.context !== intent.visit.context) throw notFound();
    const canonical = subjectHref({ id: subject.id, label: pickText(subject.labels, data.locale).text }, data.locale);
    if (canonical.params.slug !== data.slug)
      throw redirect(canonicalRedirect(`${canonical.href}/game`, data.search));
    return { id: subject.id, intent };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/game')({
  staticData: { publicCache: false },
  loader: ({ params, location }) =>
    canonicalGame({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.game_profile_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: GameRoute,
});
function GameRoute() {
  const { id, intent } = Route.useLoaderData();
  if (!intent.valid) return <GameVisitNotice locale={getLocale()} invalid />;
  return <GameProfileSession id={id} locale={getLocale()} visit={intent.visit} address={gameVisitSearch(intent.visit)} />;
}
