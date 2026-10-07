'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Textarea } from '@rezics/ui/textarea';
import { ArrowDownIcon, ArrowUpIcon, LinkIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { IconAction, SyncedTextarea } from './controls.tsx';
import type { Copy } from './messages.ts';
import { groups, ingredients, type IngredientNode, type RecipeState, steps, type StepNode } from './model.ts';
import type { RecipeStore } from './store.ts';
import { directionOf } from '../studio/types.ts';

interface Common { store: RecipeStore; state: RecipeState; language: string; t: Copy; busy: boolean }

/** The name an ingredient goes by in a list of links: its own line, which is unique through its section heading. */
const nameOf = (node: IngredientNode) => node.qualifier.originalText.value;

/** Every ingredient as a checkbox, under its section's heading, so equal names in two sections stay apart. */
function UsesPicker({ state, value, onChange, t, idPrefix }: {
  state: RecipeState; value: readonly string[]; onChange: (next: string[]) => void; t: Copy; idPrefix: string;
}) {
  const all = ingredients(state);
  if (!all.length) return <p className="text-muted-foreground text-sm">{t.usesEmpty}</p>;
  const blocks: { key: string; heading: string | null; lines: IngredientNode[] }[] = [
    { key: 'loose', heading: groups(state).length ? t.unsectioned : null, lines: all.filter(node => node.parent === state.structure) },
    ...groups(state).map(group => ({ key: group.occurrence, heading: group.label?.value ?? '', lines: all.filter(node => node.parent === group.occurrence) })),
  ].filter(block => block.lines.length);
  const toggle = (occurrence: string, on: boolean) =>
    onChange(on ? [...value, occurrence] : value.filter(id => id !== occurrence));
  return <div className="grid gap-3" role="group" aria-label={t.usesIngredients}>
    {blocks.map(block => <fieldset key={block.key} className="grid min-w-0 gap-1">
      {block.heading ? <legend className="font-medium text-muted-foreground text-xs">{t.usesInSection({ section: block.heading })}</legend> : null}
      {block.lines.map(node => <Checkbox key={node.occurrence} id={`${idPrefix}-${node.occurrence.slice(-12)}`}
        checked={value.includes(node.occurrence)} onCheckedChange={details => toggle(node.occurrence, details.checked === true)}
        className="min-h-9 pointer-coarse:min-h-11">{nameOf(node)}</Checkbox>)}
    </fieldset>)}
  </div>;
}

function StepRow({ node, index, count, store, state, language, t, busy }: Common & { node: StepNode; index: number; count: number }) {
  const [linking, setLinking] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  const stored = node.qualifier.instructionText.value;
  const uses = node.qualifier.usesIngredient;
  const parent = state.nodes.find(item => item.occurrence === node.parent);
  const section = parent?.role === 'group' ? parent.label?.value : null;
  const commit = (next: string[] = [...uses]) => {
    const value = text.current?.value.trim() ?? stored;
    if (!value) { if (text.current) text.current.value = stored; return; }
    if (value !== stored || next.length !== uses.length || next.some((id, at) => id !== uses[at])) {
      void store.submit({ kind: 'editStep', occurrence: node.occurrence, text: value, uses: next });
    }
  };
  const number = index + 1;
  return <li data-step={node.occurrence} className="grid gap-2 rounded-2xl border border-border/60 bg-card p-3">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-2 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-sm">{number}</span>
      <div className="grid min-w-0 flex-1 gap-1">
        {section ? <span className="text-muted-foreground text-xs">{t.stepSection({ section: section })}</span> : null}
        <SyncedTextarea ref={text} value={stored} aria-label={t.stepText({ number: String(number) })} maxLength={4000}
          lang={language} dir={directionOf(language)} onBlur={() => commit()} className="min-h-16" />
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-1 ps-11">
      <Button type="button" variant="ghost" size="sm" aria-expanded={linking} className="pointer-coarse:h-11"
        onClick={() => setLinking(value => !value)}><LinkIcon aria-hidden="true" />
        {uses.length ? t.usesCount(uses.length) : t.usesChoose}</Button>
      <span className="flex-1" />
      <IconAction label={t.moveUp({ name: t.stepNumber({ number: String(number) }) })} disabled={busy || index === 0}
        onClick={() => void store.submit({ kind: 'moveStep', occurrence: node.occurrence, direction: 'up' })}><ArrowUpIcon aria-hidden="true" /></IconAction>
      <IconAction label={t.moveDown({ name: t.stepNumber({ number: String(number) }) })} disabled={busy || index === count - 1}
        onClick={() => void store.submit({ kind: 'moveStep', occurrence: node.occurrence, direction: 'down' })}><ArrowDownIcon aria-hidden="true" /></IconAction>
      <IconAction label={t.remove({ name: t.stepNumber({ number: String(number) }) })} disabled={busy}
        onClick={() => void store.submit({ kind: 'removeStep', occurrence: node.occurrence })}><Trash2Icon aria-hidden="true" /></IconAction>
    </div>
    {linking ? <div className="ms-11 rounded-xl border border-border/60 bg-background p-3">
      <UsesPicker state={state} value={uses} idPrefix={`uses-${node.occurrence.slice(-12)}`} t={t} onChange={next => commit(next)} />
    </div> : null}
  </li>;
}

function AddStep({ store, state, language, t }: Common) {
  const [text, setText] = useState('');
  const [uses, setUses] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);
  const typed = useRef({ text: '', uses: [] as string[] });
  const add = async () => {
    const submitted = typed.current;
    if (!submitted.text.trim()) return;
    await store.whenIdle();
    const outcome = await store.submit({ kind: 'addStep', text: submitted.text, language, uses: submitted.uses });
    if (outcome.kind === 'saved' && typed.current === submitted) {
      typed.current = { text: '', uses: [] };
      setText(''); setUses([]); setLinking(false);
    }
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void add(); }
  };
  return <form onSubmit={event => { event.preventDefault(); void add(); }} aria-label={t.addStep} className="grid gap-2">
    <label className="grid gap-1 text-sm"><span className="font-medium">{t.addStep}</span>
      <Textarea value={text} onChange={event => { typed.current = { ...typed.current, text: event.target.value }; setText(event.target.value); }} onKeyDown={keys} placeholder={t.stepPlaceholder}
        maxLength={4000} lang={language} dir={directionOf(language)} className="min-h-20" /></label>
    <p className="text-muted-foreground text-xs">{t.stepHelp}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={!text.trim()} className="pointer-coarse:h-11"><PlusIcon aria-hidden="true" />{t.addAction}</Button>
      <Button type="button" variant="ghost" size="sm" aria-expanded={linking} className="pointer-coarse:h-11"
        onClick={() => setLinking(value => !value)}><LinkIcon aria-hidden="true" />
        {uses.length ? t.usesCount(uses.length) : t.usesChoose}</Button>
    </div>
    {linking ? <div className="rounded-xl border border-border/60 bg-background p-3">
      <UsesPicker state={state} value={uses} onChange={next => { typed.current = { ...typed.current, uses: next }; setUses(next); }} idPrefix="uses-new" t={t} /></div> : null}
  </form>;
}

export function MethodSection(common: Common) {
  const list = steps(common.state);
  const { t } = common;
  return <section aria-labelledby="recipe-method" className="grid gap-4">
    <h2 id="recipe-method" className="font-semibold text-xl">{t.methodHeading}</h2>
    {list.length ? <ol className="grid gap-3">{list.map((node, index) =>
      <StepRow key={node.occurrence} node={node} index={index} count={list.length} {...common} />)}</ol>
      : <p className="text-muted-foreground text-sm">{t.emptySteps}</p>}
    <AddStep {...common} />
  </section>;
}
