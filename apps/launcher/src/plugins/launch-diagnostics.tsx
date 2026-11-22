import { launchDiagnosticsPlugin, type Instance, type LaunchIssue, type LaunchReport } from '@rezics/launcher-contract';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { useCallback, useEffect, useState } from 'react';
import { Failure, Pending, useAction, useRemote } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';

const stateLabel: Record<LaunchReport['state'], string> = {
  running: 'Running',
  exited: 'Exited',
  failed: 'Failed',
};
const outputClass =
  'max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]';

const recoveryPanels: Record<
  Exclude<LaunchIssue['action'], 'none'>,
  { panel: string; label: string; focus: string }
> = {
  account: { panel: 'overview', label: 'Open Minecraft accounts', focus: 'minecraft-account' },
  settings: { panel: 'settings', label: 'Open instance settings', focus: 'game-panel-settings' },
  mods: { panel: 'mods', label: 'Open mods', focus: 'game-panel-mods' },
  packs: { panel: 'packs', label: 'Open packs', focus: 'game-panel-packs' },
  repair: { panel: 'overview', label: 'Open installation', focus: 'minecraft-preparation-heading' },
  saves: { panel: 'saves', label: 'Open save history', focus: 'saves-heading' },
};

function LaunchDiagnostics({
  api,
  instance: { id: instanceId, kind },
  running,
  selectPanel,
}: {
  api: Pick<DesktopApi, 'readLaunchReport' | 'copyLaunchDiagnostic' | 'onLaunchReportChanged'>;
  instance: Instance;
  running: boolean;
  selectPanel: (panel: string, focusId: string) => void;
}) {
  const load = useCallback(() => api.readLaunchReport(instanceId), [api, instanceId, running]);
  const { data, error, pending, reload } = useRemote(load);
  useEffect(
    () =>
      api.onLaunchReportChanged((id) => {
        if (id === instanceId) reload();
      }),
    [api, instanceId, reload],
  );
  const copy = useAction();
  const [copied, setCopied] = useState(false);
  const issue = data?.issue;
  const next = issue?.action;
  const recovery =
    next &&
    next !== 'none' &&
    (kind === 'minecraft' || next === 'saves' || (kind === 'visual-novel' && next === 'settings'))
      ? recoveryPanels[next]
      : undefined;

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="launch-log-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="launch-log-heading" className="text-base font-semibold" tabIndex={-1}>
            Launch log
          </h2>
          {data && (
            <Badge variant={data.state === 'failed' ? 'destructive' : 'secondary'}>{stateLabel[data.state]}</Badge>
          )}
        </div>
        <div className="actions">
          {data && (
            <Button
              variant="outline"
              size="sm"
              disabled={copy.pending}
              onClick={() => {
                setCopied(false);
                void copy.run(async () => {
                  if (!(await api.copyLaunchDiagnostic(instanceId))) throw new Error('No launch report is available.');
                  setCopied(true);
                });
              }}
            >
              Copy diagnostics
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={pending} onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>
      <Failure error={error} retry={reload} />
      <Failure error={copy.error} />
      {copied && (
        <p className="text-sm text-muted-foreground" role="status">
          Diagnostics copied.
        </p>
      )}
      {pending && data === undefined && <Pending>Reading launch log…</Pending>}
      {data === null && !pending && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No launch recorded</EmptyTitle>
            <EmptyDescription>Start this instance to see its output and exit status.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {data && (
        <>
          <Failure error={issue?.summary ?? data.error} />
          {issue && data.error && data.error !== issue.summary && (
            <p className="wrap-anywhere text-sm text-muted-foreground">{data.error}</p>
          )}
          {recovery && (
            <div>
              <Button size="sm" variant="outline" onClick={() => selectPanel(recovery.panel, recovery.focus)}>
                {recovery.label}
              </Button>
            </div>
          )}
          {(data.exitCode !== null || data.signal !== null || data.truncated) && (
            <p className="text-xs text-muted-foreground">
              {data.exitCode !== null && `Exit code ${data.exitCode}`}
              {data.signal !== null && `Stopped by ${data.signal}`}
              {data.truncated && `${data.exitCode !== null || data.signal !== null ? ' · ' : ''}Recent output only`}
            </p>
          )}
          {data.crashReport && (
            <section className="grid min-w-0 gap-2" aria-labelledby="minecraft-crash-report-heading">
              <h3 id="minecraft-crash-report-heading" className="text-sm font-medium">
                Minecraft crash report
              </h3>
              <pre className={outputClass} aria-label="Minecraft crash report excerpt" tabIndex={0}>
                {data.crashReport.text}
              </pre>
              {data.crashReport.truncated && (
                <p className="text-xs text-muted-foreground">Only the start of the report is shown.</p>
              )}
            </section>
          )}
          {data.output ? (
            <pre className={outputClass} aria-label="Game process output" tabIndex={0}>
              {data.output}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">The process produced no readable output.</p>
          )}
        </>
      )}
    </section>
  );
}

export const launchDiagnosticsFrontend = {
  manifest: launchDiagnosticsPlugin,
  panels: {
    logs: { label: 'Logs', Component: LaunchDiagnostics },
  },
} as const;
