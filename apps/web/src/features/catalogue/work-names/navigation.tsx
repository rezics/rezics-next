import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { m } from '../../../paraglide/messages.js';
import { subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

export const NAMES_RETURN_BYTES = 8192;
export type NamesWindow = { query: string; page: number; expanded: boolean; groups: { index: number; page: number; open: boolean }[] };
export type NamesReturn = { binding: string; href: string; window: NamesWindow };
const integer = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 32768;

/** One bounded browser-history value, not a registry or an editor payload. */
export function namesReturn(value: unknown, locale: string): NamesReturn | undefined {
  try {
    if (!value || typeof value !== 'object' || new TextEncoder().encode(JSON.stringify(value)).length > NAMES_RETURN_BYTES) return;
    const candidate = value as NamesReturn;
    const w = candidate.window;
    if (typeof candidate.binding !== 'string' || candidate.binding.length > 2048 ||
      typeof candidate.href !== 'string' || subjectVisitReturn(candidate.href, locale) !== candidate.href ||
      !candidate.href.endsWith('#supplied-names') || !w || typeof w.query !== 'string' || w.query.length > 250 ||
      !integer(w.page) || typeof w.expanded !== 'boolean' || !Array.isArray(w.groups) || w.groups.length > 8 ||
      w.groups.some(g => !g || !integer(g.index) || !integer(g.page) || typeof g.open !== 'boolean') ||
      new Set(w.groups.map(g => g.index)).size !== w.groups.length) return;
    // Copy only the closed public view state; never carry extra input fields into navigation.
    return { binding: candidate.binding, href: candidate.href, window: { query: w.query, page: w.page,
      expanded: w.expanded, groups: w.groups.map(g => ({ index: g.index, page: g.page, open: g.open })) } };
  } catch { return; }
}

export function namesReturnHref(href: string, locale: string): string | undefined {
  try {
    const url = new URL(href, 'https://rezics.invalid');
    url.hash = 'supplied-names';
    return subjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, locale);
  } catch { return; }
}

function selectedReturn(href: string | undefined, realm: string | null, locale: string) {
  if (!href) return;
  const url = new URL(href, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  return subjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, locale);
}

export function NamesHandoff({ binding, returnHref, locale, current, children }: {
  binding: string | undefined; returnHref: string | undefined; locale: string; current: () => boolean;
  children: (restored: NamesWindow | undefined) => ReactNode;
}) {
  const router = useRouter({ warn: false });
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      host.current?.querySelector<HTMLElement>('summary')?.focus();
  });
  const [restored, setRestored] = useState<NamesWindow>();
  useEffect(() => {
    const saved = namesReturn(Reflect.get(router?.history.location.state ?? window.history.state ?? {}, 'namesReturn'), locale);
    if (saved && binding && saved.binding === binding && saved.href === selectedReturn(returnHref, new URLSearchParams(router?.history.location.search ?? window.location.search).get('realm'), locale) && current()) setRestored(saved.window);
    // Restoration belongs to this reading, not subsequent mutations of browser state.
  }, [binding, returnHref, locale]);
  useEffect(() => {
    if (restored && current()) host.current?.querySelector<HTMLAnchorElement>('[data-names-terms] a')?.focus();
  }, [restored]);
  return <div ref={host} className="min-w-0" onFocusCapture={event => { focused.current = event.target; }} onClickCapture={event => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('[data-names-terms] a') : null;
    if (!anchor || !router || !binding || !returnHref || !current() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destination = new URL(anchor.href);
    if (destination.origin !== window.location.origin || !destination.pathname.endsWith('/terms')) return;
    const actualReturn = selectedReturn(returnHref, destination.searchParams.get('realm'), locale);
    if (!actualReturn) return;
    const root = host.current!;
    const saved = namesReturn({ binding, href: actualReturn, window: {
      query: root.querySelector<HTMLInputElement>('input[type="search"]')?.value ?? '',
      page: Number(root.querySelector('[data-names-page]')?.getAttribute('data-names-page') ?? 0),
      expanded: root.querySelector('details')?.open ?? false,
      groups: [...root.querySelectorAll<HTMLDetailsElement>('[data-name-index]')].map(group => ({
        index: Number(group.dataset.nameIndex), page: Number(group.dataset.namePage ?? 0), open: group.open,
      })),
    } }, locale);
    if (!saved) return;
    event.preventDefault();
    event.stopPropagation();
    // Preserve back navigation as well as the explicit Terms return, without putting filters in URLs.
    router.history.replace(router.history.location.href, { ...router.history.location.state, namesReturn: saved } as never);
    destination.searchParams.delete('via');
    const to = withSubjectVisitReturn(`${destination.pathname}${destination.search}`, actualReturn, locale);
    void router.navigate({ to: to as never, state: previous => ({ ...previous, namesReturn: saved }) as never });
  }}>{children(restored)}</div>;
}

/** A validated return link participates in the existing Terms departure guard and recovery. */
export function NamesTermsReturn({ id, locale, via }: { id: string; locale: string; via?: string | undefined }) {
  const router = useRouter({ warn: false });
  const href = subjectVisitReturn(via, locale);
  const safe = href?.startsWith(`/${locale}/subjects/${id}/`) && href.endsWith('#supplied-names') ? href : undefined;
  const [saved, setSaved] = useState<NamesReturn>();
  useEffect(() => {
    const value = namesReturn(Reflect.get(router?.history.location.state ?? window.history.state ?? {}, 'namesReturn'), locale);
    setSaved(value?.href === safe ? value : undefined);
  }, [safe, locale]);
  if (!safe) return null;
  return <div className="mx-auto w-full max-w-4xl px-6 pt-4">
    <Link className="inline-flex min-h-11 items-center text-primary underline focus-visible:outline-2"
      to={safe as never} state={previous => ({ ...previous, namesReturn: saved }) as never}>
      {m.work_names_return({}, { locale: locale as never })}
    </Link>
  </div>;
}
