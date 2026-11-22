import type { CatalogInstallPreview, PackageInstallProgress } from '@rezics/launcher-contract';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Progress } from '@rezics/ui/shadcn/progress';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/desktop';
import { Failure, Pending, useAction, useRemote } from './actions';

type PackageReviewChange = Pick<
  CatalogInstallPreview['changes'][number],
  'title' | 'version' | 'installedVersion' | 'action' | 'enables'
> & { key: string; releaseId: string };
type PackageReview = { revision: string; changes: PackageReviewChange[] };
type ReviewControls = { locked: boolean; cancel: () => void; done: () => void };
type InstallNotifications = Pick<DesktopApi, 'cancelPackageInstall' | 'onPackageInstallProgress'>;

const packageInstallAction: Record<PackageReviewChange['action'], string> = {
  install: 'Install',
  replace: 'Change version',
  enable: 'Enable',
  keep: 'Keep',
  reinstall: 'Reinstall',
};

export function CatalogInstallReview({
  api,
  instanceId,
  packageId,
  releaseId,
  ...controls
}: ReviewControls & {
  api: Pick<DesktopApi, 'previewCatalogInstall' | 'installReviewedCatalogPackage'> & InstallNotifications;
  instanceId: string | undefined;
  packageId: string;
  releaseId: string;
}) {
  const load = useCallback(async (): Promise<PackageReview> => {
    const plan = await api.previewCatalogInstall({ packageId, releaseId }, instanceId);
    return { revision: plan.revision, changes: plan.changes.map((change) => ({ ...change, key: change.packageId })) };
  }, [api, packageId, releaseId, instanceId]);
  return (
    <PackageInstallReview
      {...controls}
      title={instanceId ? 'Review mod installation' : 'Review extension installation'}
      load={load}
      install={(revision, attemptId) =>
        api.installReviewedCatalogPackage({ packageId, releaseId }, revision, attemptId, instanceId)
      }
      stopInstall={api.cancelPackageInstall}
      onProgress={api.onPackageInstallProgress}
    />
  );
}

export function ModrinthInstallReview({
  api,
  instanceId,
  versionId,
  projectTitle,
  ...controls
}: ReviewControls & {
  api: Pick<DesktopApi, 'previewModInstall' | 'installMod'> & InstallNotifications;
  instanceId: string;
  versionId: string;
  projectTitle: string;
}) {
  const load = useCallback(async (): Promise<PackageReview> => {
    const plan = await api.previewModInstall(instanceId, versionId);
    return {
      revision: plan.revision,
      changes: plan.changes.map((change) => ({
        ...change,
        key: change.projectId,
        releaseId: change.id,
        title: change.id === versionId ? projectTitle : change.title,
      })),
    };
  }, [api, instanceId, versionId, projectTitle]);
  return (
    <PackageInstallReview
      {...controls}
      title="Review mod installation"
      load={load}
      install={(revision, attemptId) => api.installMod(instanceId, versionId, revision, attemptId)}
      stopInstall={api.cancelPackageInstall}
      onProgress={api.onPackageInstallProgress}
    />
  );
}

const phaseLabel: Record<PackageInstallProgress['phase'], string> = {
  checking: 'Checking reviewed releases…',
  downloading: 'Downloading',
  verifying: 'Verifying',
  staging: 'Preparing package changes…',
  publishing: 'Finishing installation…',
};
const number = new Intl.NumberFormat();

function InstallProgress({ progress }: { progress: PackageInstallProgress | undefined }) {
  if (progress?.phase !== 'downloading' && progress?.phase !== 'verifying') {
    return <Pending>{progress ? phaseLabel[progress.phase] : 'Waiting to check reviewed releases…'}</Pending>;
  }
  const { phase, title, position, total, bytes, totalBytes } = progress;
  const count = `${number.format(bytes)} of ${number.format(totalBytes)} bytes received`;
  return (
    <div className="grid min-w-0 gap-2">
      <Pending>
        <span className="min-w-0 wrap-anywhere">
          {phaseLabel[phase]} {title} ({position} of {total})
        </span>
      </Pending>
      <Progress
        aria-label="Package download progress"
        aria-valuetext={count}
        value={bytes}
        max={totalBytes}
        className="gap-1"
      >
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      </Progress>
    </div>
  );
}

function PackageInstallReview({
  title,
  load,
  install,
  stopInstall,
  onProgress,
  locked,
  cancel,
  done,
}: ReviewControls & {
  title: string;
  load: () => Promise<PackageReview>;
  install: (revision: string, attemptId: string) => Promise<boolean>;
  stopInstall: (attemptId: string) => Promise<boolean>;
  onProgress: DesktopApi['onPackageInstallProgress'];
}) {
  const heading = useId();
  const preview = useRemote(load);
  const action = useAction();
  const stop = useAction();
  const attempt = useRef<string | undefined>(undefined);
  const confirm = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<'cancelling' | 'finishing' | 'cancelled'>();
  const [progress, setProgress] = useState<PackageInstallProgress>();
  const finishing = status === 'finishing' || progress?.phase === 'publishing';

  useEffect(
    () =>
      onProgress((id, value) => {
        if (attempt.current === id) setProgress(value);
      }),
    [onProgress],
  );
  useEffect(
    () => () => {
      if (attempt.current) void stopInstall(attempt.current).catch(() => {});
    },
    [stopInstall],
  );
  useEffect(() => {
    if (status === 'cancelled' && !action.pending) confirm.current?.focus();
  }, [status, action.pending]);

  function cancelInstallation() {
    const id = attempt.current;
    if (!id) return;
    void stop.run(async () => {
      const accepted = await stopInstall(id);
      if (attempt.current === id) setStatus(accepted ? 'cancelling' : 'finishing');
    });
  }

  return (
    <section className="grid min-w-0 gap-3 rounded-lg border p-3" aria-labelledby={heading}>
      <h4 className="text-sm font-semibold" id={heading}>
        {title}
      </h4>
      {preview.pending && <Pending>Checking required packages…</Pending>}
      <Failure error={preview.error} retry={preview.reload} />
      {preview.data && !preview.pending && !preview.error && (
        <ul className="grid gap-1 text-sm" aria-label="Package changes">
          {preview.data.changes.map((change) => {
            const version =
              change.action === 'replace'
                ? change.installedVersion === change.version
                  ? `${change.version} · ${change.releaseId}`
                  : `${change.installedVersion} → ${change.version}`
                : change.title.endsWith(change.version)
                  ? null
                  : change.version;
            return (
              <li key={change.key} className="flex flex-wrap items-baseline gap-x-2">
                <Badge variant="secondary">{packageInstallAction[change.action]}</Badge>
                <span className="wrap-anywhere">{change.title}</span>
                {version && <span className="text-muted-foreground wrap-anywhere">{version}</span>}
                {change.enables && <span className="text-muted-foreground">Enables this package</span>}
              </li>
            );
          })}
        </ul>
      )}
      {action.pending &&
        (status === 'cancelling' ? (
          <Pending>Cancelling installation…</Pending>
        ) : status === 'finishing' ? (
          <Pending>Finishing installation…</Pending>
        ) : (
          <InstallProgress progress={progress} />
        ))}
      {status === 'cancelled' && !action.pending && (
        <p className="text-sm text-muted-foreground" role="status">
          Installation cancelled. You can retry from this review.
        </p>
      )}
      <Failure error={action.error} retry={() => void action.run(async () => preview.reload())} />
      {action.pending && <Failure error={stop.error} />}
      <div className="actions">
        <Button
          variant="ghost"
          disabled={action.pending && (stop.pending || status === 'cancelling' || finishing)}
          onClick={action.pending ? cancelInstallation : cancel}
        >
          {action.pending ? 'Cancel installation' : 'Cancel'}
        </Button>
        <Button
          ref={confirm}
          disabled={
            locked ||
            !preview.data ||
            preview.pending ||
            Boolean(preview.error) ||
            action.pending ||
            Boolean(action.error)
          }
          onClick={() => {
            const review = preview.data;
            if (!review) return;
            void action.run(async () => {
              const id = crypto.randomUUID();
              attempt.current = id;
              setStatus(undefined);
              setProgress(undefined);
              try {
                if (await install(review.revision, id)) done();
                else setStatus('cancelled');
              } finally {
                attempt.current = undefined;
              }
            });
          }}
        >
          Confirm install
        </Button>
      </div>
    </section>
  );
}
