'use client';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Code, Paintbrush, RotateCcw, Type } from 'lucide-react';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';
import type { RichTextEditorLabels } from './editor-labels.ts';
import type { EditorBehaviorAction } from './editor-behavior-actions.ts';
import { editorCommandsForPresentation } from './editor-command-preferences.ts';
import { formattingControlLabels, type FormattingControlLabels } from './editor-formatting-labels.ts';
import {
  applyAuthoredAlignment,
  applyAuthoredMark,
  applyCodeLanguage,
  captureFormattingTarget,
  mapFormattingTarget,
  type FormattingTarget,
} from './editor-formatting-commands.ts';
import { documentEmphasisShapes, wireColor, type DocumentAlignment } from './document-style.ts';
import { returnFocus } from './editor-menu-helpers.ts';

type Panel = 'textStyle' | 'textEmphasis' | 'codeLanguage';
function formattingAttributes(editor: Editor, panel: Panel): Record<string, string | undefined> {
  if (panel === 'codeLanguage') return {};
  const attributes = editor.getAttributes(panel);
  const result: Record<string, string | undefined> = {};
  for (const key of ['color', 'backgroundColor', 'shape', 'fill', 'position']) {
    const value: unknown = attributes[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}
const alignments = {
  alignLeft: 'left',
  alignCenter: 'center',
  alignRight: 'right',
  alignJustify: 'justify',
  alignDefault: null,
} as const;
function FormattingDialog({
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
  target: FormattingTarget;
  onClose: () => void;
}) {
  const t = (key: keyof FormattingControlLabels) => labels[key] ?? formattingControlLabels[key];
  const id = useId();
  const [initial] = useState(() => formattingAttributes(editor, panel));
  const [values, setValues] = useState<Record<string, string>>((): Record<string, string> =>
    panel === 'codeLanguage'
      ? { language: target.block.attrs.language ?? '' }
      : panel === 'textStyle'
        ? { color: initial.color ?? '', backgroundColor: initial.backgroundColor ?? '' }
        : {
            shape: initial.shape ?? 'dot',
            fill: initial.fill ?? 'filled',
            position: initial.position ?? 'over',
            color: initial.color ?? '',
          },
  );
  const saved = useRef<FormattingTarget | null>(target);
  const [failed, setFailed] = useState(false);
  const composing = useRef(false);
  const latest = useRef({ isCurrent, onClose });
  latest.current = { isCurrent, onClose };
  useLayoutEffect(() => {
    const update = ({ transaction }: { transaction: Transaction }) => {
      if (saved.current) saved.current = mapFormattingTarget(saved.current, transaction, editor);
      if (!saved.current) latest.current.onClose();
    };
    editor.on('transaction', update);
    return () => {
      saved.current = null;
      editor.off('transaction', update);
    };
  }, [editor]);
  const current = () =>
    latest.current.isCurrent() && !editor.isDestroyed && editor.isEditable && !editor.view.composing;
  const close = () => {
    saved.current = null;
    onClose();
    if (current()) returnFocus(editor, current)();
  };
  const valid =
    panel === 'codeLanguage' ||
    Object.entries(values).every(([key, value]) => !['color', 'backgroundColor'].includes(key) || wireColor(value));
  const run = (remove = false) => {
    const admitted = saved.current;
    if (!admitted || !current() || !valid || composing.current) return;
    saved.current = null;
    const patch = Object.fromEntries(
      Object.entries(values)
        .filter(([key, value]) => value !== (initial[key] ?? ''))
        .map(([key, value]) => [key, value || null]),
    );
    const changed =
      panel === 'codeLanguage'
        ? applyCodeLanguage(editor, admitted, remove ? '' : values.language!, current)
        : applyAuthoredMark(editor, admitted, panel, remove ? null : patch, current);
    if (changed) close();
    else {
      saved.current = admitted;
      setFailed(true);
    }
  };
  const color = (key: 'color' | 'backgroundColor', label: string) => (
    <Field data-invalid={!wireColor(values[key] ?? '')}>
      <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
      <Input
        id={`${id}-${key}`}
        value={values[key] ?? ''}
        placeholder="#2563eb"
        aria-invalid={!wireColor(values[key] ?? '')}
        onChange={(event) => setValues({ ...values, [key]: event.target.value })}
      />
      <FieldDescription>{t('colorHelp')}</FieldDescription>
    </Field>
  );
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
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          run();
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
          if (event.key === 'Enter' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'))
            event.stopPropagation();
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
        }}
      >
        <FieldGroup>
          {panel === 'textStyle' ? (
            <>
              {color('color', t('textColor'))}
              {color('backgroundColor', t('backgroundColor'))}
            </>
          ) : null}
          {panel === 'textEmphasis' ? (
            <>
              {(['shape', 'fill', 'position'] as const).map((key) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`${id}-${key}`}>
                    {t(key === 'shape' ? 'emphasisShape' : key === 'fill' ? 'emphasisFill' : 'emphasisPosition')}
                  </FieldLabel>
                  <NativeSelect
                    id={`${id}-${key}`}
                    value={values[key]}
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  >
                    {(key === 'shape'
                      ? documentEmphasisShapes
                      : key === 'fill'
                        ? ['filled', 'open']
                        : ['over', 'under']
                    ).map((value) => (
                      <NativeSelectOption key={value} value={value}>
                        {t(value as keyof FormattingControlLabels)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
              {color('color', t('emphasisColor'))}
            </>
          ) : null}
          {panel === 'codeLanguage' ? (
            <Field>
              <FieldLabel htmlFor={`${id}-language`}>{t('codeLanguageField')}</FieldLabel>
              <Textarea
                id={`${id}-language`}
                rows={2}
                value={values.language}
                autoFocus
                onChange={(event) => setValues({ language: event.target.value })}
              />
            </Field>
          ) : null}
        </FieldGroup>
        {!valid || failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t(!valid ? 'invalidColor' : 'cannotApply')}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {panel !== 'textStyle' ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-7 min-w-0 max-w-full whitespace-normal"
              onClick={() => run(true)}
            >
              {t(panel === 'codeLanguage' ? 'clearCodeLanguage' : 'removeEmphasis')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" className="h-auto min-h-7 min-w-0 max-w-full whitespace-normal" onClick={close}>
            {labels.cancel}
          </Button>
          <Button type="submit" disabled={!valid} className="h-auto min-h-7 min-w-0 max-w-full whitespace-normal">
            {labels.apply}
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  );
}

export function AuthorFormattingControls({
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
  const [request, setRequest] = useState<{ panel: Panel; target: FormattingTarget } | null>(null);
  const t = (key: keyof FormattingControlLabels) => labels[key] ?? formattingControlLabels[key];
  const ids = ['textStyle', 'textEmphasis', 'codeLanguage', ...Object.keys(alignments)] as const;
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const target = captureFormattingTarget(current);
      const hasText =
        !!target &&
        (target.selection.empty || target.content.content.textBetween(0, target.content.content.size, '', '') !== '');
      return {
        textStyle:
          hasText &&
          !!target &&
          !!current.schema.marks.textStyle &&
          target.block.type.allowsMarkType(current.schema.marks.textStyle),
        textEmphasis:
          hasText &&
          !!target &&
          !!current.schema.marks.textEmphasis &&
          target.block.type.allowsMarkType(current.schema.marks.textEmphasis),
        codeLanguage: target?.block.type.name === 'codeBlock',
        align: !!target && ['paragraph', 'heading'].includes(target.block.type.name),
        alignment: target?.block.attrs.textAlign,
        emphasisActive: current.isActive('textEmphasis'),
        styleActive: current.isActive('textStyle'),
        presented: editorCommandsForPresentation(
          ids.map((id) => ({ id })),
          current,
        ),
      };
    },
  });
  const run = (id: string): boolean => {
    if (!isCurrent()) return false;
    const target = captureFormattingTarget(editor);
    if (!target) return false;
    if (id in alignments)
      return applyAuthoredAlignment(
        editor,
        target,
        alignments[id as keyof typeof alignments] as DocumentAlignment | null,
        isCurrent,
      );
    const panel = id as Panel;
    if (!state[panel]) return false;
    setRequest({ panel, target });
    return true;
  };
  useLayoutEffect(() => {
    onCommands?.(
      ids.map((id) => ({
        id,
        label: t(id as keyof FormattingControlLabels),
        disabled: id in alignments ? !state.align : !state[id as Panel],
        run: () => run(id),
      })),
    );
    return () => onCommands?.([]);
  }, [editor, labels, isCurrent, onCommands, state.align, state.textStyle, state.textEmphasis, state.codeLanguage]);
  const icons = {
    textStyle: Paintbrush,
    textEmphasis: Type,
    codeLanguage: Code,
    alignLeft: AlignLeft,
    alignCenter: AlignCenter,
    alignRight: AlignRight,
    alignJustify: AlignJustify,
    alignDefault: RotateCcw,
  };
  if (!isCurrent()) return null;
  return (
    <TooltipProvider delay={600}>
      <div
        role="group"
        aria-label={t('authoredFormatting')}
        className="flex flex-wrap items-center gap-1"
        data-slot="editor-authored-formatting"
      >
        {state.presented.map(({ id }) => {
          const Icon = icons[id as keyof typeof icons];
          const alignment = id in alignments;
          const pressed = alignment
            ? (state.alignment ?? null) === alignments[id as keyof typeof alignments]
            : id === 'textStyle'
              ? state.styleActive
              : id === 'textEmphasis'
                ? state.emphasisActive
                : undefined;
          return (
            <ActionButton
              key={id}
              label={t(id as keyof FormattingControlLabels)}
              icon={<Icon aria-hidden="true" />}
              disabled={alignment ? !state.align : !state[id as Panel]}
              {...(pressed === undefined ? {} : { pressed })}
              action={() => {
                run(id);
              }}
            />
          );
        })}
      </div>
      {request ? (
        <FormattingDialog
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
