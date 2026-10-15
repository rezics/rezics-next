import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-6';

/** Compiler display bytes, not declaration bytes or heap size. Keep the audit's
 * formatting flags so a smaller display remains comparable to its first probe. */
export async function inferenceTypeSize(root: string, projectPath: string) {
  const { API } = await import('typescript/unstable/async');
  const api = new API({ cwd: root });
  try {
    const path = join(root, projectPath);
    const snapshot = await api.updateSnapshot({ openProjects: [path] });
    const project = snapshot.getProject(path);
    if (!project) throw new Error(`Cannot open inference project ${projectPath}`);
    const file = join(root, 'services/main/src/app.ts');
    const source = readFileSync(file, 'utf8');
    const position = source.indexOf('MainApp =');
    if (position < 0) throw new Error('Cannot locate MainApp type alias');
    const app = await project.checker.getTypeAtPosition(file, position);
    if (!app) throw new Error(`Cannot resolve MainApp in ${projectPath}`);
    const property = await project.checker.getPropertyOfType(app, '~Routes');
    const routes = property && await project.checker.getTypeOfSymbol(property);
    if (!routes) throw new Error(`Cannot resolve MainApp routes in ${projectPath}`);
    const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
    const rendered = await project.checker.typeToString(app, undefined, flags);
    const renderedRoutes = await project.checker.typeToString(routes, undefined, flags);
    if (!rendered || !renderedRoutes || /\.\.\. \d+ more/.test(rendered + renderedRoutes))
      throw new Error(`Incomplete inferred type display in ${projectPath}`);
    return { appBytes: Buffer.byteLength(rendered), routesBytes: Buffer.byteLength(renderedRoutes), rendered, renderedRoutes };
  } finally { await api.close(); }
}
