import type { KernelClient } from '@rezics/client';
import type { ComponentProps } from 'react';
import { dataComponents, PageData, type PageMessages } from './data';
import { homeJsonLd, serializeJsonLd } from './jsonld';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender } from './render';

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

export type RoutePageLoad = { kind: 'missing' } | { kind: 'page'; page: RoutePageData };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemError(value: unknown): Error {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  return new Error(code);
}

/** One `pages.read` for a route. Missing or not-yet-published pages use the site's static fallback. */
export async function loadRoutePage(client: KernelClient, route: string): Promise<RoutePageLoad> {
  const result = await client.pages.$read.post({ target: { route } });
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 503 && isRecord(result.error?.value) && result.error.value.code === 'presentation_not_ready')
    return { kind: 'missing' };
  if (result.status === 200 && result.data) {
    const page = result.data as Omit<RoutePageData, 'route'>;
    return { kind: 'page', page: { ...page, route } };
  }
  throw problemError(result.error?.value);
}

/** Render a route document through the shared composition and page-read context. */
export function RoutePage({
  page,
  locale,
  messages,
  link,
}: {
  page: RoutePageData;
  locale: string;
  messages: PageMessages;
  link?: ComponentProps<typeof PageData>['link'];
}) {
  const jsonLd = page.route === '/' ? serializeJsonLd(homeJsonLd({ origin: 'https://rezics.com', locale })) : undefined;
  return (
    <>
      <PageHost>
        <PageData
          locale={locale}
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
      {jsonLd !== undefined && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />}
    </>
  );
}
