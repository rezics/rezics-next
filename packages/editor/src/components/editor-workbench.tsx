'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import type { Editor } from '@tiptap/core';
import { Search, ListTree, Settings2, Command as CommandIcon } from 'lucide-react';
import { useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  defaultEditorKeyboardBindings,
  editorCommandIds,
  type EditorPreferenceCommand,
  type EditorPreferences,
  type ResolvedEditorPreferences,
} from '../preferences.ts';
import {
  availableCommands,
  blockCommands,
  markCommands,
  horizontalRuleCommand,
  tableCommand,
  imageCommand,
  undoCommand,
  redoCommand,
  useCommandState,
} from './editor-commands.ts';
import { editorCommandLabel, type RichTextEditorLabels } from './editor-labels.ts';
import { EditorCommandPalette, type EditorProductCommand } from './editor-command-palette.tsx';
import { editorShortcutMatches, orderedEditorCommands } from './editor-command-preferences.ts';
import { EditorFind, type EditorFindHandle } from './editor-find.tsx';
import { EditorOutline } from './editor-outline.tsx';
import { BlockActions } from './editor-block-actions.tsx';
import { DomainTextControls } from './editor-domain-controls.tsx';
import { EditorPreferencesPanel, type EditorPreferencesPanelProps } from './editor-preferences.tsx';
import type { EditorBehaviorAction } from './editor-behavior-actions.ts';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import { useEditorState } from '@tiptap/react';
import { tableCommands, runTableCommand, type TableCommandName } from './editor-table-commands.ts';
import { tableControlLabels } from './editor-upstream/reactjs-tiptap-editor/table-labels.ts';
import { editorWorkbenchLabels, type EditorWorkbenchLabels } from './editor-workbench-labels.ts';

export type EditorPreset = 'writing' | 'knowledge' | 'compact';
export const editorPresetPreferences: Readonly<Record<EditorPreset, EditorPreferences>> = {
  writing: {
    commandOrder: ['paragraph', 'heading1', 'heading2', 'bold', 'italic', 'link', 'ruby', 'footnote', 'find'],
  },
  knowledge: { commandOrder: ['paragraph', 'heading1', 'table', 'taskList', 'bulletList', 'codeBlock', 'link'] },
  compact: { commandOrder: ['bold', 'italic', 'link', 'bulletList', 'orderedList'] },
};

export type EditorWorkbenchHandle = { handleShortcut: (event: KeyboardEvent) => boolean };

type Props = {
  editor: Editor;
  labels: RichTextEditorLabels;
  workbenchLabels?: Partial<EditorWorkbenchLabels>;
  preferences: EditorPreferences;
  preferencesPanelValue?: EditorPreferences;
  resolvedPreferences: ResolvedEditorPreferences;
  onPreferencesChange: (value: EditorPreferences) => void;
  preferencesPanel?: Omit<EditorPreferencesPanelProps, 'value' | 'onChange' | 'commands'>;
  isCurrent: () => boolean;
  upload: boolean;
  onLink: () => void;
  onImage: () => void;
  onTable: () => void;
  inspection?: ReactNode;
  preset?: EditorPreset;
  onInvalidContent?: () => void;
  toolbarHidden?: boolean;
  ref?: Ref<EditorWorkbenchHandle>;
};

const preferenceCommandIds = new Set<string>(editorCommandIds);

/** Tools subscribe locally; the editor root never renders on ordinary document transactions. */
export function EditorWorkbench({
  editor,
  labels,
  workbenchLabels,
  preferences,
  preferencesPanelValue,
  resolvedPreferences,
  onPreferencesChange,
  preferencesPanel,
  isCurrent,
  upload,
  onLink,
  onImage,
  onTable,
  inspection,
  preset = 'writing',
  onInvalidContent,
  toolbarHidden = false,
  ref,
}: Props) {
  const text = useMemo(() => ({ ...editorWorkbenchLabels, ...workbenchLabels }), [workbenchLabels]);
  const [findOpen, setFindOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [outlineOverride, setOutlineOverride] = useState<boolean>();
  const outlineOpen = outlineOverride ?? resolvedPreferences.outline;
  const [domainActions, setDomainActions] = useState<readonly EditorBehaviorAction[]>([]);
  const [blockActions, setBlockActions] = useState<readonly EditorBehaviorAction[]>([]);
  const acceptDomainActions = useCallback((actions: readonly EditorBehaviorAction[]) => setDomainActions(actions), []);
  const acceptBlockActions = useCallback((actions: readonly EditorBehaviorAction[]) => setBlockActions(actions), []);
  const find = useRef<EditorFindHandle>(null);
  const state = useCommandState(editor);
  const tableAvailability = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      Object.fromEntries(
        Object.entries(tableCommands).map(([name, command]) => [name, command(current.state)]),
      ) as Record<TableCommandName, boolean>,
  });
  const commands = useMemo((): EditorProductCommand[] => {
    const core = availableCommands(
      [
        ...markCommands,
        ...blockCommands,
        horizontalRuleCommand,
        tableCommand,
        ...(upload ? [imageCommand] : []),
        undoCommand,
        redoCommand,
      ],
      editor,
      true,
    ).map((command): EditorProductCommand => ({
      id: command.id,
      label: editorCommandLabel(labels, command.label),
      ...(command.keywords ? { keywords: command.keywords } : {}),
      disabled: command.id === 'undo' ? !state.canUndo : command.id === 'redo' ? !state.canRedo : false,
      active: command.active?.(editor) ?? false,
      run: () => {
        if (!isCurrent() || editor.view.composing) return false;
        const applied = command.id === 'table' ? onTable() : command.run(editor, onLink, onImage);
        if (isCurrent() && !['link', 'image', 'table'].includes(command.id)) editor.view.focus();
        return applied !== false;
      },
    }));
    const tables = editor.schema.nodes.table
      ? Object.keys(tableCommands).map((id): EditorProductCommand => ({
          id,
          label: labels[id as TableCommandName] ?? tableControlLabels[id as TableCommandName],
          disabled: !tableAvailability[id as TableCommandName],
          run: () => runTableCommand(editor, id as TableCommandName, isCurrent),
        }))
      : [];
    return [
      ...core,
      ...tables,
      ...domainActions,
      ...blockActions,
      { id: 'find', label: text.find, run: () => setFindOpen(true) },
      {
        id: 'replace',
        label: text.replaceWith,
        run: () => {
          setFindOpen(true);
          find.current?.focusReplacement();
        },
      },
      {
        id: 'findNext',
        label: text.nextMatch,
        run: () => {
          setFindOpen(true);
          return find.current?.next() ?? true;
        },
      },
      {
        id: 'findPrevious',
        label: text.previousMatch,
        run: () => {
          setFindOpen(true);
          return find.current?.next(true) ?? true;
        },
      },
      { id: 'commandPalette', label: text.commandPalette, run: () => setPaletteOpen(true) },
    ].map((command) => ({
      ...command,
      ...(resolvedPreferences.keyboardBindings[command.id as EditorPreferenceCommand]
        ? {
            shortcut: resolvedPreferences.keyboardBindings[command.id as EditorPreferenceCommand],
          }
        : {}),
    }));
  }, [
    editor,
    labels,
    state,
    tableAvailability,
    upload,
    isCurrent,
    onLink,
    onImage,
    onTable,
    domainActions,
    blockActions,
    text,
    resolvedPreferences.keyboardBindings,
  ]);
  const presented = useMemo(
    () => orderedEditorCommands(commands, resolvedPreferences),
    [commands, resolvedPreferences],
  );
  const pinned = presented.filter((command) =>
    resolvedPreferences.pinnedCommands.includes(command.id as EditorPreferenceCommand),
  );
  useImperativeHandle(
    ref,
    () => ({
      handleShortcut(event) {
        if (
          !isCurrent() ||
          editor.view.composing ||
          event.isComposing ||
          event.keyCode === 229 ||
          ['Process', 'Dead'].includes(event.key) ||
          event.getModifierState('AltGraph')
        )
          return false;
        const command = commands.find(
          (action) =>
            !action.disabled &&
            editorShortcutMatches(
              event,
              resolvedPreferences.keyboardBindings[action.id as EditorPreferenceCommand] ?? '',
            ),
        );
        if (command) return command.run() !== false;
        // Suppress a replaced default before ProseMirror keymaps can also apply it.
        if (
          Object.entries(defaultEditorKeyboardBindings).some(
            ([id, chord]) =>
              resolvedPreferences.keyboardBindings[id as EditorPreferenceCommand] !== chord &&
              editorShortcutMatches(event, chord),
          )
        )
          return true;
        // Preserve the established Windows/Linux redo alias unless the author replaces or disables redo.
        if (
          resolvedPreferences.keyboardBindings.redo === defaultEditorKeyboardBindings.redo &&
          event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'y'
        ) {
          const redo = commands.find((action) => action.id === 'redo' && !action.disabled);
          return redo ? redo.run() !== false : false;
        }
        return false;
      },
    }),
    [commands, editor, isCurrent, resolvedPreferences.keyboardBindings],
  );
  const finalFocus = () => (isCurrent() ? editor.view.dom : false);
  const closeSettings = () => setSettingsOpen(false);

  return (
    <div
      data-slot="editor-workbench"
      className="mb-3 flex min-w-0 flex-col gap-3"
      onKeyDown={(event) => {
        // These inputs can be nested in a publish form. Native composition still owns its Enter.
        if (
          event.key === 'Enter' &&
          (event.target as HTMLElement).tagName === 'INPUT' &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          !editor.view.composing &&
          !event.getModifierState('AltGraph')
        )
          event.preventDefault();
      }}
    >
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={text.commandPalette}>
        {preset !== 'compact' ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (isCurrent()) setFindOpen((open) => !open);
            }}
            aria-expanded={findOpen}
          >
            <Search data-icon="inline-start" />
            {text.find}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (isCurrent()) setPaletteOpen(true);
          }}
        >
          <CommandIcon data-icon="inline-start" />
          {text.commandPalette}
        </Button>
        {preset !== 'compact' ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (isCurrent()) setOutlineOverride(!outlineOpen);
            }}
            aria-expanded={outlineOpen}
          >
            <ListTree data-icon="inline-start" />
            {text.outline}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (isCurrent()) setSettingsOpen(true);
          }}
        >
          <Settings2 data-icon="inline-start" />
          {text.editorSettings}
        </Button>
        <div hidden={toolbarHidden || preset === 'compact'}>
          <DomainTextControls editor={editor} labels={labels} isCurrent={isCurrent} onCommands={acceptDomainActions} />
        </div>
        <div hidden={toolbarHidden || preset === 'compact'}>
          <BlockActions editor={editor} labels={labels} isCurrent={isCurrent} onCommands={acceptBlockActions} />
        </div>
      </div>
      {pinned.length && !toolbarHidden ? (
        <TooltipProvider>
          <div role="toolbar" aria-label={text.pinnedCommands} className="flex flex-wrap gap-1">
            {pinned.map((command) => (
              <ActionButton
                key={command.id}
                label={command.label}
                disabled={!!command.disabled}
                {...(command.active === undefined ? {} : { pressed: command.active })}
                action={() => {
                  if (isCurrent() && !command.disabled) command.run();
                }}
              >
                {command.label}
              </ActionButton>
            ))}
          </div>
        </TooltipProvider>
      ) : null}
      {findOpen ? (
        <EditorFind
          ref={find}
          editor={editor}
          labels={text}
          isCurrent={isCurrent}
          onClose={() => setFindOpen(false)}
          {...(onInvalidContent ? { onInvalidContent } : {})}
        />
      ) : null}
      {outlineOpen ? (inspection ?? <EditorOutline editor={editor} labels={text} isCurrent={isCurrent} />) : null}
      <EditorCommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={presented}
        labels={text}
        isCurrent={isCurrent}
        finalFocus={finalFocus}
      />
      <ResponsiveDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
        title={text.editorSettings}
        description={text.settingsDescription}
        closeLabel={text.close}
        finalFocus={finalFocus}
      >
        <EditorPreferencesPanel
          {...preferencesPanel}
          value={preferencesPanelValue ?? preferences}
          onChange={(next) => {
            if (isCurrent()) onPreferencesChange(next);
          }}
          commands={commands
            .filter((command) => preferenceCommandIds.has(command.id))
            .map((command) => ({ id: command.id as EditorPreferenceCommand, label: command.label }))}
        />
      </ResponsiveDialog>
    </div>
  );
}
