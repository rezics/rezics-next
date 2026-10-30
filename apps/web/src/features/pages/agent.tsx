import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import { requestLanguages } from '../../kernel/languages.ts';
import { accountOf } from './account-read';
import { pageContext, type SubjectPageData } from './subject';
import { isRecord } from './shared';

export type AgentPageLoad =
  | { kind: 'missing' }
  | {
      kind: 'page';
      page: SubjectPageData & {
        account: NonNullable<SubjectPageData['account']>;
        operator?: { id: string; handle: string | null; displayName: string | null };
      };
    };

/** The activity lists an agent page reads from the account, by the page read that names each. */
const LIST_READS = new Set(['accountPosts', 'accountThreads', 'accountCollections']);

function problemError(value: unknown): Error {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  return new Error(code);
}

/** The address of an agent's page, or of one of its views. */
export function agentPath(locale: string, handle: string, view?: View): string {
  const base = `/${encodeURIComponent(locale)}/@${encodeURIComponent(handle)}`;
  return view && view !== 'overview' ? `${base}/${view}` : base;
}

/**
 * One `pages.read` of the agent's overview, or of the named view. The kernel resolves the account and the subject
 * it is, so the page is a subject page whichever agent it is. An unknown, reserved, deleted or invisible handle is
 * the same 404, and a handle the kernel refuses to read is the same missing page; neither echoes the handle.
 */
export async function loadAgentPage(
  client: KernelClient,
  handle: string,
  view?: View,
  locale = 'en',
): Promise<AgentPageLoad> {
  const result = await client.pages.$read.post({
    target: { account: handle, ...(view ? { view } : {}) },
    languages: requestLanguages(locale),
  });
  if (result.status === 404 || result.status === 400) return { kind: 'missing' };
  if (result.status === 200 && result.data) {
    const data = result.data as unknown as Omit<SubjectPageData, 'subject' | 'account'> & {
      subject?: string;
      account?: string;
    };
    if (typeof data.account !== 'string') throw new Error('internal_error');
    const { account, subject, ...rest } = data;
    const page = { ...rest, subject: subject ?? null, account: { id: account, handle } } as SubjectPageData;
    const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
    const canonicalHandle = Object.entries(reads).flatMap(([key, read]) => {
      if (read.kind !== 'account' || page.reads[key]?.status !== 200) return [];
      const profile = accountOf(page.reads[key]?.body);
      if (profile?.id !== account) return [];
      const canonical = profile.handle;
      return canonical ? [canonical] : [];
    })[0];
    return {
      kind: 'page',
      page: {
        ...page,
        account: { id: account, handle: canonicalHandle ?? handle },
      },
    };
  }
  throw problemError(result.error?.value);
}

/**
 * The page with its list replaced by the page after `cursor`, read through the list's standalone route. The page
 * read gives the first page of each list and its `next`; everything after that is the list's own route.
 */
export async function continueAgentList(
  client: KernelClient,
  page: SubjectPageData & { account: NonNullable<SubjectPageData['account']> },
  cursor: string,
): Promise<SubjectPageData> {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const entry = Object.entries(plan.reads).find(([, read]) => LIST_READS.has(read.kind));
  if (!entry) return page;
  const [key, read] = entry;
  const accountId = page.account.id;
  const query = { cursor, limit: 'limit' in read ? read.limit : 20 };
  const outcome =
    read.kind === 'accountPosts'
      ? await client.accounts({ accountId }).posts.get({ query })
      : read.kind === 'accountThreads'
        ? await client.accounts({ accountId }).threads.get({ query: { ...query, kind: read.threadKind } })
        : await client.accounts({ accountId }).collections.get({ query: { ...query, view: 'BASIC' } });
  return {
    ...page,
    reads: { ...page.reads, [key]: { status: outcome.status, body: outcome.data ?? outcome.error?.value ?? null } },
  };
}

/** The agent's name: its display name, else its handle. */
export function agentTitle(page: SubjectPageData): string {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  for (const [key, read] of Object.entries(plan.reads)) {
    const result = read.kind === 'account' ? page.reads[key] : undefined;
    const profile = result?.status === 200 ? accountOf(result.body) : undefined;
    if (profile) return profile.displayName ?? (profile.handle ? `@${profile.handle}` : '');
  }
  return page.account ? `@${page.account.handle}` : '';
}
