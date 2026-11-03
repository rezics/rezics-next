import type { PresentationProfile, View } from '@rezics/composition';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { overviewOf, type CompanionViewSource } from './curate';
import type { ViewSelection } from './curate-view-editor-state';
import { presentationMessageOptions } from './curate-view-editor-messages';
import {
  admitCompanionAdd,
  admitCompanionReset,
  availableCompanionViews,
  canResetCompanionView,
  companionResetIntent,
  emptyCompanionAdd,
  type CompanionAddChoice,
  type CompanionResetIntent,
} from './curation-companion-state';

const controlClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';
const selectClass = 'w-full min-w-0 max-w-full [&_select]:min-h-11';

type CompanionViewControlsProps = {
  profile: PresentationProfile;
  selection: ViewSelection;
  viewNames: Record<View, string>;
  disabled?: boolean;
  locale?: string | undefined;
  onAdd: (view: View, source: CompanionViewSource) => void;
  onReset: (view: View) => void;
};

export function CurationCompanionViews({
  profile,
  selection,
  viewNames,
  disabled = false,
  locale,
  onAdd,
  onReset,
}: CompanionViewControlsProps) {
  const options = presentationMessageOptions(locale);
  const id = useId();
  const [choice, setChoice] = useState<CompanionAddChoice>(emptyCompanionAdd);
  const [resetting, setResetting] = useState<CompanionResetIntent | null>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const restoreReset = useRef(true);
  const resetWasOpen = useRef(false);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const template = selection.template;
  const availableViews = availableCompanionViews(profile, template);
  const hasOverview = overviewOf(profile, template) !== undefined;
  const canReset = canResetCompanionView(profile, template, selection.view);
  const admitted = admitCompanionAdd(choice, profile, template);
  const admittedReset = admitCompanionReset(resetting, profile, template);
  if (resetting !== admittedReset) setResetting(admittedReset);
  useLayoutEffect(() => {
    if (admittedReset !== null) {
      resetWasOpen.current = true;
      return;
    }
    if (!resetWasOpen.current || !restoreReset.current) return;
    resetWasOpen.current = false;
    resetTrigger.current?.focus();
  }, [admittedReset]);

  if (template.scope === 'route' || (availableViews.length === 0 && !canReset && admittedReset === null)) return null;

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      aria-label={m.curation_companion_views({}, options)}
    >
      <div className="space-y-1">
        <h3 className="font-medium">{m.curation_companion_views({}, options)}</h3>
        <p className="text-sm text-muted-foreground">{m.curation_companion_views_help({}, options)}</p>
      </div>
      {availableViews.length > 0 && (
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field className="min-w-0">
            <FieldLabel htmlFor={`${id}-view`}>{m.curation_companion_view({}, options)}</FieldLabel>
            <NativeSelect
              id={`${id}-view`}
              className={selectClass}
              value={admitted.view}
              disabled={disabled}
              onChange={(event) => {
                const view = availableViews.find((item) => item === event.target.value);
                if (view) setChoice((current) => ({ ...current, view }));
              }}
            >
              <NativeSelectOption value="" disabled>
                {m.curation_companion_choose_view({}, options)}
              </NativeSelectOption>
              {availableViews.map((candidate) => (
                <NativeSelectOption key={candidate} value={candidate}>
                  {viewNames[candidate]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor={`${id}-source`}>{m.curation_companion_source({}, options)}</FieldLabel>
            <NativeSelect
              id={`${id}-source`}
              className={selectClass}
              value={admitted.source}
              disabled={disabled}
              onChange={(event) => {
                const source = event.target.value;
                if (source === 'overview' || source === 'empty') setChoice((current) => ({ ...current, source }));
              }}
            >
              <NativeSelectOption value="" disabled>
                {m.curation_companion_choose_source({}, options)}
              </NativeSelectOption>
              {hasOverview && (
                <NativeSelectOption value="overview">
                  {m.curation_companion_source_overview({}, options)}
                </NativeSelectOption>
              )}
              <NativeSelectOption value="empty">{m.curation_companion_source_empty({}, options)}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Button
            className={controlClass}
            type="button"
            variant="outline"
            disabled={disabled || admitted.view === '' || admitted.source === ''}
            onClick={() => {
              if (admitted.view === '' || admitted.source === '') return;
              onAdd(admitted.view, admitted.source);
              setChoice(emptyCompanionAdd);
            }}
          >
            {m.curation_companion_add({}, options)}
          </Button>
        </div>
      )}
      {canReset && (
        <Button
          ref={resetTrigger}
          className={controlClass}
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            restoreReset.current = true;
            setResetting(companionResetIntent(profile, template, selection.view));
          }}
        >
          {m.curation_companion_reset({}, options)}
        </Button>
      )}
      <AlertDialog open={admittedReset !== null} onOpenChange={(open) => !open && setResetting(null)}>
        <AlertDialogContent
          initialFocus={resetCancel}
          finalFocus={() => (restoreReset.current && resetTrigger.current?.isConnected ? resetTrigger.current : false)}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{m.curation_companion_reset_title({}, options)}</AlertDialogTitle>
            <AlertDialogDescription>{m.curation_companion_reset_description({}, options)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={resetCancel} className={controlClass}>
              {m.curation_companion_reset_cancel({}, options)}
            </AlertDialogCancel>
            <AlertDialogAction
              className={controlClass}
              variant="destructive"
              disabled={disabled || admittedReset === null}
              onClick={() => {
                if (!admittedReset) return;
                restoreReset.current = false;
                onReset(admittedReset.view);
                setResetting(null);
                setChoice(emptyCompanionAdd);
              }}
            >
              {m.curation_companion_reset_confirm({}, options)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
