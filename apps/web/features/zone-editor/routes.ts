/** Addresses for the Zone editor. The space segment is the one the page was opened with. */
export function zoneEditorPath(space: string): string {
  return `/manage/z/${encodeURIComponent(space)}`;
}

export function zonePreviewPath(space: string): string {
  return `/manage/z/${encodeURIComponent(space)}/preview`;
}

export function zoneNavigationPath(space: string): string {
  return `${zoneEditorPath(space)}/navigation`;
}

export function zoneRealmPath(space: string): string {
  return `${zoneEditorPath(space)}/realm`;
}

export function zoneThemePath(space: string): string {
  return `${zoneEditorPath(space)}/theme`;
}

/** A stable management address that still works when public Space resolution is retired. */
export function zoneLifecyclePath(space: string, returnAddress?: string): string {
  return `${zoneEditorPath(space)}/lifecycle${returnAddress ? `?address=${encodeURIComponent(returnAddress)}` : ''}`;
}
