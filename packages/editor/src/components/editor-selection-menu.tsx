'use client';

import { Button } from '@rezics/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import type { Editor } from '@tiptap/core';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, ChevronDown, Code, Ellipsis, EyeOff, Italic, Link, Strikethrough, Underline } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useCommandState, type EditorCommand } from './editor-commands.ts';
import { editorCommandLabel, type RichTextEditorLabels } from './editor-labels.ts';
import { bubbleOptions } from './editor-menu-helpers.ts';
import { LinkField, type LinkVisitRange } from './editor-link.tsx';
import { BlockMenu } from './editor-upstream/reactjs-tiptap-editor/block-menu.tsx';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';
import type { EditorProductCommand } from './editor-command-palette.tsx';
import { productControlLabels } from './editor-upstream/reactjs-tiptap-editor/control-labels.ts';

const markIcons = {
  bold: Bold,
  italic: Italic,
  link: Link,
  underline: Underline,
  strike: Strikethrough,
  code: Code,
  spoiler: EyeOff,
};
const primaryMarks = ['bold', 'italic', 'link'];

/**
 * Upstream action controls keep one tab stop and arrow-key travel in the existing selection layer.
 * The editor's range owner still controls links and frame-deferred focus restoration.
 */
export function SelectionMenu({
  editor,
  labels,
  linkRange,
  onLink,
  onLinkClose,
  container,
  contextCommands,
  visible = true,
  isCurrent,
  isRangeCurrent,
  onLinkUrlChange,
  focusEditor,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  linkRange: LinkVisitRange | null;
  onLink: () => void;
  onLinkClose: () => void;
  container: RefObject<HTMLDivElement | null>;
  contextCommands: () => readonly EditorProductCommand[];
  visible?: boolean;
  isCurrent: () => boolean;
  isRangeCurrent: (range: LinkVisitRange) => boolean;
  onLinkUrlChange: (range: LinkVisitRange, url: string) => void;
  focusEditor: () => void;
}) {
  const state = useCommandState(editor);
  const [tabStop, setTabStop] = useState('bold');
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreContext, setMoreContext] = useState<readonly EditorProductCommand[]>([]);
  const openingDialog = useRef(false);
  const moreLabel = labels.moreFormatting ?? productControlLabels.moreFormatting;
  const marks = state.marks.filter(({ command }) => primaryMarks.includes(command.id));
  const additionalMarks = state.marks.filter(({ command }) => !primaryMarks.includes(command.id));
  const markMenu = useRef(false);
  // The block menu lives in a portal, outside the bubble, so the bubble must not hide while it holds focus.
  const holdsFocus = useRef(false);
  const selectionRevision = useRef(0);
  const [renderedSelectionRevision, setRenderedSelectionRevision] = useState(0);
  const menuIsCurrent = () => isCurrent() && selectionRevision.current === renderedSelectionRevision;
  const availableTabStops = [
    ...marks.map(({ command }) => command.id),
    ...(additionalMarks.length ? ['more'] : []),
    ...(state.blocks.length ? ['turnInto'] : []),
  ];
  const activeTabStop = availableTabStops.includes(tabStop) ? tabStop : availableTabStops[0];
  useLayoutEffect(() => {
    const close = () => {
      if (!isCurrent()) return;
      selectionRevision.current += 1;
      setRenderedSelectionRevision(selectionRevision.current);
      holdsFocus.current = false;
      markMenu.current = false;
      setMoreOpen(false);
    };
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor, isCurrent]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!menuIsCurrent() || event.nativeEvent.isComposing || event.keyCode === 229 || editor.view.composing) return;
    const target = event.target as HTMLElement;
    // Menu items render in a portal, but their events still bubble through this tree.
    if (!event.currentTarget.contains(target) || target.closest('input')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      focusEditor();
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    // Up and down open the menu on its own button.
    if (
      target.closest('[data-editor-block-trigger], [aria-haspopup="menu"]') &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    )
      return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (step ?? 0) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  function runCommand(command: EditorCommand) {
    if (!menuIsCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing) return;
    command.run(editor, onLink, () => undefined);
    if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  }
  if (!isCurrent() || state.empty) return null;
  return (
    <TooltipProvider delay={600}>
      <BubbleMenu
        editor={editor}
        pluginKey="rezicsSelectionMenu"
        updateDelay={0}
        options={bubbleOptions}
        appendTo={() => container.current!}
        shouldShow={({ editor: current, state: live, view, element }) =>
          visible &&
          isCurrent() &&
          current.isEditable &&
          (live.selection instanceof TextSelection || live.selection instanceof AllSelection) &&
          !live.selection.empty &&
          (view.hasFocus() || element.contains(document.activeElement) || holdsFocus.current || markMenu.current)
        }
      >
        <div
          role="toolbar"
          aria-label={labels.formatting}
          data-slot="editor-selection-menu"
          className="relative flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          onKeyDown={moveFocus}
        >
          {linkRange ? (
            <LinkField
              key={linkRange.id}
              editor={editor}
              labels={labels}
              range={linkRange}
              onClose={onLinkClose}
              isCurrent={menuIsCurrent}
              isRangeCurrent={isRangeCurrent}
              onUrlChange={onLinkUrlChange}
              focusEditor={focusEditor}
            />
          ) : (
            <>
              {marks.map(({ command, active }) => {
                const Icon = markIcons[command.id as keyof typeof markIcons];
                return (
                  <ActionButton
                    key={command.id}
                    label={editorCommandLabel(labels, command.label)}
                    icon={<Icon aria-hidden="true" />}
                    pressed={active}
                    action={() => runCommand(command)}
                    tabIndex={activeTabStop === command.id ? 0 : -1}
                    onFocus={() => {
                      if (menuIsCurrent()) setTabStop(command.id);
                    }}
                  />
                );
              })}
              {additionalMarks.length ? (
                <DropdownMenu
                  modal={false}
                  open={moreOpen}
                  onOpenChange={(open) => {
                    markMenu.current = open;
                    if (open) {
                      openingDialog.current = false;
                      setMoreContext(contextCommands());
                    }
                    setMoreOpen(open);
                  }}
                >
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={moreLabel}
                        title={moreLabel}
                        tabIndex={activeTabStop === 'more' ? 0 : -1}
                        onFocus={() => {
                          if (menuIsCurrent()) setTabStop('more');
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <Ellipsis aria-hidden="true" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent
                    finalFocus={(method) => {
                      if (method === 'keyboard' && menuIsCurrent() && !openingDialog.current) focusEditor();
                      return false;
                    }}
                    className="w-max max-w-[min(18rem,calc(100vw-1rem))]"
                  >
                    <DropdownMenuGroup>
                      {additionalMarks.map(({ command, active }) => {
                        const Icon = markIcons[command.id as keyof typeof markIcons];
                        const label = editorCommandLabel(labels, command.label);
                        if (!command.active)
                          return (
                            <DropdownMenuItem key={command.id} onClick={() => runCommand(command)}>
                              {label}
                            </DropdownMenuItem>
                          );
                        return (
                          <DropdownMenuCheckboxItem
                            key={command.id}
                            checked={active}
                            onCheckedChange={() => {
                              runCommand(command);
                              markMenu.current = false;
                              setMoreOpen(false);
                            }}
                          >
                            {Icon ? <Icon aria-hidden="true" /> : null}
                            {label}
                          </DropdownMenuCheckboxItem>
                        );
                      })}
                    </DropdownMenuGroup>
                    {moreContext.length ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          {moreContext.map((command) => (
                            <DropdownMenuItem
                              key={command.id}
                              onClick={() => {
                                if (!menuIsCurrent() || editor.view.composing) return;
                                openingDialog.current = command.run() !== false;
                              }}
                            >
                              {command.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {state.blocks.length ? (
                <BlockMenu
                  editor={editor}
                  labels={labels}
                  title={labels.turnInto}
                  commands={state.blocks.map(({ command }) => command)}
                  selectedBlock={state.blocks.find((block) => block.active)?.command.id}
                  isCurrent={menuIsCurrent}
                  onSelect={runCommand}
                  onOpenChange={(open) => {
                    holdsFocus.current = open;
                  }}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      data-editor-block-trigger
                      className="ms-0.5 border-s ps-2"
                      tabIndex={activeTabStop === 'turnInto' ? 0 : -1}
                      onFocus={() => {
                        if (menuIsCurrent()) setTabStop('turnInto');
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {labels.turnInto}
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  }
                />
              ) : null}
            </>
          )}
        </div>
      </BubbleMenu>
    </TooltipProvider>
  );
}
