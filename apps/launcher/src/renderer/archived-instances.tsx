import type { Instance } from '@rezics/launcher-contract';
import { EmptyState } from '@rezics/ui/empty-state';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import type { DesktopApi } from '../shared/desktop';
import { Failure, Pending, useAction, useRemote } from './actions';
import { ConfirmAction } from './confirm-action';
import { instanceMetadata } from './installed-games';

type ArchivedApi = Pick<
  DesktopApi,
  | 'listArchivedInstances'
  | 'setLocalGameArchived'
  | 'restoreArchivedMinecraft'
  | 'deleteArchivedMinecraft'
  | 'onInstalledChanged'
>;

export function ArchivedInstances({
  api,
  back,
  openInstance,
}: {
  api: ArchivedApi;
  back: () => void;
  openInstance: (value: Instance) => void;
}) {
  const instances = useRemote(api.listArchivedInstances);
  const reload = instances.reload;
  useEffect(() => api.onInstalledChanged(reload), [api, reload]);
  const action = useAction();
  return (
    <section className="stack">
      <div>
        <Button variant="ghost" onClick={back}>
          <ArrowLeft aria-hidden="true" data-icon="inline-start" />
          Installed
        </Button>
      </div>
      <h1>Archived instances</h1>
      <Failure error={instances.error} retry={instances.reload} />
      <Failure error={action.error} />
      {instances.pending && <Pending>Reading archive…</Pending>}
      {instances.data?.length === 0 && <EmptyState headingLevel={2} title="No archived instances" />}
      <ul className="rows">
        {instances.data?.map((instance) => (
          <li
            key={instance.kind === 'minecraft' ? `${instance.id}:${instance.revision}` : instance.id}
            className="row-item"
          >
            <div className="row-content">
              <p className="row-text">
                <strong>{instance.name}</strong>
                <MetaLine className="muted" items={instanceMetadata(instance)} />
              </p>
              <div className="actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      const restored =
                        instance.kind === 'minecraft'
                          ? await api.restoreArchivedMinecraft(instance.id)
                          : (await api.setLocalGameArchived(instance.id, false)).instance;
                      openInstance(restored);
                    })
                  }
                >
                  Restore instance
                </Button>
                {instance.kind === 'minecraft' && (
                  <ConfirmAction
                    label="Delete permanently"
                    title={`Delete ${instance.name}?`}
                    description="This permanently deletes the archived instance, its worlds and backup history."
                    disabled={action.pending}
                    destructive
                    confirm={async () => {
                      await api.deleteArchivedMinecraft(instance.id, instance.revision);
                      instances.reload();
                    }}
                  />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
