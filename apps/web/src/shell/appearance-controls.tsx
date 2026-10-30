import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { Globe, Monitor, Moon, Sun } from 'lucide-react';
import { getLocale, locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
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
export function ThemeControl() {
  const hydrated = useHydrated();
  const [theme, setTheme] = useState<'system' | 'light' | 'dark' | null>(null);
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
    if (theme === null) return;
    const preference = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && preference.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('light', !dark);
    };
    apply();
    if (theme !== 'system') return;
    preference.addEventListener('change', apply);
    return () => preference.removeEventListener('change', apply);
  }, [theme]);
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
  const locale = getLocale();
  const change = async (value: string | null) => {
    if (!value || value === locale) return;
    const next = value as typeof locale;
    document.cookie = `rezics_locale=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    await setLocale(next);
  };
  return (
    <>
      <div data-language-js className="contents">
        <Menu
          title={m.shell_language()}
          entries={[
            {
              type: 'radio',
              label: m.shell_language(),
              value: locale,
              options: locales.map((option) => ({ value: option, label: names[option] })),
              onValueChange: change,
            },
          ]}
          trigger={
            <Button
              className={cn(headerControlClass, 'max-w-32 bg-transparent px-3 hover:bg-accent/60 ')}
              variant="ghost"
              size="lg"
              disabled={!hydrated}
            >
              <Globe aria-hidden="true" />
              <span className="sr-only">{m.shell_language()} </span>
              <span className="inline">{names[locale]}</span>
            </Button>
          }
        />
      </div>
      <noscript>
        <details>
          <summary className="cursor-pointer rounded-lg border border-border/60 px-2 py-2">{names[locale]}</summary>
          <div className="absolute z-50 grid rounded-xl bg-popover p-2">
            {locales.map((value) => (
              <a key={value} lang={value} href={`/${value}`} className="px-2 py-1">
                {names[value]}
              </a>
            ))}
          </div>
        </details>
        <style>{'[data-language-js]{display:none!important}'}</style>
      </noscript>
    </>
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
