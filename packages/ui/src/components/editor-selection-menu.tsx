'use client';

import { isNodeSelection, type Editor as TiptapEditor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { CheckIcon, ChevronDownIcon, MoreHorizontalIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from './button.tsx';
import {
  alignCommands, availableCommands, blockCommands, commandById, describeCommand, markCommands, tableCommands, useCommandState,
  type CommandIO, type EditorCommand,
} from './editor-commands.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';
import { LinkField, type LinkRange } from './editor-link.tsx';
import { bubbleOptions } from './editor-surface.ts';

type View = 'main' | 'turn' | 'more';
type State = ReturnType<typeof useCommandState>;

function IconCommand({ editor, command, labels, io, state }: { editor: TiptapEditor; command: EditorCommand; labels: RichTextEditorLabels; io: CommandIO; state: State }) {
  const active = state.isActive(command.id);
  return <Button size="icon-sm" variant={active ? 'soft' : 'ghost'} aria-label={labels[command.label]} title={describeCommand(command, labels)}
    aria-pressed={command.active ? active : undefined} disabled={state.isDisabled(command.id)} onClick={() => command.run(editor, io)}>
    <command.icon aria-hidden="true" />
  </Button>;
}

/**
 * A list that opens beside the panel, on whichever side has room, and never leaves the viewport.
 * It is placed before the browser paints and never hidden: a hidden list would make its buttons
 * transition in from `visibility: hidden` and read as inaccessible for a moment.
 */
function Popout({ anchor, label, slot, children }: { anchor: RefObject<HTMLElement | null>; label: string; slot: string; children: ReactNode }) {
  const own = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const host = anchor.current, list = own.current;
    if (!host || !list) return;
    const panel = host.getBoundingClientRect(), size = list.getBoundingClientRect();
    const room = window.innerWidth - panel.right - 8;
    const overflow = panel.top + size.height - (window.innerHeight - 8);
    setPlace({ left: room >= size.width ? panel.width + 4 : -(size.width + 4), top: Math.min(0, -overflow) });
  }, [anchor]);
  return <div ref={own} role="menu" aria-label={label} data-slot={slot} style={place ?? undefined}
    className="absolute z-10 w-52 rounded-xl border border-border/60 bg-popover p-1.5 shadow-(--aura-shadow-float)">{children}</div>;
}

/** The caret end of the selection, where the pointer was released: the panel opens there like a context menu. */
function selectionHead(editor: TiptapEditor) {
  const caret = editor.view.coordsAtPos(editor.state.selection.head);
  const rect = new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
  return { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
}

/**
 * The pointer's selection panel: a compact grid of icons that opens just below and after the
 * caret, as a context menu does, and flips or shifts to stay in view. Keyboard users reach the
 * same commands from the context menu.
 */
export function SelectionMenu({ editor, labels, blocks, io, linkRange, onLinkClose }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; blocks: boolean; io: CommandIO; linkRange: LinkRange | null; onLinkClose: () => void;
}) {
  const state = useCommandState(editor);
  const [view, setView] = useState<View>('main');
  const panel = useRef<HTMLDivElement>(null);
  // The lists belong to the selection they were opened on. The event fires with the transaction, so a late render never closes one.
  useEffect(() => {
    const close = () => setView('main');
    editor.on('selectionUpdate', close);
    return () => { editor.off('selectionUpdate', close); };
  }, [editor]);
  const options = useMemo(() => ({ ...bubbleOptions, placement: 'bottom-start' as const, offset: 6, onHide: () => setView('main') }), []);
  const current = commandById(state.block);
  const row = (commands: readonly EditorCommand[]) => commands.map(command => <IconCommand key={command.id} editor={editor} command={command} labels={labels} io={io} state={state} />);
  const toggle = (next: View) => setView(view === next ? 'main' : next);
  return <BubbleMenu editor={editor} pluginKey="rezicsSelectionMenu" updateDelay={80} options={options} getReferencedVirtualElement={() => selectionHead(editor)}
    shouldShow={({ editor: live, element, view: editorView, state: editorState }) => live.isEditable && !isNodeSelection(editorState.selection) && !editorState.selection.empty
      && (editorView.hasFocus() || element.contains(document.activeElement))}
    className="max-w-[calc(100vw-1rem)]" data-slot="editor-selection-menu">
    <div ref={panel} role="group" aria-label={labels.formatting} className="relative w-fit max-w-full rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-(--aura-shadow-float)"
      onMouseDown={event => { if (!(event.target as HTMLElement).closest('input')) event.preventDefault(); }}>
      {linkRange ? <div className="w-64 max-w-full p-0.5"><LinkField editor={editor} labels={labels} range={linkRange} onClose={onLinkClose} /></div> : <>
        <Button size="sm" variant="ghost" className="w-full justify-start px-2" aria-haspopup="menu" aria-expanded={view === 'turn'} aria-label={`${labels.turnInto}: ${labels[current.label]}`}
          onClick={() => toggle('turn')}>
          <current.icon aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-start">{labels[current.label]}</span><ChevronDownIcon aria-hidden="true" />
        </Button>
        <div className="mt-0.5 flex gap-0.5" role="group" aria-label={labels.toolbar}>{row(markCommands)}</div>
        <div className="mt-0.5 flex gap-0.5">
          {row(['link', 'ruby', 'emphasis', 'clearFormatting'].map(commandById))}
          <Button size="icon-sm" variant={view === 'more' ? 'soft' : 'ghost'} aria-label={labels.moreFormatting} title={labels.moreFormatting} aria-haspopup="menu" aria-expanded={view === 'more'}
            onClick={() => toggle('more')}><MoreHorizontalIcon aria-hidden="true" /></Button>
        </div>
        {view === 'turn' ? <Popout anchor={panel} label={labels.turnInto} slot="editor-turn-into">
          {availableCommands(blockCommands, blocks).map(command => <Button key={command.id} role="menuitemradio" aria-checked={state.block === command.id} size="sm" variant="ghost" className="w-full justify-start"
            onClick={() => { command.run(editor, { openDialog: () => {} }); setView('main'); }}>
            <command.icon aria-hidden="true" />{labels[command.label]}
            {state.block === command.id ? <CheckIcon aria-hidden="true" className="ms-auto" /> : null}
          </Button>)}
        </Popout> : null}
        {view === 'more' ? <Popout anchor={panel} label={labels.moreFormatting} slot="editor-more">
          <div className="flex gap-0.5" role="group" aria-label={labels.alignment}>{row(alignCommands)}</div>
          {blocks && state.inTable ? <div className="mt-1 grid border-t border-border/60 pt-1" role="group" aria-label={labels.table}>
            {tableCommands.map(command => <Button key={command.id} size="sm" variant="ghost" className="w-full justify-start" onClick={() => command.run(editor, io)}>
              <command.icon aria-hidden="true" />{labels[command.label]}</Button>)}
          </div> : null}
        </Popout> : null}
      </>}
    </div>
  </BubbleMenu>;
}
