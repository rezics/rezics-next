import type { VisualNovelInspection } from '@rezics/launcher-contract';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Pending } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';
import type { LocalImportContribution, LocalImportFieldProps } from './builtin-plugins';
import { InspectionSummary } from './visual-novel-inspection';
import { VisualNovelFolderImport } from './visual-novel-folder-import';

export const VisualNovelSubjectPicker = lazy(async () => ({
  default: (await import('./visual-novel-association')).VisualNovelSubjectPicker,
}));

type ImportApi = Pick<
  DesktopApi,
  | 'inspectVisualNovel'
  | 'searchVisualNovelSubjects'
  | 'cancelVisualNovelSubjectSearch'
  | 'scanVisualNovelFolder'
  | 'discardVisualNovelScan'
  | 'importScannedVisualNovels'
>;
type Inspection = {
  executable: string;
  workingDirectory: string | undefined;
  report: VisualNovelInspection | null;
};

function VisualNovelImportFields({
  api,
  formId,
  paths: { executable, workingDirectory, saveDirectory },
  options,
  onOptionsChange,
  subjectId,
  onSubjectChange,
  suggestName,
  disabled,
}: LocalImportFieldProps<ImportApi>) {
  const [inspection, setInspection] = useState<Inspection>();
  const current =
    inspection?.executable === executable && inspection?.workingDirectory === workingDirectory ? inspection : undefined;

  useEffect(() => {
    if (!executable) return;
    let active = true;
    const path = executable;
    function settle(report: VisualNovelInspection | null) {
      if (!active) return;
      setInspection({ executable: path, workingDirectory, report });
      suggestName(report?.title);
    }
    void api
      .inspectVisualNovel({ executable, ...(workingDirectory && { workingDirectory }) })
      .then(settle, () => settle(null));
    return () => {
      active = false;
    };
  }, [api, executable, suggestName, workingDirectory]);

  return (
    <>
      {!saveDirectory && (current?.report?.engine !== 'kirikiri' || options.renpySaveName) && (
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={formId + '-save'}>Ren’Py save folder name (optional)</FieldLabel>
          <Input
            id={formId + '-save'}
            name="renpySaveName"
            value={options.renpySaveName ?? ''}
            placeholder={current?.report?.saveName}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => onOptionsChange({ renpySaveName: event.target.value })}
          />
        </Field>
      )}
      {executable && !current && <Pending>Inspecting the selected game…</Pending>}
      {current && (
        <InspectionSummary
          report={current.report}
          saveFolderOverride={saveDirectory ?? (options.renpySaveName?.trim() ? null : undefined)}
        />
      )}
      <Suspense fallback={<Pending>Loading REZICS search…</Pending>}>
        <VisualNovelSubjectPicker
          api={api}
          subjectId={subjectId}
          detectedTitle={current?.report?.title}
          change={onSubjectChange}
          disabled={disabled}
        />
      </Suspense>
    </>
  );
}

export const visualNovelImport = {
  label: 'Visual novel',
  Fields: VisualNovelImportFields,
  batch: { label: 'Scan a visual novel folder', Component: VisualNovelFolderImport },
  instanceOptions({ renpySaveName }, { saveDirectory }) {
    const name = renpySaveName?.trim();
    return !saveDirectory && name ? { renpySaveName: name } : {};
  },
} satisfies LocalImportContribution<ImportApi>;
