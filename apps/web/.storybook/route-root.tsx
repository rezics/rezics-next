import { Outlet } from '@tanstack/react-router';
import { useLayoutEffect, type ReactNode } from 'react';
import { Route } from '../src/routes/__root';
import { AppShell } from '../src/shell/shell';
import { RecentSearchBinding } from '../src/session/recent-search-binding';

function StorybookDocument({ children }: { children: ReactNode }) {
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
    <RecentSearchBinding>
      <AppShell>{children}</AppShell>
    </RecentSearchBinding>
  );
}

// Storybook owns the iframe document. Keep the real root route but mount its AppShell in the story canvas.
Route.update({ component: Outlet });
Object.assign(Route.options, { shellComponent: StorybookDocument });
