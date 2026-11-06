import { useMemo } from 'react';
import { usePersonalImportVisit, type VndbVisit } from '../personal-list-import/visit';
import { sameCommand, type MalCommand, type MalDeliveryCustody } from './contract';

export type MalVisit = VndbVisit & {
  locale: string;
  delivery: () => MalDeliveryCustody | null;
  retainDelivery: (custody: MalDeliveryCustody) => void;
  resolveDelivery: (command: MalCommand) => void;
};

// Keep one original uncertain command per sender in memory, independently of the private page lifetime.
const uncertainDeliveries = new Map<string, MalDeliveryCustody>();

export function useMalVisit(): MalVisit | null {
  const visit = usePersonalImportVisit();
  return useMemo(() => {
    if (!visit) return null;
    const key = visit.subject;
    return {
      ...visit,
      delivery() {
        const custody = uncertainDeliveries.get(key);
        return custody ? structuredClone(custody) : null;
      },
      retainDelivery(custody: MalDeliveryCustody) {
        uncertainDeliveries.set(key, structuredClone(custody));
      },
      resolveDelivery(command: MalCommand) {
        const custody = uncertainDeliveries.get(key);
        if (custody && sameCommand(custody.command, command)) uncertainDeliveries.delete(key);
      },
    };
  }, [visit]);
}
