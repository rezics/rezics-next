'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { IconAction } from './controls.tsx';
import type { Copy } from './messages.ts';
import type { RecipeState } from './model.ts';
import type { RecipeStore } from './store.ts';

/** Structure selects an existing source; Content remains its only editor and procedure store. */
export function InstructionEditor({ store, state, t, busy, closed }: {
  store: RecipeStore; state: RecipeState; t: Copy; busy: boolean; closed: boolean;
}) {
  const id = useId();
  const [kind, setKind] = useState<'content' | 'representation'>('content');
  const list = state.nodes.filter(node => node.role === 'instruction');
  return <div className="grid min-w-0 gap-4">
    {list.length ? <ol className="grid min-w-0 gap-3">{list.map((node, index) => <li key={node.occurrence}
      className="grid min-w-0 gap-2 rounded-xl border p-3">
      <p className="break-all text-sm">{node.reference.target}</p>
      <p className="break-all text-xs text-muted-foreground">{node.reference.selector.revision}
        {node.reference.selector.grain === 'content' && node.reference.selector.block ? ` · ${node.reference.selector.block}` : ''}</p>
      <div className="flex flex-wrap gap-1">
        <IconAction label={t.moveUp({ name: node.reference.target })} disabled={closed || busy || index === 0}
          onClick={() => void store.submit({ kind: 'moveInstruction', occurrence: node.occurrence, direction: 'up' })}><ArrowUpIcon /></IconAction>
        <IconAction label={t.moveDown({ name: node.reference.target })} disabled={closed || busy || index === list.length - 1}
          onClick={() => void store.submit({ kind: 'moveInstruction', occurrence: node.occurrence, direction: 'down' })}><ArrowDownIcon /></IconAction>
        <IconAction label={t.remove({ name: node.reference.target })} disabled={closed || busy}
          onClick={() => void store.submit({ kind: 'removeInstruction', occurrence: node.occurrence })}><Trash2Icon /></IconAction>
      </div>
    </li>)}</ol> : null}
    <form onSubmit={event => {
      event.preventDefault();
      if (closed || busy) return;
      const data = new FormData(event.currentTarget);
      const value = (key: string) => String(data.get(key) ?? '').trim();
      void store.submit({ kind: 'adoptInstruction', reference: { target: value('target'), selector: kind === 'content'
        ? { grain: 'content', revision: value('revision'), variantId: value('variant'), ...(value('block') ? { block: value('block') } : {}) }
        : { grain: 'representation', revision: value('revision'), representation: value('representation'),
          ...(value('fragment') ? { fragment: value('fragment') } : {}) } } });
    }}>
      <fieldset disabled={closed || busy} className="grid min-w-0 gap-3 rounded-xl border p-3">
        <legend className="px-1 font-medium">{t.adoptInstructions}</legend>
        <ChoiceSelect value={kind} label={t.instructionKind}
          options={[{ value: 'content', label: t.instructionPost }, { value: 'representation', label: t.instructionRecording }]}
          onValueChange={value => setKind(value === 'representation' ? 'representation' : 'content')} />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field id={`${id}-target`} name="target" label={t.instructionTarget} />
          <Field id={`${id}-revision`} name="revision" label={t.instructionRevision} />
          {kind === 'content' ? <>
            <Field id={`${id}-variant`} name="variant" label={t.instructionVariant} />
            <Field id={`${id}-block`} name="block" label={t.instructionBlock} optional />
          </> : <>
            <Field id={`${id}-representation`} name="representation" label={t.instructionRepresentation} />
            <Field id={`${id}-fragment`} name="fragment" label={t.instructionFragment} optional />
          </>}
        </div>
        <p className="text-xs text-muted-foreground">{t.instructionSelectionHelp}</p>
        <Button type="submit" className="min-h-11 justify-self-start">{t.adoptInstructions}</Button>
      </fieldset>
    </form>
  </div>;
}

function Field({ id, name, label, optional }: { id: string; name: string; label: string; optional?: boolean }) {
  return <label className="grid min-w-0 gap-1 text-sm" htmlFor={id}>{label}
    <Input id={id} name={name} required={!optional} autoComplete="off" className="min-w-0" /></label>;
}
