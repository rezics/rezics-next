/** Save a file the person asked for, such as their data or an audit export. */
export function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
