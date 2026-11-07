import { createContext, createElement, useContext, type ComponentProps, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { sessionQuery, useSession } from '../../session';
import { isSessionQueryKey, personalRead, SESSION_QUERY_KEY } from '../ports/vocabulary';
import type {
  SettingsAppearanceControls,
  SettingsOperationAdmission,
  SettingsSessionObservation,
  SettingsShellPort,
  SettingsSubjectHref,
  SettingsSubjectHrefInput,
} from '../ports/shell';

const headingClass = 'text-4xl font-semibold tracking-tight text-balance';

/** Settings-owned heading style; the shell heading remains the composition binding for other surfaces. */
export function SettingsPageHeading({ className, ...props }: ComponentProps<'h1'>) {
  return createElement('h1', {
    className: className ? `${headingClass} ${className}` : headingClass,
    ...props,
  });
}

function unboundAppearanceControls(_props: { className?: string }) {
  return null;
}

function unknownAdmission(
  _operation: Parameters<SettingsShellPort['useOperationAdmission']>[0],
): SettingsOperationAdmission {
  return 'unknown';
}

function closedOperation(_operation: Parameters<SettingsShellPort['useOperation']>[0]) {
  return false;
}

function subjectAddress(subject: SettingsSubjectHrefInput, locale: string): SettingsSubjectHref {
  return { href: `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject.id)}` };
}

export type SettingsShellBindings = {
  AppearanceControls?: SettingsAppearanceControls;
  PageHeading?: SettingsShellPort['PageHeading'];
  subjectHref?: SettingsShellPort['subjectHref'];
  useSession?: SettingsShellPort['useSession'];
  useOperation?: SettingsShellPort['useOperation'];
  useOperationAdmission?: SettingsShellPort['useOperationAdmission'];
};

function refreshSession(client: QueryClient): Promise<SettingsSessionObservation> {
  return client.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

/** Bind the installed session query. Composition supplies appearance, heading, subject address and exposure. */
export function createSettingsShellPort(bindings: SettingsShellBindings = {}): SettingsShellPort {
  return {
    sessionQueryKey: SESSION_QUERY_KEY,
    personalRead,
    useSession: bindings.useSession ?? useSession,
    refreshSession,
    sessionQueryState: (client) => client.getQueryState(sessionQuery.queryKey),
    sessionQueryData: (client) => client.getQueryData(sessionQuery.queryKey),
    sessionCacheRecord: (client, hash) => client.getQueryCache().get(hash(sessionQuery.queryKey)),
    subscribeSessionQuery: (client, onChange) =>
      client.getQueryCache().subscribe(({ query }) => {
        if (isSessionQueryKey(query.queryKey)) onChange();
      }),
    isSessionQuery: isSessionQueryKey,
    sessionQueryHash: (hash) => hash(sessionQuery.queryKey),
    useOperation: bindings.useOperation ?? closedOperation,
    useOperationAdmission: bindings.useOperationAdmission ?? unknownAdmission,
    subjectHref: bindings.subjectHref ?? subjectAddress,
    PageHeading: bindings.PageHeading ?? SettingsPageHeading,
    AppearanceControls: bindings.AppearanceControls ?? unboundAppearanceControls,
  };
}

export const productionSettingsShellPort = createSettingsShellPort();

const SettingsShellContext = createContext<SettingsShellPort | null>(null);

/** Route and shell composition supply the bound port; tests and stories may inject a fake. */
export function SettingsShellProvider({ port, children }: { port?: SettingsShellPort; children: ReactNode }) {
  return createElement(SettingsShellContext.Provider, { value: port ?? productionSettingsShellPort }, children);
}

export function useSettingsShell(): SettingsShellPort {
  return useContext(SettingsShellContext) ?? productionSettingsShellPort;
}

export function useSettingsSession() {
  return useSettingsShell().useSession();
}

export function useSettingsOperation(operation: Parameters<SettingsShellPort['useOperation']>[0]) {
  return useSettingsShell().useOperation(operation);
}

export function useSettingsOperationAdmission(operation: Parameters<SettingsShellPort['useOperationAdmission']>[0]) {
  return useSettingsShell().useOperationAdmission(operation);
}
