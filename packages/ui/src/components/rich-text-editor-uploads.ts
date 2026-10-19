import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** A stored file is still pending until its occurrence is part of the live document. */
export function editorUploads(onState: (state: 'pending' | 'ready' | 'failed', count: number) => void) {
  const entries = new Map<string, { file: File; position: number; phase: 'uploading' | 'stored' | 'failed' }>();
  function report() {
    const count = [...entries.values()].filter(entry => entry.phase !== 'failed').length;
    onState(count ? 'pending' : entries.size ? 'failed' : 'ready', count);
  }
  return {
    start(occurrence: string, file: File, position: number) {
      entries.set(occurrence, { file, position, phase: 'uploading' }); report();
    },
    stored(occurrence: string) {
      const entry = entries.get(occurrence);
      if (entry) entry.phase = 'stored';
      report();
    },
    failed(occurrence: string) {
      const entry = entries.get(occurrence);
      if (entry) entry.phase = 'failed';
      report();
    },
    snapshot(document: ProseMirrorNode) {
      let changed = false;
      document.descendants(node => {
        const occurrence: unknown = node.attrs.id;
        if (node.type.name === 'image' && typeof occurrence === 'string' && entries.get(occurrence)?.phase === 'stored') {
          entries.delete(occurrence); changed = true;
        }
      });
      if (changed) report();
    },
    takeFailures() {
      const failed: Array<{ file: File; position: number }> = [];
      for (const [occurrence, entry] of entries) {
        if (entry.phase !== 'failed') continue;
        failed.push({ file: entry.file, position: entry.position }); entries.delete(occurrence);
      }
      report(); return failed;
    },
  };
}
