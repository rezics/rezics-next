'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@rezics/ui/menu';
import { PaletteIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { preferenceCookie } from '../shell/preferences.ts';
import { ZONE_LOOK_COOKIE } from './execution.ts';

/**
 * The reader's switch between each community's design and the standard look
 * everywhere. It is a site-wide preference in a cookie, so signed-out readers
 * have it too; the server re-renders the page without Zone colors, type and code.
 */
export function LookMenu({ enabled, labels }: {
  enabled: boolean;
  labels: { menu: string; zone: string; standard: string; help: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function choose(value: string) {
    document.cookie = preferenceCookie(ZONE_LOOK_COOKIE, value === 'standard' ? 'standard' : 'zone',
      location.protocol === 'https:');
    start(() => router.refresh());
  }
  return <Menu>
    <MenuTrigger asChild>
      <Button variant="outline" size="sm" pill aria-label={labels.menu} isLoading={pending}
        className="bg-card/80 backdrop-blur">
        <PaletteIcon aria-hidden="true" /><span className="max-sm:sr-only">{labels.menu}</span>
      </Button>
    </MenuTrigger>
    <MenuContent className="w-64">
      <MenuRadioGroup heading={labels.menu} value={enabled ? 'zone' : 'standard'}
        onValueChange={details => choose(details.value)}>
        <MenuRadioItem value="zone">{labels.zone}</MenuRadioItem>
        <MenuRadioItem value="standard">{labels.standard}</MenuRadioItem>
      </MenuRadioGroup>
      <p className="px-3 pt-1 pb-2 text-muted-foreground text-xs">{labels.help}</p>
    </MenuContent>
  </Menu>;
}
