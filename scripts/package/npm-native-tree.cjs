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
  const identity = process.argv[4] === 'identity' || process.argv[4] === 'composition';
  const tree = await new Arborist({ path: process.argv[3], offline: true,
    ignoreScripts: true, strictPeerDeps: true, legacyPeerDeps: false }).loadVirtual();
  const nodes = [...tree.inventory.values()].map(node => ({
    path: node.location, name: node.package.name || node.name, version: node.version,
    resolved: node.resolved || null, integrity: node.integrity || null,
    ...(identity ? { slotName: node.parent ? node.name : null, isLink: node.isLink,
      linkTarget: node.isLink ? node.target.location : null, isWorkspace: !!node.isWorkspace,
      parent: node.resolveParent?.location ?? null } : {}),
    edges: [...node.edgesOut.values()].map(edge => ({ name: edge.name, specifier: edge.spec,
      kind: edge.type, to: edge.to?.location ?? null, error: edge.error || null })),
  }));
  let projection;
  if (process.argv[4] && !identity || process.argv[4] === 'composition') {
    const target = JSON.parse(process.argv[4] === 'composition' ? process.argv[5] : process.argv[4]);
    const path = require('node:path');
    const lib = path.dirname(requireNpm.resolve('@npmcli/arborist'));
    const { checkPlatform } = requireNpm('npm-install-checks');
    const optionalSet = require(path.join(lib, 'optional-set.js'));
    const resetDepFlags = require(path.join(lib, 'reset-dep-flags.js'));
    const calcDepFlags = require(path.join(lib, 'calc-dep-flags.js'));
    const ordered = [...tree.inventory.values()].sort((a, b) => a.location < b.location ? -1 : a.location > b.location ? 1 : 0);
    const lockedOptional = new Map(ordered.map(node => [node.location, node.optional]));
    resetDepFlags(tree);
    calcDepFlags(tree);
    const metadata = ordered.map(node => ({ path: node.location, optional: node.optional,
      lockedOptional: lockedOptional.get(node.location), os: node.package.os ?? null, cpu: node.package.cpu ?? null }));
    const platformErrors = [];
    const omissions = [];
    for (const node of ordered) {
      if (node.inert) continue;
      try { checkPlatform(node.package, false, target); }
      catch (error) {
        if (error.code !== 'EBADPLATFORM') throw error;
        if (!node.optional) platformErrors.push({ path: node.location, code: error.code, required: error.required });
        else for (const omitted of optionalSet(node)) {
          if (!omitted.inert) omissions.push({ path: omitted.location, causePath: node.location, reason: 'platform' });
          omitted.inert = true;
        }
      }
    }
    projection = { target, metadata, platformErrors,
      omissions: omissions.sort((a, b) => a.path.localeCompare(b.path)),
      activePaths: ordered.filter(node => !node.inert).map(node => node.location) };
  }
  process.stdout.write(JSON.stringify({ npmVersion: requireNpm('./package.json').version,
    arboristVersion: requireNpm('@npmcli/arborist/package.json').version, nodes,
    ...(projection ? { projection } : {}) }));
}
main().catch(error => {
  if (['identity', 'composition'].includes(process.argv[4])) process.stdout.write(JSON.stringify({
    error: { code: error.code || error.name, message: error.message } }));
  console.error(error); process.exitCode = 1;
});
