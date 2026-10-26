import { Outlet } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';
import { Route } from '../src/routes/__root';
import { AppShell } from '../src/shell/shell';

function StorybookDocument() {
  const { theme, collapsed, session, csrfToken } = Route.useLoaderData();
  useLayoutEffect(() => {
    const moveSkipLink = () => {
      const skipLink = document.querySelector('[data-slot="skip-nav-link"]');
      const header = document.querySelector('header');
      if (skipLink && header && !header.contains(skipLink)) header.appendChild(skipLink);
    };
    moveSkipLink();
    const observer = new MutationObserver(moveSkipLink);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <AppShell theme={theme} collapsed={collapsed} session={session} csrfToken={csrfToken}>
      <Outlet />
    </AppShell>
  );
}

// Storybook owns the iframe document. Keep the real root route and its loader, but mount its AppShell in the story canvas.
Route.update({ component: StorybookDocument });
