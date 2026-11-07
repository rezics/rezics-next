import { createContext, useContext, type ReactNode } from 'react';
import type { ScreenReadingPort } from './screen-reading-port';

export type { ScreenReadingPort, ScreenSubjectHref, ScreenVisitReturn } from './screen-reading-port';

/** Consumer capabilities for Screen profile and episode continuation, never a Search page store. */
export type ScreenReadingApplication = ScreenReadingPort;

export const ScreenReadingApplicationContext = createContext<ScreenReadingApplication | null>(null);

export function useScreenReadingApplication(): ScreenReadingApplication {
  const application = useContext(ScreenReadingApplicationContext);
  if (!application) throw new Error('Screen reading requires application page capabilities');
  return application;
}

export function ScreenReadingApplicationProvider({
  port,
  children,
}: {
  port: ScreenReadingApplication;
  children: ReactNode;
}) {
  return <ScreenReadingApplicationContext value={port}>{children}</ScreenReadingApplicationContext>;
}
