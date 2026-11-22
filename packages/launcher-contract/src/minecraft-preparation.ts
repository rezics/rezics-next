import type { MinecraftJavaPolicy, MinecraftSelection } from './index.ts';
import type { MinecraftWorldVersionRisk } from './save-management.ts';

export type MinecraftPreparationMode = 'install' | 'repair' | 'upgrade';
export type MinecraftUpgradeMode = 'in-place' | 'copy';
export type MinecraftInPlaceUpgradeBlocker = 'worlds' | 'newer-worlds' | 'mods' | 'modpack';

export const minecraftInPlaceUpgradeMessages: Record<MinecraftInPlaceUpgradeBlocker, string> = {
  worlds: 'This instance has worlds. Prepare a downgraded copy to keep them with the original version.',
  'newer-worlds': 'A world was saved by a newer Minecraft release. Prepare a separate copy to keep the original world.',
  mods: 'This instance has mods. Prepare a separate copy to keep them with the original.',
  modpack: 'This instance has a modpack. Prepare a separate copy to keep it with the original.',
};

export type MinecraftPreparationPhase =
  | 'queued'
  | 'waiting-for-game'
  | 'version'
  | 'loader'
  | 'libraries'
  | 'assets'
  | 'java'
  | 'worlds'
  | 'verify';
export type MinecraftPreparationState = 'running' | 'cancelling' | 'cancelled' | 'failed' | 'ready';
export type MinecraftPreparationProgress = { completed: number; total: number };

export interface MinecraftPreparation {
  id: string;
  instanceId: string;
  mode: MinecraftPreparationMode;
  state: MinecraftPreparationState;
  phase: MinecraftPreparationPhase;
  progress?: MinecraftPreparationProgress;
  updatedAt: number;
  cancellable: boolean;
  interrupted?: true;
  error?: string;
  selection?: MinecraftSelection;
  upgradeMode?: MinecraftUpgradeMode;
  /** Copy upgrades use all worlds when omitted and no worlds when empty. */
  worldIds?: readonly string[];
  worldVersionConfirmation?: MinecraftWorldVersionRisk;
  java?: MinecraftJavaPolicy;
  resultInstanceId?: string;
}

export function isActiveMinecraftPreparation(preparation: MinecraftPreparation | null | undefined): boolean {
  return preparation?.state === 'running' || preparation?.state === 'cancelling';
}
