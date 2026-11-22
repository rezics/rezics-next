import {
  visualNovelPlugin,
  type Instance,
  type VisualNovelSettings,
  type VisualNovelSettingsPatch,
} from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { BookOpen } from 'lucide-react';
import { Suspense, useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Failure, Pending, useAction, useRemote } from '../renderer/actions';
import { InstanceNameField, PathField } from '../renderer/instance-fields';
import type { DesktopApi, Picker } from '../shared/desktop';
import { visualNovelImport, VisualNovelSubjectPicker } from './visual-novel-import';
import { InspectionSummary } from './visual-novel-inspection';

type SettingsApi = Pick<
  DesktopApi,
  | 'pickPath'
  | 'readVisualNovelSettings'
  | 'updateVisualNovelSettings'
  | 'searchVisualNovelSubjects'
  | 'cancelVisualNovelSubjectSearch'
  | 'readLinkedVisualNovelSubject'
  | 'onInstalledChanged'
>;

type ReadSettingsApi = Pick<SettingsApi, 'readVisualNovelSettings' | 'onInstalledChanged'>;

function useVisualNovelSettings(api: ReadSettingsApi, id: string) {
  const remote = useRemote(useCallback(() => api.readVisualNovelSettings(id), [api, id]));
  const reload = remote.reload;
  useEffect(() => api.onInstalledChanged(reload), [api, reload]);
  return remote;
}

function VisualNovelOverview({
  api,
  instance,
  selectPanel,
}: {
  api: ReadSettingsApi;
  instance: Instance;
  selectPanel: (panel: string, focus: string) => void;
}) {
  const info = useVisualNovelSettings(api, instance.id);
  return (
    <section className="section stack" aria-labelledby="vn-installation">
      <div className="section-heading">
        <h2 id="vn-installation">Local installation</h2>
        <Button size="sm" variant="outline" onClick={() => selectPanel('settings', 'game-panel-settings')}>
          Edit settings
        </Button>
      </div>
      {info.pending && <Pending>Inspecting the installation…</Pending>}
      <Failure error={info.error} retry={info.reload} />
      {info.data && <InspectionSummary report={info.data.metadata} saveFolderOverride={info.data.saveDirectory} />}
    </section>
  );
}

function VisualNovelSettingsPanel({
  api,
  instance,
  running,
  refresh,
}: {
  api: SettingsApi;
  instance: Instance;
  running: boolean;
  refresh: () => void;
}) {
  const id = useId();
  const remote = useVisualNovelSettings(api, instance.id);
  return (
    <section className="section stack" aria-labelledby={id}>
      <h2 id={id}>Visual novel settings</h2>
      {remote.pending && !remote.data && <Pending>Loading game settings…</Pending>}
      <Failure error={remote.error} retry={remote.reload} />
      {remote.data && (
        <VisualNovelForm
          key={instance.id}
          api={api}
          instance={instance.id}
          settings={remote.data}
          running={running}
          refresh={() => {
            remote.reload();
            refresh();
          }}
        />
      )}
    </section>
  );
}

function edited(value: string | null | undefined, saved: string | undefined) {
  return value === undefined ? saved : (value ?? undefined);
}

function VisualNovelForm({
  api,
  instance,
  settings,
  running,
  refresh,
}: {
  api: SettingsApi;
  instance: string;
  settings: VisualNovelSettings;
  running: boolean;
  refresh: () => void;
}) {
  const fields = useId();
  const [draft, setDraft] = useState<{ patch: VisualNovelSettingsPatch; revision: string }>();
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const stale = draft !== undefined && draft.revision !== settings.revision;
  const locked = running || action.pending || stale;
  const patch = draft?.patch ?? {};
  const name = patch.name ?? settings.name;
  const work = edited(patch.workingDirectory, settings.workingDirectory);
  const save = edited(patch.saveDirectory, settings.saveDirectory);
  const saveName = edited(patch.renpySaveName, settings.renpySaveName) ?? '';
  const detectedSaveFolder =
    patch.executable === undefined && patch.workingDirectory === undefined && patch.renpySaveName === undefined
      ? (settings.metadata?.detectedSaveDirectory ?? settings.metadata?.gameSaveDirectory)
      : undefined;
  const subject = edited(patch.subjectId, settings.subjectId) ?? '';
  const savedSubject = settings.subjectId;
  const linked = useRemote(
    useCallback(
      () => (savedSubject ? api.readLinkedVisualNovelSubject(instance) : Promise.resolve(null)),
      [api, instance, savedSubject],
    ),
  );

  function update(change: VisualNovelSettingsPatch) {
    setSaved(false);
    setDraft((previous) => ({
      patch: { ...previous?.patch, ...change },
      revision: previous?.revision ?? settings.revision,
    }));
  }

  function pick(field: Picker) {
    void action.run(async () => {
      const value = await api.pickPath(field);
      if (value) update({ [field]: value });
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !draft) return;
    void action.run(async () => {
      try {
        await api.updateVisualNovelSettings(
          instance,
          {
            ...patch,
            ...(patch.renpySaveName !== undefined && { renpySaveName: patch.renpySaveName?.trim() || null }),
            ...(patch.subjectId !== undefined && { subjectId: patch.subjectId?.trim() || null }),
          },
          draft.revision,
        );
        setDraft(undefined);
        setSaved(true);
      } finally {
        refresh();
      }
    });
  }

  return (
    <form className="form" onSubmit={submit}>
      <FieldGroup>
        {running && (
          <p role="status" className="muted">
            Close the visual novel before changing its settings.
          </p>
        )}
        <InstanceNameField
          id={fields + '-name'}
          value={name}
          change={(value) => update({ name: value })}
          disabled={locked}
        />
        <PathField
          name="Game executable"
          path={patch.executable ?? settings.executable}
          disabled={locked}
          pick={() => pick('executable')}
        />
        <PathField
          name="Working folder (optional)"
          path={work}
          fallback="Game executable’s folder"
          disabled={locked}
          pick={() => pick('workingDirectory')}
          clear={() => update({ workingDirectory: null })}
        />
        <PathField
          name="Save folder (optional)"
          path={save}
          fallback={detectedSaveFolder ?? 'Detected save folders'}
          disabled={locked}
          pick={() => pick('saveDirectory')}
          clear={() => update({ saveDirectory: null })}
        />
        {!save && (settings.metadata?.engine !== 'kirikiri' || settings.renpySaveName) && (
          <Field>
            <FieldLabel htmlFor={fields + '-save'}>Ren’Py save folder name (optional)</FieldLabel>
            <Input
              id={fields + '-save'}
              maxLength={120}
              value={saveName}
              disabled={locked}
              placeholder={settings.metadata?.saveName}
              onChange={(event) => update({ renpySaveName: event.target.value || null })}
            />
          </Field>
        )}
        <p className="muted">
          Future backups and restores use these save settings. Earlier backups stay in Save history.
        </p>
        <Suspense fallback={<Pending>Loading REZICS search…</Pending>}>
          <VisualNovelSubjectPicker
            api={api}
            subjectId={subject}
            linkedSubject={linked.data ?? undefined}
            detectedTitle={settings.metadata?.title}
            change={(value) => update({ subjectId: value || null })}
            disabled={locked}
          />
        </Suspense>
        {subject && subject === savedSubject && (
          <>
            <Failure error={linked.error} retry={linked.reload} />
            {!linked.pending && linked.data === null && !linked.error && (
              <p className="muted">The saved REZICS link has no public visual novel title.</p>
            )}
          </>
        )}
        <Failure error={action.error} />
        {stale && (
          <Failure error="Settings changed while you were editing. Discard your draft to review the current settings." />
        )}
        {saved && <p role="status">Settings saved.</p>}
        <div className="actions">
          <Button type="submit" disabled={locked || !name.trim() || !Object.keys(patch).length}>
            Save settings
          </Button>
          {stale && (
            <Button type="button" variant="outline" onClick={() => setDraft(undefined)}>
              Discard draft
            </Button>
          )}
        </div>
      </FieldGroup>
    </form>
  );
}

export const visualNovelFrontend = {
  manifest: visualNovelPlugin,
  localImport: visualNovelImport,
  panels: {
    overview: { label: 'Overview', Component: VisualNovelOverview },
    settings: { label: 'Settings', Component: VisualNovelSettingsPanel },
  },
  instance: {
    Icon: BookOpen,
    canLaunch: () => true,
    metadata: () => ['Visual novel'],
  },
};
