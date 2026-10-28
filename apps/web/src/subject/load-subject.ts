import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PagePaths } from '../shell/head';
import { m } from '../paraglide/messages.js';
import { locales, type Locale } from '../paraglide/runtime.js';
import { readRelease } from './definitions';
import { originalLanguage } from './language';
import type { Subject } from './types';
import { subjectHref } from './subject-href';

const agentRoots = new Set(['schema:Person', 'schema:Organization']);

export type LoadedSubject = {
  id: string;
  subject: Subject;
  label: string;
  slug: string;
  href: string;
  paths: PagePaths;
};

export type SubjectLoad = { kind: 'missing' } | { kind: 'subject'; value: LoadedSubject };

export function subjectUrlForView(subject: LoadedSubject, view?: string): string {
  return view && !subject.href.includes('/@') ? `${subject.href}/${encodeURIComponent(view)}` : subject.href;
}

export function keepSearch(href: string, search: string): string {
  return `${encodeURI(href)}${search ? (search.startsWith('?') ? search : `?${search}`) : ''}`;
}

function subjectLabel(subject: Subject, locale: Locale): string {
  return pickText(subject.labels, locale, originalLanguage(subject)).text || m.subject_value_unlabelled({}, { locale });
}

function pathsFor(subject: Subject): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => {
      const href = subjectHref({ id: subject.id, label: subjectLabel(subject, locale) }, locale).href;
      return [locale, href.slice(`/${locale}`.length)];
    }),
  ) as PagePaths;
}

async function isAgentType(type: string): Promise<boolean> {
  if (agentRoots.has(type)) return true;
  try {
    const release = await readRelease();
    const visited = new Set<string>();
    const visit = (current: string): boolean => {
      if (agentRoots.has(current)) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      return (release.types[current]?.bases ?? []).some(visit);
    };
    return visit(type);
  } catch {
    return false;
  }
}

async function verifiedHandle(client: KernelClient, subject: Subject): Promise<string | undefined> {
  if (!(await isAgentType(subject.type))) return undefined;
  try {
    const result = await client.accounts.get({ query: { agent: subject.id } });
    const accounts = result.data?.accounts;
    if (result.error || !accounts || accounts.length !== 1) return undefined;
    const handle = accounts[0]?.handle;
    return typeof handle === 'string' && handle.length > 0 ? handle : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the subject before page data. The kernel follows a merged id's single 308 to its survivor; verified agents
 * use their account address. Optional account failures leave the catalogue subject address in place.
 */
export async function loadSubject(client: KernelClient, id: string, locale: Locale): Promise<SubjectLoad> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return { kind: 'missing' };

  let result = await client.subjects({ id }).get();
  if (result.status === 308) {
    // Eden reports a 308 body through `error.value`, since it is not a successful response.
    const response = result as unknown as { data?: unknown; error?: { value?: unknown } | null };
    const body = response.data ?? response.error?.value;
    const redirect = (body as { redirect?: { from?: unknown; to?: unknown } } | undefined)?.redirect;
    if (redirect?.from !== id || typeof redirect.to !== 'string') throw new Error('Subject redirect was invalid');
    result = await client.subjects({ id: redirect.to }).get();
  }
  if (result.status === 404) return { kind: 'missing' };
  if (result.status !== 200 || result.error || !result.data?.subject) throw new Error('Subject read failed');

  const subject = result.data.subject as Subject;
  const label = subjectLabel(subject, locale);
  const handle = await verifiedHandle(client, subject);
  const href = handle
    ? `/${encodeURIComponent(locale)}/@${handle}`
    : subjectHref({ id: subject.id, label }, locale).href;
  return {
    kind: 'subject',
    value: {
      id: subject.id,
      subject,
      label,
      slug: subjectHref({ id: subject.id, label }, locale).params.slug,
      href,
      paths: pathsFor(subject),
    },
  };
}

/** Add a view to each locale path for the root head's canonical and hreflang tags. */
export function subjectViewPaths(paths: PagePaths, view: string): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => [locale, `${paths[locale]}/${encodeURIComponent(view)}`]),
  ) as PagePaths;
}
