import type { KernelClient } from '@rezics/client';
import { loadSettingsPage } from '../settings/preferences';
import type { SessionEnv } from '../session/client';
import { defaultReader, type Reader } from './reader';

/** One preferences read for a signed-in reader, none for an anonymous one. A failed read shows the safest page. */
export async function loadReader(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<Reader> {
  try {
    const page = await loadSettingsPage(client, request, sessionEnv);
    if (!page.signedIn || !('preferences' in page)) return defaultReader;
    return { spoilerLevel: page.preferences.spoilerLevel, suitability: page.preferences.suitability };
  } catch {
    return defaultReader;
  }
}
