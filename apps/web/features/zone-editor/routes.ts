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
