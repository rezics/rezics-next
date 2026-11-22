import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { DesktopApi, DesktopWorldPreview, WorldImportSource } from '../shared/desktop';
import { Failure, Pending, useAction } from './actions';

const numbers = new Intl.NumberFormat();

export function MinecraftWorldTransfers({
  api,
  instanceId,
  worldId,
  locked,
  imported,
}: {
  api: Pick<
    DesktopApi,
    | 'previewMinecraftWorld'
    | 'cancelMinecraftWorldTransfer'
    | 'discardMinecraftWorldPreview'
    | 'importMinecraftWorld'
    | 'exportMinecraftWorldArchive'
  >;
  instanceId: string;
  worldId: string | undefined;
  locked: boolean;
  imported: (id: string) => void;
}) {
  const id = useId();
  const [preview, setPreview] = useState<DesktopWorldPreview | null>(null);
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [transfer, setTransfer] = useState<{ id: string; cancelling: boolean }>();
  const action = useAction();
  const disabled = locked || action.pending;
  const token = preview?.token;
  const versionRisk = preview?.versionRisk;
  const canImport = !disabled && (!versionRisk || confirmed) && Boolean(name.trim());
  useEffect(
    () => () => {
      if (token) void api.discardMinecraftWorldPreview(token).catch(() => {});
    },
    [api, token],
  );

  function transferWorld(work: (attemptId: string) => Promise<void>) {
    void action.run(async () => {
      const attemptId = crypto.randomUUID();
      setMessage('');
      setTransfer({ id: attemptId, cancelling: false });
      try {
        await work(attemptId);
      } finally {
        setTransfer(undefined);
      }
    });
  }

  function cancelTransfer() {
    if (!transfer || transfer.cancelling) return;
    const { id } = transfer;
    setTransfer({ id, cancelling: true });
    void api.cancelMinecraftWorldTransfer(id).catch(() => {
      setTransfer((current) => (current?.id === id ? { id, cancelling: false } : current));
      setMessage('Could not request cancellation.');
    });
  }

  function choose(kind: WorldImportSource) {
    transferWorld(async (attemptId) => {
      const selected = await api.previewMinecraftWorld(instanceId, kind, attemptId);
      setConfirmed(false);
      setPreview(selected);
      if (selected) setName(selected.world.name);
    });
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || !canImport) return;
    transferWorld(async (attemptId) => {
      const result = await api.importMinecraftWorld(preview.token, name.trim(), confirmed, attemptId);
      if (!result) {
        setMessage('World import cancelled.');
        return;
      }
      imported(result.id);
      setPreview(null);
      setMessage(`Imported ${result.name}.`);
    });
  }

  return (
    <section className="stack" aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold">
        World transfer
      </h3>
      <div className="actions">
        <Button variant="outline" disabled={disabled} onClick={() => choose('folder')}>
          Preview world folder
        </Button>
        <Button variant="outline" disabled={disabled} onClick={() => choose('zip')}>
          Preview world ZIP
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !worldId}
          onClick={() => {
            if (!worldId) return;
            transferWorld(async (attemptId) => {
              const path = await api.exportMinecraftWorldArchive(instanceId, worldId, attemptId);
              if (path) setMessage(`World exported to ${path}`);
            });
          }}
        >
          Export selected world
        </Button>
      </div>
      {!worldId && <p className="muted">Choose a world above to export it.</p>}
      {preview && (
        <form className="stack" onSubmit={confirm}>
          <p className="muted">
            {numbers.format(preview.world.files)} files · {numbers.format(preview.world.bytes)} bytes
            {!versionRisk && preview.world.minecraftVersion && ` · Minecraft ${preview.world.minecraftVersion}`}
          </p>
          {versionRisk && (
            <Alert>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>World saved in Minecraft {versionRisk.worldVersion}</AlertTitle>
              <AlertDescription id={id + '-version-risk'}>
                Opening this copy in Minecraft {versionRisk.targetVersion} can damage it.
              </AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor={id + '-folder'}>World folder name</FieldLabel>
            <Input
              id={id + '-folder'}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              disabled={disabled}
            />
          </Field>
          {versionRisk && (
            <Field orientation="horizontal">
              <Checkbox
                id={id + '-confirm-version'}
                checked={confirmed}
                onCheckedChange={setConfirmed}
                disabled={disabled}
                aria-describedby={id + '-version-risk'}
              />
              <FieldLabel htmlFor={id + '-confirm-version'}>Import a copy anyway</FieldLabel>
            </Field>
          )}
          <div className="actions">
            <Button type="submit" disabled={!canImport}>
              Import world
            </Button>
            <Button type="button" variant="ghost" disabled={action.pending} onClick={() => setPreview(null)}>
              Cancel preview
            </Button>
          </div>
        </form>
      )}
      {transfer && (
        <div className="actions">
          <Pending>{transfer.cancelling ? 'Cancelling the world transfer…' : 'Working on the world transfer…'}</Pending>
          <Button type="button" variant="outline" disabled={transfer.cancelling} onClick={cancelTransfer}>
            Cancel transfer
          </Button>
        </div>
      )}
      <Failure error={action.error} />
      {message && (
        <p role="status" className="[overflow-wrap:anywhere]">
          {message}
        </p>
      )}
    </section>
  );
}
