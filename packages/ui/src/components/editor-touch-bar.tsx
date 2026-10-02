'use client';

import type { Editor as TiptapEditor } from '@tiptap/core';
import { ALargeSmallIcon, ChevronDownIcon, PlusIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Drawer, DrawerBody, DrawerContent, DrawerHeader } from './drawer.tsx';
import {
  alignCommands, availableCommands, blockActionCommands, blockCommands, commandById, composeCommandGroups, describeCommand, historyCommands, inlineCommands, insertCommands, markCommands,
  tableCommands, useCommandState, type CommandIO, type EditorCommand,
} from './editor-commands.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';

type Panel = 'format' | 'insert';

/** The height the on-screen keyboard takes from the visual viewport, so the bar can rest on top of it. */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, [active]);
  return inset;
}

/** Whether the writing surface has the caret. Leaving it briefly, such as into a drawer, does not count as leaving. */
function useEditorFocus(editor: TiptapEditor): boolean {
  const [focused, setFocused] = useState(editor.isFocused);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focus = () => { clearTimeout(timer); setFocused(true); };
    const blur = () => { clearTimeout(timer); timer = setTimeout(() => setFocused(false), 150); };
    editor.on('focus', focus);
    editor.on('blur', blur);
    return () => { clearTimeout(timer); editor.off('focus', focus); editor.off('blur', blur); };
  }, [editor]);
  return focused;
}

function Tile({ editor, command, labels, state, onPick }: {
  editor: TiptapEditor; command: EditorCommand; labels: RichTextEditorLabels; state: ReturnType<typeof useCommandState>; onPick: (command: EditorCommand) => void;
}) {
  const active = state.isActive(command.id);
  return <Button type="button" variant={active ? 'soft' : 'outline'} className="h-16 min-w-0 flex-col gap-1 px-1 text-xs" aria-pressed={command.active ? active : undefined}
    disabled={state.isDisabled(command.id)} onClick={() => onPick(command)}>
    <command.icon aria-hidden="true" className="size-5" /><span className="max-w-full truncate">{labels[command.label]}</span>
  </Button>;
}

function Section({ heading, children, className }: { heading?: string; children: React.ReactNode; className?: string }) {
  return <section aria-label={heading} className="grid gap-2 text-start">
    {heading ? <h3 className="text-xs font-medium text-muted-foreground">{heading}</h3> : null}
    <div className={className}>{children}</div>
  </section>;
}

/**
 * Phones select with handles and the system's own menu, so a floating panel would fight it. Touch
 * writers get a bar resting on the keyboard for what they do most, and a drawer for everything else.
 * Discussion writing shows no bar until text is selected, then the inline formats. Buttons never
 * take focus, so the keyboard stays up while a format is toggled.
 */
export const TouchBar = memo(function TouchBar({ editor, labels, blocks, compact, io }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; blocks: boolean; compact: boolean; io: CommandIO;
}) {
  const state = useCommandState(editor);
  const focused = useEditorFocus(editor);
  const [panel, setPanel] = useState<Panel | null>(null);
  const later = useRef<(() => void) | null>(null);
  // Discussion writing has no standing toolbar: formats appear once text is selected, as a long press does in chat apps.
  const visible = compact ? focused && !state.empty : focused || panel !== null;
  const inset = useKeyboardInset(visible);
  // The drawer is modal, so a command waits for it to leave; otherwise two focus traps contend for the caret.
  const pick = (command: EditorCommand) => { later.current = () => command.run(editor, io); setPanel(null); };
  const quick = ['bold', 'italic', 'strike', 'bulletList', 'taskList', 'blockquote', 'link'].map(commandById);
  const divider = (key: string) => <span key={key} aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border/60" />;
  const button = (command: EditorCommand) => <Button key={command.id} type="button" size="icon-sm" className="size-10 shrink-0" variant={state.isActive(command.id) ? 'soft' : 'ghost'}
    aria-label={labels[command.label]} title={describeCommand(command, labels)} aria-pressed={command.active ? state.isActive(command.id) : undefined}
    disabled={state.isDisabled(command.id)} onMouseDown={event => event.preventDefault()} onClick={() => command.run(editor, io)}>
    <command.icon aria-hidden="true" />
  </Button>;
  const open = (next: Panel) => { editor.chain().focus().run(); setPanel(next); };
  return <>
    {visible && panel === null ? <div role="toolbar" aria-label={labels.toolbar} data-slot="editor-touch-bar" style={{ bottom: inset }}
      className={cn('fixed inset-x-0 z-40 flex items-center gap-1 border-t border-border/60 bg-popover px-2 text-popover-foreground', inset === 0 && 'pb-[env(safe-area-inset-bottom)]')}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1">
        {compact ? composeCommandGroups.flatMap((group, index) => [...(index ? [divider(`divider-${index}`)] : []), ...group.map(commandById).map(button)]) : <>
          <Button type="button" size="icon-sm" variant="ghost" className="size-10 shrink-0" aria-label={labels.formatting} title={labels.formatting} aria-haspopup="dialog"
            onMouseDown={event => event.preventDefault()} onClick={() => open('format')}><ALargeSmallIcon aria-hidden="true" /></Button>
          <Button type="button" size="icon-sm" variant="ghost" className="size-10 shrink-0" aria-label={labels.insertBlock} title={labels.insertBlock} aria-haspopup="dialog"
            onMouseDown={event => event.preventDefault()} onClick={() => open('insert')}><PlusIcon aria-hidden="true" /></Button>
          {divider('drawers')}
          {quick.map(button)}
          {divider('history')}
          {historyCommands.map(button)}
        </>}
      </div>
      <Button type="button" size="icon-sm" variant="ghost" className="size-10 shrink-0" aria-label={labels.hideKeyboard} title={labels.hideKeyboard}
        onMouseDown={event => event.preventDefault()} onClick={() => editor.commands.blur()}><ChevronDownIcon aria-hidden="true" /></Button>
    </div> : null}
    <Drawer open={panel !== null} onOpenChange={({ open: next }) => { if (!next) setPanel(null); }}
      finalFocusEl={() => editor.view.dom as HTMLElement}
      onExitComplete={() => { const next = later.current; later.current = null; if (next) next(); else editor.commands.focus(); }}>
      <DrawerContent>
        <DrawerHeader className="text-start" title={panel === 'insert' ? labels.insertBlock : labels.formatting} />
        <DrawerBody className="grid gap-5 text-start">
          {panel === 'format' ? <>
            <Section heading={labels.turnInto} className="grid grid-cols-3 gap-2 min-[28rem]:grid-cols-4">
              {availableCommands(blockCommands, blocks).map(command => <Tile key={command.id} editor={editor} command={command} labels={labels} state={{ ...state, isActive: id => state.block === id, isDisabled: () => false }} onPick={pick} />)}
            </Section>
            <Section heading={labels.toolbar} className="grid grid-cols-3 gap-2 min-[28rem]:grid-cols-4">
              {[...markCommands, commandById('clearFormatting')].map(command => <Tile key={command.id} editor={editor} command={command} labels={labels} state={state} onPick={pick} />)}
            </Section>
            <Section className="grid gap-1">
              {inlineCommands.filter(command => command.id !== 'clearFormatting').map(command => <Button key={command.id} type="button" variant={state.isActive(command.id) ? 'soft' : 'ghost'}
                className="h-11 w-full justify-start" disabled={state.isDisabled(command.id)} onClick={() => pick(command)}><command.icon aria-hidden="true" />{labels[command.label]}</Button>)}
            </Section>
            <Section heading={labels.alignment} className="grid grid-cols-4 gap-2">
              {alignCommands.map(command => <Button key={command.id} type="button" variant={state.isActive(command.id) ? 'soft' : 'outline'} className="h-11" aria-label={labels[command.label]}
                aria-pressed={state.isActive(command.id)} onClick={() => pick(command)}><command.icon aria-hidden="true" /></Button>)}
            </Section>
            <Section heading={labels.block} className="grid grid-cols-4 gap-2">
              {blockActionCommands.map(command => <Tile key={command.id} editor={editor} command={command} labels={labels} state={state} onPick={pick} />)}
            </Section>
            {blocks && state.inTable ? <Section heading={labels.tableMenu} className="grid gap-1">
              {tableCommands.map(command => <Button key={command.id} type="button" variant="ghost" className="h-11 w-full justify-start" onClick={() => pick(command)}><command.icon aria-hidden="true" />{labels[command.label]}</Button>)}
            </Section> : null}
          </> : null}
          {panel === 'insert' ? <Section className="grid grid-cols-3 gap-2 min-[28rem]:grid-cols-4">
            {availableCommands(insertCommands, blocks).map(command => <Tile key={command.id} editor={editor} command={command}
              labels={labels} state={{ ...state, isActive: () => false, isDisabled: () => false }} onPick={pick} />)}
          </Section> : null}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  </>;
});
