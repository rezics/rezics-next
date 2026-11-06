import type { KernelClient } from '@rezics/client';
import type { ComponentProps, ReactNode } from 'react';
import { requestLanguages } from '../../kernel/languages.ts';
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
  reads: Record<string, { status: number; body: JsonValue; headers?: Record<string, string> }>;
};

export type RoutePageLoad =
  | { kind: 'missing' }
  | { kind: 'page'; page: RoutePageData }
  | { kind: 'preparing'; status: number; code: string; retryAfter?: string }
  | { kind: 'rejected'; status: number; code: string; retryAfter?: string }
  | { kind: 'unavailable'; status?: number; code: string; retryAfter?: string };

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
  const code = problemCode(result.error?.value ?? result.data);
  const hint = new Headers(result.headers).get('retry-after');
  const failure = { status: result.status, code, ...(hint ? { retryAfter: hint } : {}) };
  if (result.status === 202 || code === 'presentation_not_ready') return { kind: 'preparing', ...failure };
  if (result.status >= 500) return { kind: 'unavailable', ...failure };
  if (result.status >= 400) return { kind: 'rejected', ...failure };
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
