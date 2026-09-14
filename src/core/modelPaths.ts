/**
 * Where to look for a speech or language model.
 *
 * A packaged build ships a model inside the app bundle so it works the moment
 * it is installed, with no download and no Terminal. A model the user has
 * downloaded themselves lives in their application-support folder and must win,
 * so replacing the bundled model with a better one never requires a new build.
 *
 * Pure so the precedence is testable without a filesystem or Electron.
 */
export interface ModelLookup {
  /** File name, e.g. "ggml-base.en.bin". */
  name: string;
  /** Writable per-user model directory. Searched first. */
  userModelDir: string | null;
  /** Read-only directory inside the installed app. Searched second. */
  bundledModelDir: string | null;
  /** Injected so tests need no disk. */
  exists: (path: string) => boolean;
  /** Path separator, so the same tests pass on any host. */
  join?: (...parts: string[]) => string;
}

export interface ResolvedModel {
  path: string;
  source: "user" | "bundled";
}

const defaultJoin = (...parts: string[]): string => parts.join("/");

export function resolveModelPath(lookup: ModelLookup): ResolvedModel | null {
  const join = lookup.join ?? defaultJoin;
  const name = lookup.name.trim();
  if (!name) return null;

  if (lookup.userModelDir) {
    const candidate = join(lookup.userModelDir, name);
    if (lookup.exists(candidate)) return { path: candidate, source: "user" };
  }

  if (lookup.bundledModelDir) {
    const candidate = join(lookup.bundledModelDir, name);
    if (lookup.exists(candidate)) return { path: candidate, source: "bundled" };
  }

  return null;
}

/**
 * Where a model the user downloads should be written. Always the writable
 * per-user directory, never the app bundle, which is read-only once installed.
 */
export function userModelTarget(
  userModelDir: string,
  name: string,
  join: (...parts: string[]) => string = defaultJoin
): string {
  return join(userModelDir, name);
}
