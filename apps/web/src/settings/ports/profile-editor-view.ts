import { createElement, type ComponentProps } from 'react';
import { ProfileCard as SettingsProfileCard, ProfileFeedback } from '../profile';
import { settingsContent } from '../adapters/presentation';

/** Bind Settings capabilities at the delegated Profile route's presentation composition. */
export function ProfileCard(props: Omit<ComponentProps<typeof SettingsProfileCard>, 'content'>) {
  return createElement(SettingsProfileCard, { ...props, content: settingsContent });
}
export { ProfileFeedback };
export { PublicViewsCard } from '../public-views';
export { ProfileNavigation } from '../profile-navigation';
