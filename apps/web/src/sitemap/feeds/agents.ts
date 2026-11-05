import type { Kernel } from '@rezics/client';
import { kernelClient } from '../../kernel/client.ts';
import { accountHref } from '../../subject/subject-href.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';
import { sitemapFamilyFromPagePaths, sitemapPagePaths } from '../url.ts';
import { utcLastmod } from '../xml.ts';

type AgentPage = Kernel['~Routes']['v1']['agent-pages']['get']['response'][200];
type AgentItem = AgentPage['agentPages'][number] & { id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the wire envelope, never reinterpret a failed public read as an empty inventory. */
function isAgentPage(value: unknown): value is AgentPage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.agentPages) &&
    value.agentPages.length <= 1_000 &&
    (value.next === null || (typeof value.next === 'string' && value.next.length > 0)) &&
    value.agentPages.every(
      (item: unknown) =>
        isRecord(item) &&
        Object.keys(item).length === 3 &&
        typeof item.handle === 'string' &&
        // Lookup syntax includes existing short, mixed-case and punctuation-ending handles.
        item.handle.trim() === item.handle &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(item.handle) &&
        (item.kind === 'actor' || item.kind === 'organization') &&
        typeof item.lastModified === 'string',
    )
  );
}

export const feed: SitemapFeed<AgentItem> = {
  type: 'agents',
  async read(cursor) {
    const result = await kernelClient()['agent-pages'].get({
      query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
    });
    if (result.status !== 200 || result.error)
      throw Object.assign(new Error(`Sitemap feed agents returned ${result.status}`), {
        status: result.status,
        problem: result.error?.value,
      });
    if (!isAgentPage(result.data))
      throw Object.assign(new Error('Sitemap feed agents returned an invalid inventory'), { status: 502 });
    return {
      // Handles identify page families for the exporter's bounded repeated-item check. Native keyset order is
      // not handle order, so this feed deliberately supplies no lexicographic key.
      items: result.data.agentPages.map((item) => ({ ...item, id: item.handle })),
      next: result.data.next,
    };
  },
  family(item) {
    const paths = Object.fromEntries(
      sitemapLocales.map((locale) => [locale, accountHref(locale, item.handle)]),
    ) as Record<(typeof sitemapLocales)[number], string>;
    // Access supplies meaningful public identity change time; activity has its own owners and clocks.
    const lastModified = utcLastmod(item.lastModified) === undefined ? undefined : item.lastModified;
    return sitemapFamilyFromPagePaths(sitemapPagePaths(paths), lastModified);
  },
};
