import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { m } from '../../../paraglide/messages.js';
import { subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

export const NAMES_RETURN_BYTES = 8192;
export type NamesWindow = {
  query: string;
  page: number;
  expanded: boolean;
  groups: { index: number; page: number; open: boolean }[];
};
export type NamesReturnFocus = 'terms' | 'sources';
export type NamesReturn = { binding: string; href: string; window: NamesWindow; focus?: NamesReturnFocus | undefined };
export type NamesReturnStatus = 'none' | 'restored' | 'changed' | 'restart';
const integer = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 32768;

/** One bounded browser-history value, not a registry or an editor payload. */
export function namesReturn(value: unknown, locale: string): NamesReturn | undefined {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      new TextEncoder().encode(JSON.stringify(value)).length > NAMES_RETURN_BYTES
    )
      return;
    const candidate = value as NamesReturn;
    const w = candidate.window;
    if (
      typeof candidate.binding !== 'string' ||
      candidate.binding.length > 2048 ||
      typeof candidate.href !== 'string' ||
      subjectVisitReturn(candidate.href, locale) !== candidate.href ||
      !candidate.href.endsWith('#supplied-names') ||
      (candidate.focus !== undefined && candidate.focus !== 'terms' && candidate.focus !== 'sources') ||
      !w ||
      typeof w.query !== 'string' ||
      w.query.length > 250 ||
      !integer(w.page) ||
      typeof w.expanded !== 'boolean' ||
      !Array.isArray(w.groups) ||
      w.groups.length > 8 ||
      w.groups.some((g) => !g || !integer(g.index) || !integer(g.page) || typeof g.open !== 'boolean') ||
      new Set(w.groups.map((g) => g.index)).size !== w.groups.length
    )
      return;
    // Copy only the closed public view state; never carry extra input fields into navigation.
    return {
      binding: candidate.binding,
      href: candidate.href,
      window: {
        query: w.query,
        page: w.page,
        expanded: w.expanded,
        groups: w.groups.map((g) => ({ index: g.index, page: g.page, open: g.open })),
      },
      ...(candidate.focus === undefined ? {} : { focus: candidate.focus }),
    };
  } catch {
    return;
  }
}

export function namesReturnHref(href: string, locale: string): string | undefined {
  try {
    const url = new URL(href, 'https://rezics.invalid');
    url.hash = 'supplied-names';
    return subjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, locale);
  } catch {
    return;
  }
}

function namesReturnFromHistory(state: unknown, locale: string): NamesReturn | undefined {
  const value = state && typeof state === 'object' ? Reflect.get(state, 'namesReturn') : undefined;
  return namesReturn(value, locale);
}

function selectedReturn(href: string | undefined, realm: string | null, locale: string) {
  if (!href) return;
  const url = new URL(href, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  return subjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, locale);
}

export function NamesHandoff({
  binding,
  returnHref,
  locale,
  current,
  children,
}: {
  binding: string | undefined;
  returnHref: string | undefined;
  locale: string;
  current: () => boolean;
  children: (restored: NamesWindow | undefined, status: NamesReturnStatus) => ReactNode;
}) {
  const router = useRouter({ warn: false });
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      host.current?.querySelector<HTMLElement>('summary')?.focus();
  });
  const [restored, setRestored] = useState<{ window?: NamesWindow; focus?: NamesReturnFocus | 'section'; status: NamesReturnStatus }>({
    status: 'none',
  });
  useEffect(() => {
    const saved = namesReturnFromHistory(router?.history.location.state ?? window.history.state, locale);
    const actualReturn = selectedReturn(
      returnHref,
      new URLSearchParams(router?.history.location.search ?? window.location.search).get('realm'),
      locale,
    );
    if (saved && actualReturn && saved.href === actualReturn && binding && saved.binding === binding && current()) {
      setRestored({ window: saved.window, focus: saved.focus ?? 'terms', status: 'restored' });
    } else if (saved && actualReturn && saved.href === actualReturn && current()) {
      setRestored({ focus: 'section', status: 'changed' });
    } else if ((router?.history.location.hash ?? window.location.hash) === '#supplied-names' && current()) {
      setRestored({ focus: 'section', status: 'restart' });
    }
    // Restoration belongs to this reading, not subsequent mutations of browser state.
  }, [binding, returnHref, locale]);
  useLayoutEffect(() => {
    if (restored.status === 'none' || !current()) return;
    const anchor =
      restored.focus === 'sources'
        ? host.current?.querySelector<HTMLAnchorElement>('[data-names-sources] a')
        : restored.focus === 'terms'
          ? host.current?.querySelector<HTMLAnchorElement>('[data-names-terms] a')
          : undefined;
    (anchor ?? host.current?.querySelector<HTMLElement>('summary'))?.focus();
  }, [restored]);
  return (
    <div
      ref={host}
      className="min-w-0"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
      onClickCapture={(event) => {
        const anchor =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('[data-names-terms] a, [data-names-sources] a')
            : null;
        const sourceVisit = !!anchor?.closest('[data-names-sources]');
        if (
          !anchor ||
          !router ||
          !binding ||
          !returnHref ||
          !current() ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          anchor.target ||
          anchor.hasAttribute('download')
        )
          return;
        const destination = new URL(anchor.href);
        if (
          destination.origin !== window.location.origin ||
          !(sourceVisit ? destination.pathname.endsWith('/sources') : destination.pathname.endsWith('/terms'))
        )
          return;
        const actualReturn = selectedReturn(returnHref, destination.searchParams.get('realm'), locale);
        if (!actualReturn) return;
        const root = host.current!;
        const saved = namesReturn(
          {
            binding,
            href: actualReturn,
            focus: sourceVisit ? 'sources' : 'terms',
            window: {
              query: root.querySelector<HTMLInputElement>('input[type="search"]')?.value ?? '',
              page: Number(root.querySelector('[data-names-page]')?.getAttribute('data-names-page') ?? 0),
              expanded: root.querySelector('details')?.open ?? false,
              groups: [...root.querySelectorAll<HTMLDetailsElement>('[data-name-index]')].map((group) => ({
                index: Number(group.dataset.nameIndex),
                page: Number(group.dataset.namePage ?? 0),
                open: group.open,
              })),
            },
          },
          locale,
        );
        if (!saved) return;
        event.preventDefault();
        event.stopPropagation();
        // Preserve back navigation as well as the explicit Terms return, without putting filters in URLs.
        router.history.replace(router.history.location.href, {
          ...router.history.location.state,
          namesReturn: saved,
        } as never);
        destination.searchParams.delete('via');
        const to = withSubjectVisitReturn(`${destination.pathname}${destination.search}`, actualReturn, locale);
        void router.navigate({ to: to as never, state: (previous) => ({ ...previous, namesReturn: saved }) as never });
      }}
    >
      {children(restored.window, restored.status)}
    </div>
  );
}

/** A validated return link participates in the existing Terms departure guard and recovery. */
export function NamesTermsReturn({ id, locale, via }: { id: string; locale: string; via?: string | undefined }) {
  const router = useRouter({ warn: false });
  const href = subjectVisitReturn(via, locale);
  const safe = href?.startsWith(`/${locale}/subjects/${id}/`) && href.endsWith('#supplied-names') ? href : undefined;
  const [saved, setSaved] = useState<NamesReturn>();
  useEffect(() => {
    const value = namesReturnFromHistory(router?.history.location.state ?? window.history.state, locale);
    setSaved(value?.href === safe ? value : undefined);
  }, [safe, locale]);
  if (!safe) return null;
  return (
    <div className="mx-auto w-full max-w-4xl px-6 pt-4">
      <Link
        className="inline-flex min-h-11 items-center text-primary underline focus-visible:outline-2"
        to={safe as never}
        state={(previous) => ({ ...previous, namesReturn: saved }) as never}
      >
        {m.work_names_return({}, { locale: locale as never })}
      </Link>
    </div>
  );
}
