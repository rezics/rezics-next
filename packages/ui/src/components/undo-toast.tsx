import { toast } from '../shadcn/toast.tsx';

export const undoToastLabels = { undo: 'Undo' };
const id = 'rezics-undo';
let current: { deadline: number; timer: ReturnType<typeof setTimeout> } | undefined;

/** Result feedback with one replaceable undo window; composed on the existing shadcn toast manager. */
export function undoToast(label: string, onUndo: () => void, labels: Partial<typeof undoToastLabels> = {}) {
  if (current) clearTimeout(current.timer);
  const entry = {
    deadline: Date.now() + 8000,
    timer: setTimeout(() => {
      if (current === entry) {
        current = undefined;
        toast.close(id);
      }
    }, 8000),
  };
  current = entry;
  return toast.add({
    id,
    title: label,
    timeout: 8000,
    priority: 'low',
    onClose() {
      if (current === entry) {
        clearTimeout(entry.timer);
        current = undefined;
      }
    },
    actionProps: {
      children: labels.undo ?? undoToastLabels.undo,
      onClick() {
        if (current !== entry || Date.now() >= entry.deadline) return;
        current = undefined;
        clearTimeout(entry.timer);
        toast.close(id);
        onUndo();
      },
    },
  });
}
