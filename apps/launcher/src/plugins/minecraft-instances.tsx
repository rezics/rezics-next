import type { Instance } from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useId, useState } from 'react';
import { Failure, Pending, useAction } from '../renderer/actions';
import { ConfirmAction } from '../renderer/confirm-action';
import type { DesktopApi } from '../shared/desktop';

export type InstanceActionsApi = Pick<DesktopApi, 'renameMinecraft' | 'duplicateMinecraft' | 'archiveMinecraft'>;

export function MinecraftInstanceActions({
  api,
  instance,
  running,
  refresh,
  openInstance,
  openArchive,
}: {
  api: InstanceActionsApi;
  instance: Instance;
  running: boolean;
  refresh: () => void;
  openInstance: (value: Instance) => void;
  openArchive: () => void;
}) {
  const id = useId();
  const [nameDraft, setNameDraft] = useState<string>();
  const [copyNameDraft, setCopyNameDraft] = useState<string>();
  const [copyWorlds, setCopyWorlds] = useState(false);
  const action = useAction();
  const name = nameDraft ?? instance.name;
  const copyName = copyNameDraft ?? `${instance.name.slice(0, 115)} copy`;
  const disabled = running || action.pending;
  return (
    <section className="section stack" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Manage instance</h2>
      {running && <p className="muted">Close Minecraft to change this instance.</p>}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !name.trim() || name.trim() === instance.name) return;
          void action.run(async () => {
            const renamed = await api.renameMinecraft(instance.id, name.trim());
            setNameDraft(renamed.name);
            refresh();
          });
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Instance name</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </Field>
        <div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={disabled || !name.trim() || name.trim() === instance.name}
          >
            Rename
          </Button>
        </div>
      </form>
      <form
        className="stack border-t pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !copyName.trim()) return;
          void action.run(async () =>
            openInstance(await api.duplicateMinecraft(instance.id, copyName.trim(), copyWorlds)),
          );
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-copy`}>Copy name</FieldLabel>
          <Input
            id={`${id}-copy`}
            value={copyName}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => setCopyNameDraft(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox id={`${id}-worlds`} checked={copyWorlds} disabled={disabled} onCheckedChange={setCopyWorlds} />
          <FieldLabel htmlFor={`${id}-worlds`}>Copy current worlds</FieldLabel>
        </Field>
        <div>
          <Button type="submit" variant="outline" size="sm" disabled={disabled || !copyName.trim()}>
            Duplicate instance
          </Button>
        </div>
      </form>
      <Failure error={action.error} />
      {action.pending && <Pending>Updating instance…</Pending>}
      <div className="border-t pt-3">
        <ConfirmAction
          label="Archive instance"
          title={`Archive ${instance.name}?`}
          description="The instance, its worlds and backup history will stay in the local archive. You can restore it from the library."
          disabled={disabled}
          confirm={async () => {
            await api.archiveMinecraft(instance.id);
            refresh();
            openArchive();
          }}
        />
      </div>
    </section>
  );
}
