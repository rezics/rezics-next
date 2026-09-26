// Run only by the documented npm oracle, using the checked npm installation.
const { createRequire } = require('node:module');
const requireNpm = createRequire(process.argv[2]);
const Arborist = requireNpm('@npmcli/arborist');
// Virtual topology must stay offline even if an upstream code path changes.
for (const name of ['node:http', 'node:https', 'node:net']) {
  const mod = require(name);
  for (const method of ['request', 'get', 'connect', 'createConnection']) {
    if (mod[method]) mod[method] = () => { throw new Error('native oracle forbids network'); };
  }
}
globalThis.fetch = () => { throw new Error('native oracle forbids network'); };
async function main() {
  const tree = await new Arborist({ path: process.argv[3], offline: true,
    ignoreScripts: true, strictPeerDeps: true, legacyPeerDeps: false }).loadVirtual();
  const nodes = [...tree.inventory.values()].map(node => ({
    path: node.location, name: node.package.name || node.name, version: node.version,
    resolved: node.resolved || null, integrity: node.integrity || null,
    edges: [...node.edgesOut.values()].map(edge => ({ name: edge.name, specifier: edge.spec,
      kind: edge.type, to: edge.to?.location ?? null, error: edge.error || null })),
  }));
  process.stdout.write(JSON.stringify({ npmVersion: requireNpm('./package.json').version,
    arboristVersion: requireNpm('@npmcli/arborist/package.json').version, nodes }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
