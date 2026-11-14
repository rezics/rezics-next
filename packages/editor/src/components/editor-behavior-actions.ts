/** Runtime actions share the owning editor's visit and availability with command search and shortcuts. */
export interface EditorBehaviorAction {
  id: string;
  label: string;
  disabled?: boolean;
  run: () => boolean | void;
}
