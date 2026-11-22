import { EmptyState } from '@rezics/ui/empty-state';
import { MetaLine } from '@rezics/ui/meta-line';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { ArrowLeft, FolderOpen } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Failure, Pending, useAction } from '../renderer/actions';
import type { DesktopApi, DesktopVisualNovelScan, VisualNovelBatchResult } from '../shared/desktop';

type ScanApi = Pick<DesktopApi, 'scanVisualNovelFolder' | 'discardVisualNovelScan' | 'importScannedVisualNovels'>;
type Installation = DesktopVisualNovelScan['installations'][number];

export function VisualNovelFolderImport({ api, back, done }: { api: ScanApi; back: () => void; done: () => void }) {
  const [request] = useState(() => crypto.randomUUID());
  const [scan, setScan] = useState<DesktopVisualNovelScan>();
  const [selection, setSelection] = useState(() => new Map<string, number>());
  const [outcomes, setOutcomes] = useState(() => new Map<string, VisualNovelBatchResult>());
  const heading = useRef<HTMLHeadingElement>(null);
  const scanning = useAction();
  const importing = useAction();
  const pending = scanning.pending || importing.pending;

  useEffect(() => {
    heading.current?.focus();
    return () => {
      void api.discardVisualNovelScan(request).catch(() => {});
    };
  }, [api, request]);

  function chooseFolder() {
    void scanning.run(async () => {
      const found = await api.scanVisualNovelFolder(request);
      if (!found) return;
      const defaults = new Map<string, number>();
      for (const installation of found.installations) {
        const recommended = installation.candidates.find(
          ({ executable }) => executable === installation.recommendedExecutable,
        );
        if (recommended) defaults.set(installation.directory, recommended.id);
      }
      setScan(found);
      setSelection(defaults);
      setOutcomes(new Map());
    });
  }

  function choose(directory: string, id: number | undefined) {
    setSelection((previous) => {
      const next = new Map(previous);
      if (id === undefined) next.delete(directory);
      else next.set(directory, id);
      return next;
    });
  }

  function importSelection() {
    if (!scan) return;
    const { token } = scan;
    const chosen = [...selection];
    void importing.run(async () => {
      const results = await api.importScannedVisualNovels(
        token,
        chosen.map(([, id]) => id),
      );
      const completed: string[] = [];
      const received = new Map<string, VisualNovelBatchResult>();
      for (const result of results) {
        const directory = chosen[result.index]?.[0];
        if (directory === undefined) continue;
        received.set(directory, result);
        if (result.status === 'imported' || result.status === 'existing' || result.status === 'archived') {
          completed.push(directory);
        }
      }
      setOutcomes((previous) => new Map([...previous, ...received]));
      setSelection((previous) => {
        const next = new Map(previous);
        for (const directory of completed) next.delete(directory);
        return next;
      });
    });
  }

  const imported = [...outcomes.values()].filter(({ status }) => status === 'imported').length;
  return (
    <section className="section stack" aria-labelledby="scan-heading">
      <header className="section-heading">
        <h1 id="scan-heading" ref={heading} tabIndex={-1}>
          Import visual novels
        </h1>
        <Button variant="ghost" onClick={back} disabled={pending}>
          <ArrowLeft data-icon="inline-start" aria-hidden="true" /> Single game import
        </Button>
      </header>
      <div className="actions">
        <Button variant="outline" disabled={pending} onClick={chooseFolder}>
          <FolderOpen data-icon="inline-start" aria-hidden="true" /> Choose folder
        </Button>
        {scan && <span className="muted [overflow-wrap:anywhere]">{scan.root}</span>}
      </div>
      {scanning.pending && <Pending>Scanning for visual novels…</Pending>}
      <Failure error={scanning.error} />
      {scan?.errors.length ? (
        <details>
          <summary>
            {scan.errors.length} scan {scan.errors.length === 1 ? 'issue' : 'issues'}
          </summary>
          <ul className="mt-2 grid gap-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {scan.errors.map(({ path, message }, index) => (
              <li key={`${path}:${index}`}>
                {path} · {message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {scan?.installations.length === 0 && (
        <EmptyState
          icon={<FolderOpen />}
          title="No game executables found"
          description="Choose another folder or import a game manually."
        />
      )}
      {scan && scan.installations.length > 0 && (
        <ul className="rows" aria-label="Discovered game folders">
          {scan.installations.map((installation) => (
            <FolderRow
              key={installation.directory}
              installation={installation}
              path={installation.directory.slice(scan.root.length).replace(/^[\\/]/u, '')}
              selected={selection.get(installation.directory)}
              outcome={outcomes.get(installation.directory)}
              disabled={pending}
              choose={(id) => choose(installation.directory, id)}
            />
          ))}
        </ul>
      )}
      <div className="actions sticky bottom-0 border-t bg-card py-3">
        {!!scan?.installations.length && (
          <Button disabled={pending || !selection.size} onClick={importSelection}>
            Import selected ({selection.size})
          </Button>
        )}
        <Button variant="outline" onClick={done} disabled={pending}>
          Back to Installed
        </Button>
        {importing.pending && <Pending>Importing selected games…</Pending>}
        {imported > 0 && (
          <span role="status">
            {imported} {imported === 1 ? 'game' : 'games'} imported
          </span>
        )}
      </div>
      <Failure error={importing.error} />
    </section>
  );
}

function FolderRow({
  installation,
  path,
  selected,
  outcome,
  disabled,
  choose,
}: {
  installation: Installation;
  path: string;
  selected: number | undefined;
  outcome: VisualNovelBatchResult | undefined;
  disabled: boolean;
  choose: (id: number | undefined) => void;
}) {
  const control = useId();
  const choices = scanChoices(installation);
  const registration =
    installation.candidates.find(({ instance, archived }) => instance && !archived) ??
    installation.candidates.find(({ instance }) => instance);
  const registered = outcome && 'instance' in outcome ? outcome.instance : registration?.instance;
  const archived = outcome && 'instance' in outcome ? outcome.status === 'archived' : registration?.archived;
  const selectedCandidate = choices.find(({ id }) => id === selected);
  const active = selectedCandidate ?? choices[0];
  const title = registered?.name ?? active?.metadata.title ?? basename(installation.directory);
  const metadata = active?.metadata;
  const items = [
    { value: 'skip', label: 'Skip' },
    ...choices.map(({ id, executable }) => ({ value: String(id), label: basename(executable) })),
  ];
  return (
    <li className="row-item grid gap-2 p-3 [overflow-wrap:anywhere]">
      <div className="actions">
        <h3>{title}</h3>
        {registered && <Badge variant="secondary">{archived ? 'Archived' : 'Installed'}</Badge>}
      </div>
      {path && path !== title && <p className="muted">{path}</p>}
      {metadata && (
        <MetaLine
          items={[
            metadata.engine === 'renpy' ? 'Ren’Py' : 'KiriKiri',
            metadata.version,
            (choices.length === 1 || selectedCandidate) && active && basename(active.executable),
          ]}
        />
      )}
      {!registered &&
        (choices.length === 1 && active ? (
          <Field orientation="horizontal" data-disabled={disabled || undefined}>
            <Checkbox
              id={control}
              checked={selected === active.id}
              disabled={disabled}
              onCheckedChange={(checked) => choose(checked ? active.id : undefined)}
            />
            <FieldLabel htmlFor={control}>Import {title}</FieldLabel>
          </Field>
        ) : choices.length > 1 ? (
          <Field data-disabled={disabled || undefined}>
            <FieldLabel htmlFor={control}>Executable for {title}</FieldLabel>
            <Select
              items={items}
              value={selected === undefined ? 'skip' : String(selected)}
              disabled={disabled}
              onValueChange={(value) => choose(!value || value === 'skip' ? undefined : Number(value))}
            >
              <SelectTrigger id={control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {items.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <p className="muted">
            {installation.candidates.some(({ metadata }) => metadata.engine !== 'unknown')
              ? 'No detected executable for this platform.'
              : 'No supported engine detected. Use single game import.'}
          </p>
        ))}
      {outcome?.status === 'error' && <Failure error={outcome.message} />}
    </li>
  );
}

function scanChoices(installation: Installation) {
  return installation.candidates.filter(
    ({ metadata, platformMatch }) => platformMatch && metadata.engine !== 'unknown',
  );
}

function basename(path: string) {
  return path.split(/[\\/]/u).at(-1) || path;
}
