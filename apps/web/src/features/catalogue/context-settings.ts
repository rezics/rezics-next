import type { KernelClient } from '@rezics/client';
import { readSettingsInventory, settingsDigest } from '../contexts/settings-api';
import {
  capturedMatches,
  labelsFromDraft,
  policyFingerprint,
  policyPreview,
  settingsId,
  type SettingsPreview,
  type SettingsRead,
} from '../contexts/settings';
import type { EditorialFailure } from './editorial-context';

export {
  capturedMatches,
  emptyLabelRow,
  filterSettings,
  labelsFromDraft,
  labelsFromRows,
  pageSettings,
  parseSettingsSnapshot,
  policyFingerprint,
  policyPreview,
  propertyCaption,
  settingsChoice,
  settingsId,
  SETTINGS_CAP,
  SETTINGS_ID,
  SETTINGS_PAGE,
  type CapturedPolicy,
  type DefaultMode,
  type LabelRow,
  type SettingsChoice,
  type SettingsPreview,
  type SettingsRead,
  type SettingsSnapshot,
} from '../contexts/settings';
export { readSettingsInventory, settingsDigest } from '../contexts/settings-api';

export type EditorialSettingsTransport = {
  choices: (session?: string) => Promise<SettingsRead>;
  captured: (digest: string, session?: string) => Promise<SettingsRead>;
};

export async function readEditorialSettings(
  client: KernelClient,
  authorization: string,
  digest?: string,
  session?: string,
): Promise<SettingsRead> {
  return readSettingsInventory(client, authorization, digest, session);
}

export function editorialSettingsInput(input: unknown): { digest?: string; session?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings request');
  return settingsDigest(input as Record<string, unknown>);
}

export function asEditorialSettingsFailure(read: SettingsRead): EditorialFailure | null {
  if (read.kind === 'denied') return { ok: false, reason: 'denied', ...(read.session ? { session: read.session } : {}) };
  if (read.kind === 'unavailable')
    return { ok: false, reason: 'unavailable', ...(read.session ? { session: read.session } : {}) };
  return null;
}

export function reviewedCreateBody(
  labels: Record<string, string>,
  preview: SettingsPreview,
): { labels: Record<string, string>; settings?: string } {
  return preview.settings && settingsId(preview.settings)
    ? { labels, settings: preview.settings }
    : { labels };
}

export function previewChanged(previous: SettingsPreview, next: SettingsPreview): boolean {
  return policyFingerprint(previous) !== policyFingerprint(next);
}
