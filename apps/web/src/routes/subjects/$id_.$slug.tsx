import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { isView, type View } from '@rezics/composition';
import {
  loadSubjectPage,
  SubjectPage,
  pageRelationProperties,
  subjectPageJsonLd,
  subjectPageTitle,
  subjectPageType,
} from '../../features/pages/subject';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectTabs } from '../../features/pages/views';
import { loadSubjectReactions } from '../../features/pages/subject-reactions';
import { SubjectHeaderActions } from '../../features/pages/subject-reactions-view';
import { loadSubjectRatings } from '../../features/pages/subject-ratings';
import { RatingsContext } from '../../features/pages/subject-ratings-view';
import { kernelClient } from '../../kernel/client';
import { loadSubjectLibrarySlot } from '../../library/subject-slot';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import type { SessionEnv } from '../../session/client';
import { useSession } from '../../session/query';
import { relationLabels, typeFrame } from '../../subject/definitions';
import { keepSearch, loadSubject, subjectUrlForView } from '../../subject/load-subject';
import { loadReader } from '../../subject/load-reader';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { env } from 'cloudflare:workers';

// Page documents type their props as unknown. The kernel already returned JSON.
const readSubject = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('slug' in input) ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      !('search' in input) ||
      typeof input.search !== 'string' ||
      input.search.length > 2048 ||
      !('loadCollections' in input) ||
      typeof input.loadCollections !== 'boolean' ||
      !('slotResult' in input) ||
      (input.slotResult !== undefined && typeof input.slotResult !== 'string') ||
      !('view' in input) ||
      (input.view !== undefined && !isView(input.view))
    )
      throw notFound();
    return {
      id: input.id,
      slug: input.slug,
      locale: input.locale,
      search: input.search,
      loadCollections: input.loadCollections,
      slotResult: input.slotResult as string | undefined,
      view: input.view as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const canonical = await loadSubject(client, data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect({ href: keepSearch(subjectUrlForView(canonical.value, data.view), data.search), statusCode: 301 });

    const request = getRequest();
    const [result, library, reader, reactions, ratings] = await Promise.all([
      loadSubjectPage(client, data.id, data.view as View | undefined, data.locale),
      loadSubjectLibrarySlot(
        client,
        request,
        env as Partial<SessionEnv>,
        data.id,
        data.loadCollections,
        data.slotResult,
      ),
      loadReader(client, request, env as Partial<SessionEnv>),
      loadSubjectReactions(client, request, env as Partial<SessionEnv>, data.id),
      loadSubjectRatings(client, request, env as Partial<SessionEnv>, data.id),
    ]);
    if (result.kind === 'missing') throw notFound();
    if (result.kind === 'redirect') {
      const survivor = await loadSubject(client, result.id, data.locale as never);
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({ href: keepSearch(subjectUrlForView(survivor.value, data.view), data.search), statusCode: 301 });
    }
    const type = subjectPageType(result.page);
    const [frame, relations] = await Promise.all([
      type ? typeFrame(type, data.locale) : Promise.resolve<Awaited<ReturnType<typeof typeFrame>>>({}),
      relationLabels(pageRelationProperties(result.page), data.locale),
    ]);
    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    const verification = {
      sitekey: config.TURNSTILE_SITE_KEY ?? '',
      scriptUrl:
        (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    };
    return {
      page: result.page,
      library,
      reader,
      frame,
      relations,
      tabs: subjectTabs(result.page),
      reactions,
      ratings,
      verification,
      paths: canonical.value.paths,
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug')({
  validateSearch: (search: Record<string, unknown>): { slot?: 'collections'; slotResult?: string } => ({
    ...(search.slot === 'collections' ? { slot: 'collections' as const } : {}),
    ...(typeof search.slotResult === 'string' ? { slotResult: search.slotResult } : {}),
  }),
  loaderDeps: ({ search }) => ({ slot: search.slot, slotResult: search.slotResult }),
  loader: ({ params, deps, location }) =>
    readSubject({
      data: {
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        search: location.searchStr,
        loadCollections: deps.slot === 'collections',
        slotResult: deps.slotResult,
        view: isView(params.slug) && params.slug !== 'overview' ? params.slug : undefined,
      },
    }),
  head: ({ loaderData }) => {
    const locale = getLocale();
    const jsonLd = loaderData ? subjectPageJsonLd(loaderData.page, locale) : undefined;
    return {
      meta: [{ title: loaderData ? subjectPageTitle(loaderData.page, locale) : m.not_found_heading() }],
      ...(jsonLd ? { scripts: [{ type: 'application/ld+json', children: jsonLd }] } : {}),
    };
  },
  component: SubjectRoute,
});

function SubjectRoute() {
  const { page, library, reader, frame, relations, tabs, reactions, ratings, verification } = Route.useLoaderData();
  const { state: session } = useSession();
  const returnTo = useLocation().publicHref.split(/[?#]/, 1)[0]!;
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <RatingsContext.Provider value={ratings}>
      <SubjectPage
        page={page}
        locale={getLocale()}
        messages={subjectPageMessages()}
        reader={reader}
        {...(frame.label ? { typeLabel: frame.label } : {})}
        {...(frame.ratio ? { ratio: frame.ratio } : {})}
        relations={relations}
        link={SubjectLink}
        tabs={tabs}
        tabLabels={viewTabLabels()}
        invitation={m.subject_empty()}
        {...(nonce !== undefined ? { nonce } : {})}
        renderJsonLd={false}
        actions={(subject) => (
          <SubjectHeaderActions
            id={subject.id}
            reactions={reactions}
            signedIn={session === 'signed-in'}
            returnTo={returnTo}
            verification={verification}
          >
            <SubjectLibrarySlot
              subject={{ id: subject.id, type: subject.type, label: subjectPageTitle(page, subject.locale) }}
              locale={subject.locale}
              data={library}
            />
          </SubjectHeaderActions>
        )}
      />
    </RatingsContext.Provider>
  );
}
