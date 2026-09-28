'use client';

import { ActionBar, ActionBarBody, ActionBarClose, ActionBarContent, ActionBarSeparator, ActionBarValue }
  from '@rezics/ui/action-bar';
import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/collapsible';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent,
  MenuSubTrigger, MenuTrigger } from '@rezics/ui/menu';
import { ChoiceSelect } from '@rezics/ui/select';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { ArrowDownIcon, ArrowLeftRightIcon, ArrowUpIcon, BookOpenIcon, ChevronDownIcon, EllipsisIcon, FolderInputIcon,
  GripVerticalIcon, LockIcon, PenLineIcon, PlusIcon, SendIcon, Trash2Icon, TriangleAlertIcon, XIcon }
  from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import { type DragEvent, type FormEvent, type ReactNode, Suspense, use, useEffect, useId, useMemo, useRef, useState }
  from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { relativeTime } from '../feed/time.ts';
import Link from '../shell/localized-link.tsx';
import { chapterHref as readerChapterHref } from '../work-page/route.ts';
import { volumeName } from '../work-page/format.ts';
import { chapterVariant, changeComposition, type CompositionOperation, createChapter, ensureComposition,
  publishLatest } from './content-api.ts';
import { browserStorage, type ChapterMemory, chapterMemoryKey, readChapterMemory } from './local-draft.ts';
import type { StudioMessages } from './messages.ts';
import { chapterHref } from './agent.ts';
import { lengthUnit } from './counts.ts';
import { type ChapterFact, type ChapterFacts, type ChapterState, chapterFacts, defaultChapterParent,
  type Destination, dropEdge, groupsOf, moveOperation, publishable, stepDestination } from './outline.ts';
import { lengthLabel } from './parts.tsx';
import { studioAgentName } from './studio-frame.tsx';
import type { ContentsItem, ContentsPage, Loaded, MainClient } from './types.ts';
import { idOf } from './types.ts';

type T = ContractOf<StudioMessages>;
type Division = 'volume' | 'part' | 'extras';

export interface ChapterListProps {
  agent: AgentOption;
  /** This person's identities, to name who writes each chapter. */
  agents?: readonly AgentOption[];
  book: { id: string; mainVersion: string; title: string; language: string };
  /** The Book's top level (chapters, volumes, parts, extras); `none` while the Book has no composition. */
  page: Loaded<ContentsPage> | { ok: false; failure: 'none' };
  /** The volume shown open, with its first page of chapters and their facts, read with the top level. */
  opened?: { occurrence: string; page: ContentsPage; facts: Promise<ChapterFacts> } | null;
  /** The identity Main read the chapters as (this Agent, or another of this person's that writes the Book). */
  readAs?: string;
  locale: UiLocale;
  messages: StudioMessages;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: MainClient;
  /** Stories pin the clock for relative save times. */
  now?: number;
  /**
   * Who writes each top-level chapter and where it stands, as Main says. It
   * streams in after the list; until then a chapter's state is what readers get.
   */
  facts?: Promise<ChapterFacts>;
}

/** One level of the outline as Studio holds it: the loaded items in order and Main's cursor for more. */
interface Level { status: 'idle' | 'loading' | 'loaded' | 'failed'; items: ContentsItem[]; next: string | null }
const levelOf = (page: ContentsPage): Level => ({ status: 'loaded', items: page.items, next: page.nextCursor });
/** What is being dragged, and where it would land. */
type Drag = { occurrence: string; role: 'chapter' | 'group'; parent: string };
type Drop = { occurrence: string; edge: 'before' | 'after' | 'into' } | { end: true };

/** Where a chapter stands: Main's word when it has come, else what readers get and this device remembers. */
function stateOf(row: ContentsItem, fact: ChapterFact | undefined, memory: ChapterMemory | undefined): ChapterState {
  if (fact?.state) return fact.state;
  if (row.availability === 'available') {
    return memory?.publishedHead && memory.head && memory.head !== memory.publishedHead ? 'changed' : 'published';
  }
  return memory?.head ? 'draft' : 'empty';
}

function Status({ state, t }: { state: ChapterState; t: T }) {
  switch (state) {
    case 'published': return <Badge variant="success">{t.statePublished}</Badge>;
    case 'changed': return <><Badge variant="success">{t.statePublished}</Badge>
      <Badge variant="warning">{t.chapterChanged}</Badge></>;
    case 'draft': return <Badge variant="outline">{t.stateDraft}</Badge>;
    case 'empty': return <Badge variant="secondary">{t.stateEmpty}</Badge>;
  }
}

/** A group's name: its title, else what it is ("Volume 2", "Extras", "Untitled part"). */
function groupName(item: ContentsItem, locale: UiLocale, t: T): string {
  return item.label?.value ?? (item.division === 'volume' && item.number ? volumeName(item.number, locale, t)
    : item.division === 'extras' ? t.extras : t.untitledPart);
}

/** Resolves the server's facts for the rows under it; the list renders at once without them. */
function WithFacts({ facts, children }: { facts: Promise<ChapterFacts>; children: (known: ChapterFacts) => ReactNode }) {
  return children(use(facts));
}

const dropClass = (drop: Drop | null, occurrence: string) => drop && 'occurrence' in drop && drop.occurrence === occurrence
  ? drop.edge === 'before' ? 'shadow-[inset_0_2px_0_0_var(--color-primary)]'
    : drop.edge === 'after' ? 'shadow-[inset_0_-2px_0_0_var(--color-primary)]' : 'ring-2 ring-primary ring-inset'
  : '';

/**
 * A Book's chapters as its writer manages them, the way long serials are
 * built: volumes, parts and extras (番外) as sections that open and close, each
 * chapter with its number, where it stands and how long it is. Chapters and
 * volumes move by dragging their handle, or from the handle's menu with the
 * keyboard; several chapters can be selected to publish or move together; a
 * new chapter goes to the end of a chosen volume. Every change is one command
 * on the composition's current head, and each changed level is read again.
 */
export function ChapterList({ agent, agents = [agent], book, page, opened = null, readAs = agent.iri, locale, messages,
  main, now, facts }: ChapterListProps) {
  const t = materializeData(messages, { locale });
  const formId = useId();
  const client = () => main ?? browserMainApi();
  const [composition, setComposition] = useState(page.ok
    ? { structure: page.data.composition, head: page.data.compositionRevision } : null);
  const [top, setTop] = useState<Level>(page.ok ? levelOf(page.data) : { status: 'loaded', items: [], next: null });
  const [levels, setLevels] = useState<Record<string, Level>>(opened ? { [opened.occurrence]: levelOf(opened.page) } : {});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(opened ? [opened.occurrence] : []));
  const [known, setKnown] = useState<ChapterFacts>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const structure = composition?.structure ?? null;
  const [target, setTarget] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<string | null>(null);
  const openedFacts = useMemo(() => opened?.facts ?? Promise.resolve({}), [opened]);
  const serverFacts = useMemo(() => Promise.all([facts ?? Promise.resolve({}), openedFacts])
    .then(([first, second]) => ({ ...first, ...second })), [facts, openedFacts]);

  // What this device remembers of each chapter's draft: when it last saved it and the head it saved,
  // which pins the chapter's address and stands for Main's word on its state until that streams in.
  const visible = useMemo(() => [...top.items, ...[...open].flatMap(group => levels[group]?.items ?? [])]
    .filter(item => item.role === 'chapter' && item.target), [top, levels, open]);
  const [memory, setMemory] = useState<Record<string, ChapterMemory>>({});
  useEffect(() => {
    let active = true;
    const storage = browserStorage();
    void Promise.all(visible.map(async row => {
      const variant = await chapterVariant(row.target!, row.label?.language ?? book.language);
      return [row.target!, readChapterMemory(storage, chapterMemoryKey(agent.iri, variant))] as const;
    })).then(entries => {
      if (active) {
        setMemory(Object.fromEntries(entries.filter((entry): entry is readonly [string, ChapterMemory] => !!entry[1])));
      }
    });
    return () => { active = false; };
  }, [visible, agent.iri, book.language]);

  /** Reads one level again (the top level for `null`), with Main's facts for its chapters. */
  const read = async (parent: string | null, cursor?: string) => {
    const answer = await client().v1.me.agents({ agent: idOf(readAs) }).works({ id: idOf(book.id) }).chapters.get({
      query: { language: book.language, ...(parent ? { parent } : {}), ...(cursor ? { cursor } : {}) } });
    if (!answer.data) return null;
    setKnown(current => ({ ...current, ...chapterFacts(agent, agents, answer.data.page, answer.data.facts) }));
    setComposition({ structure: answer.data.page.composition, head: answer.data.page.compositionRevision });
    return answer.data.page;
  };
  const load = async (group: string, cursor?: string) => {
    setLevels(current => ({ ...current, [group]: { ...(current[group] ?? { items: [], next: null }),
      status: 'loading' } }));
    const loaded = await read(group, cursor).catch(() => null);
    setLevels(current => ({ ...current, [group]: loaded ? { status: 'loaded', next: loaded.nextCursor,
      items: cursor ? [...current[group]?.items ?? [], ...loaded.items] : loaded.items }
      : { ...(current[group] ?? { items: [], next: null }), status: 'failed' } }));
  };
  /** After a change: the top level and every open group read again, since numbers and counts move with it. */
  const refresh = async (also: readonly string[] = []) => {
    const loaded = await read(null).catch(() => null);
    if (loaded) setTop(levelOf(loaded));
    const groups = new Set([...open, ...also].filter(group => loaded?.items.some(item => item.occurrence === group)));
    await Promise.all([...groups].map(group => load(group)));
  };

  const run = async (label: string, operations: CompositionOperation[], done: string, also: readonly string[] = []) => {
    if (!composition || busy) return false;
    setBusy(label);
    setError(null);
    let changed = false;
    try {
      // A change carries at most 16 moves; a larger selection moves in order, one change after another.
      let head = composition.head;
      for (let start = 0; start < operations.length; start += 16) {
        const result = await changeComposition({ actingSubject: agent.iri, book: book.id, language: book.language,
          composition: { structure: composition.structure, head }, operations: operations.slice(start, start + 16),
          key: crypto.randomUUID() }, main);
        if (result.outcome !== 'done') {
          setError(result.outcome === 'denied' ? t.outlineChangeDenied : t.outlineChangeFailed);
          break;
        }
        head = result.head;
        changed = start + 16 >= operations.length;
      }
      if (changed) setAnnouncement(done);
    } catch {
      setError(t.outlineChangeFailed);
    } finally {
      await refresh(also);
      setBusy(null);
    }
    return changed;
  };

  const siblingsOf = (parent: string) => parent === structure ? top.items : levels[parent]?.items ?? [];
  const nameOf = (item: ContentsItem, fact?: ChapterFact) => item.role === 'group' ? groupName(item, locale, t)
    : (item.label ?? fact?.label)?.value ?? (item.target || fact?.target ? t.chapterUntitled : t.chapterHidden);
  const moveTo = (item: ContentsItem, destination: Destination, fact?: ChapterFact) => {
    const into = destination.parent === structure ? null : top.items.find(group => group.occurrence === destination.parent);
    const done = item.parent === destination.parent ? t.movedWithin({ title: nameOf(item, fact) })
      : into ? t.movedInto({ title: nameOf(item, fact), group: groupName(into, locale, t) })
        : t.movedOut({ title: nameOf(item, fact) });
    void run(item.occurrence, [moveOperation(item.occurrence, destination, siblingsOf(destination.parent))], done,
      into ? [into.occurrence] : []);
    if (into) setOpen(current => new Set([...current, into.occurrence]));
  };

  const onDragStart = (event: DragEvent, item: ContentsItem) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', nameOf(item));
    setDrag({ occurrence: item.occurrence, role: item.role, parent: item.parent });
  };
  const over = (event: DragEvent, item: ContentsItem, into = false) => {
    if (!drag || drag.occurrence === item.occurrence) return;
    // Volumes stand only at the top level; a chapter dropped on a volume's header goes to its end.
    if (drag.role === 'group' && item.parent !== structure) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const edge = into && drag.role === 'chapter' ? 'into' as const
      : dropEdge(event.clientY, event.currentTarget.getBoundingClientRect());
    setDrop(current => current && 'occurrence' in current && current.occurrence === item.occurrence
      && current.edge === edge ? current : { occurrence: item.occurrence, edge });
  };
  const dropped = (event: DragEvent, facts: ChapterFacts) => {
    event.preventDefault();
    const moving = drag && [...top.items, ...Object.values(levels).flatMap(level => level.items)]
      .find(item => item.occurrence === drag.occurrence);
    const at = drop;
    setDrag(null);
    setDrop(null);
    if (!moving || !at || !structure) return;
    if ('end' in at) return moveTo(moving, { parent: structure, end: true }, facts[moving.occurrence]);
    const anchor = [...top.items, ...Object.values(levels).flatMap(level => level.items)]
      .find(item => item.occurrence === at.occurrence);
    if (!anchor) return;
    moveTo(moving, at.edge === 'into' ? { parent: anchor.occurrence, end: true }
      : at.edge === 'before' ? { parent: anchor.parent, before: anchor.occurrence }
        : { parent: anchor.parent, after: anchor.occurrence }, facts[moving.occurrence]);
  };
  const dragEnd = () => { setDrag(null); setDrop(null); };

  const addChapter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('title') ?? '').trim();
    if (!name || busy) return;
    setBusy('add');
    setError(null);
    // One key per chapter the writer asked for: a retry after a lost answer replays instead of adding it twice.
    attempt.current ??= crypto.randomUUID();
    const parent = target && target !== structure ? target : null;
    try {
      const result = await createChapter({ actingSubject: agent.iri, book: book.id, mainVersion: book.mainVersion,
        title: name, language: book.language, key: attempt.current, composition, parent }, main);
      const again = result.outcome === 'stale' && composition ? await createChapter({ actingSubject: agent.iri,
        book: book.id, mainVersion: book.mainVersion, title: name, language: book.language, key: attempt.current,
        composition: await read(null).then(read => read ? { structure: read.composition, head: read.compositionRevision }
          : composition), parent }, main) : result;
      if (again.outcome === 'done' && again.chapter && again.structure) {
        attempt.current = null;
        setComposition({ structure: again.structure, head: again.head });
        form.reset();
        setAnnouncement(t.chapterAdded({ title: name }));
        if (parent) setOpen(current => new Set([...current, parent]));
        await refresh(parent ? [parent] : []);
      } else {
        setError(again.outcome === 'denied' ? t.chapterAddDenied : again.outcome === 'pending' ? t.chapterAddPending
          : t.chapterAddFailed);
      }
    } catch {
      setError(t.chapterAddFailed);
    } finally { setBusy(null); }
  };

  const createGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const division = (String(data.get('division') ?? 'volume') || 'volume') as Division;
    if (busy) return;
    let current = composition;
    if (!current) {
      const made = await ensureComposition({ actingSubject: agent.iri, book: book.id, mainVersion: book.mainVersion,
        language: book.language, key: crypto.randomUUID() }, main);
      if (typeof made === 'string') return setError(made === 'denied' ? t.outlineChangeDenied : t.outlineChangeFailed);
      current = made;
      setComposition(made);
    }
    const operation: CompositionOperation = { op: 'insert', parent: current.structure, position: 'last', role: 'group',
      division, ...(title ? { label: { value: title, language: book.language } } : {}) };
    setBusy('group');
    setError(null);
    const result = await changeComposition({ actingSubject: agent.iri, book: book.id, language: book.language,
      composition: current, operations: [operation], key: crypto.randomUUID() }, main).catch(() => null);
    setBusy(null);
    if (result?.outcome === 'done') {
      setCreating(false);
      const group = result.occurrences?.[0];
      if (group) {
        setOpen(existing => new Set([...existing, group]));
        setTarget(group);
      }
      setAnnouncement(t.volumeCreated({ title: title || (division === 'extras' ? t.extras : t.newVolume) }));
      await refresh(group ? [group] : []);
    } else setError(result?.outcome === 'denied' ? t.outlineChangeDenied : t.outlineChangeFailed);
  };

  const [publishing, setPublishing] = useState<{ done: number; total: number } | null>(null);
  const publishSelected = async (facts: ChapterFacts) => {
    const items = [...top.items, ...Object.values(levels).flatMap(level => level.items)]
      .filter((item, index, all) => selected.has(item.occurrence)
        && all.findIndex(other => other.occurrence === item.occurrence) === index);
    const ready = items.filter(item => item.target && publishable(facts[item.occurrence]));
    if (!ready.length) return setAnnouncement(t.nothingToPublish);
    setBusy('publish');
    setError(null);
    let done = 0;
    for (const item of ready) {
      setPublishing({ done: done + 1, total: ready.length });
      const outcome = await publishLatest({ actingSubject: agent.iri, chapter: item.target!,
        language: item.label?.language ?? book.language }, main).catch(() => 'failed' as const);
      if (outcome === 'done') done++;
    }
    setPublishing(null);
    setSelected(new Set());
    setAnnouncement(done === ready.length ? t.publishedChapters(done)
      : t.publishSomeFailed({ done: String(done), total: String(ready.length) }));
    await refresh();
    setBusy(null);
  };
  const moveSelected = (parent: string, facts: ChapterFacts) => {
    // In reading order: the top level, then each group's loaded chapters.
    const order = top.items.flatMap(item => item.role === 'group' ? levels[item.occurrence]?.items ?? [] : [item]);
    const moving = order.filter(item => selected.has(item.occurrence) && item.role === 'chapter');
    const into = parent === structure ? null : top.items.find(item => item.occurrence === parent);
    const title = moving.length === 1 ? nameOf(moving[0]!, facts[moving[0]!.occurrence]) : t.selected(moving.length);
    void run('move', moving.map(item => moveOperation(item.occurrence, { parent, end: true }, [])),
      into ? t.movedInto({ title, group: groupName(into, locale, t) }) : t.movedOut({ title }),
      into ? [into.occurrence] : []).then(changed => { if (changed) setSelected(new Set()); });
  };

  const groups = groupsOf(top.items);
  const chosen = target ?? (structure ? defaultChapterParent(structure, top.items) : null);
  const failed = !page.ok && page.failure !== 'none' && page.failure !== 'missing';
  const clock = now ?? Date.now();

  /** The handle a chapter or volume moves by: drag it, or open it for moves the keyboard reaches. */
  const handle = (item: ContentsItem, parent: string, facts: ChapterFacts) => {
    const name = nameOf(item, facts[item.occurrence]);
    const siblings = siblingsOf(parent);
    const up = stepDestination(item.occurrence, -1, parent, siblings);
    const down = stepDestination(item.occurrence, 1, parent, siblings);
    const into = item.role === 'chapter' ? groups.filter(group => group.occurrence !== item.parent) : [];
    return <Menu onSelect={details => {
      if (details.value === 'up' && up) moveTo(item, up, facts[item.occurrence]);
      else if (details.value === 'down' && down) moveTo(item, down, facts[item.occurrence]);
      else if (details.value === 'top' && structure) moveTo(item, { parent: structure, end: true }, facts[item.occurrence]);
      else if (details.value.startsWith('into:')) {
        moveTo(item, { parent: details.value.slice(5), end: true }, facts[item.occurrence]);
      }
    }}>
      <MenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" draggable={busy === null}
          onDragStart={event => onDragStart(event, item)} onDragEnd={dragEnd}
          aria-label={t.moveHandle({ title: name })} title={t.moveHandleHint} disabled={busy !== null}
          className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing">
          <GripVerticalIcon aria-hidden="true" /></Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem value="up" disabled={!up}><ArrowUpIcon aria-hidden="true" />{t.moveUp({ title: name })}</MenuItem>
        <MenuItem value="down" disabled={!down}><ArrowDownIcon aria-hidden="true" />{t.moveDown({ title: name })}</MenuItem>
        {item.role === 'chapter' && (into.length || item.parent !== structure) ? <>
          <MenuSeparator />
          <MenuSub onSelect={details => {
            if (details.value === 'top' && structure) moveTo(item, { parent: structure, end: true }, facts[item.occurrence]);
            else if (details.value.startsWith('into:')) {
              moveTo(item, { parent: details.value.slice(5), end: true }, facts[item.occurrence]);
            }
          }}>
            <MenuSubTrigger><FolderInputIcon aria-hidden="true" />{t.moveTo}</MenuSubTrigger>
            <MenuSubContent>
              {item.parent !== structure ? <MenuItem value="top">{t.moveToTop}</MenuItem> : null}
              {into.map(group => <MenuItem key={group.occurrence} value={`into:${group.occurrence}`}
                lang={group.label?.language}>{groupName(group, locale, t)}</MenuItem>)}
            </MenuSubContent>
          </MenuSub>
        </> : null}
      </MenuContent>
    </Menu>;
  };

  const chapterRow = (row: ContentsItem, parent: string, facts: ChapterFacts) => {
    const fact = facts[row.occurrence];
    const chapter = row.target ?? fact?.target ?? null;
    const label = row.label ?? fact?.label ?? null;
    const writer = fact?.writer.kind === 'agent' ? fact.writer.agent : null;
    const remembered = chapter ? memory[chapter] : undefined;
    const language = label?.language ?? book.language;
    const length = fact?.length ?? (typeof remembered?.length === 'number'
      ? { unit: lengthUnit(language), value: remembered.length } : null);
    const stats = [length ? lengthLabel(length, t) : null,
      remembered?.savedAt ? t.savedWhen({ time: relativeTime(remembered.savedAt, clock, locale, 'long') }) : null]
      .filter((part): part is string => part !== null);
    const name = nameOf(row, fact);
    return <li key={row.occurrence} data-occurrence={row.occurrence}
      onDragOver={event => over(event, row)} onDragLeave={() => setDrop(null)} onDrop={event => dropped(event, facts)}
      className={cn('grid grid-cols-[auto_auto_2rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2 px-2 py-3',
        'sm:grid-cols-[auto_auto_2.5rem_minmax(0,1fr)_auto] sm:px-3',
        drag?.occurrence === row.occurrence && 'opacity-50', dropClass(drop, row.occurrence))}>
      <Field orientation="horizontal" className="w-auto">
        <Checkbox checked={selected.has(row.occurrence)} disabled={!chapter || busy !== null}
          onCheckedChange={details => setSelected(current => {
            const next = new Set(current);
            if (details.checked === true) next.add(row.occurrence); else next.delete(row.occurrence);
            return next;
          })} />
        <FieldLabel className="sr-only">{t.selectChapter({ title: name })}</FieldLabel>
      </Field>
      {handle(row, parent, facts)}
      <span className="text-center font-medium text-muted-foreground text-sm tabular-nums">
        {row.number ?? <span aria-hidden="true">·</span>}</span>
      <div className="grid min-w-0 gap-1">
        <p lang={chapter ? label?.language : undefined} className={chapter
          ? 'font-medium font-work-title [overflow-wrap:anywhere]' : 'flex items-center gap-1.5 text-muted-foreground'}>
          {chapter ? null : <LockIcon aria-hidden="true" className="size-4" />}{name}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
          {chapter ? <Status state={stateOf(row, fact, remembered)} t={t} /> : null}
          {writer ? <span>{t.writtenAs({ agent: studioAgentName(writer, t) })}</span> : null}
          {stats.map(part => <span key={part}>{part}</span>)}
        </p>
      </div>
      <div className="col-span-full flex flex-wrap items-center gap-1 ps-20 sm:col-span-1 sm:justify-end sm:ps-0">
        {writer && chapter ? <Link href={chapterHref(writer, book.id, chapter, undefined, book.language)}
          aria-label={t.switchToWrite({ title: name, agent: studioAgentName(writer, t) })}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeftRightIcon aria-hidden="true" />{t.switchChapter}</Link>
          : row.target ? <Link href={chapterHref(agent, book.id, row.target, memory[row.target]?.head ?? undefined,
            book.language)} aria-label={t.writeNamed({ title: name })}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <PenLineIcon aria-hidden="true" />{t.writeChapter}</Link> : null}
        {row.availability === 'available' && row.target ? <Link href={readerChapterHref(book.id.slice(-36),
          row.occurrence.slice(-36), book.language)} aria-label={t.readNamed({ title: name })}
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <BookOpenIcon aria-hidden="true" /><span className="max-sm:sr-only">{t.readChapter}</span></Link> : null}
      </div>
    </li>;
  };

  const groupSection = (item: ContentsItem, facts: ChapterFacts) => {
    const name = groupName(item, locale, t);
    const level = levels[item.occurrence];
    const isOpen = open.has(item.occurrence);
    const kind = item.division === 'volume' && item.number ? volumeName(item.number, locale, t)
      : item.division === 'extras' ? t.extras : t.untitledPart === name ? null : t.part;
    return <li key={item.occurrence} data-occurrence={item.occurrence} className={cn('bg-muted/30',
      drag?.occurrence === item.occurrence && 'opacity-50')}>
      <Collapsible open={isOpen} onOpenChange={details => {
        setOpen(current => {
          const next = new Set(current);
          if (details.open) next.add(item.occurrence); else next.delete(item.occurrence);
          return next;
        });
        if (details.open && (!level || level.status === 'failed')) void load(item.occurrence);
      }}>
        <div onDragOver={event => over(event, item, true)} onDragLeave={() => setDrop(null)}
          onDrop={event => dropped(event, facts)}
          className={cn('flex items-center gap-2 px-2 py-2 sm:px-3', dropClass(drop, item.occurrence))}>
          {handle(item, structure ?? item.parent, facts)}
          {renaming === item.occurrence ? <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
            onSubmit={event => {
              event.preventDefault();
              const value = String(new FormData(event.currentTarget).get('title') ?? '').trim();
              setRenaming(null);
              if (value && value !== item.label?.value) {
                void run(item.occurrence, [{ op: 'update', occurrence: item.occurrence,
                  label: { value, language: book.language } }], t.groupRenamed({ title: value }));
              }
            }}>
            <Input name="title" defaultValue={item.label?.value ?? ''} autoFocus maxLength={200} lang={book.language}
              aria-label={t.renameLabel({ title: name })} className="min-w-40 flex-1 font-work-title" />
            <Button type="submit" size="sm">{t.saveName}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>{t.cancel}</Button>
          </form> : <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-start
            outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDownIcon aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground transition-transform',
              !isOpen && '-rotate-90 rtl:rotate-90')} />
            <span className="grid min-w-0">
              <span lang={item.label?.language} className="truncate font-semibold font-work-title">{name}</span>
              <span className="text-muted-foreground text-xs">
                {[kind, t.chapterCount(item.childCount ?? 0)].filter(Boolean).join(' · ')}</span>
            </span>
          </CollapsibleTrigger>}
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t.addChapterHere({ title: name })}
            disabled={busy !== null} onClick={() => {
              setTarget(item.occurrence);
              titleInput.current?.focus();
            }}><PlusIcon aria-hidden="true" /></Button>
          <Menu onSelect={details => {
            if (details.value === 'rename') setRenaming(item.occurrence);
            else if (details.value === 'delete' && !item.childCount) {
              void run(item.occurrence, [{ op: 'remove', occurrence: item.occurrence }], t.groupDeleted({ title: name }))
                .then(changed => { if (changed && target === item.occurrence) setTarget(null); });
            }
          }}>
            <MenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t.groupActions({ title: name })}
                disabled={busy !== null}><EllipsisIcon aria-hidden="true" /></Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem value="rename"><PenLineIcon aria-hidden="true" />{t.renameGroup}</MenuItem>
              <MenuSub>
                <MenuSubTrigger>{t.showAs}</MenuSubTrigger>
                <MenuSubContent>
                  <MenuRadioGroup value={item.division ?? 'part'} onValueChange={details => {
                    if (details.value !== item.division) {
                      void run(item.occurrence, [{ op: 'update', occurrence: item.occurrence,
                        division: details.value as Division }], t.groupRenamed({ title: name }));
                    }
                  }}>
                    <MenuRadioItem value="volume">{t.divisionVolume}</MenuRadioItem>
                    <MenuRadioItem value="part">{t.divisionPart}</MenuRadioItem>
                    <MenuRadioItem value="extras">{t.divisionExtras}</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <MenuItem value="delete" variant="destructive" disabled={Boolean(item.childCount)}
                title={item.childCount ? t.deleteNeedsEmpty : undefined}>
                <Trash2Icon aria-hidden="true" />{t.deleteGroup}</MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <CollapsibleContent>
          <div className="border-border/60 border-t bg-card">
            {level?.status === 'loaded' || (level?.items.length ?? 0) > 0 ? level!.items.length
              ? <ol className="grid divide-y divide-border/60">
                {level!.items.map(row => row.role === 'chapter' ? chapterRow(row, item.occurrence, facts) : null)}
              </ol>
              : <p onDragOver={event => over(event, item, true)} onDrop={event => dropped(event, facts)}
                className="px-4 py-4 text-muted-foreground text-sm">{t.groupEmpty}</p>
              : level?.status === 'failed' ? <p role="alert" className="flex flex-wrap items-center gap-2 px-4 py-3
                text-destructive-foreground text-sm">{t.loadChaptersFailed}
                <Button type="button" variant="outline" size="sm" onClick={() => void load(item.occurrence)}>
                  {t.retry}</Button></p>
                : <div role="status" aria-label={t.loadingChapters} className="grid gap-2 px-4 py-3">
                  <Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>}
            {level?.next ? <Button type="button" variant="ghost" size="sm" className="m-2"
              isLoading={level.status === 'loading'} onClick={() => void load(item.occurrence, level.next!)}>
              {t.moreChapters}</Button> : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>;
  };

  const outline = (facts: ChapterFacts) => {
    const merged = { ...facts, ...known };
    return <>
      <ol className="grid divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-card">
        {top.items.map(item => item.role === 'group' ? groupSection(item, merged)
          : chapterRow(item, structure ?? item.parent, merged))}
      </ol>
      {drag ? <p onDragOver={event => {
        if (!drag) return;
        event.preventDefault();
        setDrop({ end: true });
      }} onDrop={event => dropped(event, merged)} className={cn('rounded-2xl border-2 border-dashed px-4 py-3',
        'text-center text-muted-foreground text-sm', drop && 'end' in drop ? 'border-primary' : 'border-border')}>
        {t.dropAtEnd}</p> : null}
      <ActionBar open={selected.size > 0} onOpenChange={next => { if (!next) setSelected(new Set()); }}>
        <ActionBarContent aria-label={t.bulkActions}>
          <ActionBarBody>
            <ActionBarValue count={selected.size}>{t.selected(selected.size)}</ActionBarValue>
            <ActionBarSeparator />
            <Button type="button" size="sm" disabled={busy !== null} isLoading={busy === 'publish'}
              onClick={() => void publishSelected(merged)}>
              <SendIcon aria-hidden="true" />{publishing
                ? t.publishingProgress({ done: String(publishing.done), total: String(publishing.total) })
                : t.publishSelected}</Button>
            <Menu onSelect={details => {
              if (details.value === 'top' && structure) moveSelected(structure, merged);
              else if (details.value.startsWith('into:')) moveSelected(details.value.slice(5), merged);
            }}>
              <MenuTrigger asChild>
                <Button type="button" size="sm" variant="outline" disabled={busy !== null || !structure}>
                  <FolderInputIcon aria-hidden="true" />{t.moveSelected}</Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem value="top">{t.moveToTop}</MenuItem>
                {groups.map(group => <MenuItem key={group.occurrence} value={`into:${group.occurrence}`}
                  lang={group.label?.language}>{groupName(group, locale, t)}</MenuItem>)}
              </MenuContent>
            </Menu>
            <ActionBarSeparator />
            <ActionBarClose aria-label={t.clearSelection}
              className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}><XIcon aria-hidden="true" /></ActionBarClose>
          </ActionBarBody>
        </ActionBarContent>
      </ActionBar>
    </>;
  };

  const empty = !top.items.length;
  // The next story chapter's number, for the new chapter's placeholder: extras are not counted.
  const nextNumber = top.items.filter(item => item.role === 'chapter').length + groups.reduce((total, group) =>
    total + (group.division === 'extras' ? 0 : group.childCount ?? 0), 0) + 1;
  const choices = [{ value: structure ?? '', label: t.topLevel },
    ...groups.map(group => ({ value: group.occurrence, label: groupName(group, locale, t), lang: group.label?.language }))];
  return <div className="grid gap-4">
    <p role="status" className="sr-only">{announcement}</p>
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy !== null || creating}
        onClick={() => setCreating(true)}><PlusIcon aria-hidden="true" />{t.newVolume}</Button>
    </div>
    {creating ? <form onSubmit={event => void createGroup(event)} className="grid gap-3 rounded-2xl border
      border-border/60 bg-muted/40 p-3 sm:grid-cols-[minmax(0,1fr)_16rem_auto] sm:items-end">
      <label className="grid gap-1.5 text-sm"><span className="font-medium">{t.volumeTitle}</span>
        <Input name="title" maxLength={200} autoFocus lang={book.language} className="font-work-title"
          placeholder={volumeName(groups.filter(group => group.division === 'volume').length + 1, locale, t)}
          aria-describedby={`${formId}-volume-help`} autoComplete="off" />
        <span id={`${formId}-volume-help`} className="text-muted-foreground text-xs">{t.volumeTitleHelp}</span></label>
      <div className="grid gap-1.5 text-sm"><span className="font-medium">{t.divisionLabel}</span>
        <ChoiceSelect name="division" defaultValue="volume" label={t.divisionLabel} options={[
          { value: 'volume', label: t.divisionVolume }, { value: 'part', label: t.divisionPart },
          { value: 'extras', label: t.divisionExtras }]} /></div>
      <div className="flex gap-2">
        <Button type="submit" isLoading={busy === 'group'}>{busy === 'group' ? t.creatingVolume : t.createVolume}</Button>
        <Button type="button" variant="ghost" onClick={() => setCreating(false)}>{t.cancel}</Button>
      </div>
    </form> : null}
    {failed ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-destructive-foreground">{t.chaptersFailed}</AlertDescription></Alert> : null}
    {!empty ? <Suspense fallback={outline({})}><WithFacts facts={serverFacts}>{outline}</WithFacts></Suspense>
      : page.ok || page.failure === 'none' || page.failure === 'missing' ? <p className="rounded-2xl border
        border-border/80 border-dashed px-4 py-6 text-center text-muted-foreground text-sm">{t.noChapters}</p> : null}
    {top.next ? <Button type="button" variant="outline" className="justify-self-start"
      isLoading={top.status === 'loading'} onClick={() => {
        setTop(current => ({ ...current, status: 'loading' }));
        void read(null, top.next!).then(more => setTop(current => more ? { status: 'loaded',
          items: [...current.items, ...more.items], next: more.nextCursor } : { ...current, status: 'failed' }));
      }}>{t.moreChapters}</Button> : null}
    {error ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription role="alert" className="text-destructive-foreground">{error}</AlertDescription></Alert> : null}
    <form onSubmit={event => void addChapter(event)} className="grid gap-2 rounded-2xl border border-border/60
      bg-muted/40 p-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
      <label className="grid min-w-0 gap-1.5 text-sm"><span className="font-medium">{t.newChapter}</span>
        <Input ref={titleInput} name="title" maxLength={200} required
          placeholder={t.newChapterPlaceholder({ number: String(nextNumber) })} lang={book.language}
          className="font-work-title" autoComplete="off" /></label>
      {groups.length ? <div className="grid gap-1.5 text-sm"><span className="font-medium">{t.addTo}</span>
        <ChoiceSelect value={chosen ?? ''} onValueChange={value => setTarget(value || structure)} label={t.addTo}
          options={choices} /></div> : null}
      <Button type="submit" disabled={busy !== null} isLoading={busy === 'add'}>
        <PlusIcon aria-hidden="true" />{busy === 'add' ? t.addingChapter : t.addChapter}</Button>
    </form>
  </div>;
}
