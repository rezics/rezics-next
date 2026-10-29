import { useEffect, useState } from 'react';

type Metadata = { commit: string; builtAt: string };

export function BuildMetadata() {
  const [metadata, setMetadata] = useState<Metadata>();

  useEffect(() => {
    void fetch('/build.json')
      .then((response) => response.json() as Promise<Metadata>)
      .then(setMetadata);
  }, []);

  if (!metadata) return <p>Loading build metadata…</p>;
  return (
    <dl>
      <dt>Commit</dt>
      <dd>{metadata.commit}</dd>
      <dt>Built at</dt>
      <dd>{metadata.builtAt}</dd>
    </dl>
  );
}

export function LedgerLink() {
  const [commit, setCommit] = useState<string>();

  useEffect(() => {
    void fetch('/build.json')
      .then((response) => response.json() as Promise<Metadata>)
      .then((metadata) => setCommit(metadata.commit));
  }, []);

  return (
    <a href={`https://github.com/rezics/rezics-next/blob/${commit ?? 'main'}/docs/development/page-stories.md`}>
      page story coverage map
    </a>
  );
}
