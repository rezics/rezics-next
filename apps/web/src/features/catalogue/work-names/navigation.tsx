import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { m } from '../../../paraglide/messages.js';
import { subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import type { WorkName, WorkNameGroup } from './model';

export const NAMES_RETURN_BYTES = 8192;
export type NamesWindow = {
  query: string;
  page: number;
  expanded: boolean;
  groups: { index: number; page: number; open: boolean }[];
};
export type NamesNameFocus = {
  kind: 'name';
  language: string;
  role: 'title' | 'alias';
  identity: string;
};
export type NamesReturnFocus = 'terms' | 'sources' | NamesNameFocus;
/** Connected presentation targets belong to this mount, never browser history. */
export type NamesFocusTargets = {
  group: (language: string) => RefCallback<HTMLElement>;
  name: (language: string, name: WorkName) => RefCallback<HTMLButtonElement>;
};
type NameTarget = { language: string; name: WorkName };

async function spellingIdentity(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function returnFocus(value: unknown): NamesReturnFocus | undefined {
  if (value === 'terms' || value === 'sources') return value;
  if (!value || typeof value !== 'object') return;
  const focus = value as NamesNameFocus;
  if (
    focus.kind !== 'name' ||
    typeof focus.language !== 'string' ||
    focus.language.length > 2048 ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(focus.language) ||
    (focus.role !== 'title' && focus.role !== 'alias') ||
    typeof focus.identity !== 'string' ||
    !/^[a-f0-9]{64}$/.test(focus.identity)
  )
    return;
  return { kind: 'name', language: focus.language, role: focus.role, identity: focus.identity };
}
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
    const focus = returnFocus(candidate.focus);
    if (
      typeof candidate.binding !== 'string' ||
      candidate.binding.length > 2048 ||
      typeof candidate.href !== 'string' ||
      subjectVisitReturn(candidate.href, locale) !== candidate.href ||
      !candidate.href.endsWith('#supplied-names') ||
      (candidate.focus !== undefined && focus === undefined) ||
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
      ...(focus === undefined ? {} : { focus }),
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
  names,
  children,
}: {
  binding: string | undefined;
  returnHref: string | undefined;
  locale: string;
  current: () => boolean;
  names: readonly WorkNameGroup[];
  children: (restored: NamesWindow | undefined, status: NamesReturnStatus, targets: NamesFocusTargets) => ReactNode;
}) {
  const router = useRouter({ warn: false });
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef<EventTarget | null>(null);
  const lastName = useRef<NameTarget | undefined>(undefined);
  const nameTargets = useRef(new Map<HTMLElement, NameTarget>());
  const groupTargets = useRef(new Map<HTMLElement, string>());
  const targets = useMemo<NamesFocusTargets>(
    () => ({
      group: (language) => (element) => {
        if (!element) return;
        groupTargets.current.set(element, language);
        return () => {
          groupTargets.current.delete(element);
        };
      },
      name: (language, name) => (element) => {
        if (!element) return;
        nameTargets.current.set(element, { language, name });
        return () => {
          nameTargets.current.delete(element);
        };
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      host.current?.querySelector<HTMLElement>('summary')?.focus();
  });
  const [restored, setRestored] = useState<{
    window?: NamesWindow;
    focus?: NamesReturnFocus | 'section';
    status: NamesReturnStatus;
  }>({
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
    let active = true;
    const visitorFocused = () =>
      document.activeElement?.isConnected &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement;
    const restoreFocus = async () => {
      if (visitorFocused()) return;
      const intent = restored.focus;
      if (intent && typeof intent === 'object') {
        // Validate against this fresh finite projection, not a former DOM row or its index.
        const group = names.find((group) => group.language === intent.language);
        const candidates = group?.names.filter((name) => name.roles.includes(intent.role)) ?? [];
        const identities = await Promise.all(candidates.map((name) => spellingIdentity(name.text)));
        if (!active || !current() || visitorFocused()) return;
        const name = candidates[identities.indexOf(intent.identity)];
        const target =
          name &&
          [...nameTargets.current].find(
            ([element, target]) =>
              element.isConnected &&
              target.language === intent.language &&
              target.name.text === name.text &&
              target.name.roles.includes(intent.role),
          )?.[0];
        if (target) {
          target.focus();
          return;
        }
        const groupTarget = [...groupTargets.current].find(
          ([element, language]) => element.isConnected && language === intent.language,
        )?.[0];
        setRestored((value) => ({ ...value, focus: 'section', status: 'changed' }));
        (groupTarget ?? host.current?.querySelector<HTMLElement>('summary'))?.focus();
        return;
      }
      const anchor =
        intent === 'sources'
          ? host.current?.querySelector<HTMLAnchorElement>('[data-names-sources] a')
          : intent === 'terms'
            ? host.current?.querySelector<HTMLAnchorElement>('[data-names-terms] a')
            : undefined;
      (anchor ?? host.current?.querySelector<HTMLElement>('summary'))?.focus();
    };
    void restoreFocus();
    return () => {
      active = false;
    };
  }, [restored, names]);
  return (
    <div
      ref={host}
      className="min-w-0"
      onFocusCapture={(event) => {
        focused.current = event.target;
        const name = nameTargets.current.get(event.target as HTMLElement);
        if (name) lastName.current = name;
        else if (!(event.target instanceof Element && event.target.closest('[data-names-terms], [data-names-sources]')))
          lastName.current = undefined;
      }}
      onClickCapture={async (event) => {
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
        const descriptor = {
          binding,
          href: actualReturn,
          focus: (sourceVisit ? 'sources' : 'terms') as NamesReturnFocus,
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
        };
        event.preventDefault();
        event.stopPropagation();
        const name = lastName.current;
        if (name)
          descriptor.focus = {
            kind: 'name',
            language: name.language,
            role: name.name.roles[0]!,
            identity: await spellingIdentity(name.name.text),
          };
        if (!current()) return;
        const saved = namesReturn(descriptor, locale);
        if (!saved) return;
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
      {children(restored.window, restored.status, targets)}
    </div>
  );
}

/** A validated return link participates in the existing Terms departure guard and recovery. */
export function NamesTermsReturn({ id, locale, via }: { id: string; locale: string; via?: string | undefined }) {
  const href = subjectVisitReturn(via, locale);
  const safe = href?.startsWith(`/${locale}/subjects/${id}/`) && href.endsWith('#supplied-names') ? href : undefined;
  if (!safe) return null;
  return (
    <div className="mx-auto w-full max-w-4xl px-6 pt-4">
      <NamesReturnAnchor
        className="inline-flex min-h-11 items-center text-primary underline focus-visible:outline-2"
        href={safe}
        locale={locale}
      >
        {m.work_names_return({}, { locale: locale as never })}
      </NamesReturnAnchor>
    </div>
  );
}

/** Transfer only the closed history value; modified activation and new tabs use the real href. */
export function NamesReturnAnchor({
  href,
  locale,
  className,
  children,
}: {
  href: string;
  locale: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter({ warn: false });
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          !router ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          subjectVisitReturn(href, locale) !== href ||
          !href.endsWith('#supplied-names')
        )
          return;
        const saved = namesReturnFromHistory(router.history.location.state, locale);
        event.preventDefault();
        void router.navigate({
          to: href as never,
          state: (previous) => ({ ...previous, namesReturn: saved?.href === href ? saved : undefined }) as never,
        });
      }}
    >
      {children}
    </a>
  );
}
