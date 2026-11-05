import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PagePaths } from '../shell/head';
import { m } from '../paraglide/messages.js';
import { locales, type Locale } from '../paraglide/runtime.js';
import { originalLanguage } from './language';
import type { Subject } from './types';
import { accountHref, subjectHref } from './subject-href';
export { keepSearch, subjectUrlForView, subjectViewPaths } from './subject-href';

const agentRoots = new Set(['schema:Person', 'schema:Organization']);

export type LoadedSubject = {
  id: string;
  subject: Subject;
  read: SubjectRead;
  label: string;
  slug: string;
  href: string;
  paths: PagePaths;
};

export type SubjectLoad = { kind: 'missing' } | { kind: 'subject'; value: LoadedSubject };

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

function isAgentType(read: SubjectRead): boolean {
  return (
    agentRoots.has(read.subject.type) ||
    (read.summary?.types.some((type) => agentRoots.has(type)) ?? false)
  );
}

export async function verifiedHandle(client: KernelClient, read: SubjectRead): Promise<string | undefined> {
  const subject = read.subject;
  if (!read.account && !isAgentType(read)) return undefined;
  try {
    const result = await client.accounts.get({ query: { agent: subject.id } });
    const accounts = result.data?.accounts;
    if (result.error || !accounts || accounts.length !== 1) return undefined;
    const account = accounts[0];
    const handle = account && 'handle' in account ? account.handle : undefined;
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

  let result = await client.subjects({ id }).get({ fetch: { redirect: 'manual' } });
  if (result.status === 308) {
    // Eden reports a 308 body through `error.value`, since it is not a successful response.
    const body = result.data ?? result.error?.value;
    const redirect = body && 'redirect' in body ? body.redirect : undefined;
    if (
      redirect?.from !== id ||
      typeof redirect.to !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(redirect.to) ||
      redirect.to === id
    )
      throw new Error('Subject redirect was invalid');
    result = await client.subjects({ id: redirect.to }).get({ fetch: { redirect: 'manual' } });
  }
  if (result.status === 404) return { kind: 'missing' };
  if (result.status !== 200 || result.error || !result.data?.subject) throw new Error('Subject read failed');

  const subject = result.data.subject as Subject;
  const label = subjectLabel(subject, locale);
  const handle = await verifiedHandle(client, result.data);
  const href = handle ? accountHref(locale, handle) : subjectHref({ id: subject.id, label }, locale).href;
  return {
    kind: 'subject',
    value: {
      id: subject.id,
      subject,
      read: result.data,
      label,
      slug: subjectHref({ id: subject.id, label }, locale).params.slug,
      href,
      paths: handle
        ? (Object.fromEntries(
            locales.map((language) => [language, accountHref(language, handle).slice(`/${language}`.length)]),
          ) as PagePaths)
        : pathsFor(subject),
    },
  };
}
