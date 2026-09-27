'use client';

import { Dialog, DialogBody, DialogContent, DialogHeader } from '@rezics/ui/dialog';
import { Kbd, KbdGroup } from '@rezics/ui/kbd';
import { useEffect, useState } from 'react';
import { useAdmin } from './admin-context.tsx';
import { isMac } from './keys.ts';
import { useTranslation } from '../../../i18n/client.ts';

/** The `?` cheat sheet. */
export function ShortcutsDialog() {
  const { t } = useTranslation('admin');
  const { shortcutsOpen, setShortcutsOpen } = useAdmin();
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => { if (isMac()) setMod('⌘'); }, []);
  const rows: [string[][], string][] = [
    [[[mod, 'K']], t.shortcuts.palette], [[['/']], t.shortcuts.search], [[['J'], ['K']], t.shortcuts.move],
    [[['Enter']], t.shortcuts.openRow], [[['X']], t.shortcuts.select], [[['?']], t.shortcuts.help], [[['Esc']], t.shortcuts.close],
  ];
  return <Dialog open={shortcutsOpen} onOpenChange={details => setShortcutsOpen(details.open)}>
    <DialogContent size="sm">
      <DialogHeader title={t.shortcuts.title} />
      <DialogBody>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-sm">
          {rows.map(([keys, label]) => <div key={label} className="contents">
            <dt><KbdGroup>{keys.map(chord => <span key={chord.join('+')} className="inline-flex gap-1">
              {chord.map(key => <Kbd key={key}>{key}</Kbd>)}</span>)}</KbdGroup></dt>
            <dd className="text-muted-foreground">{label}</dd>
          </div>)}
        </dl>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
