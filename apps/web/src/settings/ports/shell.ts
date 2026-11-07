import type { ComponentProps, ComponentType } from 'react';
import type { QueryClient, QueryState } from '@tanstack/react-query';
import { SESSION_QUERY_KEY, personalRead } from './vocabulary';

export type SettingsSessionObservation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};

export type SettingsExposureOperation =
  | 'account.collections'
  | 'agent_verification.request'
  | 'collection.update'
  | 'collection.get';

export type SettingsOperationAdmission = 'unknown' | 'available' | 'denied' | 'unavailable';

export type SettingsSubjectHrefInput = { id: string; label: string };
export type SettingsSubjectHref = { href: string };

export type SettingsPageHeading = ComponentType<ComponentProps<'h1'>>;
export type SettingsAppearanceControls = ComponentType<{ className?: string }>;

/**
 * Shell and session capabilities Settings owns as a consumer. Composition binds the installed
 * session query, exposure reads, heading, appearance and subject address. The port carries those
 * observations; it does not start another fetch or cache.
 */
export type SettingsShellPort = {
  readonly sessionQueryKey: typeof SESSION_QUERY_KEY;
  readonly personalRead: typeof personalRead;
  useSession: () => SettingsSessionObservation;
  refreshSession: (client: QueryClient) => Promise<SettingsSessionObservation>;
  sessionQueryState: (client: QueryClient) => QueryState<SettingsSessionObservation> | undefined;
  sessionQueryData: (client: QueryClient) => SettingsSessionObservation | undefined;
  sessionCacheRecord: (client: QueryClient, hash: (key: readonly unknown[]) => string) => unknown;
  subscribeSessionQuery: (client: QueryClient, onChange: () => void) => () => void;
  isSessionQuery: (key: readonly unknown[]) => boolean;
  sessionQueryHash: (hash: (key: readonly unknown[]) => string) => string;
  useOperation: (operation: SettingsExposureOperation) => boolean;
  useOperationAdmission: (operation: SettingsExposureOperation) => SettingsOperationAdmission;
  subjectHref: (subject: SettingsSubjectHrefInput, locale: string) => SettingsSubjectHref;
  PageHeading: SettingsPageHeading;
  AppearanceControls: SettingsAppearanceControls;
};

export type { SettingsSessionObservation as SettingsSession };
