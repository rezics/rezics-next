import { useId, useLayoutEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { getLocale, locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const names = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
} satisfies Record<(typeof locales)[number], string>;
export type DisplayTheme = 'system' | 'light' | 'dark';

/** Compose the shell's cookie and locale-runtime pattern. The shell alone applies system theme and media changes. */
export function DisplayPreferences({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const ids = useId();
  const [theme, setTheme] = useState<DisplayTheme | null>(null);
  useLayoutEffect(() => {
    const cookie = /(?:^|;\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(document.cookie)?.[1];
    setTheme(cookie === 'light' || cookie === 'dark' ? cookie : 'system');
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-display-heading">{m.settings_display_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_display_text()}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${ids}-language`}>{m.shell_language()}</FieldLabel>
            <NativeSelect
              id={`${ids}-language`}
              value={getLocale()}
              disabled={theme === null}
              onChange={(event) => {
                const next = locales.find((locale) => locale === event.currentTarget.value);
                if (!next || next === getLocale()) return;
                document.cookie = `rezics_locale=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
                void setLocale(next);
              }}
            >
              {locales.map((locale) => (
                <NativeSelectOption key={locale} value={locale} lang={locale}>
                  {names[locale]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-theme`}>{m.shell_theme()}</FieldLabel>
            <NativeSelect
              id={`${ids}-theme`}
              value={theme ?? 'system'}
              disabled={theme === null}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (next !== 'system' && next !== 'light' && next !== 'dark') return;
                document.cookie = `rezics_theme=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
                setTheme(next);
                reload();
              }}
            >
              <NativeSelectOption value="system">{m.shell_theme_system()}</NativeSelectOption>
              <NativeSelectOption value="light">{m.shell_theme_light()}</NativeSelectOption>
              <NativeSelectOption value="dark">{m.shell_theme_dark()}</NativeSelectOption>
            </NativeSelect>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
