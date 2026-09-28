'use client';

import { Dialog, DialogBody, DialogContent, DialogHeader } from '@rezics/ui/dialog';
import { Kbd, KbdGroup } from '@rezics/ui/kbd';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useAdmin } from './admin-context.tsx';
import { isMac } from './keys.ts';
import { useTranslation } from '../../../i18n/client.ts';

type Row = [string[][], string];

/** The `?` cheat sheet, by where each key works. */
export function ShortcutsDialog() {
  const { t } = useTranslation('admin');
  const { shortcutsOpen, setShortcutsOpen, can } = useAdmin();
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => { if (isMac()) setMod('⌘'); }, []);
  const go = (key: string, section: string): Row => [[['G'], [key]], t.keys.goTo({ section })];
  const groups: [string, Row[]][] = [
    [t.keys.everywhere, [[[[mod, 'K']], t.shortcuts.palette], [[['/']], t.shortcuts.search], go('O', t.overview), go('U', t.users),
      go('S', t.staff), ...(can('clients:manage') ? [go('C', t.clients)] : []), ...(can('audit:read') ? [go('A', t.audit)] : []),
      [[['?']], t.shortcuts.help], [[['Esc']], t.shortcuts.close]]],
    [t.keys.lists, [[[['J'], ['K']], t.shortcuts.move], [[['Enter']], t.shortcuts.openRow], [[['X']], t.shortcuts.select]]],
    [t.overview, [[[['R']], t.keys.review]]],
    [t.keys.userPage, [[[['N']], t.keys.note]]],
  ];
  const content = useRef<HTMLDivElement>(null);
  // Start on the Close button, not the scrolling body (see useDismiss).
  return <Dialog open={shortcutsOpen} onOpenChange={details => setShortcutsOpen(details.open)}
    initialFocusEl={() => content.current?.querySelector('button') ?? null}>
    <DialogContent ref={content} size="sm">
      <DialogHeader title={t.shortcuts.title} />
      <DialogBody className="flex flex-col gap-5">
        {groups.map(([heading, rows]) => <section key={heading}>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{heading}</h3>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2.5 text-sm">
            {rows.map(([keys, label]) => <div key={label} className="contents">
              <dt><KbdGroup>{keys.map((chord, index) => <Fragment key={chord.join('+')}>
                {index && keys[0]![0] === 'G' ? <span className="text-xs text-muted-foreground">{t.keys.then}</span> : null}
                <span className="inline-flex gap-1">{chord.map(key => <Kbd key={key}>{key}</Kbd>)}</span></Fragment>)}</KbdGroup></dt>
              <dd className="text-muted-foreground">{label}</dd>
            </div>)}
          </dl>
        </section>)}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
