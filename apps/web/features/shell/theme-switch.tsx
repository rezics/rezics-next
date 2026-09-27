'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@rezics/ui/menu';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { themes, type Theme } from './preferences.ts';
import { useShell } from './shell-provider.tsx';

const icons = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

export function ThemeMenu() {
  const { t, theme, setTheme } = useShell();
  const labels: Record<Theme, string> = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark };
  const Icon = icons[theme];
  return <Menu>
    <MenuTrigger asChild>
      <Button variant="ghost" size="icon-md" aria-label={t.displayMode} title={t.displayMode}>
        <Icon aria-hidden="true" className="size-5" />
      </Button>
    </MenuTrigger>
    <MenuContent className="w-48">
      <MenuRadioGroup heading={t.displayMode} value={theme}
        onValueChange={details => setTheme(details.value as Theme)}>
        {themes.map(choice => <MenuRadioItem key={choice} value={choice}>{labels[choice]}</MenuRadioItem>)}
      </MenuRadioGroup>
    </MenuContent>
  </Menu>;
}
