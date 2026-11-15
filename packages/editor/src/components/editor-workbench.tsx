'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import type { Editor } from '@tiptap/core';
import { Search, ListTree, Settings2, Ellipsis, Command as CommandIcon } from 'lucide-react';
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
import { EditorFind, type EditorFindHandle, type EditorFindIntent } from './editor-find.tsx';
import { EditorOutline } from './editor-outline.tsx';
import { BlockActions, blockActionNames } from './editor-block-actions.tsx';
import { DomainTextControls } from './editor-domain-controls.tsx';
import { AuthorFormattingControls } from './editor-formatting-controls.tsx';
import { EditorMediaControls } from './editor-image.tsx';
import { EditorPreferencesPanel, type EditorPreferencesPanelProps } from './editor-preferences.tsx';
import type { EditorBehaviorAction } from './editor-behavior-actions.ts';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import { useEditorState } from '@tiptap/react';
import { isInTable } from '@tiptap/pm/tables';
import { tableCommands, runTableCommand, type TableCommandName } from './editor-table-commands.ts';
import { tableControlLabels } from './editor-upstream/reactjs-tiptap-editor/table-labels.ts';
import { editorWorkbenchLabels, type EditorWorkbenchLabels } from './editor-workbench-labels.ts';
import { productControlLabels } from './editor-upstream/reactjs-tiptap-editor/control-labels.ts';

export type EditorPreset = 'writing' | 'knowledge' | 'compact';
export const editorPresetPreferences: Readonly<Record<EditorPreset, EditorPreferences>> = {
  writing: {
    commandOrder: ['paragraph', 'heading1', 'heading2', 'bold', 'italic', 'link', 'ruby', 'footnote', 'find'],
  },
  knowledge: { commandOrder: ['paragraph', 'heading1', 'table', 'taskList', 'bulletList', 'codeBlock', 'link'] },
  compact: { commandOrder: ['bold', 'italic', 'link', 'bulletList', 'orderedList'] },
};

export type EditorWorkbenchHandle = {
  handleShortcut: (event: KeyboardEvent) => boolean;
  selectionCommands: () => readonly EditorProductCommand[];
};

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
  readOnly?: boolean;
  ref?: Ref<EditorWorkbenchHandle>;
};

const preferenceCommandIds = new Set<string>(editorCommandIds);
const selectionCommandIds = new Set(['ruby', 'footnote', 'language', 'textStyle', 'textEmphasis', ...blockActionNames]);

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
  readOnly = false,
  ref,
}: Props) {
  const text = useMemo(() => ({ ...editorWorkbenchLabels, ...workbenchLabels }), [workbenchLabels]);
  const [findIntent, setFindIntent] = useState<EditorFindIntent | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [outlineOverride, setOutlineOverride] = useState<boolean>();
  const outlineOpen = outlineOverride ?? resolvedPreferences.outline;
  const [domainActions, setDomainActions] = useState<readonly EditorBehaviorAction[]>([]);
  const [blockActions, setBlockActions] = useState<readonly EditorBehaviorAction[]>([]);
  const [formattingActions, setFormattingActions] = useState<readonly EditorBehaviorAction[]>([]);
  const [mediaActions, setMediaActions] = useState<readonly EditorBehaviorAction[]>([]);
  const acceptDomainActions = useCallback((actions: readonly EditorBehaviorAction[]) => setDomainActions(actions), []);
  const acceptBlockActions = useCallback((actions: readonly EditorBehaviorAction[]) => setBlockActions(actions), []);
  const acceptFormattingActions = useCallback(
    (actions: readonly EditorBehaviorAction[]) => setFormattingActions(actions),
    [],
  );
  const acceptMediaActions = useCallback((actions: readonly EditorBehaviorAction[]) => setMediaActions(actions), []);
  const find = useRef<EditorFindHandle>(null);
  const lastFindQuery = useRef('');
  const openFind = useCallback((intent: EditorFindIntent) => {
    if (find.current) return find.current.activate(intent);
    setFindIntent(intent);
    return true;
  }, []);
  const state = useCommandState(editor);
  const tableAvailability = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current.isEditable || !isInTable(current.state)) return null;
      return Object.fromEntries(
        Object.entries(tableCommands).map(([name, command]) => [name, command(current.state)]),
      ) as Record<TableCommandName, boolean>;
    },
  });
  const commands = useMemo((): EditorProductCommand[] => {
    const navigation: EditorProductCommand[] = [
      { id: 'find', afterPaletteClose: true, label: text.find, run: () => openFind('find') },
      { id: 'findNext', afterPaletteClose: true, label: text.nextMatch, run: () => openFind('next') },
      { id: 'findPrevious', afterPaletteClose: true, label: text.previousMatch, run: () => openFind('previous') },
    ];
    if (readOnly) return navigation;
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
          disabled: !tableAvailability?.[id as TableCommandName],
          run: () => runTableCommand(editor, id as TableCommandName, isCurrent),
        }))
      : [];
    return [
      ...core,
      ...tables,
      ...domainActions,
      ...blockActions,
      ...formattingActions,
      ...mediaActions,
      ...navigation,
      { id: 'replace', afterPaletteClose: true, label: text.replaceWith, run: () => openFind('replace') },
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
    readOnly,
    tableAvailability,
    upload,
    isCurrent,
    onLink,
    onImage,
    onTable,
    domainActions,
    blockActions,
    formattingActions,
    mediaActions,
    text,
    openFind,
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
      selectionCommands: () => presented.filter((command) => selectionCommandIds.has(command.id) && !command.disabled),
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
        if (readOnly) return false;
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
    [commands, editor, isCurrent, presented, readOnly, resolvedPreferences.keyboardBindings],
  );
  const finalFocus = () => (isCurrent() && !find.current ? editor.view.dom : false);
  const closeSettings = () => setSettingsOpen(false);

  return (
    <div
      data-slot="editor-workbench"
      className="mb-3 flex min-w-0 flex-col gap-1 md:gap-3"
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
      <div
        className="relative flex min-w-0 flex-wrap items-center gap-1 py-1"
        role="group"
        aria-label={text.commandPalette}
      >
        {preset !== 'compact' ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={text.find}
            title={text.find}
            onClick={() => {
              if (isCurrent()) setFindIntent((intent) => (intent ? null : 'find'));
            }}
            aria-expanded={findIntent !== null}
          >
            <Search data-icon="inline-start" />
            <span className="hidden md:inline">{text.find}</span>
          </Button>
        ) : null}
        {!readOnly ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={text.commandPalette}
            title={text.commandPalette}
            onClick={() => {
              if (isCurrent()) setPaletteOpen(true);
            }}
          >
            <CommandIcon data-icon="inline-start" />
            <span className="hidden md:inline">{text.commandPalette}</span>
          </Button>
        ) : null}
        {preset !== 'compact' ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={text.outline}
            title={text.outline}
            onClick={() => {
              if (!isCurrent()) return;
              if (findIntent) {
                setFindIntent(null);
                setOutlineOverride(true);
              } else setOutlineOverride(!outlineOpen);
            }}
            aria-expanded={outlineOpen && !findIntent}
          >
            <ListTree data-icon="inline-start" />
            <span className="hidden md:inline">{text.outline}</span>
          </Button>
        ) : null}
        {!readOnly ? (
          <>
            <Button
              type="button"
              variant="ghost"
              aria-label={text.editorSettings}
              title={text.editorSettings}
              onClick={() => {
                if (isCurrent()) setSettingsOpen(true);
              }}
            >
              <Settings2 data-icon="inline-start" />
              <span className="hidden md:inline">{text.editorSettings}</span>
            </Button>
            <details
              className="ms-auto"
              hidden={toolbarHidden || preset === 'compact'}
              onKeyDown={(event) => {
                const details = event.currentTarget;
                if (
                  event.key !== 'Escape' ||
                  !details.open ||
                  !details.contains(event.target as Node) ||
                  event.nativeEvent.isComposing
                )
                  return;
                event.preventDefault();
                details.open = false;
                details.querySelector('summary')?.focus();
              }}
            >
              <summary
                className="flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
                onMouseDown={(event) => event.preventDefault()}
              >
                <Ellipsis aria-hidden="true" className="size-4" />
                {labels.moreTools ?? productControlLabels.moreTools}
              </summary>
              <div className="absolute end-0 z-20 mt-1 flex w-max max-w-full flex-col gap-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md">
                <DomainTextControls editor={editor} labels={labels} isCurrent={isCurrent} onCommands={acceptDomainActions} />
                <BlockActions editor={editor} labels={labels} isCurrent={isCurrent} onCommands={acceptBlockActions} />
                <AuthorFormattingControls
                  editor={editor}
                  labels={labels}
                  isCurrent={isCurrent}
                  onCommands={acceptFormattingActions}
                />
                <EditorMediaControls editor={editor} labels={labels} isCurrent={isCurrent} onCommands={acceptMediaActions} />
              </div>
            </details>
          </>
        ) : null}
      </div>
      {pinned.length && !toolbarHidden && !readOnly ? (
        <TooltipProvider>
          <div
            role="toolbar"
            aria-label={text.pinnedCommands}
            className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain md:flex-wrap"
          >
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
      {findIntent ? (
        <div className="editor-navigation-panel w-[min(25rem,calc(100%_-_2rem))]">
          <EditorFind
            ref={find}
            editor={editor}
            labels={text}
            isCurrent={isCurrent}
            initialIntent={findIntent}
            defaultQuery={lastFindQuery.current}
            onQueryChange={(query) => {
              lastFindQuery.current = query;
            }}
            onClose={() => setFindIntent(null)}
            {...(onInvalidContent ? { onInvalidContent } : {})}
          />
        </div>
      ) : outlineOpen ? (
        <div className="editor-navigation-panel w-[min(22rem,calc(100%_-_2rem))]">
          <EditorOutline editor={editor} labels={text} isCurrent={isCurrent} onClose={() => setOutlineOverride(false)}>
            {inspection}
          </EditorOutline>
        </div>
      ) : null}
      <EditorCommandPalette
        open={paletteOpen && !readOnly}
        onClose={() => setPaletteOpen(false)}
        commands={presented.filter((command) => command.id !== 'commandPalette')}
        labels={text}
        isCurrent={isCurrent}
        finalFocus={finalFocus}
      />
      <ResponsiveDialog
        open={settingsOpen && !readOnly}
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
