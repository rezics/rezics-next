import type { ReactNode } from 'react';
import { AccountShell, type AccountSection, sectionPaths } from './account-shell.tsx';
import { readSession, type AccountSession, type Read } from '../api/server.ts';
import { accountsConfig } from '../config/env.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';

/** Every account section: the shell, then the section's content for a signed-in
 * visitor or the matching state (signed out, unavailable) for anyone else. */
export async function renderAccountPage(section: AccountSection,
  render: (session: AccountSession) => Promise<ReactNode> | ReactNode): Promise<ReactNode> {
  const session = await readSession();
  const webOrigin = accountsConfig().WEB_ORIGIN;
  if (session.status !== 'ok') {
    return <AccountShell section={section} webOrigin={webOrigin}>
      <ReadStatePanel status={session.status} next={sectionPaths[section]} headingLevel={1} /></AccountShell>;
  }
  return <AccountShell section={section} user={session.data.user} webOrigin={webOrigin}>
    {await render(session.data)}</AccountShell>;
}

export function count<T>(read: Read<T[]>): number | null {
  return read.status === 'ok' ? read.data.length : null;
}
