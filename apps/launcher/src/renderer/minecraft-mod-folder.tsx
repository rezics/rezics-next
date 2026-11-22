import type { MinecraftModFolder, MinecraftModFolderFile } from '@rezics/launcher-contract';
import { MetaLine } from '@rezics/ui/meta-line';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Failure, Pending, useAction } from './actions';

const ownerLabel = { launcher: 'Launcher', pack: 'Modpack', manual: 'Manual file' } as const;
const stateLabel = { active: 'Active', disabled: 'Disabled', ignored: 'Ignored by Fabric' } as const;

export function MinecraftModFolderPanel({
  folder,
  error,
  pending,
  running,
  rescan,
  open,
  setEnabled,
}: {
  folder: MinecraftModFolder | null | undefined;
  error: string | undefined;
  pending: boolean;
  running: boolean;
  rescan: () => void;
  open: () => Promise<void>;
  setEnabled: (name: string, enabled: boolean, revision: string) => Promise<{ name: string; enabled: boolean }>;
}) {
  const action = useAction();
  const rescanButton = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState('');
  const files = folder?.files.filter(({ owner }) => owner !== 'launcher') ?? [];
  const byName = new Map(folder?.files.map((file) => [file.name, file]));

  function toggle(file: MinecraftModFolderFile | undefined) {
    if (!file?.revision) return null;
    const { name, revision } = file;
    const enabled = file.state === 'disabled';
    const label = enabled ? 'Enable' : 'Disable';
    return (
      <Button
        size="sm"
        variant="outline"
        aria-label={`${label} ${name}`}
        disabled={running || pending || action.pending}
        onClick={() =>
          void action.run(async () => {
            setMessage('');
            try {
              const result = await setEnabled(name, enabled, revision);
              setMessage(`${result.enabled ? 'Enabled' : 'Disabled'} ${result.name}.`);
            } finally {
              rescanButton.current?.focus();
              rescan();
            }
          })
        }
      >
        {label}
      </Button>
    );
  }

  return (
    <section className="section stack" aria-labelledby="mod-folder-heading">
      <header className="section-heading">
        <h2 id="mod-folder-heading">Mods folder</h2>
        <div className="actions">
          <Button variant="outline" disabled={!folder?.exists || action.pending} onClick={() => void action.run(open)}>
            <FolderOpen aria-hidden="true" data-icon="inline-start" /> Open mods folder
          </Button>
          <Button
            ref={rescanButton}
            variant="ghost"
            aria-disabled={pending}
            onClick={() => {
              if (!pending) rescan();
            }}
          >
            Rescan files
          </Button>
        </div>
      </header>
      {pending && <Pending>Checking mod files…</Pending>}
      <Failure error={error} retry={rescan} />
      <Failure error={action.error} />
      {message && (
        <p role="status" className="muted wrap-anywhere">
          {message}
        </p>
      )}
      {running && files.some(({ revision }) => revision) && (
        <p className="muted">Close the game to change manual mod files.</p>
      )}
      {!error && folder && folder.duplicates.length > 0 && (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Repeated mod IDs</AlertTitle>
          <AlertDescription className="min-w-0 text-wrap">
            <ul className="grid gap-3 wrap-anywhere" aria-label="Repeated mod IDs">
              {folder.duplicates.map(({ id, files: duplicates }) => (
                <li key={id}>
                  <strong>{id}</strong>
                  <ul className="grid gap-1">
                    {duplicates.map((name) => {
                      const file = byName.get(name);
                      return (
                        <li key={name} className="flex flex-wrap items-center gap-x-2">
                          <code>{name}</code>
                          {file && <span>{ownerLabel[file.owner]}</span>}
                          {toggle(file)}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {!pending && !error && folder?.files.length === 0 && <p className="muted">No mod JARs found.</p>}
      {!error && files.length > 0 && (
        <details>
          <summary>Pack and manual files ({files.length})</summary>
          <ul className="rows mt-2" aria-label="Pack and manual mod files">
            {files.map((file) => (
              <ModFolderRow key={file.name} file={file} action={toggle(file)} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ModFolderRow({ file, action }: { file: MinecraftModFolderFile; action: ReactNode }) {
  return (
    <li className="row-item">
      <div className="row-content">
        <div className="row-text">
          <strong>{file.status === 'identified' ? file.title : file.name}</strong>
          {file.status === 'identified' && (
            <>
              <code className="muted">{file.name}</code>
              <MetaLine className="muted" items={[file.version, ...file.ids]} />
            </>
          )}
          <div className="actions">
            <Badge variant="outline">{ownerLabel[file.owner]}</Badge>
            <Badge variant="outline">{stateLabel[file.state]}</Badge>
            {file.status !== 'identified' && (
              <span className="muted">{file.status === 'linked' ? 'Linked file' : 'Mod metadata unavailable'}</span>
            )}
          </div>
        </div>
        {action}
      </div>
    </li>
  );
}
