'use client';

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { segmentClass } from './locale-switch.tsx';
import type { Theme } from './preferences.ts';
import { useShell } from './shell-provider.tsx';

const icons = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

export function ThemeSwitch() {
  const { t, theme, setTheme } = useShell();
  const labels: Record<Theme, string> = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark };
  return <div role="group" aria-label={t.theme} className="flex gap-1 rounded-xl bg-muted p-1">
    {(Object.keys(icons) as Theme[]).map(choice => {
      const Icon = icons[choice];
      return <button key={choice} type="button" aria-pressed={theme === choice} aria-label={labels[choice]}
        title={labels[choice]} onClick={() => setTheme(choice)} className={segmentClass}>
        <Icon aria-hidden="true" className="size-4" />
      </button>;
    })}
  </div>;
}
