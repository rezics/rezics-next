import {
  defaultFabricVersion,
  defaultMinecraftVersion,
  minecraftLoaderNames,
  type MinecraftLoader,
  type MinecraftSelection,
} from '@rezics/launcher-contract';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { useCallback } from 'react';
import type { DesktopApi } from '../shared/desktop';
import { Failure, Pending, useRemote } from './actions';

type VersionFieldProps = {
  id: string;
  value: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
};
type Option = { value: string; label: string };

export type MinecraftSelectionDraft = { version: string; loader: MinecraftLoader; loaderVersion?: string | undefined };

export type MinecraftCatalogueApi = Pick<
  DesktopApi,
  'listMinecraftVersions' | 'listFabricVersions' | 'listForgeVersions' | 'listNeoForgeVersions'
>;

const loaders = (['vanilla', 'fabric', 'forge', 'neoforge'] satisfies MinecraftLoader[]).map((loader) => ({
  value: loader,
  label: minecraftLoaderNames[loader],
}));

export function exactSelection({
  version,
  loader,
  loaderVersion,
}: MinecraftSelectionDraft): MinecraftSelection | undefined {
  if (loader === 'vanilla') return { version, loader };
  if (!loaderVersion) return undefined;
  if (loader === 'fabric') return { version, loader, fabricVersion: loaderVersion };
  if (loader === 'forge') return { version, loader, forgeVersion: loaderVersion };
  return { version, loader, neoForgeVersion: loaderVersion };
}

export function MinecraftSelectionFields({
  api,
  id,
  value,
  disabled,
  change,
}: {
  api: MinecraftCatalogueApi;
  id: string;
  value: MinecraftSelectionDraft;
  disabled: boolean;
  change: (selection: MinecraftSelectionDraft) => void;
}) {
  const { version, loader, loaderVersion } = value;
  const list = { fabric: api.listFabricVersions, forge: api.listForgeVersions, neoforge: api.listNeoForgeVersions };
  function select(version: string, loader: MinecraftLoader) {
    const loaderVersion = loader === 'fabric' && version === defaultMinecraftVersion ? defaultFabricVersion : undefined;
    change({ version, loader, loaderVersion });
  }
  return (
    <>
      <MinecraftVersionField
        id={`${id}-version`}
        listVersions={api.listMinecraftVersions}
        value={version}
        disabled={disabled}
        onChange={(version) => select(version, loader)}
      />
      <Field data-disabled={disabled || undefined}>
        <FieldLabel htmlFor={`${id}-loader`}>Mod loader</FieldLabel>
        <Select
          items={loaders}
          name="loader"
          value={loader}
          disabled={disabled}
          onValueChange={(next) => {
            if (next && next !== loader) select(version, next);
          }}
        >
          <SelectTrigger id={`${id}-loader`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {loaders.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {loader !== 'vanilla' && (
        <LoaderVersionField
          key={`${version}-${loader}`}
          id={`${id}-loader-version`}
          listVersions={list[loader]}
          gameVersion={version}
          loader={loader}
          value={loaderVersion}
          disabled={disabled}
          onChange={(loaderVersion) => change({ version, loader, loaderVersion })}
        />
      )}
    </>
  );
}

export function MinecraftVersionField({
  id,
  value,
  disabled,
  onChange,
  listVersions,
}: VersionFieldProps & { listVersions: DesktopApi['listMinecraftVersions'] }) {
  const catalogue = useRemote(listVersions);
  const items = (catalogue.data ?? []).map(({ id: version, latest }) => ({
    value: version,
    label: latest ? `${version} · Latest release` : version,
  }));
  if (!items.some(({ value: version }) => version === defaultMinecraftVersion)) {
    items.push({ value: defaultMinecraftVersion, label: defaultMinecraftVersion });
  }
  if (value && !items.some((item) => item.value === value)) items.push({ value, label: value });

  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>Minecraft version</FieldLabel>
      <VersionSelect id={id} value={value} items={items} disabled={disabled} onChange={onChange} />
      {catalogue.pending && !catalogue.data && <Pending>Checking for Minecraft releases…</Pending>}
      {catalogue.error && (
        <Failure
          error={`Could not load Minecraft releases. You can still select ${defaultMinecraftVersion}. ${catalogue.error}`}
          retry={catalogue.reload}
        />
      )}
    </Field>
  );
}

export function LoaderVersionField({
  id,
  value,
  gameVersion,
  loader,
  disabled,
  onChange,
  listVersions,
}: VersionFieldProps & {
  gameVersion: string;
  loader: Exclude<MinecraftLoader, 'vanilla'>;
  listVersions: DesktopApi['listFabricVersions'];
}) {
  const loaderName = minecraftLoaderNames[loader];
  const load = useCallback(() => listVersions(gameVersion), [gameVersion, listVersions]);
  const catalogue = useRemote(load);
  const latestStable = catalogue.data?.find(({ stable }) => stable)?.id;
  const items = (catalogue.data ?? []).map(({ id: version }) => ({
    value: version,
    label: version === latestStable ? `${version} · Latest stable` : version,
  }));
  if (
    loader === 'fabric' &&
    gameVersion === defaultMinecraftVersion &&
    !items.some((item) => item.value === defaultFabricVersion)
  ) {
    items.push({ value: defaultFabricVersion, label: defaultFabricVersion });
  }
  if (value && !items.some((item) => item.value === value)) items.push({ value, label: value });

  return (
    <Field data-disabled={disabled || items.length === 0 || undefined}>
      <FieldLabel htmlFor={id}>{loaderName} loader version</FieldLabel>
      <VersionSelect
        id={id}
        value={value}
        items={items}
        disabled={disabled || items.length === 0}
        onChange={onChange}
      />
      {catalogue.pending && !catalogue.data && <Pending>Checking available {loaderName} loaders…</Pending>}
      {catalogue.error && (
        <Failure error={`Could not load ${loaderName} loaders. ${catalogue.error}`} retry={catalogue.reload} />
      )}
      {catalogue.data && items.length === 0 && (
        <FieldDescription>
          {loaderName} is unavailable for this Minecraft version. Choose another loader or game version.
        </FieldDescription>
      )}
    </Field>
  );
}

function VersionSelect({ id, value, items, disabled, onChange }: VersionFieldProps & { items: Option[] }) {
  return (
    <Select value={value ?? null} items={items} disabled={disabled} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select a version" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
