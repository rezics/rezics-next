import { createContext } from 'react';
import type { OverviewValue } from './overview';

/** Page-section context lives in this leaf so data components can read it without joining the overview cycle. */
export const OverviewContext = createContext<OverviewValue | null>(null);
