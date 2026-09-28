// Browser dependencies pre-bundled up front, so neither the dev server nor
// Storybook re-optimizes (and reloads) on a page's first visit.
export const browserDependencies = ['@ark-ui/react/avatar', '@ark-ui/react/checkbox', '@ark-ui/react/dialog',
  '@ark-ui/react/factory', '@ark-ui/react/field', '@ark-ui/react/fieldset', '@ark-ui/react/menu',
  '@ark-ui/react/password-input', '@ark-ui/react/portal', '@ark-ui/react/qr-code',
  '@ark-ui/react/scroll-area', 'lucide-react', 'native-i18n',
  'native-i18n/react/client', 'tailwind-variants',
  // The operator panel (features/admin): its palette, popovers, toasts and progress.
  '@ark-ui/react', '@ark-ui/react/collection', '@ark-ui/react/combobox', '@ark-ui/react/popover',
  '@ark-ui/react/progress', '@ark-ui/react/toast'];
