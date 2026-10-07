'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { cn } from '@rezics/ui/utils';
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from 'react';
import { composeLine, emptyParts, type IngredientParts, knownUnits, parseLine, partsOf, partsProblem, qualifierOf }
  from './ingredient-line.ts';
import { IconAction, SyncedInput } from './controls.tsx';
import type { Copy } from './messages.ts';
import { groups, type GroupNode, type IngredientNode, linesOf, type RecipeState } from './model.ts';
import type { RecipeStore } from './store.ts';
import { directionOf } from '../studio/types.ts';

interface Common { store: RecipeStore; state: RecipeState; language: string; t: Copy; busy: boolean }

const fieldClass = 'grid min-w-0 gap-1 text-sm';

/** The four parts a line was read as, shown while typing so a misread is seen before it is saved. */
function ReadAs({ parts, t }: { parts: IngredientParts; t: Copy }) {
  const items: [string, string][] = [[t.quantity, parts.quantity], [t.unit, parts.unit], [t.name, parts.name], [t.note, parts.note]];
  return <dl aria-label={t.readAs} className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
    {items.map(([label, value]) => <div key={label} className="flex gap-1">
      <dt>{label}:</dt><dd className={cn(value ? 'font-medium text-foreground' : '')}>{value || t.partNone}</dd></div>)}
  </dl>;
}

/** One field for a whole line, and the same line as parts that stay editable. */
function LineFields({ line, parts, onLine, onParts, onSubmit, onCancel, t, language, autoFocus, idPrefix }: {
  line: string; parts: IngredientParts; onLine: (line: string) => void; onParts: (parts: IngredientParts) => void;
  onSubmit: () => void; onCancel?: () => void; t: Copy; language: string; autoFocus?: boolean; idPrefix: string;
}) {
  const lang = { lang: language, dir: directionOf(language) } as const;
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); onSubmit(); }
    if (event.key === 'Escape' && onCancel) { event.preventDefault(); onCancel(); }
  };
  const part = (name: keyof IngredientParts, label: string, extra?: { list?: string; className?: string }) =>
    <label className={cn(fieldClass, extra?.className)}>{label}
      <Input value={parts[name]} onChange={event => onParts({ ...parts, [name]: event.target.value })} onKeyDown={keys}
        autoComplete="off" list={extra?.list} {...lang} /></label>;
  return <div className="grid gap-3">
    <label className={fieldClass}>{t.ingredientLine}
      <Input value={line} onChange={event => onLine(event.target.value)} onKeyDown={keys} placeholder={t.ingredientPlaceholder}
        autoComplete="off" enterKeyHint="done" autoFocus={autoFocus} maxLength={1000} {...lang} /></label>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[6rem_8rem_minmax(0,1fr)_minmax(0,1fr)]">
      {part('quantity', t.quantity)}
      {part('unit', t.unit, { list: `${idPrefix}-units` })}
      {part('name', t.name, { className: 'col-span-2 sm:col-span-1' })}
      {part('note', t.note, { className: 'col-span-2 sm:col-span-1' })}
    </div>
    <datalist id={`${idPrefix}-units`}>{knownUnits.map(unit => <option key={unit} value={unit} />)}</datalist>
  </div>;
}

/** Adds an ingredient to a section: type the line, press Enter, and the field is ready for the next. */
function AddLine({ section, label, store, language, t, busy }: Common & { section: string | null; label: string | null }) {
  const [line, setLine] = useState('');
  const [parts, setParts] = useState<IngredientParts>(emptyParts);
  const [editing, setEditing] = useState(false);
  const id = useId();
  const field = useRef<HTMLDivElement>(null);
  const problem = partsProblem(parts);
  const add = async () => {
    if (problem || busy) return;
    const outcome = await store.submit({ kind: 'addLine', section, qualifier: qualifierOf(parts, language) });
    if (outcome.kind === 'saved' || outcome.kind === 'unchanged') {
      setLine(''); setParts(emptyParts); setEditing(false);
      field.current?.querySelector<HTMLInputElement>('input')?.focus();
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void add(); };
  return <form onSubmit={submit} aria-label={label ? t.addIngredientTo({ section: label }) : t.addIngredient} className="grid gap-2">
    <div ref={field} className="grid gap-3">
      <LineFields line={line} parts={parts} idPrefix={id} t={t} language={language} onSubmit={() => void add()}
        onLine={value => { setLine(value); setParts(parseLine(value)); setEditing(false); }}
        onParts={value => { setParts(value); setLine(composeLine(value)); setEditing(true); }} />
    </div>
    {line.trim() && !editing ? <ReadAs parts={parts} t={t} /> : null}
    <p className="text-muted-foreground text-xs">{t.ingredientHelp}</p>
    <div><Button type="submit" size="md" disabled={Boolean(problem) || busy} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />{t.addAction}</Button></div>
  </form>;
}

function LineEditor({ node, store, state, language, t, busy, onDone }: Common & { node: IngredientNode; onDone: () => void }) {
  const initial = partsOf(node.qualifier);
  const [parts, setParts] = useState(initial);
  const [line, setLine] = useState(composeLine(initial));
  const [section, setSection] = useState(node.parent === state.structure ? '' : node.parent);
  const id = useId();
  const problem = partsProblem(parts);
  const save = async () => {
    if (problem) return;
    const moved = (section || null) !== (node.parent === state.structure ? null : node.parent);
    const edited = await store.submit({ kind: 'editLine', occurrence: node.occurrence, qualifier: qualifierOf(parts, language, node.qualifier) });
    if (edited.kind === 'refused') return;
    if (moved) {
      const outcome = await store.submit({ kind: 'moveLineTo', occurrence: node.occurrence, section: section || null });
      if (outcome.kind === 'refused') return;
    }
    onDone();
  };
  const sections = groups(state);
  return <form onSubmit={event => { event.preventDefault(); void save(); }} aria-label={t.edit({ name: node.qualifier.originalText.value })}
    className="grid gap-3 rounded-2xl border border-primary/30 bg-card p-3">
    <LineFields line={line} parts={parts} idPrefix={id} t={t} language={language} autoFocus onSubmit={() => void save()} onCancel={onDone}
      onLine={value => { setLine(value); setParts(parseLine(value)); }}
      onParts={value => { setParts(value); setLine(composeLine(value)); }} />
    {sections.length ? <div className={fieldClass}><span>{t.moveToSection}</span>
      <ChoiceSelect value={section} onValueChange={setSection} label={t.moveToSection} className="w-full" portalled={false}
        options={[{ value: '', label: t.noSection }, ...sections.map(group => ({ value: group.occurrence, label: group.label?.value ?? '' }))]} /></div> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={Boolean(problem) || busy} className="pointer-coarse:h-11">{t.saveAction}</Button>
      <Button type="button" variant="outline" onClick={onDone} className="pointer-coarse:h-11">{t.cancel}</Button>
    </div>
  </form>;
}

function LineRow({ node, index, count, ...common }: Common & { node: IngredientNode; index: number; count: number }) {
  const [editing, setEditing] = useState(false);
  const { store, t, language, busy } = common;
  const text = node.qualifier.originalText.value;
  if (editing) return <li data-line={node.occurrence}><LineEditor node={node} {...common} onDone={() => setEditing(false)} /></li>;
  return <li data-line={node.occurrence} className="flex items-center gap-1 border-border/60 border-b py-1 last:border-0">
    <span lang={language} dir={directionOf(language)} className="min-w-0 flex-1 text-pretty break-words py-1.5 font-medium">{text}</span>
    <IconAction label={t.moveUp({ name: text })} disabled={busy || index === 0}
      onClick={() => void store.submit({ kind: 'moveLine', occurrence: node.occurrence, direction: 'up' })}><ArrowUpIcon aria-hidden="true" /></IconAction>
    <IconAction label={t.moveDown({ name: text })} disabled={busy || index === count - 1}
      onClick={() => void store.submit({ kind: 'moveLine', occurrence: node.occurrence, direction: 'down' })}><ArrowDownIcon aria-hidden="true" /></IconAction>
    <IconAction label={t.edit({ name: text })} onClick={() => setEditing(true)}><PencilIcon aria-hidden="true" /></IconAction>
    <IconAction label={t.remove({ name: text })} disabled={busy}
      onClick={() => void store.submit({ kind: 'removeLine', occurrence: node.occurrence })}><Trash2Icon aria-hidden="true" /></IconAction>
  </li>;
}

function SectionHeader({ group, index, count, store, state, t, busy, language }: Common & { group: GroupNode; index: number; count: number }) {
  const [confirming, setConfirming] = useState(false);
  const name = group.label?.value ?? '';
  const lines = linesOf(state, group.occurrence);
  const rename = (value: string) => {
    const next = value.trim();
    if (next && next !== name) void store.submit({ kind: 'renameSection', occurrence: group.occurrence, label: next, language });
  };
  const remove = () => void store.submit({ kind: 'removeSection', occurrence: group.occurrence }).then(() => setConfirming(false));
  return <div className="grid gap-2">
    <div className="flex items-center gap-1">
      <SyncedInput value={name} aria-label={t.sectionName} maxLength={500} lang={language} dir={directionOf(language)}
        className="font-semibold" autoComplete="off"
        onBlur={event => rename(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
      <IconAction label={t.moveUp({ name: name })} disabled={busy || index === 0}
        onClick={() => void store.submit({ kind: 'moveSection', occurrence: group.occurrence, direction: 'up' })}><ArrowUpIcon aria-hidden="true" /></IconAction>
      <IconAction label={t.moveDown({ name: name })} disabled={busy || index === count - 1}
        onClick={() => void store.submit({ kind: 'moveSection', occurrence: group.occurrence, direction: 'down' })}><ArrowDownIcon aria-hidden="true" /></IconAction>
      <IconAction label={t.removeSection({ name: name })} disabled={busy}
        onClick={() => lines.length ? setConfirming(true) : remove()}><Trash2Icon aria-hidden="true" /></IconAction>
    </div>
    {confirming ? <div role="alertdialog" aria-label={t.removeSection({ name: name })} className="grid gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p>{t.removeSectionConfirm({ name: name })}</p>
      <div className="flex gap-2">
        <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={remove}>{t.confirmRemove}</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>{t.keep}</Button>
      </div>
    </div> : null}
  </div>;
}

function Lines({ lines, ...common }: Common & { lines: IngredientNode[] }) {
  return lines.length ? <ul className="grid">{lines.map((node, index) =>
    <LineRow key={node.occurrence} node={node} index={index} count={lines.length} {...common} />)}</ul>
    : <p className="text-muted-foreground text-sm">{common.t.emptySection}</p>;
}

function AddSection({ store, language, t, busy }: Common) {
  const [name, setName] = useState('');
  const add = async () => {
    if (!name.trim() || busy) return;
    const outcome = await store.submit({ kind: 'addSection', label: name.trim(), language });
    if (outcome.kind === 'saved') setName('');
  };
  return <form onSubmit={event => { event.preventDefault(); void add(); }} aria-label={t.addSection} className="grid gap-2 rounded-2xl border border-border/70 border-dashed p-3">
    <label className={fieldClass}><span className="font-medium">{t.addSection}</span>
      <Input value={name} onChange={event => setName(event.target.value)} placeholder={t.sectionPlaceholder} maxLength={500}
        autoComplete="off" lang={language} dir={directionOf(language)} aria-label={t.sectionName} /></label>
    <p className="text-muted-foreground text-xs">{t.addSectionHelp}</p>
    <div><Button type="submit" variant="outline" disabled={!name.trim() || busy} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />{t.addSectionAction}</Button></div>
  </form>;
}

/** Ingredient sections, each with its lines; a recipe may have unsectioned lines too. */
export function IngredientsSection(common: Common) {
  const { state, t } = common;
  const sections = groups(state);
  const loose = linesOf(state, null);
  const showLoose = loose.length > 0 || sections.length === 0;
  return <section aria-labelledby="recipe-ingredients" className="grid gap-5">
    <h2 id="recipe-ingredients" className="font-semibold text-xl">{t.ingredientsHeading}</h2>
    {showLoose ? <div className="grid gap-3" data-section="">
      {sections.length ? <h3 className="font-semibold">{t.unsectioned}</h3> : null}
      {loose.length ? <Lines lines={loose} {...common} /> : <p className="text-muted-foreground text-sm">{t.emptyIngredients}</p>}
      <AddLine section={null} label={null} {...common} />
    </div> : null}
    {sections.map((group, index) => <div key={group.occurrence} role="group" aria-label={t.sectionLabel({ name: group.label?.value ?? '' })}
      data-section={group.occurrence} className="grid gap-3 rounded-2xl border border-border/60 bg-card/50 p-3">
      <SectionHeader group={group} index={index} count={sections.length} {...common} />
      <Lines lines={linesOf(state, group.occurrence)} {...common} />
      <AddLine section={group.occurrence} label={group.label?.value ?? ''} {...common} />
    </div>)}
    <AddSection {...common} />
  </section>;
}
