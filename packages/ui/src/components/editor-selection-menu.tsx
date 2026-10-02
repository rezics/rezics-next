'use client';

import { isNodeSelection, type Editor as TiptapEditor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import {
  alignCommands, availableCommands, blockCommands, commandById, describeCommand, formatShortcut, inlineCommands, markCommands, tableCommands, useCommandState,
  type CommandIO, type EditorCommand,
} from './editor-commands.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';
import { LinkField, type LinkRange } from './editor-link.tsx';
import { bubbleOptions } from './editor-surface.ts';

type View = 'main' | 'turn';

function IconCommand({ editor, command, labels, io, state }: { editor: TiptapEditor; command: EditorCommand; labels: RichTextEditorLabels; io: CommandIO; state: ReturnType<typeof useCommandState> }) {
  const active = state.isActive(command.id);
  return <Button size="icon-sm" variant={active ? 'soft' : 'ghost'} aria-label={labels[command.label]} title={describeCommand(command, labels)}
    aria-pressed={command.active ? active : undefined} disabled={state.isDisabled(command.id)} onClick={() => command.run(editor, io)}>
    <command.icon aria-hidden="true" />
  </Button>;
}

function TextCommand({ editor, command, labels, io, state }: { editor: TiptapEditor; command: EditorCommand; labels: RichTextEditorLabels; io: CommandIO; state: ReturnType<typeof useCommandState> }) {
  const shortcut = formatShortcut(command.shortcut);
  return <Button size="sm" variant={state.isActive(command.id) ? 'soft' : 'ghost'} className="w-full justify-start" disabled={state.isDisabled(command.id)}
    onClick={() => command.run(editor, io)}>
    <command.icon aria-hidden="true" />{labels[command.label]}{command.id === 'ruby' || command.id === 'emphasis' ? '…' : ''}
    {shortcut ? <span className="ms-auto text-xs font-normal text-muted-foreground">{shortcut}</span> : null}
  </Button>;
}

/**
 * The list of block types opens beside the panel, on whichever side has room, and never leaves the viewport.
 * It is placed before the browser paints, so it is never hidden: a hidden list would make its buttons
 * transition in from `visibility: hidden` and read as inaccessible for a moment.
 */
function TurnIntoList({ editor, labels, state, blocks, onDone, anchor }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; state: ReturnType<typeof useCommandState>; blocks: boolean; onDone: () => void; anchor: React.RefObject<HTMLElement | null>;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const host = anchor.current, own = list.current;
    if (!host || !own) return;
    const panel = host.getBoundingClientRect(), size = own.getBoundingClientRect();
    const room = window.innerWidth - panel.right - 8;
    const left = room >= size.width ? panel.width + 4 : -(size.width + 4);
    const overflow = panel.top + size.height - (window.innerHeight - 8);
    setPlace({ left, top: Math.min(0, -overflow) });
  }, [anchor]);
  return <div ref={list} role="menu" aria-label={labels.turnInto} data-slot="editor-turn-into" style={place ?? undefined}
    className="absolute z-10 w-52 rounded-xl border border-border/60 bg-popover p-1.5 shadow-(--aura-shadow-float)">
    {availableCommands(blockCommands, blocks).map(command => <Button key={command.id} role="menuitemradio" aria-checked={state.block === command.id} size="sm" variant="ghost" className="w-full justify-start"
      onClick={() => { command.run(editor, { openDialog: () => {} }); onDone(); }}>
      <command.icon aria-hidden="true" />{labels[command.label]}
      {state.block === command.id ? <CheckIcon aria-hidden="true" className="ms-auto" /> : null}
    </Button>)}
  </div>;
}

/**
 * The pointer's selection panel: everything a selection can become or carry, in fixed rows, so a
 * writer finds a command by position. Keyboard users reach the same commands from the context menu.
 */
export function SelectionMenu({ editor, labels, blocks, io, linkRange, onLinkClose }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; blocks: boolean; io: CommandIO; linkRange: LinkRange | null; onLinkClose: () => void;
}) {
  const state = useCommandState(editor);
  const [view, setView] = useState<View>('main');
  const panel = useRef<HTMLDivElement>(null);
  // The list belongs to the selection it was opened on. The event fires with the transaction, so a late render never closes it.
  useEffect(() => {
    const close = () => setView('main');
    editor.on('selectionUpdate', close);
    return () => { editor.off('selectionUpdate', close); };
  }, [editor]);
  const options = useMemo(() => ({ ...bubbleOptions, onHide: () => setView('main') }), []);
  const current = commandById(state.block);
  const row = (commands: readonly EditorCommand[]) => commands.map(command => <IconCommand key={command.id} editor={editor} command={command} labels={labels} io={io} state={state} />);
  return <BubbleMenu editor={editor} pluginKey="rezicsSelectionMenu" updateDelay={80} options={options}
    shouldShow={({ editor: live, element, view: editorView, state: editorState }) => live.isEditable && !isNodeSelection(editorState.selection) && !editorState.selection.empty
      && (editorView.hasFocus() || element.contains(document.activeElement))}
    className="max-w-[calc(100vw-1rem)]" data-slot="editor-selection-menu">
    <div ref={panel} role="group" aria-label={labels.formatting} className="relative w-[17.5rem] max-w-full rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-(--aura-shadow-float)"
      onMouseDown={event => { if (!(event.target as HTMLElement).closest('input')) event.preventDefault(); }}>
      {linkRange ? <LinkField editor={editor} labels={labels} range={linkRange} onClose={onLinkClose} /> : <>
        <Button size="sm" variant="ghost" className="w-full justify-start" aria-haspopup="menu" aria-expanded={view === 'turn'} aria-label={`${labels.turnInto}: ${labels[current.label]}`}
          onClick={() => setView(view === 'turn' ? 'main' : 'turn')}>
          <current.icon aria-hidden="true" />{labels[current.label]}<ChevronRightIcon aria-hidden="true" className={cn('ms-auto', 'rtl:rotate-180')} />
        </Button>
        {view === 'turn' ? <TurnIntoList editor={editor} labels={labels} state={state} blocks={blocks} anchor={panel} onDone={() => setView('main')} /> : null}
        <div className="mt-1 flex flex-wrap gap-0.5" role="group" aria-label={labels.toolbar}>{row(markCommands)}{row([commandById('clearFormatting')])}</div>
        <div className="mt-1 grid border-t border-border/60 pt-1">
          {inlineCommands.filter(command => command.id !== 'clearFormatting').map(command => <TextCommand key={command.id} editor={editor} command={command} labels={labels} io={io} state={state} />)}
        </div>
        <div className="mt-1 flex gap-0.5 border-t border-border/60 pt-1" role="group" aria-label={labels.alignment}>{row(alignCommands)}</div>
        {blocks && state.inTable ? <div className="mt-1 grid border-t border-border/60 pt-1" role="group" aria-label={labels.table}>
          {tableCommands.map(command => <TextCommand key={command.id} editor={editor} command={command} labels={labels} io={io} state={state} />)}
        </div> : null}
      </>}
    </div>
  </BubbleMenu>;
}
