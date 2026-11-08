import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument, type PageRead, type View } from '@rezics/composition';
import { requestLanguages } from '../../kernel/languages.ts';
import { accountHref, canonicalRedirect } from '../../subject/load-subject';
import { accountOf, pageProfile } from './account-profile-reading';
export { pageProfile } from './account-profile-reading';
import { pageContext, type SubjectPageData } from './page-model';
import { isRecord } from './shared';

export class AgentReadError extends Error {
  constructor(
    message: string,
    public state: 'denied' | 'preparing' | 'unavailable',
  ) {
    super(message);
  }
}

export type AgentPageLoad =
  | { kind: 'missing' }
  | {
      kind: 'page';
      page: SubjectPageData & {
        account: NonNullable<SubjectPageData['account']>;
        operator?: { id: string; handle: string | null; displayName: string | null };
      };
    };

type AccountListRead = Extract<PageRead, { kind: 'accountPosts' | 'accountThreads' | 'accountCollections' }>;

/** A bare cursor can identify only one distinct planned account list. */
function accountListEntry(reads: Record<string, PageRead>): [string, AccountListRead] {
  let entry: [string, AccountListRead] | undefined;
  for (const [key, read] of Object.entries(reads)) {
    if (read.kind !== 'accountPosts' && read.kind !== 'accountThreads' && read.kind !== 'accountCollections') continue;
    // Identical descriptors already share a key; different limits or kinds cannot share a continuation.
    if (entry) throw new AgentReadError('Ambiguous account list continuation', 'unavailable');
    entry = [key, read];
  }
  if (!entry) throw new AgentReadError('Account page has no list to continue', 'unavailable');
  return entry;
}

function problemError(value: unknown): Error {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  return new AgentReadError(code, 'unavailable');
}

/** The address of an agent's page, or of one of its views. */
export function agentPath(locale: string, handle: string, view?: View | 'realms'): string {
  return accountHref(locale, handle, view);
}

/** The owner lookup decides former-claim expiry and current account eligibility. */
export async function formerHandleRedirect(
  client: KernelClient,
  handle: string,
  locale: string,
  view?: View | 'realms',
  search = '',
) {
  const result = await client.accounts.get({ query: { handle } });
  if (result.status === 400 || result.status === 404) return undefined;
  if (result.status !== 200 || result.error) throw problemError(result.error?.value);
  const movedTo = accountOf(result.data)?.movedTo;
  return movedTo ? canonicalRedirect(agentPath(locale, movedTo, view), search, '', 302) : undefined;
}

/**
 * One `pages.read` of the agent's overview, or of the named view. The kernel resolves the account and the subject
 * it is, so the page is a subject page whichever agent it is. An unknown, reserved, deleted or invisible handle is
 * the same 404, and a handle the kernel refuses to read is the same missing page; neither echoes the handle.
 */
export async function loadAgentPage(
  client: KernelClient,
  handle: string,
  view?: View | 'realms',
  locale = 'en',
): Promise<AgentPageLoad> {
  const result = await client.pages.$read.post({
    target: { account: handle, ...(view && view !== 'realms' ? { view } : {}) },
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
    if (!canonicalHandle) throw new Error('Account page has no current handle');
    return {
      kind: 'page',
      page: {
        ...page,
        account: { id: account, handle: canonicalHandle },
      },
    };
  }
  if (result.status === 401 || result.status === 403) throw new AgentReadError('denied', 'denied');
  if (result.status === 202) throw new AgentReadError('preparing', 'preparing');
  throw problemError(result.error?.value);
}

/**
 * The page with its list replaced by the page after `cursor`, read through the list's standalone route. The page
 * read gives the first page of each list and its `next`; everything after that is the list's own route.
 * Without a list address, zero or multiple distinct account lists make the continuation unavailable.
 */
export async function continueAgentList(
  client: KernelClient,
  page: SubjectPageData & { account: NonNullable<SubjectPageData['account']> },
  cursor: string,
): Promise<SubjectPageData> {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const [key, read] = accountListEntry(plan.reads);
  const accountId = page.account.id;
  const query = { cursor, limit: read.limit };
  const outcome =
    read.kind === 'accountPosts'
      ? await client.accounts({ accountId }).posts.get({ query: { ...query, limit: String(query.limit) } })
      : read.kind === 'accountThreads'
        ? await client
            .accounts({ accountId })
            .threads.get({ query: { ...query, limit: String(query.limit), kind: read.threadKind } })
        : await client.accounts({ accountId }).collections.get({ query: { ...query, view: 'BASIC' } });
  return {
    ...page,
    reads: { ...page.reads, [key]: { status: outcome.status, body: outcome.data ?? outcome.error?.value ?? null } },
  };
}

/** The agent's name: its display name, else its handle. */
export function agentTitle(page: SubjectPageData): string {
  const profile = pageProfile(page);
  const handle = profile?.handle || page.account?.handle;
  return profile?.displayName || (handle ? `@${handle}` : '');
}
