import type { Instance, LocalInstanceInput } from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import type { FormEvent } from 'react';
import { useCallback, useId, useState } from 'react';
import { bundledLocalImports, type LocalImportOptions, type LocalImportPaths } from '../plugins/builtin-plugins';
import type { DesktopApi, Picker } from '../shared/desktop';
import { Failure, Pending, useAction } from './actions';
import { InstanceNameField, InstanceSubjectField, PathField } from './instance-fields';

const gameKinds = [
  ...bundledLocalImports.map(({ kind, label }) => ({ value: kind, label })),
  { value: 'local', label: 'Other local game' },
] as const;

export function ImportGame({
  api,
  done,
  cancel,
}: {
  api: DesktopApi;
  done: (instance: Instance) => void;
  cancel: () => void;
}) {
  const fields = useId();
  const [name, setName] = useState('');
  const [kindOfGame, setKindOfGame] = useState<LocalInstanceInput['kind']>(gameKinds[0]?.value ?? 'local');
  const [paths, setPaths] = useState<LocalImportPaths>({});
  const [options, setOptions] = useState<LocalImportOptions>({});
  const [subjectId, setSubjectId] = useState('');
  const [showBatch, setShowBatch] = useState(false);
  const action = useAction();
  const { executable } = paths;
  const localImport = bundledLocalImports.find(({ kind }) => kind === kindOfGame);
  const ImportFields = localImport?.Fields;
  const suggestName = useCallback(
    (title?: string) => {
      if (executable) setName((previous) => previous || title || executableName(executable));
    },
    [executable],
  );

  function pick(field: Picker) {
    void action.run(async () => {
      const value = await api.pickPath(field);
      if (!value) return;
      setPaths((previous) => ({ ...previous, [field]: value }));
      if (field === 'executable' && kindOfGame === 'local') {
        setName((previous) => previous || executableName(value));
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void action.run(async () => {
      const subject = subjectId.trim() || undefined;
      if (!paths.executable) throw new Error('Choose the game executable first.');
      const input: LocalInstanceInput = {
        kind: kindOfGame,
        name: name.trim(),
        executable: paths.executable,
        ...(paths.workingDirectory && { workingDirectory: paths.workingDirectory }),
        ...(paths.saveDirectory && { saveDirectory: paths.saveDirectory }),
        ...localImport?.instanceOptions(options, paths),
        ...(subject && { subjectId: subject }),
      };
      done(await api.importInstance(input));
    });
  }

  const batch = localImport?.batch;
  if (showBatch && batch) {
    return <batch.Component api={api} back={() => setShowBatch(false)} done={cancel} />;
  }

  return (
    <section className="form-panel" aria-labelledby="create-heading">
      <header className="section-heading">
        <h1 id="create-heading">Import a game</h1>
        {batch && (
          <Button variant="outline" disabled={action.pending} onClick={() => setShowBatch(true)}>
            {batch.label}
          </Button>
        )}
      </header>
      <form className="form" onSubmit={submit}>
        <FieldGroup>
          <InstanceNameField id={fields + '-name'} value={name} change={setName} disabled={action.pending} />
          <Field data-disabled={action.pending || undefined}>
            <FieldLabel htmlFor={`${fields}-kind`}>Game type</FieldLabel>
            <Select
              items={gameKinds}
              name="kind"
              value={kindOfGame}
              disabled={action.pending}
              onValueChange={(value) => {
                if (!value || value === kindOfGame) return;
                setKindOfGame(value);
                setSubjectId('');
                if (value === 'local' && executable) setName((previous) => previous || executableName(executable));
              }}
            >
              <SelectTrigger id={`${fields}-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {gameKinds.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <PathField
            name="Game executable"
            path={paths.executable}
            disabled={action.pending}
            pick={() => pick('executable')}
          />
          <PathField
            name="Working folder (optional)"
            path={paths.workingDirectory}
            disabled={action.pending}
            pick={() => pick('workingDirectory')}
            clear={() => setPaths(({ workingDirectory: _, ...rest }) => rest)}
          />
          <PathField
            name="Save folder (optional)"
            path={paths.saveDirectory}
            disabled={action.pending}
            pick={() => pick('saveDirectory')}
            clear={() => setPaths(({ saveDirectory: _, ...rest }) => rest)}
          />
          {ImportFields ? (
            <ImportFields
              api={api}
              formId={fields}
              paths={paths}
              options={options}
              onOptionsChange={setOptions}
              subjectId={subjectId}
              onSubjectChange={setSubjectId}
              suggestName={suggestName}
              disabled={action.pending}
            />
          ) : (
            <InstanceSubjectField
              id={fields + '-subject'}
              value={subjectId}
              change={setSubjectId}
              disabled={action.pending}
            />
          )}
          <Failure error={action.error} />
          {action.pending && <Pending>Working…</Pending>}
          <div className="actions">
            <Button type="submit" disabled={action.pending || !name.trim() || !paths.executable}>
              Import game
            </Button>
            <Button type="button" variant="ghost" disabled={action.pending} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </FieldGroup>
      </form>
    </section>
  );
}

function executableName(path: string) {
  return (
    path
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.[^.]+$/, '') ?? ''
  );
}
