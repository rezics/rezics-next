import { VIEWS, type PresentationProfile, type View } from '@rezics/composition';
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
import { viewOf, type CompanionViewSource, type Template } from './curate';
import type { ViewSelection } from './curate-view-editor-state';

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
  const [view, setView] = useState<View | ''>('');
  const [source, setSource] = useState<CompanionViewSource | ''>('');
  const [resetting, setResetting] = useState<View | null>(null);
  const template: Template = selection.template;
  const availableViews =
    template.scope === 'route'
      ? []
      : VIEWS.filter((candidate) => candidate !== 'overview' && viewOf(profile, template, candidate) === undefined);
  const hasOverview = viewOf(profile, template, 'overview') !== undefined;
  const canReset =
    template.scope !== 'route' &&
    selection.view !== 'overview' &&
    viewOf(profile, template, selection.view) !== undefined;

  if (template.scope === 'route' || (availableViews.length === 0 && !canReset)) return null;

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
              value={view}
              disabled={disabled}
              onChange={(event) => {
                const candidate = availableViews.find((item) => item === event.target.value);
                if (candidate) setView(candidate);
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
              value={source}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value === 'overview' || event.target.value === 'empty') setSource(event.target.value);
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
            disabled={disabled || !view || !source || (source === 'overview' && !hasOverview)}
            onClick={() => {
              if (!view || !source || (source === 'overview' && !hasOverview)) return;
              onAdd(view, source);
              setView('');
              setSource('');
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
          onClick={() => setResetting(selection.view)}
        >
          {m.curation_companion_reset()}
        </Button>
      )}
      <AlertDialog open={resetting !== null} onOpenChange={(open) => !open && setResetting(null)}>
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
              disabled={disabled}
              onClick={() => {
                if (!resetting) return;
                onReset(resetting);
                setResetting(null);
                setView('');
                setSource('');
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
