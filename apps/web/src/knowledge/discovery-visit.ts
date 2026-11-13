import { knowledgeId } from './public-read';
import type { KnowledgeDiscoveryPage, KnowledgeDiscoveryRead, KnowledgeDiscoveryRequest } from './discovery';

export const KNOWLEDGE_DISCOVERY_RETURN_MAXIMUM = 2048;
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es'] as const;
const subjectVisit = new RegExp(
  `^/(${locales.join('|')})/subjects/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/`,
);

export type KnowledgeDiscoveryBinding = Readonly<{
  subjectId: string;
  locale: string;
  visitHref: string;
  sessionRevision: number;
}>;
export type KnowledgeDiscoverySnapshot = Readonly<{
  state: 'preparing' | 'ready' | 'denied' | 'unavailable' | 'restart' | 'retired';
  status?: number;
  cursor: string | null;
  page?: KnowledgeDiscoveryPage;
  frontier?: string;
  busy: boolean;
}>;
export type KnowledgeDiscoveryReader = (request: KnowledgeDiscoveryRequest) => Promise<KnowledgeDiscoveryRead>;

function privateLocator(value: string): boolean {
  return /\/knowledge\/notebooks\//.test(value) || /[?&#](?:credential|authorization|token)=/i.test(value);
}

function parseReturnUrl(value: unknown, locale: string): { href: string; subjectId: string } | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > KNOWLEDGE_DISCOVERY_RETURN_MAXIMUM) return null;
  if (value.includes('\\') || value.includes('//') || privateLocator(value)) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://rezics.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://rezics.invalid' || url.username || url.password) return null;
  const match = subjectVisit.exec(url.pathname);
  if (!match || match[1] !== locale || !match[2]) return null;
  const search = [...url.searchParams.keys()];
  if (new Set(search).size !== search.length) return null;
  if (search.some((key) => /^(authorization|credential|token|access_token)$/i.test(key))) return null;
  return { href: `${url.pathname}${url.search}${url.hash}`, subjectId: match[2] };
}

/** Same-origin Subject visit path for the current locale, before the published document's subject is known. */
export function parseKnowledgeDiscoveryReturnPath(value: unknown, locale: string): string | null {
  return parseReturnUrl(value, locale)?.href ?? null;
}

/**
 * Same-origin Subject visit only. Credentials, private notebook paths and foreign hosts stay out of
 * the public reader address.
 */
export function parseKnowledgeDiscoveryReturn(value: unknown, locale: string, subjectId: string): string | null {
  const parsed = parseReturnUrl(value, locale);
  const id = knowledgeId(subjectId);
  return parsed && id && parsed.subjectId === id ? parsed.href : null;
}

function preparing(cursor: string | null): KnowledgeDiscoverySnapshot {
  return { state: 'preparing', cursor, busy: true };
}

/** One replacing page. Late work from a retired generation cannot restore rows or a previous cursor. */
export class KnowledgeDiscoveryReading {
  private snapshot: KnowledgeDiscoverySnapshot = preparing(null);
  private listeners = new Set<() => void>();
  private sequence = 0;
  private retired = false;
  constructor(
    private read: KnowledgeDiscoveryReader,
    private binding: KnowledgeDiscoveryBinding,
    private current = () => true,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: KnowledgeDiscoverySnapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
  private live(sequence: number) {
    return !this.retired && this.current() && this.sequence === sequence;
  }
  async open(cursor: string | null) {
    if (this.retired || !this.current()) return;
    const sequence = ++this.sequence;
    this.publish(preparing(cursor));
    let result: KnowledgeDiscoveryRead;
    try {
      result = await this.read({
        subjectId: this.binding.subjectId,
        cursor,
        locale: this.binding.locale,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (this.live(sequence)) this.publish({ state: 'unavailable', status: 503, cursor, busy: false });
      return;
    }
    if (!this.live(sequence)) return;
    if (result.state === 'ready') {
      this.publish({ state: 'ready', cursor, page: result.page, busy: false });
      return;
    }
    if (result.state === 'preparing') {
      this.publish({ state: 'preparing', cursor, frontier: result.next, busy: false });
      return;
    }
    this.publish({
      state: result.state,
      status: result.status,
      cursor,
      busy: false,
    });
  }
  /** Every action closes over its rendered snapshot so a replaced reading cannot be driven late. */
  actions(snapshot: KnowledgeDiscoverySnapshot) {
    const current = () => !this.retired && this.current() && this.snapshot === snapshot && !snapshot.busy;
    return {
      more: () => {
        if (current() && snapshot.state === 'ready' && snapshot.page?.next) void this.open(snapshot.page.next);
      },
      continuePreparation: () => {
        if (current() && snapshot.state === 'preparing' && snapshot.frontier) void this.open(snapshot.frontier);
      },
      retry: () => {
        if (current() && (snapshot.state === 'denied' || snapshot.state === 'unavailable'))
          void this.open(snapshot.cursor);
      },
      restart: () => {
        if (current() && snapshot.state === 'restart') void this.open(null);
      },
    };
  }
  retire() {
    this.retired = true;
    this.sequence += 1;
    this.publish({ state: 'retired', cursor: null, busy: false });
    this.listeners.clear();
    this.read = async () => ({ state: 'unavailable', status: 503 });
  }
}

export function knowledgeDiscoverySearch(search: Record<string, unknown>): { returnTo?: string } {
  if (!('returnTo' in search) || search.returnTo === undefined || search.returnTo === '') return {};
  return typeof search.returnTo === 'string' && search.returnTo.length <= KNOWLEDGE_DISCOVERY_RETURN_MAXIMUM
    ? { returnTo: search.returnTo }
    : {};
}
