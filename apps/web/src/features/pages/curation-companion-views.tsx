import type { PresentationProfile, View } from '@rezics/composition';
import { useId, useState } from 'react';
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

type CompanionViewControlsProps = {
  profile: PresentationProfile;
  selection: ViewSelection;
  viewNames: Record<View, string>;
  disabled?: boolean;
  onAdd: (view: View, source: CompanionViewSource) => void;
  onReset: (view: View) => void;
};

export function CurationCompanionViews({
  profile,
  selection,
  viewNames,
  disabled = false,
  onAdd,
  onReset,
}: CompanionViewControlsProps) {
  const id = useId();
  const [choice, setChoice] = useState<CompanionAddChoice>(emptyCompanionAdd);
  const [resetting, setResetting] = useState<CompanionResetIntent | null>(null);
  const template = selection.template;
  const availableViews = availableCompanionViews(profile, template);
  const hasOverview = overviewOf(profile, template) !== undefined;
  const canReset = canResetCompanionView(profile, template, selection.view);
  const admitted = admitCompanionAdd(choice, profile, template);
  const admittedReset = admitCompanionReset(resetting, profile, template);
  if (resetting !== admittedReset) setResetting(admittedReset);

  if (template.scope === 'route' || (availableViews.length === 0 && !canReset && admittedReset === null)) return null;

  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label={m.curation_companion_views()}>
      <div className="space-y-1">
        <h3 className="font-medium">{m.curation_companion_views()}</h3>
        <p className="text-sm text-muted-foreground">{m.curation_companion_views_help()}</p>
      </div>
      {availableViews.length > 0 && (
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field className="min-w-0">
            <FieldLabel htmlFor={`${id}-view`}>{m.curation_companion_view()}</FieldLabel>
            <NativeSelect
              id={`${id}-view`}
              className="w-full min-w-0 max-w-full"
              value={admitted.view}
              disabled={disabled}
              onChange={(event) => {
                const view = availableViews.find((item) => item === event.target.value);
                if (view) setChoice((current) => ({ ...current, view }));
              }}
            >
              <NativeSelectOption value="" disabled>
                {m.curation_companion_choose_view()}
              </NativeSelectOption>
              {availableViews.map((candidate) => (
                <NativeSelectOption key={candidate} value={candidate}>
                  {viewNames[candidate]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor={`${id}-source`}>{m.curation_companion_source()}</FieldLabel>
            <NativeSelect
              id={`${id}-source`}
              className="w-full min-w-0 max-w-full"
              value={admitted.source}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value === 'overview' || event.target.value === 'empty')
                  setChoice((current) => ({ ...current, source: event.target.value }));
              }}
            >
              <NativeSelectOption value="" disabled>
                {m.curation_companion_choose_source()}
              </NativeSelectOption>
              {hasOverview && (
                <NativeSelectOption value="overview">{m.curation_companion_source_overview()}</NativeSelectOption>
              )}
              <NativeSelectOption value="empty">{m.curation_companion_source_empty()}</NativeSelectOption>
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
            {m.curation_companion_add()}
          </Button>
        </div>
      )}
      {canReset && (
        <Button
          className={controlClass}
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => setResetting(companionResetIntent(profile, template, selection.view))}
        >
          {m.curation_companion_reset()}
        </Button>
      )}
      <AlertDialog open={admittedReset !== null} onOpenChange={(open) => !open && setResetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.curation_companion_reset_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.curation_companion_reset_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={controlClass}>{m.curation_companion_reset_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className={controlClass}
              variant="destructive"
              disabled={disabled || admittedReset === null}
              onClick={() => {
                if (!admittedReset) return;
                onReset(admittedReset.view);
                setResetting(null);
                setChoice(emptyCompanionAdd);
              }}
            >
              {m.curation_companion_reset_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
