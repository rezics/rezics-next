'use client';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { normalizeDocument } from '@rezics/document';
import { useListCollection } from '@ark-ui/react/combobox';
import { RichTextEditor } from '../../../packages/ui/src/components/rich-text-editor.tsx';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogBody, DialogClose } from '../../../packages/ui/src/components/dialog.tsx';
import { Menu, MenuTrigger, MenuContent, MenuItem } from '../../../packages/ui/src/components/menu.tsx';
import { Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem } from '../../../packages/ui/src/components/combobox.tsx';
import { Adapter } from 'virtual:hotkey-adapter';
import { NativeOwners } from 'virtual:native-owners';
import { ariaKey, bindings, blocked, validateRemap } from './policy.mjs';

declare const __CANDIDATE__: string;
const candidate = __CANDIDATE__;
const labels = ['Search', 'Editor link', 'Editor bold', 'Toggle sidebar', 'Navigation / help'];

function Workload({ count, epoch }: { count: number; epoch: number }) {
  const [documentValue, setDocumentValue] = useState(() => normalizeDocument({
    version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'keyboard-trial-paragraph' }, content: [{ type: 'text', text: 'A mixed 漢字 manuscript.' }] },
    ] },
  }));
  const [disabled, setDisabled] = useState(false);
  const [searchKey, setSearchKey] = useState('Mod+K');
  const [proposal, setProposal] = useState('Mod+K');
  const [error, setError] = useState('');
  const [sequence, setSequence] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [pending, setPending] = useState(false);
  const [apple, setApple] = useState<boolean | undefined>();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const rows = bindings(count, searchKey, disabled, sequence);
  const logs = useRef<any[]>([]);
  const act = useCallback((id: string) => {
    logs.current.push({ id, at: performance.now(), epoch });
    if (id === 'search') (window.document.querySelector('#fixture-search') as HTMLInputElement)?.focus();
    if (id === 'sidebar') setSidebar(open => !open);
    const output = window.document.querySelector('#action-log');
    if (output) output.textContent = JSON.stringify(logs.current.slice(-8));
  }, [epoch]);
  useEffect(() => {
    setApple(/Mac|iPhone|iPad/.test(navigator.platform));
    setPortal(window.document.getElementById('portal-target'));
    const legacy = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      // Independent owner: cooperation is explicit, counted shared policy.
      if (candidate !== 'native-as-is' && (event.altKey || blocked(event, 'search')
        || !rows.some((row: any) => row.id === 'search' && row.enabled && row.key === 'Mod+K'))) return;
      act('legacy');
    };
    window.addEventListener('keydown', legacy);
    (window as any).__fixture = { logs: logs.current, rows, epoch, candidate,
      clear: () => { logs.current.length = 0; }, act };
    return () => { window.removeEventListener('keydown', legacy); };
  }, [act, disabled, searchKey, sequence, count]);
  const { collection } = useListCollection({ initialItems: [
    { label: '漢字 — Manuscript', value: 'manuscript' }, { label: 'Chapter two', value: 'two' },
  ] });
  const controls = <>
    {candidate !== 'native-as-is' && <div className="flex flex-wrap gap-3">
      <label className="grow">Search<input id="fixture-search" type="search" aria-keyshortcuts={!disabled && apple !== undefined ? ariaKey(searchKey, apple) : undefined} /></label>
      <button onClick={() => act('search')}>Focus search</button>
      <button onClick={() => act('sidebar')} aria-keyshortcuts={apple === undefined ? undefined : ariaKey('Mod+B', apple)}>Toggle sidebar</button>
    </div>}
    <output aria-label="Sidebar state">Sidebar {sidebar ? 'open' : 'closed'}</output>
    <section aria-label="Shortcut help"><h2>Actions and active keys</h2><ul>
      {labels.map((label, index) => <li key={label}>{label}: <kbd>{index === 0 ? disabled ? 'disabled' : searchKey
        : index === 1 ? 'Mod+K (editor)' : index === 2 ? 'Mod+B (editor)' : index === 3 ? 'Mod+B (page)' : disabled ? 'disabled' : sequence ? 'G then H' : '?'}</kbd></li>)}
    </ul><button aria-keyshortcuts={disabled || sequence ? undefined : 'Shift+/'} onClick={() => act('navigation-help')}>Open navigation help</button></section>
    <fieldset><legend>Trial binding controls</legend><label><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} />Disable search and character shortcuts</label>
      <label>Search binding<input aria-label="Search binding" value={proposal} onChange={event => setProposal(event.target.value)} /></label>
      <button onClick={() => { const invalid = validateRemap(proposal); setError(invalid); if (!invalid) setSearchKey(proposal); }}>Apply binding</button>
      <button onClick={() => { setSearchKey('Mod+K'); setProposal('Mod+K'); setDisabled(false); setError(''); }}>Reset bindings</button>
      <label><input type="checkbox" checked={sequence} onChange={event => setSequence(event.target.checked)} />Use G then H for help</label>
      <p role="status">{error}</p>
    </fieldset>
    <section aria-label="Writing"><RichTextEditor value={documentValue} onChange={setDocumentValue} label="Manuscript" toolbarMode="full" pointerMode="fine" />
      <output id="document-json" hidden>{JSON.stringify(documentValue)}</output></section>
    <section aria-label="Editable and widget targets" className="grid gap-3">
      <label>Plain input<input id="plain-input" /></label><label>Textarea<textarea id="plain-textarea" /></label>
      <label>Select<select id="plain-select"><option>One</option><option>Two</option></select></label>
      <Menu><MenuTrigger>Open action menu</MenuTrigger><MenuContent><MenuItem value="help" onClick={() => act('menu-help')}>Menu help</MenuItem><MenuItem value="other">Other action</MenuItem></MenuContent></Menu>
      <Combobox collection={collection}><ComboboxInput aria-label="Choose manuscript" placeholder="Choose manuscript" /><ComboboxContent><ComboboxList>
        {collection.items.map(item => <ComboboxItem key={item.value} item={item}>{item.label}</ComboboxItem>)}
      </ComboboxList></ComboboxContent></Combobox>
      <Dialog pending={pending}><DialogTrigger id="modal-trigger">Open trial modal</DialogTrigger><DialogContent>
        <DialogHeader title="Trial modal" description="Existing dialog owner; no saved changes." /><DialogBody>
          <label>Dialog input<input id="modal-input" /></label>
          <label><input type="checkbox" checked={pending} onChange={event => setPending(event.target.checked)} />Pending trial action</label>
          <Dialog><DialogTrigger>Open nested modal</DialogTrigger><DialogContent><DialogHeader title="Nested modal" /><DialogBody><input aria-label="Nested input" /><DialogClose>Close nested modal</DialogClose></DialogBody></DialogContent></Dialog>
          <DialogClose disabled={pending}>Close trial modal</DialogClose>
        </DialogBody></DialogContent></Dialog>
    </section>
    <div id="portal-target" />{portal && createPortal(<label>Portal input<input id="portal-input" /></label>, portal)}
    <button id="consumed" onKeyDown={event => { if (event.key.toLowerCase() === 'k') event.preventDefault(); }}>Consumed-event target</button>
    <button id="page-target">Page key target</button>
    <output id="action-log" aria-label="Action log" className="block break-all text-xs">[]</output>
  </>;
  return <><Adapter rows={rows} act={act} /><NativeOwners act={act}>{controls}</NativeOwners></>;
}

export default function Fixture() {
  const [count, setCount] = useState(5);
  const [mounted, setMounted] = useState(true);
  const [strict, setStrict] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const content = mounted ? <Workload key={epoch} count={count} epoch={epoch} /> : null;
  return <main id="keyboard-fixture" className="mx-auto grid max-w-4xl gap-5 p-5" aria-label="Keyboard comparison">
    <h1>Keyboard comparison: {candidate}</h1><p>Isolated benign actions. This fixture grants no API authority.</p>
    <nav className="flex flex-wrap gap-3"><Link href="/">Fixture home</Link><Link href="/second">Fixture second route</Link></nav>
    <div className="flex flex-wrap gap-3"><label>Registrations<select aria-label="Registration count" value={count} onChange={event => setCount(Number(event.target.value))}><option value={5}>5</option><option value={50}>50</option></select></label>
      <label><input type="checkbox" checked={strict} onChange={event => { setStrict(event.target.checked); setEpoch(n => n + 1); }} />Strict Mode</label>
      <button onClick={() => { setMounted(value => !value); setEpoch(n => n + 1); }}>{mounted ? 'Unmount workload' : 'Mount workload'}</button>
    </div>{strict ? <StrictMode>{content}</StrictMode> : content}
  </main>;
}
