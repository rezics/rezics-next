import { renameLinuxDirectory } from '@rezics/launcher-core/directory-move';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Supply the directory to move and its destination.');
console.log(await renameLinuxDirectory(source, destination));
