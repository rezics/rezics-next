import { serializeDocument, type DocumentSnapshot } from '@rezics/document';

export type DocumentSaveState = 'pending' | 'ready' | 'failed';

/** The latest complete edit remains available when binding, serialization or its owner fails. */
export function documentPublication(
  reconcile: (document: DocumentSnapshot, imported?: boolean) => Promise<DocumentSnapshot>,
  persist: (value: string) => void,
  onState: (state: DocumentSaveState, error?: unknown, retained?: DocumentSnapshot) => void,
) {
  let sequence = 0;
  let current: DocumentSnapshot | null = null;
  let imported = false;
  async function publish(document: DocumentSnapshot, importing = false): Promise<boolean> {
    current = document;
    imported = importing;
    const attempt = ++sequence;
    try {
      onState('pending', undefined, document);
      const bound = await reconcile(document, importing);
      if (attempt !== sequence) return false;
      current = bound;
      persist(serializeDocument(bound));
      onState('ready');
      return true;
    } catch (error) {
      if (attempt === sequence) onState('failed', error);
      return false;
    }
  }
  return { publish, current: () => current,
    retry: () => current ? publish(current, imported) : Promise.resolve(false),
    invalidate: () => { sequence++; onState('pending'); },
    cancel: () => { sequence++; },
  };
}
