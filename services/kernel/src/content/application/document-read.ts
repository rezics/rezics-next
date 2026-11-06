import {
  CONTENT_DOCUMENT_BYTES,
  type ContentAmbient,
  type ContentApplicationPorts,
  type ContentDeadline,
} from '../contract/index.ts';
import { admitDocumentRead, documentReadExhausted } from '../core/index.ts';

export function createDocumentReads(ports: Pick<ContentApplicationPorts, 'documents'>, ambient: ContentAmbient) {
  return {
    elapsed(deadline: ContentDeadline): boolean {
      return documentReadExhausted(ambient.now(), deadline, {});
    },
    admits(route: number | null, deadline: ContentDeadline, maxSourceBytes?: number): boolean {
      return admitDocumentRead({
        route,
        deadline,
        now: ambient.now(),
        maxSourceBytes,
        maxBytes: CONTENT_DOCUMENT_BYTES,
      });
    },
    async read(
      client: Parameters<ContentApplicationPorts['documents']['read']>[0],
      route: number,
      id: string,
      deadline: ContentDeadline,
      maxSourceBytes?: number,
    ) {
      if (!this.admits(route, deadline, maxSourceBytes)) return null;
      const found = await ports.documents.read(client, route, id, maxSourceBytes);
      if (documentReadExhausted(ambient.now(), deadline, found)) return null;
      return found;
    },
  };
}
