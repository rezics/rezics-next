import {
  defaultFabricVersion,
  defaultMinecraftVersion,
  minecraftLoaderNames,
  minecraftLoaderVersion,
  minecraftPlugin,
  type Instance,
  type MinecraftPreparation,
} from '@rezics/launcher-contract';
import { Button } from '@rezics/ui/shadcn/button';
import { FieldGroup } from '@rezics/ui/shadcn/field';
import { Blocks } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Failure, Pending, useAction } from '../renderer/actions';
import { InstanceNameField, InstanceSubjectField } from '../renderer/instance-fields';
import {
  exactSelection,
  MinecraftSelectionFields,
  type MinecraftCatalogueApi,
  type MinecraftSelectionDraft,
} from '../renderer/minecraft-versions';
import { Packages, type PackagesApi } from '../renderer/packages';
import type { DesktopApi } from '../shared/desktop';
import { MinecraftAccount, type MinecraftAccountApi } from './minecraft-account';
import { MinecraftPacks, PackImport, type PackImportApi } from './minecraft-packs';
import { MinecraftPreparationPanel } from './minecraft-preparation';
import { MinecraftSettingsPanel } from './minecraft-settings';

function CreateMinecraftInstance({
  api,
  done,
  cancel,
}: {
  api: PackImportApi & MinecraftCatalogueApi & Pick<DesktopApi, 'createMinecraft'>;
  done: (instance: Instance) => void;
  cancel: () => void;
}) {
  const fields = useId();
  const [name, setName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [draft, setDraft] = useState<MinecraftSelectionDraft>({
    version: defaultMinecraftVersion,
    loader: 'fabric',
    loaderVersion: defaultFabricVersion,
  });
  const [isImportingPack, setIsImportingPack] = useState(false);
  const action = useAction();
  const selection = exactSelection(draft);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void action.run(async () => {
      if (!selection) throw new Error(`Choose a ${minecraftLoaderNames[draft.loader]} loader version.`);
      const subject = subjectId.trim();
      done(
        await api.createMinecraft({
          name: name.trim(),
          ...selection,
          ...(subject && { subjectId: subject }),
        }),
      );
    });
  }

  if (isImportingPack) {
    return <PackImport api={api} done={done} cancel={() => setIsImportingPack(false)} />;
  }

  return (
    <section className="form-panel" aria-labelledby={fields + '-heading'}>
      <h1 id={fields + '-heading'}>Create Minecraft instance</h1>
      <form className="form" onSubmit={submit}>
        <FieldGroup>
          <InstanceNameField id={fields + '-name'} value={name} change={setName} disabled={action.pending} />
          <MinecraftSelectionFields api={api} id={fields} value={draft} disabled={action.pending} change={setDraft} />
          <InstanceSubjectField
            id={fields + '-subject'}
            value={subjectId}
            change={setSubjectId}
            disabled={action.pending}
          />
          <Failure error={action.error} />
          {action.pending && <Pending>Creating instance…</Pending>}
          <div className="actions">
            <Button type="submit" disabled={action.pending || !name.trim() || !selection}>
              Create instance
            </Button>
            <Button type="button" variant="outline" disabled={action.pending} onClick={() => setIsImportingPack(true)}>
              Import Modrinth pack
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

type MinecraftOverviewApi = MinecraftAccountApi &
  Pick<DesktopApi, 'startMinecraftPreparation' | 'readMinecraftPreparation' | 'cancelMinecraftPreparation'>;

function MinecraftOverview({
  api,
  instance,
  running,
  preparation,
}: {
  api: MinecraftOverviewApi;
  instance: Instance;
  running: boolean;
  preparation: MinecraftPreparation | undefined;
}) {
  if (!instance.minecraft) return null;
  return (
    <>
      <MinecraftPreparationPanel
        api={api}
        instanceId={instance.id}
        prepared={instance.minecraft.prepared}
        running={running}
        preparation={preparation}
      />
      <MinecraftAccount api={api} />
    </>
  );
}

function MinecraftMods({
  api,
  instance,
  sessionActive,
}: {
  api: PackagesApi;
  instance: Instance;
  sessionActive: boolean;
}) {
  const minecraft = instance.minecraft;
  if (!minecraft) return null;
  if (minecraft.loader === 'vanilla') return <p className="muted">Mods require a mod loader.</p>;
  return <Packages api={api} instanceId={instance.id} minecraft={minecraft} running={sessionActive} />;
}

export const minecraftFrontend = {
  manifest: minecraftPlugin,
  create: { label: 'Minecraft instance', Component: CreateMinecraftInstance },
  panels: {
    overview: { label: 'Overview', Component: MinecraftOverview },
    mods: { label: 'Mods', Component: MinecraftMods },
    packs: { label: 'Packs', Component: MinecraftPacks },
    settings: { label: 'Settings', Component: MinecraftSettingsPanel },
  },
  instance: {
    Icon: Blocks,
    canLaunch: (instance: Instance) => instance.minecraft?.prepared === true,
    metadata(instance: Instance) {
      const minecraft = instance.minecraft;
      if (!minecraft) return ['Minecraft'];
      const loader = [minecraftLoaderNames[minecraft.loader], minecraftLoaderVersion(minecraft)]
        .filter(Boolean)
        .join(' ');
      return [`Minecraft ${minecraft.version}`, loader, !minecraft.prepared && 'Not installed'];
    },
  },
} as const;
