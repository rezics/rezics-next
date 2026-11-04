import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { Globe, Monitor, Moon, Sun } from 'lucide-react';
import { getLocale, locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useShellStyleNonce } from './csp-rendering/style-nonce';
import { useLocaleNavigation } from './locale-navigation/context';
import {
  deriveLocaleDestinations,
  isDestinationVisit,
  isSameLocaleVisit,
  type Locale,
  type LocaleDestination,
  type LocaleNavigationLocation,
} from './locale-navigation/routing';
const headerControlClass = 'h-11 rounded-full border border-border/60 focus-visible:ring-2 focus-visible:ring-ring';
const noSubscription = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}
const names = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
} as const;

// Older media-query implementations and browsers without a matching feature keep the fallback.
function watchPreference(query: string, apply: (matches: boolean) => void) {
  let media: MediaQueryList | undefined;
  try {
    media = window.matchMedia?.(query);
  } catch {}
  const update = () => apply(media?.matches ?? false);
  update();
  if (!media) return;
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }
  media.addListener?.(update);
  return () => media.removeListener?.(update);
}

function useAppearancePreferences() {
  const hydrated = useHydrated();
  const [theme, setTheme] = useState<'system' | 'light' | 'dark' | null>(null);
  const [contrast, setContrast] = useState<'system' | 'standard' | 'more' | null>(null);
  useLayoutEffect(() => {
    const sync = () => {
      const cookie = /(?:^|;\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(document.cookie)?.[1];
      setTheme(cookie === 'light' || cookie === 'dark' ? cookie : 'system');
    };
    sync();
    window.addEventListener('rezics:theme', sync);
    return () => window.removeEventListener('rezics:theme', sync);
  }, []);
  useLayoutEffect(() => {
    const sync = () => {
      const cookie = /(?:^|;\s*)rezics_contrast=(system|standard|more)(?:;|$)/.exec(document.cookie)?.[1];
      setContrast(cookie === 'standard' || cookie === 'more' ? cookie : 'system');
    };
    sync();
    window.addEventListener('rezics:contrast', sync);
    return () => window.removeEventListener('rezics:contrast', sync);
  }, []);
  useLayoutEffect(() => {
    if (theme === null) return;
    const apply = (matches = false) => {
      const dark = theme === 'dark' || (theme === 'system' && matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('light', !dark);
    };
    if (theme === 'system') return watchPreference('(prefers-color-scheme: dark)', apply);
    apply();
  }, [theme]);
  useLayoutEffect(() => {
    if (contrast === null) return;
    const apply = (matches = false) => {
      document.documentElement.dataset.contrast =
        contrast === 'more' || (contrast === 'system' && matches) ? 'more' : 'standard';
    };
    if (contrast === 'system') return watchPreference('(prefers-contrast: more)', apply);
    apply();
  }, [contrast]);
  return { hydrated, theme, setTheme, contrast, setContrast };
}

/** Keep system preference listeners alive even while the account menu is closed. */
export function AppearancePreferenceSync() {
  useAppearancePreferences();
  return null;
}

export function ThemeControl() {
  const { hydrated, theme, setTheme, contrast, setContrast } = useAppearancePreferences();
  const icons = { system: Monitor, light: Sun, dark: Moon };
  const Icon = icons[theme ?? 'system'];
  const choose = (value: string) => {
    const next = value as Exclude<typeof theme, null>;
    setTheme(next);
    document.documentElement.classList.remove('light', 'dark');
    if (next !== 'system') document.documentElement.classList.add(next);
    document.cookie = `rezics_theme=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    window.dispatchEvent(new Event('rezics:theme'));
  };
  const chooseContrast = (value: string) => {
    const next = value === 'standard' || value === 'more' ? value : 'system';
    setContrast(next);
    document.cookie = `rezics_contrast=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    window.dispatchEvent(new Event('rezics:contrast'));
  };
  return (
    <Menu
      title={m.shell_theme()}
      entries={[
        {
          type: 'radio',
          label: m.shell_theme(),
          value: theme ?? 'system',
          options: [
            { value: 'system', label: m.shell_theme_system() },
            { value: 'light', label: m.shell_theme_light() },
            { value: 'dark', label: m.shell_theme_dark() },
          ],
          onValueChange: choose,
        },
        { type: 'separator' },
        {
          type: 'submenu',
          label: m.shell_contrast(),
          entries: [
            {
              type: 'radio',
              label: m.shell_contrast(),
              value: contrast ?? 'system',
              options: [
                { value: 'system', label: m.shell_contrast_system() },
                { value: 'standard', label: m.shell_contrast_standard() },
                { value: 'more', label: m.shell_contrast_more() },
              ],
              onValueChange: chooseContrast,
            },
          ],
        },
      ]}
      trigger={
        <Button
          className={headerControlClass}
          variant="ghost"
          size="icon-lg"
          disabled={!hydrated}
          aria-label={m.shell_theme()}
          title={m.shell_theme()}
        >
          <Icon aria-hidden="true" className="size-5" />
        </Button>
      }
    />
  );
}
export function LanguageControl() {
  const hydrated = useHydrated();
  const nonce = useShellStyleNonce();
  const navigation = useLocaleNavigation();
  const locale = navigation?.location.locale ?? getLocale();
  const location: LocaleNavigationLocation = navigation?.location ?? {
    pathname: '/',
    searchStr: '',
    hash: '',
    locale,
    visitKey: 'isolated-control',
    supported: false,
  };
  const destinations = deriveLocaleDestinations(location, hydrated);
  const [status, setStatus] = useState<
    | { kind: 'pending'; id: number; locale: Locale; source: LocaleNavigationLocation; reached: boolean }
    | { kind: 'failed'; locale: Locale; source: LocaleNavigationLocation; recovery: LocaleDestination }
    | null
  >(null);
  const sequence = useRef(0);
  const pending = useRef<{
    id: number;
    locale: Locale;
    source: LocaleNavigationLocation;
    destination: LocaleDestination;
    reached: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!navigation) return;
    const current = navigation.location;
    const active = pending.current;
    if (active) {
      if (isDestinationVisit(current, { ...active.destination, locale: active.locale })) {
        active.reached = true;
        return;
      }
      if (active.reached || !isSameLocaleVisit(current, active.source)) {
        sequence.current++;
        pending.current = null;
        setStatus(null);
      }
      return;
    }
    if (status?.kind === 'failed' && !isSameLocaleVisit(current, status.source)) setStatus(null);
  }, [navigation, status]);

  useLayoutEffect(
    () => () => {
      sequence.current++;
      pending.current = null;
    },
    [],
  );

  const change = async (value: string) => {
    const next = locales.find((candidate) => candidate === value);
    if (!next || next === locale || !navigation || pending.current) return;
    const source = navigation.readCurrentLocation();
    const destination = deriveLocaleDestinations(source, true).find((candidate) => candidate.locale === next);
    if (!destination) return;

    const id = ++sequence.current;
    pending.current = { id, locale: next, source, destination, reached: false };
    setStatus({ kind: 'pending', id, locale: next, source, reached: false });
    try {
      const result = await navigation.navigate(destination.href);
      if (sequence.current !== id) return;
      if (!isDestinationVisit(result, destination)) {
        if (isSameLocaleVisit(result, source)) {
          pending.current = null;
          setStatus(null);
          return;
        }
        pending.current = null;
        setStatus({
          kind: 'failed',
          locale: next,
          source,
          recovery: deriveLocaleDestinations(source, true).find((candidate) => candidate.locale === source.locale)!,
        });
        return;
      }

      // The URL strategy now resolves `next`; the normal runtime call commits its cookie without a second navigation.
      await (navigation.commitLocale ? navigation.commitLocale(next) : setLocale(next));
      if (sequence.current !== id || !isDestinationVisit(navigation.readCurrentLocation(), destination)) return;
      pending.current = null;
      setStatus(null);
      void navigation.revalidate().catch(() => undefined);
    } catch {
      if (sequence.current !== id) return;
      pending.current = null;
      setStatus({
        kind: 'failed',
        locale: next,
        source,
        recovery: deriveLocaleDestinations(source, true).find((candidate) => candidate.locale === source.locale)!,
      });
    }
  };

  const optionLabel = (destination: LocaleDestination) =>
    destination.kind === 'page'
      ? m.shell_language_option_page({ language: names[destination.locale] }, { locale })
      : m.shell_language_option_home({ language: names[destination.locale] }, { locale });
  const pendingLocale = status?.kind === 'pending' ? status.locale : null;
  return (
    <div className="min-w-0" aria-busy={pendingLocale !== null}>
      <div data-language-js className="contents">
        <Menu
          title={m.shell_language({}, { locale })}
          entries={[
            {
              type: 'radio',
              label: m.shell_language({}, { locale }),
              value: locale,
              options: destinations.map((destination) => ({
                value: destination.locale,
                label: optionLabel(destination),
              })),
              onValueChange: change,
            },
          ]}
          trigger={
            <Button
              className={cn(
                headerControlClass,
                'h-auto min-h-11 max-w-36 whitespace-normal break-words bg-transparent px-3 py-2 leading-tight hover:bg-accent/60',
              )}
              variant="ghost"
              size="lg"
              disabled={!hydrated || pendingLocale !== null}
              aria-label={`${m.shell_language({}, { locale })}: ${names[locale]}`}
              title={`${m.shell_language({}, { locale })}: ${names[locale]}`}
            >
              <Globe aria-hidden="true" />
              <span className="min-w-0 text-start">{names[locale]}</span>
            </Button>
          }
        />
      </div>
      {status?.kind === 'pending' ? (
        <p role="status" aria-live="polite" className="mt-1 max-w-48 break-words text-xs text-muted-foreground">
          {m.shell_language_switching({ language: names[status.locale] }, { locale })}
        </p>
      ) : null}
      {status?.kind === 'failed' ? (
        <p role="alert" className="mt-1 max-w-56 break-words text-xs text-destructive">
          {m.shell_language_switch_failed({ language: names[status.locale] }, { locale })}{' '}
          <a className="underline underline-offset-2" href={status.recovery.href}>
            {m.shell_language_recovery({ language: names[status.source.locale] }, { locale })}
          </a>
        </p>
      ) : null}
      {destinations.every((destination) => destination.kind === 'home') ? (
        <p role="note" className="mt-1 max-w-48 break-words text-xs text-muted-foreground">
          {m.shell_language_page_fallback({}, { locale })}
        </p>
      ) : null}
      <noscript>
        <details>
          <summary className="min-h-11 cursor-pointer rounded-lg border border-border/60 px-3 py-2">
            {m.shell_language({}, { locale })}: {names[locale]}
          </summary>
          {destinations.every((destination) => destination.kind === 'home') ? (
            <p className="max-w-64 break-words p-2 text-sm">{m.shell_language_page_fallback({}, { locale })}</p>
          ) : (
            <p className="max-w-64 break-words p-2 text-sm">{m.shell_language_page_destination({}, { locale })}</p>
          )}
          <div className="absolute z-50 grid max-w-64 rounded-xl bg-popover p-2">
            {destinations.map((destination) => (
              <a
                key={destination.locale}
                lang={destination.locale}
                href={destination.href}
                aria-label={optionLabel(destination)}
                className="min-h-11 break-words px-3 py-2"
              >
                {names[destination.locale]}
              </a>
            ))}
          </div>
        </details>
        <style nonce={nonce}>{'[data-language-js]{display:none!important}'}</style>
      </noscript>
    </div>
  );
}

export type AppearanceControlsProps = { className?: string };
/** Reusable display region for Settings and the phone You sheet. Uses the existing preference protocol. */
export function AppearanceControls({ className }: AppearanceControlsProps) {
  return (
    <section aria-label={m.shell_appearance()} className={cn('space-y-3', className)}>
      <h3 className="text-sm font-semibold">{m.shell_appearance()}</h3>
      <div className="flex items-center gap-3">
        <LanguageControl />
        <ThemeControl />
      </div>
    </section>
  );
}
