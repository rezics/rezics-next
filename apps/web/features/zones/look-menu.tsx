'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@rezics/ui/menu';
import { PaletteIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { preferenceCookie } from '../shell/preferences.ts';
import { saveDisplayPreference } from '../api/preferences.ts';
import { ZONE_LOOK_COOKIE } from './execution.ts';

/**
 * The reader's switch between each community's design and the standard look
 * everywhere. It is a site-wide preference in a cookie, so signed-out readers
 * have it too; the server re-renders the page without Zone colors, type and code.
 */
export function LookMenu({ enabled, labels, save = saveDisplayPreference }: {
  enabled: boolean;
  labels: { menu: string; zone: string; standard: string; help: string; saveFailed: string };
  save?: typeof saveDisplayPreference;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  async function choose(value: string) {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    const saved = await save({ showZoneThemes: value !== 'standard' });
    setSaving(false);
    if (saved === 'failed') { setFailed(true); setOpen(true); return; }
    document.cookie = preferenceCookie(ZONE_LOOK_COOKIE, value === 'standard' ? 'standard' : 'zone',
      location.protocol === 'https:');
    start(() => router.refresh());
  }
  return <><Menu open={open} onOpenChange={details => setOpen(details.open)}>
    <MenuTrigger asChild>
      <Button variant="outline" size="sm" pill aria-label={labels.menu} isLoading={pending || saving}
        className="bg-card/80 backdrop-blur">
        <PaletteIcon aria-hidden="true" /><span className="max-sm:sr-only">{labels.menu}</span>
      </Button>
    </MenuTrigger>
    <MenuContent className="w-64">
      <MenuRadioGroup heading={labels.menu} value={enabled ? 'zone' : 'standard'}
        onValueChange={details => void choose(details.value)}>
        <MenuRadioItem value="zone">{labels.zone}</MenuRadioItem>
        <MenuRadioItem value="standard">{labels.standard}</MenuRadioItem>
      </MenuRadioGroup>
      <p className="px-3 pt-1 pb-2 text-muted-foreground text-xs">{labels.help}</p>
      {failed ? <p className="px-3 pb-2 text-destructive text-xs">{labels.saveFailed}</p> : null}
    </MenuContent>
  </Menu>{failed ? <span role="alert" className="sr-only">{labels.saveFailed}</span> : null}</>;
}
