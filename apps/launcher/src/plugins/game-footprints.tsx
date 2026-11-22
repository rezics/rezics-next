import { gameFootprintsPlugin } from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useState } from 'react';
import { Failure, useAction, useRemote } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';

type FootprintsApi = Pick<
  DesktopApi,
  'footprintStatus' | 'setFootprintRecording' | 'exportFootprints' | 'onSession' | 'onFootprintRecordingChanged'
>;

function GameFootprints({ api }: { api: FootprintsApi }) {
  const status = useRemote(api.footprintStatus);
  const reload = status.reload;
  const action = useAction();
  const [exported, setExported] = useState(false);
  useEffect(
    () =>
      api.onSession((session) => {
        if (!session) reload();
      }),
    [api, reload],
  );
  useEffect(() => api.onFootprintRecordingChanged(reload), [api, reload]);
  const busy = status.pending || action.pending;
  return (
    <details className="space-y-2 rounded-md border p-3">
      <summary className="cursor-pointer font-medium">Game footprints</summary>
      <p className="text-sm text-muted-foreground">
        Record completed runs of games linked to a REZICS Subject. Export the local records and import them from
        Footprints on the REZICS website.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={status.data?.enabled ?? false}
            disabled={busy || !status.data}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void action.run(async () => {
                await api.setFootprintRecording(enabled);
                status.reload();
              });
            }}
          />
          Record game process time
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setExported(false);
            void action.run(async () => setExported(await api.exportFootprints()));
          }}
        >
          Export footprints
        </Button>
      </div>
      <Failure error={status.error ?? action.error} />
      {status.data?.error && <p role="alert">{status.data.error}</p>}
      {exported && <p role="status">Footprints exported.</p>}
    </details>
  );
}

export const gameFootprintsFrontend = {
  manifest: gameFootprintsPlugin,
  panels: {},
  libraryPanels: { 'game-footprints': GameFootprints },
};
