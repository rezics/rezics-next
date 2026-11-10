import { useLayoutEffect, type ReactNode } from 'react';
import { ApplicationShell, Route } from '../src/routes/__root';

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

  return <ApplicationShell>{children}</ApplicationShell>;
}

// Storybook owns the iframe document; keep the real route and shell providers.
Object.assign(Route.options, { shellComponent: StorybookDocument });
