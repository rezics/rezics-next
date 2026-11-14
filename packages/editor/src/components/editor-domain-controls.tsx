'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import type { Editor } from '@tiptap/core';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { Languages, NotebookPen, Type } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { behaviorControlLabels, type BehaviorControlLabels } from './editor-behavior-labels.ts';
import {
  applyLanguage,
  applyRuby,
  canApplyRuby,
  canInsertFootnote,
  captureAnnotationTarget,
  focusFootnoteBody,
  footnoteDefinitions,
  insertFootnote,
  mapAnnotationTarget,
  removeFootnote,
  removeRuby,
  renameFootnote,
  rubyBase,
  validFootnoteLabel,
  validLanguageTag,
  type AnnotationTarget,
} from './editor-domain-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';
import type { EditorBehaviorAction } from './editor-behavior-actions.ts';
import { editorCommandsForPresentation } from './editor-command-preferences.ts';
import { returnFocus } from './editor-menu-helpers.ts';

type Panel = 'ruby' | 'language' | 'footnote';
const selectClass =
  'min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';

function AnnotationDialog({
  editor,
  labels,
  isCurrent,
  panel,
  target,
  onClose,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  isCurrent: () => boolean;
  panel: Panel;
  target: AnnotationTarget;
  onClose: () => void;
}) {
  const t = (key: keyof BehaviorControlLabels) => labels[key] ?? behaviorControlLabels[key];
  const id = useId();
  const saved = useRef<AnnotationTarget | null>(target);
  const composing = useRef(false);
  const latest = useRef({ isCurrent, onClose });
  latest.current = { isCurrent, onClose };
  const [base, setBase] = useState(rubyBase(target));
  const [reading, setReading] = useState<string>(target.ruby?.attrs.rt ?? '');
  const [position, setPosition] = useState<'over' | 'under' | 'inter-character'>(target.ruby?.attrs.position ?? 'over');
  const block = target.selection.$from.parent;
  const initialLanguage =
    target.ruby?.attrs.lang ??
    target.selection.$from.marks().find((mark) => mark.type.name === 'language')?.attrs.lang ??
    block.attrs.lang ??
    '';
  const [language, setLanguage] = useState<string>(initialLanguage);
  const [direction, setDirection] = useState<'' | 'ltr' | 'rtl' | 'auto'>(
    target.selection.$from.marks().find((mark) => mark.type.name === 'language')?.attrs.dir ?? block.attrs.dir ?? '',
  );
  const [scope, setScope] = useState<'selection' | 'block'>(target.selection.empty ? 'block' : 'selection');
  const notes = footnoteDefinitions(editor);
  const nextLabel = (() => {
    let index = 1;
    while (notes.some((note) => note.label === `note-${index}`)) index++;
    return `note-${index}`;
  })();
  const [noteLabel, setNoteLabel] = useState(target.footnote ?? nextLabel);
  const [body, setBody] = useState('');
  useLayoutEffect(() => {
    const update = ({ transaction }: { transaction: Transaction }) => {
      if (!saved.current) return;
      try {
        saved.current = mapAnnotationTarget(saved.current, transaction, editor);
      } catch {
        saved.current = null;
      }
      if (!saved.current) latest.current.onClose();
    };
    editor.on('transaction', update);
    return () => {
      saved.current = null;
      editor.off('transaction', update);
    };
  }, [editor]);
  const current = () => latest.current.isCurrent() && !editor.isDestroyed && editor.isEditable;
  const close = (focus = true) => {
    saved.current = null;
    onClose();
    if (focus && current()) {
      editor.view.focus();
      returnFocus(editor, current)();
    }
  };
  const run = (action: (admitted: AnnotationTarget) => boolean) => {
    const admitted = saved.current;
    if (!admitted || !current() || editor.view.composing) return;
    saved.current = null;
    if (action(admitted)) close();
    else saved.current = admitted;
  };
  const existingNote = notes.some((note) => note.label === noteLabel);
  const duplicateLabel = target.footnote !== null && target.footnote !== noteLabel && existingNote;
  const valid =
    panel === 'ruby'
      ? Boolean(base) && validLanguageTag(language)
      : panel === 'language'
        ? validLanguageTag(language)
        : validFootnoteLabel(noteLabel) && !duplicateLabel;
  const invalidMessage =
    panel === 'footnote' ? t('invalidFootnote') : panel === 'ruby' ? t('invalidRuby') : t('invalidLanguage');

  return (
    <ResponsiveDialog
      open
      title={t(panel)}
      description={t(`${panel}Help`)}
      closeLabel={labels.cancel}
      finalFocus={() => false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <form
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!valid || composing.current || editor.view.composing) return;
          run((admitted) =>
            panel === 'ruby'
              ? applyRuby(editor, admitted, { base, rt: reading, position, lang: language }, current)
              : panel === 'language'
                ? applyLanguage(editor, admitted, { lang: language, dir: direction, scope }, current)
                : admitted.footnote
                  ? renameFootnote(editor, admitted, noteLabel, current)
                  : insertFootnote(editor, admitted, noteLabel, body, current),
          );
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            composing.current ||
            ['Process', 'Dead'].includes(event.key) ||
            event.getModifierState('AltGraph')
          )
            return;
          if (event.key === 'Enter') {
            event.stopPropagation();
            if ((event.target as HTMLElement).tagName === 'INPUT') event.preventDefault();
          }
        }}
      >
        {panel === 'ruby' ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-base`}>{t('rubyBase')}</FieldLabel>
              <Input
                id={`${id}-base`}
                value={base}
                readOnly={Boolean(rubyBase(target))}
                onChange={(event) => setBase(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-reading`}>{t('rubyReading')}</FieldLabel>
              <Input
                id={`${id}-reading`}
                autoFocus
                value={reading}
                onChange={(event) => setReading(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-position`}>{t('rubyPosition')}</FieldLabel>
              <select
                id={`${id}-position`}
                className={selectClass}
                value={position}
                onChange={(event) => setPosition(event.target.value as typeof position)}
              >
                <option value="over">{t('rubyOver')}</option>
                <option value="under">{t('rubyUnder')}</option>
                <option value="inter-character">{t('rubyInterCharacter')}</option>
              </select>
            </Field>
          </>
        ) : null}
        {panel === 'ruby' || panel === 'language' ? (
          <Field>
            <FieldLabel htmlFor={`${id}-language`}>{t('languageTag')}</FieldLabel>
            <Input
              id={`${id}-language`}
              autoFocus={panel === 'language'}
              value={language}
              placeholder="zh-Hant"
              aria-invalid={!validLanguageTag(language)}
              onChange={(event) => setLanguage(event.target.value)}
            />
          </Field>
        ) : null}
        {panel === 'language' ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-direction`}>{t('direction')}</FieldLabel>
              <select
                id={`${id}-direction`}
                className={selectClass}
                value={direction}
                onChange={(event) => setDirection(event.target.value as typeof direction)}
              >
                <option value="">{t('directionDefault')}</option>
                <option value="ltr">{t('directionLtr')}</option>
                <option value="rtl">{t('directionRtl')}</option>
                <option value="auto">{t('directionAuto')}</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-scope`}>{t('languageScope')}</FieldLabel>
              <select
                id={`${id}-scope`}
                className={selectClass}
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                <option value="selection" disabled={target.from === target.to}>
                  {t('languageSelection')}
                </option>
                <option value="block">{t('languageBlock')}</option>
              </select>
            </Field>
          </>
        ) : null}
        {panel === 'footnote' ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-label`}>{t('footnoteLabel')}</FieldLabel>
              <Input
                id={`${id}-label`}
                list={`${id}-notes`}
                autoFocus
                value={noteLabel}
                aria-invalid={!valid}
                onChange={(event) => setNoteLabel(event.target.value)}
              />
              <datalist id={`${id}-notes`}>
                {notes.map((note) => (
                  <option key={note.label} value={note.label} />
                ))}
              </datalist>
            </Field>
            {!target.footnote && !existingNote ? (
              <Field>
                <FieldLabel htmlFor={`${id}-body`}>{t('footnoteBody')}</FieldLabel>
                <Textarea id={`${id}-body`} rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
              </Field>
            ) : !target.footnote ? (
              <p className="text-sm text-muted-foreground">{t('existingFootnote')}</p>
            ) : null}
            {target.footnote ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!current()) return;
                  close(false);
                  focusFootnoteBody(editor, target.footnote!, current);
                }}
              >
                {t('editFootnoteBody')}
              </Button>
            ) : null}
          </>
        ) : null}
        {!valid ? (
          <p role="alert" className="text-sm text-destructive">
            {invalidMessage}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {panel === 'ruby' && target.ruby ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => run((admitted) => removeRuby(editor, admitted, current))}
            >
              {t('removeRuby')}
            </Button>
          ) : null}
          {panel === 'language' ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => run((admitted) => applyLanguage(editor, admitted, { lang: '', dir: '', scope }, current))}
            >
              {t('clearLanguage')}
            </Button>
          ) : null}
          {panel === 'footnote' && target.footnote ? (
            <>
              {target.selection instanceof NodeSelection && target.selection.node.type.name === 'footnoteReference' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => run((admitted) => removeFootnote(editor, admitted, false, current))}
                >
                  {t('removeFootnoteReference')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="text-destructive"
                onClick={() => run((admitted) => removeFootnote(editor, admitted, true, current))}
              >
                {t('removeFootnote')}
              </Button>
            </>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => close()}>
            {labels.cancel}
          </Button>
          <Button type="submit" disabled={!valid}>
            {labels.apply}
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  );
}

/** Every panel captures this instance's current selection and retires when its admitted target changes. */
export function DomainTextControls({
  editor,
  labels,
  isCurrent,
  onCommands,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  isCurrent: () => boolean;
  onCommands?: (commands: readonly EditorBehaviorAction[]) => void;
}) {
  const [request, setRequest] = useState<{ panel: Panel; target: AnnotationTarget } | null>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const target = captureAnnotationTarget(current);
      return {
        ruby: Boolean(current.schema.nodes.ruby && target && canApplyRuby(target)),
        language: Boolean(current.schema.marks.language && target),
        footnote: Boolean(
          current.schema.nodes.footnoteReference && target && (target.footnote || canInsertFootnote(target)),
        ),
        presented: editorCommandsForPresentation(
          (['ruby', 'language', 'footnote'] as const).map((id) => ({ id })),
          current,
        ),
      };
    },
  });
  const t = (key: keyof BehaviorControlLabels) => labels[key] ?? behaviorControlLabels[key];
  const open = (panel: Panel) => {
    if (!isCurrent()) return false;
    const target = captureAnnotationTarget(editor);
    if (!target || !state[panel]) return false;
    setRequest({ panel, target });
    return true;
  };
  useLayoutEffect(() => {
    onCommands?.(
      (['ruby', 'language', 'footnote'] as const).map((panel) => ({
        id: panel,
        label: t(panel),
        disabled: !state[panel],
        run: () => open(panel),
      })),
    );
    return () => onCommands?.([]);
  }, [onCommands, editor, isCurrent, labels, state.ruby, state.language, state.footnote]);
  if (!isCurrent()) return null;
  return (
    <TooltipProvider delay={600}>
      <div
        role="group"
        aria-label={t('annotations')}
        data-slot="editor-domain-controls"
        className="flex flex-wrap items-center gap-1"
      >
        {state.presented.map(({ id: panel }) => {
          const Icon = { ruby: Type, language: Languages, footnote: NotebookPen }[panel];
          return (
            <ActionButton
              key={panel}
              label={t(panel)}
              icon={<Icon aria-hidden="true" />}
              disabled={!state[panel]}
              action={() => {
                open(panel);
              }}
            >
              {t(panel)}
            </ActionButton>
          );
        })}
      </div>
      {request ? (
        <AnnotationDialog
          key={request.panel}
          {...{ editor, labels, isCurrent }}
          panel={request.panel}
          target={request.target}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </TooltipProvider>
  );
}
