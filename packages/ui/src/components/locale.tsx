import { createContext, useContext, type ReactNode } from 'react';

export type LocaleContext = {
  locale: string;
  dir: 'ltr' | 'rtl';
};

const rtlScripts = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv']);

const directionOf = (locale: string): 'ltr' | 'rtl' => {
  const [language, script] = locale.toLowerCase().split('-');
  return rtlScripts.has(language ?? '') || script === 'arab' || script === 'hebr' ? 'rtl' : 'ltr';
};

const defaultLocale = () => (typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US');

const Context = createContext<string | undefined>(undefined);

export function LocaleProvider({ locale, children }: { locale: string; children?: ReactNode }) {
  return <Context value={locale}>{children}</Context>;
}

export function useLocale(): LocaleContext {
  const locale = useContext(Context) ?? defaultLocale();
  return { locale, dir: directionOf(locale) };
}
