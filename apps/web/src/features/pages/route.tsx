import type { KernelClient } from '@rezics/client';
import { Link } from '@tanstack/react-router';
import { useContext, type ComponentProps, type ReactNode } from 'react';
import { requestLanguages } from '../../kernel/languages.ts';
import { dataComponents, PageData, type PageMessages } from './data';
import { homeJsonLd, serializeJsonLd } from './jsonld';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender } from './render';
import { PlainLink, type LinkProps } from './shared';
import { ZoneDestinationsContext, ZoneTypeList, type ZoneDestinations } from './type-list';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type RouteDocument = {
  root: { props: { [key: string]: JsonValue } };
  content: { type: string; props: { id: string; [key: string]: JsonValue } }[];
};

export type RoutePageData = {
  route: string;
  subject?: string;
  profile: string;
  template: { scope: 'base' | 'generic' | 'route' | 'type'; key: string | null };
  document: RouteDocument;
  reads: Record<string, { status: number; body: JsonValue }>;
};

export type RoutePageLoad =
  | { kind: 'missing' }
  | { kind: 'page'; page: RoutePageData }
  | { kind: 'rejected'; status: number; code: string }
  | { kind: 'unavailable'; status?: number; code: string };

export function routePageJsonLd(
  page: RoutePageData,
  locale: string,
  origin = 'https://rezics.com',
): string | undefined {
  return page.route === '/' ? serializeJsonLd(homeJsonLd({ origin, locale })) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemCode(value: unknown): string {
  return isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
}

/** One `pages.read` for a route; an omitted locale leaves the read's labels available to the renderer. */
export async function loadRoutePage(client: KernelClient, route: string, locale?: string): Promise<RoutePageLoad> {
  let result: Awaited<ReturnType<typeof client.pages.$read.post>>;
  try {
    result = await client.pages.$read.post({
      target: { route },
      ...(locale === undefined ? {} : { languages: requestLanguages(locale) }),
    });
  } catch (error) {
    if (error instanceof TypeError) return { kind: 'unavailable', code: 'dependency_unavailable' };
    throw error;
  }
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 200 && result.data) {
    const page = result.data as Omit<RoutePageData, 'route'>;
    return { kind: 'page', page: { ...page, route } };
  }
  const code = problemCode(result.error?.value);
  if (result.status >= 500) return { kind: 'unavailable', status: result.status, code };
  if (result.status >= 400) return { kind: 'rejected', status: result.status, code };
  throw new Error(`Unexpected pages.read response: ${result.status}`);
}

const slotsByType = new Map(pageDefinitions.map(({ type, slots }) => [type, slots]));

/** Whether the template already carries its page heading: a level-1 `Heading` or a `SubjectHeader`. */
function hasPageHeading(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    if (!isRecord(node) || typeof node.type !== 'string' || !isRecord(node.props)) return false;
    if (node.type === 'SubjectHeader' || (node.type === 'Heading' && node.props.level === 1)) return true;
    return (slotsByType.get(node.type) ?? []).some((slot) =>
      hasPageHeading((node.props as Record<string, unknown>)[slot]),
    );
  });
}

/** Render a route document through the shared composition and page-read context. */
export function RoutePage({
  page,
  locale,
  heading,
  messages,
  link,
  personal,
  nonce,
  renderJsonLd = true,
}: {
  page: RoutePageData;
  locale: string;
  heading: string;
  messages: PageMessages;
  link?: ComponentProps<typeof PageData>['link'];
  personal?: ReactNode;
  nonce?: string;
  renderJsonLd?: boolean;
}) {
  const jsonLd = routePageJsonLd(page, locale);
  return (
    <>
      <PageHost personal={personal}>
        {!hasPageHeading(page.document.content) && <h1 className="sr-only">{heading}</h1>}
        <PageData
          locale={locale}
          listTarget={page.route.startsWith('/') ? { route: page.route } : undefined}
          pageTarget={page.route.startsWith('/') ? { route: page.route } : undefined}
          subject={page.subject ?? null}
          document={page.document}
          reads={page.reads}
          messages={messages}
          {...(link ? { link } : {})}
        >
          <CompositionRender
            document={page.document}
            definitions={pageDefinitions}
            components={{ ...layoutComponents, ...dataComponents }}
            root={PageRoot}
          />
        </PageData>
      </PageHost>
      {renderJsonLd && jsonLd !== undefined && (
        <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      )}
    </>
  );
}

const zoneComponents = { ...layoutComponents, ...dataComponents, TypeList: ZoneTypeList };
const zoneSubject = /^\/([^/]+)\/zones\/([^/]+)\/subjects\/([^/?#]+)(?:\/([^/?#]+))?$/;

function zoneSubjectHref(locale: string, zoneId: string, subjectId: string, view?: string): string {
  const base = `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zoneId)}/subjects/${encodeURIComponent(subjectId)}`;
  return view && view !== 'overview' ? `${base}/${encodeURIComponent(view)}` : base;
}

export function ZoneSubjectLink({ href, lang, className, children }: LinkProps) {
  const destinations = useContext(ZoneDestinationsContext);
  const match = zoneSubject.exec(href);
  if (match) {
    try {
      const locale = decodeURIComponent(match[1]!);
      const zoneId = decodeURIComponent(match[2]!);
      const subjectId = decodeURIComponent(match[3]!);
      const view = match[4] ? decodeURIComponent(match[4]) : undefined;
      const target = zoneSubjectHref(locale, zoneId, subjectId, view);
      return (
        <Link to={target} lang={lang} className={className}>
          {children}
        </Link>
      );
    } catch {
      /* Fall through to a plain localized address. */
    }
  }
  if (destinations && href.startsWith(`/${destinations.locale}/zones/${destinations.zoneId}`))
    return (
      <a href={href} lang={lang} className={className}>
        {children}
      </a>
    );
  return (
    <PlainLink href={href} lang={lang} className={className}>
      {children}
    </PlainLink>
  );
}

/** Configured Zone pages keep TypeList continuation and subject cards on the Zone route. */
export function ZoneRoutePage({
  page,
  locale,
  heading,
  messages,
  destinations,
}: {
  page: RoutePageData;
  locale: string;
  heading: string;
  messages: PageMessages;
  destinations: ZoneDestinations;
  nonce?: string;
}) {
  return (
    <ZoneDestinationsContext.Provider value={destinations}>
      <PageHost>
        {!hasPageHeading(page.document.content) && <h1 className="sr-only">{heading}</h1>}
        <PageData
          locale={locale}
          subject={page.subject ?? null}
          document={page.document}
          reads={page.reads}
          messages={messages}
          link={ZoneSubjectLink}
        >
          <CompositionRender
            document={page.document}
            definitions={pageDefinitions}
            components={zoneComponents}
            root={PageRoot}
          />
        </PageData>
      </PageHost>
    </ZoneDestinationsContext.Provider>
  );
}

export function zonePageDestinations(zoneId: string, locale: string, route: string, cursor?: string): ZoneDestinations {
  return { zoneId, locale, route, ...(cursor ? { cursor } : {}) };
}
