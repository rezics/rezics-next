import { closeSync, fstatSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';

type DispatchPreparationOptions<T> = {
  briefPath: string;
  briefText: string;
  branch: string;
  worktree: string;
  createWorktree: () => void;
  installDependencies?: () => void;
  freezeFiles: () => T;
  removeWorktree: () => void;
  deleteBranch: () => void;
};

export class InitialDispatchPreparationError extends Error {
  constructor(cause: unknown, retained: readonly string[]) {
    const original = cause instanceof Error ? cause.message : String(cause);
    super(
      `Initial dispatch preparation failed: ${original}${retained.length ? `. Recovery: ${retained.join('; ')}` : ''}`,
      { cause },
    );
    this.name = 'InitialDispatchPreparationError';
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function prepareInitialDispatch<T>(options: DispatchPreparationOptions<T>): T {
  let briefIdentity: { dev: number; ino: number } | undefined;
  let worktreeCreated = false;
  let worktreeCreationStarted = false;

  try {
    if (pathExists(options.worktree)) throw new Error(`task worktree path already exists: ${options.worktree}`);

    const briefFile = openSync(options.briefPath, 'wx');
    const identity = fstatSync(briefFile);
    briefIdentity = { dev: identity.dev, ino: identity.ino };
    try {
      writeFileSync(briefFile, options.briefText, 'utf8');
    } finally {
      closeSync(briefFile);
    }

    worktreeCreationStarted = true;
    options.createWorktree();
    worktreeCreated = true;
    options.installDependencies?.();
    return options.freezeFiles();
  } catch (cause) {
    const retained: string[] = [];
    let gitArtifactsRemain = false;

    if (worktreeCreated) {
      try {
        options.removeWorktree();
      } catch {
        gitArtifactsRemain = true;
        retained.push(`worktree ${options.worktree} (branch ${options.branch})`);
      }
      if (!gitArtifactsRemain) {
        try {
          options.deleteBranch();
        } catch {
          gitArtifactsRemain = true;
          retained.push(`branch ${options.branch}`);
        }
      }
    } else if (worktreeCreationStarted) {
      gitArtifactsRemain = true;
      retained.push(
        `inspect worktree ${options.worktree} and branch ${options.branch}; Git worktree creation failed before ownership was confirmed`,
      );
    }

    if (briefIdentity) {
      if (gitArtifactsRemain) {
        retained.push(`dispatch brief ${options.briefPath}`);
      } else {
        try {
          const current = lstatSync(options.briefPath);
          if (current.dev === briefIdentity.dev && current.ino === briefIdentity.ino) unlinkSync(options.briefPath);
          else retained.push(`dispatch brief ${options.briefPath} (changed after creation)`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained.push(`dispatch brief ${options.briefPath}`);
        }
      }
    }

    throw new InitialDispatchPreparationError(cause, retained);
  }
}
