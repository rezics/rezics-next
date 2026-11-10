import type { Preview } from '@storybook/react-vite';
import { useEffect, type ReactNode } from 'react';
import { configure } from 'storybook/test';
import { setLocale } from '../src/paraglide/runtime.js';
import './preview.css';
import { setFakeAdmitted } from '../src/kernel/fake';
import { connectedStoryProviders } from '../src/stories/connected-story';
import { pageRenderBinding } from '../src/features/catalogue/page-render-binding';
import { installSemanticRenderPort } from '../src/features/pages/subject-page-application';

configure({ asyncUtilTimeout: 15_000 });
installSemanticRenderPort(pageRenderBinding);

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;

function HydrationMarker({ storyId, children }: { storyId: string; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.hydrated = '';
    return () => {
      delete document.documentElement.dataset.hydrated;
    };
  }, [storyId]);

  return children;
}

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Color theme', toolbar: { title: 'Theme', icon: 'contrast', items: ['light', 'dark'] } },
    locale: { description: 'Locale', toolbar: { title: 'Locale', items: [...locales] } },
  },
  initialGlobals: { theme: 'light', locale: 'en', viewport: { value: 'responsive', isRotated: false } },
  parameters: {
    a11y: { test: 'error' },
    backgrounds: { disable: true },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  decorators: [
    ...connectedStoryProviders.decorators,
    (Story, context) => {
      setFakeAdmitted(
        context.parameters.admitted ?? [
          'selling',
          'purchases',
          'agent_verification',
          'personal_library',
          'library_entry.restore',
          'reading_progress',
          'collections',
        ],
      );
      const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
      const locale = String(context.globals.locale ?? 'en');
      setLocale(locale as (typeof locales)[number], { reload: false });
      document.documentElement.lang = locale;
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
      document.cookie = `rezics_theme=${theme}; Path=/; SameSite=Lax`;
      return (
        <HydrationMarker key={context.id} storyId={context.id}>
          <Story />
        </HydrationMarker>
      );
    },
  ],
};
export default preview;
