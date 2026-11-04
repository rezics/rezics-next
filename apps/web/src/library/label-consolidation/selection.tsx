import { createContext, useContext } from 'react';
import type { ShelfSelectionProps } from '@rezics/ui/shelf-list';
import type { LabelShelfEntry } from '../label-shelf-read';

export const ConsolidationSelection = createContext<((entry: LabelShelfEntry) => ShelfSelectionProps) | null>(null);
export function useConsolidationSelection() {
  return useContext(ConsolidationSelection);
}
