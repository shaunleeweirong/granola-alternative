/**
 * Carries a user's data across a rename of the app.
 *
 * Electron names the support folder after the app, so renaming "Meeting Notes"
 * to "Clean Record" silently points the app at an empty folder. Every past
 * meeting is still on disk, and the 2.9 GB of downloaded models with it, but
 * the app can no longer see any of it and cheerfully starts downloading the
 * models again. Nothing is deleted; it just looks to the user as though the
 * upgrade ate their work.
 *
 * So on launch, if this app has no database of its own and a folder from a
 * previous name does, its contents move across.
 *
 * Deliberately not a copy: the models are gigabytes, and a rename within one
 * volume is instant and cannot half-finish. Deliberately entry by entry rather
 * than one rename of the whole folder, because Electron may already have
 * created the new folder before this runs, and renaming onto an existing
 * directory fails.
 *
 * Kept free of Electron imports so the rules are testable without an app.
 */

/** Support folder names this app has shipped under, most recent first. */
export const LEGACY_APP_NAMES = ["Meeting Notes", "granola-alternative"] as const;

/**
 * Presence of this file is what "has data" means. It is created on the first
 * launch and never removed, so it is a reliable marker that a folder belongs
 * to a version of this app that has actually been run.
 */
export const DATA_MARKER = "notes.db";

/** The filesystem calls this needs. Narrow, so tests can stand in. */
export interface MigrationIo {
  exists(target: string): boolean;
  readdir(target: string): string[];
  mkdir(target: string): void;
  rename(from: string, to: string): void;
  join(...parts: string[]): string;
}

export interface MigrationResult {
  /** The folder data came from, or null when nothing was moved. */
  from: string | null;
  moved: string[];
  /** Entries left behind because the new folder already had one by that name. */
  skipped: string[];
}

const NOTHING: MigrationResult = Object.freeze({ from: null, moved: [], skipped: [] });

export interface MigrationOptions {
  /** Where the app will look for its data from now on. */
  currentDir: string;
  /** Folders previous versions used, in the order they should be tried. */
  legacyDirs: string[];
  io: MigrationIo;
}

/**
 * Moves a previous version's data into the current support folder.
 *
 * Does nothing at all if the current folder already has a database, so this is
 * safe to call on every launch and cannot overwrite live data with something
 * older. The first legacy folder that has a database wins; later ones are left
 * untouched rather than merged, since merging two sets of meetings would
 * produce a history that never happened.
 */
export function migrateUserData({ currentDir, legacyDirs, io }: MigrationOptions): MigrationResult {
  if (io.exists(io.join(currentDir, DATA_MARKER))) return NOTHING;

  const source = legacyDirs.find(
    (dir) => dir !== currentDir && io.exists(io.join(dir, DATA_MARKER)),
  );
  if (source === undefined) return NOTHING;

  io.mkdir(currentDir);

  const moved: string[] = [];
  const skipped: string[] = [];
  for (const entry of io.readdir(source)) {
    const destination = io.join(currentDir, entry);
    if (io.exists(destination)) {
      // Electron writes its own caches into the folder at startup. Those are
      // rebuildable and the new ones are already in use, so the old copy goes
      // nowhere rather than clobbering them.
      skipped.push(entry);
      continue;
    }
    io.rename(io.join(source, entry), destination);
    moved.push(entry);
  }

  return { from: source, moved, skipped };
}
