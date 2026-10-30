import { type CompositionDocument, type View } from '@rezics/composition';
import { useLocation, useRouter, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { ZonePublic } from '../../../../services/kernel/src/zones/contract.ts';
import { SubjectFrame, subjectFrame, SubjectViewPage } from '../features/pages/subject-frame';
import { SubjectPage, subjectPageTitle, subjectPageType, type SubjectPageData } from '../features/pages/subject';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { SubjectHeaderActions } from '../features/pages/subject-reactions-view';
import { loadSubjectReactions } from '../features/pages/subject-reactions';
import { SubjectLibrarySlot } from '../library/subject-slot-view';
import { loadSubjectLibrarySlot } from '../library/subject-slot';
import type { SubjectReactions } from '../features/pages/subject-reactions';
import type { SubjectLibrarySlotData } from '../library/subject-slot';
import type { SessionEnv } from '../session/client';
import { defaultReader, type Reader } from '../subject/reader';
import { loadReader } from '../subject/load-reader';
import { pageText } from '../features/pages/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { NotFoundPage, StatusPage } from '../shell/shell';
import type { PagePaths } from '../shell/head';
import {
  continueZonePageRequest,
  readZonePageRequest,
  type ZonePageInput,
  type ZonePageRouteOutcome,
} from './zone-read';
import { zoneAppearanceAttributes, zonePageDocument } from './appearance';
import { kernelClient } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { metaText } from '@rezics/ui/meta-line';
import { getLocale, locales } from '../paraglide/runtime.js';
import { useSession } from '../session/query';

function zoneLabel(zone: ZonePublic, locale: string): { text: string; lang?: string } | undefined {
  const label = pageText(zone.labels, locale);
  if (!label.text) return;
  return { text: label.text, ...(label.lang ? { lang: label.lang } : {}) };
}

function navigationLabel(route: string, locale: string): string {
  if (!route) return m.zone_home();
  const segment = route.split('/').at(-1) ?? route;
  return segment.replaceAll('-', ' ').replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase(locale));
}

export function zoneRouteHeading(route: string, locale: string): string {
  return navigationLabel(route, locale);
}

export function zonePageTitle(zone: ZonePublic, route: string, locale: string): string {
  const title = zoneLabel(zone, locale)?.text ?? m.zone_home();
  return route ? `${navigationLabel(route, locale)} · ${title}` : title;
}

function navigationHref(zone: ZonePublic, locale: string, route: string): string {
  const suffix = route ? `/${route.split('/').map(encodeURIComponent).join('/')}` : '';
  return `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zone.id)}${suffix}`;
}

export function ZoneShell({
  zone,
  locale,
  route = '',
  children,
}: {
  zone: ZonePublic;
  locale: string;
  route?: string;
  children: ReactNode;
}) {
  const label = zoneLabel(zone, locale);
  return (
    <div data-zone-shell className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-end sm:justify-between">
        {label ? (
          <p lang={label.lang} className="min-w-0 break-words font-serif text-xl font-semibold tracking-tight">
            {label.text}
          </p>
        ) : (
          <span />
        )}
        {zone.navigation.length > 0 && (
          <nav aria-label={m.zone_navigation()} className="flex flex-wrap gap-x-5 gap-y-2">
            {zone.navigation.map(({ route: destination }) => (
              <a
                key={destination}
                href={navigationHref(zone, locale, destination)}
                aria-current={destination === route ? 'page' : undefined}
                className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {zoneRouteHeading(destination, locale)}
              </a>
            ))}
          </nav>
        )}
      </header>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function retryDelay(value: string): number {
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 1000 : Math.max(0, at - Date.now());
}

/** Keep the last server cursor in component state and resume the public read after hydration. */
export function ZoneReadBoundary({
  initial,
  request,
  children,
}: {
  initial: ZonePageRouteOutcome;
  request: Omit<ZonePageInput, 'cursor'>;
  children: (page: Extract<ZonePageRouteOutcome, { kind: 'page' }>) => ReactNode;
}) {
  const [state, setState] = useState({ initial, outcome: initial });
  // A fresh loader result replaces any page retained by this mounted boundary immediately.
  if (state.initial !== initial) setState({ initial, outcome: initial });
  const outcome = state.initial === initial ? state.outcome : initial;
  const [continuation, setContinuation] = useState(0);
  const kind = outcome.kind;
  const cursor = outcome.kind === 'preparing' ? outcome.cursor : undefined;
  const retryAfter = outcome.kind === 'preparing' ? outcome.retryAfter : undefined;
  const targetKey = JSON.stringify(request.target);

  useEffect(() => {
    if (kind !== 'preparing') return;
    let active = true;
    const timer = setTimeout(
      async () => {
        try {
          const next = await continueZonePageRequest({
            data: {
              id: request.id,
              locale: request.locale,
              target: JSON.parse(targetKey) as ZonePageInput['target'],
              ...(request.credentialMode === undefined ? {} : { credentialMode: request.credentialMode }),
              ...(cursor === undefined ? {} : { cursor }),
            },
          });
          if (active) {
            setState({ initial, outcome: next });
            if (next.kind === 'preparing') setContinuation((step) => step + 1);
          }
        } catch {
          if (active) setState({ initial, outcome: { kind: 'error' } });
        }
      },
      retryDelay(retryAfter ?? '1'),
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [initial, kind, cursor, retryAfter, request.id, request.locale, request.credentialMode, targetKey, continuation]);

  if (outcome.kind === 'page') return children(outcome);
  if (outcome.kind === 'preparing')
    return <StatusPage heading={m.zone_preparing_heading()} message={m.zone_preparing_message()} />;
  if (outcome.kind === 'missing') return <NotFoundPage />;
  return <StatusPage heading={m.error_heading()} message={m.error_message()} />;
}

export function ZonePageSurface({
  zone,
  document,
  children,
}: {
  zone: ZonePublic;
  document: CompositionDocument;
  children: (document: CompositionDocument) => ReactNode;
}) {
  const merged = zonePageDocument(zone.appearance, document);
  return (
    <div data-zone-page {...zoneAppearanceAttributes(zone.appearance, document)}>
      {children(merged)}
    </div>
  );
}

const subjectInputId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const personalInput = (input: unknown) => {
  const subjectType =
    typeof input === 'object' && input !== null && 'subjectType' in input ? input.subjectType : undefined;
  if (
    typeof input !== 'object' ||
    input === null ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    !subjectInputId.test(input.id) ||
    (subjectType !== undefined && (typeof subjectType !== 'string' || subjectType.length > 128)) ||
    !('locale' in input) ||
    typeof input.locale !== 'string' ||
    !('overview' in input) ||
    typeof input.overview !== 'boolean'
  )
    throw notFound();
  return {
    id: input.id,
    locale: input.locale,
    overview: input.overview,
    ...(typeof subjectType === 'string' ? { subjectType } : {}),
  };
};

const loadZoneSubjectPersonal = createServerFn({ method: 'GET', strict: false })
  .validator(personalInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const request = getRequest();
    const sessionEnv = env as Partial<SessionEnv>;
    const [reader, library, reactions] = await Promise.all([
      loadReader(client, request, sessionEnv),
      data.overview
        ? loadSubjectLibrarySlot(
            client,
            request,
            sessionEnv,
            data.id,
            false,
            undefined,
            undefined,
            undefined,
            data.subjectType,
          )
        : Promise.resolve<SubjectLibrarySlotData | undefined>(undefined),
      data.overview
        ? loadSubjectReactions(client, request, sessionEnv, data.id)
        : Promise.resolve<SubjectReactions | undefined>(undefined),
    ]);
    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    return {
      reader,
      ...(library ? { library } : {}),
      ...(reactions !== undefined ? { reactions } : {}),
      verification: {
        sitekey: config.TURNSTILE_SITE_KEY ?? '',
        scriptUrl:
          (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
          'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      },
    };
  });

type ZoneSubjectPersonal = Awaited<ReturnType<typeof loadZoneSubjectPersonal>>;

function ZoneSubjectPage({
  outcome,
  locale,
  view,
}: {
  outcome: Extract<ZonePageRouteOutcome, { kind: 'page' }>;
  locale: string;
  view: View;
}) {
  const zone = outcome.page.zone;
  const subjectId = outcome.page.subject;
  const common = outcome.common;
  const [personal, setPersonal] = useState<ZoneSubjectPersonal | null>(null);
  const { state: session } = useSession();
  const returnTo = useLocation().publicHref.split(/[?#]/, 1)[0] ?? '';
  const nonce = useRouter().options.ssr?.nonce;

  useEffect(() => {
    if (!subjectId) return;
    let active = true;
    const subjectType = common?.overview ? subjectPageType(common.overview) : undefined;
    void loadZoneSubjectPersonal({
      data: { id: subjectId, locale, overview: view === 'overview', ...(subjectType ? { subjectType } : {}) },
    })
      .then((data) => {
        if (active) setPersonal(data);
      })
      .catch(() => {
        if (active) setPersonal({ reader: defaultReader, verification: { sitekey: '', scriptUrl: '' } });
      });
    return () => {
      active = false;
    };
  }, [subjectId, locale, view]);

  if (!zone || !subjectId || !common) return <StatusPage heading={m.error_heading()} message={m.error_message()} />;

  const page = {
    ...outcome.page,
    document: zonePageDocument(zone.appearance, outcome.page.document as CompositionDocument),
  } as unknown as SubjectPageData;
  const type = common.type ?? {};
  const tabs = common.tabs ?? [];
  const relations = common.relations ?? {};
  const tabLabels = viewTabLabels();
  const base = `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zone.id)}/subjects/${encodeURIComponent(subjectId)}`;
  const actions = (subject: { id: string; type: string; locale: string }) => {
    if (!personal?.library || personal.reactions === undefined) return null;
    return (
      <SubjectHeaderActions
        id={subject.id}
        reactions={personal.reactions}
        signedIn={session === 'signed-in'}
        returnTo={returnTo}
        verification={personal.verification}
      >
        <SubjectLibrarySlot
          subject={{ id: subject.id, type: subject.type, label: subjectPageTitle(page, subject.locale) }}
          locale={subject.locale}
          data={personal.library}
        />
      </SubjectHeaderActions>
    );
  };

  return (
    <ZoneShell zone={zone} locale={locale}>
      <ZonePageSurface zone={zone} document={outcome.page.document as CompositionDocument}>
        {(document) => {
          const zonePage = { ...page, document };
          if (view === 'overview') {
            return (
              <SubjectPage
                page={zonePage}
                locale={locale}
                messages={subjectPageMessages()}
                reader={personal?.reader ?? defaultReader}
                {...(type.label ? { typeLabel: type.label } : {})}
                {...(type.ratio ? { ratio: type.ratio } : {})}
                relations={relations}
                link={SubjectLink}
                tabs={tabs}
                tabLabels={tabLabels}
                base={base}
                invitation={m.subject_empty()}
                {...(personal?.library && personal.reactions !== undefined ? { actions } : {})}
                {...(nonce !== undefined ? { nonce } : {})}
                renderJsonLd={false}
              />
            );
          }

          const frame = common.frame ?? subjectFrame(common.overview, locale);
          if (!frame) return <StatusPage heading={m.error_heading()} message={m.error_message()} />;
          return (
            <SubjectViewPage
              page={zonePage}
              locale={locale}
              messages={subjectPageMessages()}
              reader={personal?.reader ?? defaultReader}
              {...(type.label ? { typeLabel: type.label } : {})}
              {...(type.ratio ? { ratio: type.ratio } : {})}
              relations={relations}
              link={SubjectLink}
              view={view}
              label={tabLabels.names[view]}
              frame={
                <SubjectFrame
                  frame={frame}
                  locale={locale}
                  link={SubjectLink}
                  reader={personal?.reader ?? defaultReader}
                  coverLabels={{
                    withheld: m.subject_cover_withheld(),
                    reveal: m.subject_cover_reveal(),
                    credit: m.subject_cover_credit(),
                    via: m.subject_cover_via(),
                  }}
                  unlabelled={m.subject_value_unlabelled()}
                  {...(type.label ? { typeLabel: type.label } : {})}
                  {...(type.ratio ? { ratio: type.ratio } : {})}
                  tabs={tabs}
                  tabLabels={tabLabels}
                  view={view}
                  base={base}
                />
              }
              {...(nonce !== undefined ? { nonce } : {})}
              renderJsonLd={false}
            />
          );
        }}
      </ZonePageSurface>
    </ZoneShell>
  );
}

export { ZoneSubjectPage };

export type ZoneSubjectRouteData = { outcome: ZonePageRouteOutcome; paths: PagePaths };

export async function readZoneSubjectRoute(input: { id: string; subjectId: string; view?: View }) {
  const locale = getLocale();
  const target: ZonePageInput['target'] = {
    subject: input.subjectId,
    ...(input.view && input.view !== 'overview' ? { view: input.view } : {}),
  };
  const outcome = await readZonePageRequest({ data: { id: input.id, locale, target } });
  const path = `/subjects/${encodeURIComponent(input.subjectId)}`;
  const paths = Object.fromEntries(locales.map((language) => [language, path])) as PagePaths;
  return { outcome, paths };
}

export function zoneSubjectHead(data: ZoneSubjectRouteData | undefined, view: View = 'overview') {
  const locale = getLocale();
  const page = data?.outcome.kind === 'page' ? data.outcome.common?.overview : undefined;
  const title = page ? subjectPageTitle(page, locale) : m.not_found_heading();
  const label = view === 'overview' ? '' : viewTabLabels().names[view];
  return { meta: [{ title: metaText([title, label]) }] };
}

export function ZoneSubjectRoute({
  data,
  id,
  subjectId,
  view,
}: {
  data: ZoneSubjectRouteData;
  id: string;
  subjectId: string;
  view?: View;
}) {
  const locale = getLocale();
  const pageView = view ?? 'overview';
  const target: ZonePageInput['target'] = {
    subject: subjectId,
    ...(pageView !== 'overview' ? { view: pageView } : {}),
  };
  return (
    <ZoneReadBoundary initial={data.outcome} request={{ id, locale, target }}>
      {(outcome) => <ZoneSubjectPage outcome={outcome} locale={locale} view={pageView} />}
    </ZoneReadBoundary>
  );
}
