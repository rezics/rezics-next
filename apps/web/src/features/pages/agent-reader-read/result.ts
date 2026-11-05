import type { SettingsPage } from '../../../settings/preferences';
import { defaultReader, type Reader } from '../../../subject/reader';

export type AgentReaderResult =
  | { kind: 'ready'; accountId: string; reader: Reader }
  | {
      kind: 'default';
      accountId: string | null;
      reader: Reader;
      reason: 'signed-out' | 'rejected' | 'closed' | 'preparing' | 'unavailable' | 'retired';
    };

/** Construct only a private-reader result admitted by the prepared account. */
export function agentReaderResult(expectedReader: string, page: SettingsPage): AgentReaderResult {
  const accountId = page.signedIn ? (page.accountId ?? null) : null;
  if (!page.signedIn) return { kind: 'default', reason: 'signed-out', accountId, reader: defaultReader };
  if (!accountId || accountId !== expectedReader)
    return { kind: 'default', reason: 'rejected', accountId, reader: defaultReader };
  if ('state' in page) return { kind: 'default', reason: page.state, accountId, reader: defaultReader };
  return {
    kind: 'ready',
    accountId,
    reader: { spoilerLevel: page.preferences.spoilerLevel, suitability: page.preferences.suitability },
  };
}
