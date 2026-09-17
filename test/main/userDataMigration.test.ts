import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migrateUserData,
  DATA_MARKER,
  type MigrationIo,
} from "../../src/main/userDataMigration.ts";

/**
 * An in-memory filesystem holding directories as sets of entry names. Enough
 * to exercise the rules without touching a disk, and it records every rename
 * so the tests can assert on what moved rather than on what was reported.
 */
function fakeIo(initial: Record<string, string[]>): MigrationIo & {
  dirs: Map<string, Set<string>>;
  renames: Array<[string, string]>;
} {
  const dirs = new Map<string, Set<string>>(
    Object.entries(initial).map(([dir, entries]) => [dir, new Set(entries)]),
  );
  const renames: Array<[string, string]> = [];

  const split = (target: string): [string, string] => {
    const cut = target.lastIndexOf("/");
    return [target.slice(0, cut), target.slice(cut + 1)];
  };

  return {
    dirs,
    renames,
    join: (...parts) => parts.join("/"),
    exists(target) {
      if (dirs.has(target)) return true;
      const [parent, name] = split(target);
      return dirs.get(parent)?.has(name) ?? false;
    },
    readdir(target) {
      return [...(dirs.get(target) ?? [])];
    },
    mkdir(target) {
      if (!dirs.has(target)) dirs.set(target, new Set());
    },
    rename(from, to) {
      const [fromParent, fromName] = split(from);
      const [toParent, toName] = split(to);
      dirs.get(fromParent)?.delete(fromName);
      dirs.get(toParent)?.add(toName);
      renames.push([from, to]);
    },
  };
}

const OLD = "/Support/Meeting Notes";
const NEW = "/Support/Clean Record";

test("a rename carries the database and the models across", () => {
  const io = fakeIo({ [OLD]: [DATA_MARKER, "models"] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD], io });

  assert.equal(result.from, OLD);
  assert.deepEqual(result.moved.sort(), ["models", DATA_MARKER]);
  assert.deepEqual([...(io.dirs.get(NEW) ?? [])].sort(), ["models", DATA_MARKER]);
  assert.deepEqual([...(io.dirs.get(OLD) ?? [])], [], "and nothing is left behind");
});

test("nothing moves once this version has a database of its own", () => {
  // The dangerous case: a second launch must not drag an older library back
  // over the one now in use.
  const io = fakeIo({ [OLD]: [DATA_MARKER, "models"], [NEW]: [DATA_MARKER] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD], io });

  assert.equal(result.from, null);
  assert.deepEqual(io.renames, []);
  assert.ok(io.dirs.get(OLD)?.has(DATA_MARKER), "the old folder is untouched");
});

test("a folder Electron created but never filled is still migrated into", () => {
  // Electron writes its own caches into the support folder at startup, so the
  // new folder can exist, and be non-empty, before there is any app data in it.
  const io = fakeIo({ [OLD]: [DATA_MARKER, "models"], [NEW]: ["Cache"] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD], io });

  assert.equal(result.from, OLD);
  assert.deepEqual(result.moved.sort(), ["models", DATA_MARKER]);
});

test("an entry the new folder already has is left behind, not clobbered", () => {
  const io = fakeIo({ [OLD]: [DATA_MARKER, "Cache"], [NEW]: ["Cache"] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD], io });

  assert.deepEqual(result.moved, [DATA_MARKER]);
  assert.deepEqual(result.skipped, ["Cache"]);
  assert.ok(io.dirs.get(OLD)?.has("Cache"), "the old copy stays where it was");
});

test("the first legacy folder with data wins, and the rest are not merged", () => {
  // Merging two libraries would produce a meeting history that never happened.
  const older = "/Support/granola-alternative";
  const io = fakeIo({ [OLD]: [DATA_MARKER], [older]: [DATA_MARKER, "models"] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD, older], io });

  assert.equal(result.from, OLD);
  assert.ok(io.dirs.get(older)?.has("models"), "the older folder is left alone");
});

test("a fresh install with no previous folder does nothing at all", () => {
  const io = fakeIo({});

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD], io });

  assert.deepEqual(result, { from: null, moved: [], skipped: [] });
  assert.deepEqual(io.renames, []);
});

test("a legacy folder that was never launched is ignored", () => {
  // A folder can exist with stray files in it and no database. There is
  // nothing worth carrying over, and moving it would be guesswork.
  const io = fakeIo({ [OLD]: ["Cache"] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [OLD], io });

  assert.equal(result.from, null);
  assert.deepEqual(io.renames, []);
});

test("a legacy name matching the current one is skipped rather than self-moved", () => {
  // Guards the case where the rename is reverted or a name is listed twice.
  const io = fakeIo({ [NEW]: [DATA_MARKER] });

  const result = migrateUserData({ currentDir: NEW, legacyDirs: [NEW], io });

  assert.equal(result.from, null);
  assert.deepEqual(io.renames, []);
});
