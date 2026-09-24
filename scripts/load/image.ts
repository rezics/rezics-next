/** Resolve the exact Fuseki image used by the Compose stack under measurement. */
export function fusekiImageFromCompose(source: string): { image: string; jenaVersion: string } {
  let inFuseki = false;
  let image: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (/^  [a-z][a-z0-9_-]*:$/.test(line)) inFuseki = line === '  fuseki:';
    else if (inFuseki) {
      image = line.match(/^    image:\s*(rezics\/fuseki:[^\s#]+)\s*$/)?.[1];
      if (image) break;
    }
  }
  const version = image?.match(/^rezics\/fuseki:(\d+\.\d+\.\d+)-cmd\d+\.\d+\.\d+$/)?.[1];
  if (!image || !version) throw new Error('Pinned Fuseki Compose image is missing or malformed');
  return { image, jenaVersion: version };
}
