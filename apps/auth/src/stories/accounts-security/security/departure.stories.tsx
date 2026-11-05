import { useState } from 'react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { SecurityPage } from '../../../routes/security';
import { m } from '../../../paraglide/messages.js';
import { initial } from './security.stories';
import { AuthStory, authLocale, reviewParameters, populatedInventory, button, waitFor } from '../../accounts-operations/story';

export default { title: 'Pages/Account/Security departure', parameters: reviewParameters, decorators: [authLocale] };
const ready = initial as Extract<typeof initial, { kind: 'ready' }>;
export const adviceInitial = {
  ...ready,
  sessions: (['last-credential', 'unavailable', 'step-up-required'] as const).map((revoke, i) => ({
    ...ready.sessions[0]!, id: `advice-${i}`, revoke,
    client_display_name: 'Reading companion with a very long application and device label for shared responsibilities',
  })),
  page: undefined,
};
function DeparturePage() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const security = createRoute({
      getParentRoute: () => root, path: '/security',
      component: () => <>
        <SecurityPage initial={adviceInitial} inventorySource={populatedInventory}
          identitySource={async () => ({ kind: 'unavailable' })}
          securitySource={{ read: async () => ({ kind: 'unavailable' }), act: () => new Promise(() => {}) }} />
        <button type="button" data-story-depart onClick={() => void router.navigate({ to: '/next' } as never)}>Leave Security</button>
      </>,
    });
    return createRouter({ history: createMemoryHistory({ initialEntries: ['/security'] }), routeTree: root.addChildren([
      security, createRoute({ getParentRoute: () => root, path: '/next', component: () => <p>Next page</p> }),
    ]) });
  });
  return <AuthStory><RouterProvider router={router} /></AuthStory>;
}
export const PendingDeparture = {
  render: () => <DeparturePage />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_security_passkey_remove()))).click();
    (await waitFor(() => canvasElement.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child'))).click();
    (await waitFor(() => canvasElement.querySelector<HTMLButtonElement>('[data-story-depart]'))).click();
    await waitFor(() => canvasElement.querySelector('[role="alertdialog"]'));
  },
};
export const SessionAdvice = {
  render: () => <AuthStory><SecurityPage initial={adviceInitial} inventorySource={populatedInventory}
    identitySource={async () => ({ kind: 'unavailable' })} /></AuthStory>,
};
