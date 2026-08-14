/**
 * Migration v4 → v5 (additive roles). The interesting case is an EXISTING
 * deployment: every user's role_id was written by the login path, and the new
 * code reads role_id as "an admin chose this — ignore groups". Get that wrong
 * and a live gateway either widens access silently or drops people's roles, so
 * build a v4-shaped database by hand and migrate it.
 */

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./index.js";
import { Repo } from "./repo.js";

/** The v1 shape of the tables this migration touches, stamped as v4. */
function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE roles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      default_max_tier TEXT NOT NULL DEFAULT 'none',
      is_admin INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      iss TEXT NOT NULL,
      sub TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
      last_login_at TEXT,
      UNIQUE (iss, sub)
    );
    CREATE TABLE group_mappings (
      id INTEGER PRIMARY KEY,
      iss TEXT NOT NULL,
      claim_value TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      UNIQUE (iss, claim_value)
    );
    INSERT INTO roles (id, name, default_max_tier, is_admin, protected) VALUES
      (1, 'viewer', 'read', 0, 1), (2, 'editor', 'write', 0, 1),
      (3, 'admin', 'destructive', 1, 1), (4, 'managers-ro', 'read', 0, 0);
    -- one user with a role (the state prod is in) and one without
    INSERT INTO users (id, iss, sub, email, role_id) VALUES
      (1, 'https://idp', 'has-role', 'daniel@test', 4),
      (2, 'https://idp', 'no-role', 'newcomer@test', NULL);
    INSERT INTO group_mappings (iss, claim_value, role_id) VALUES ('https://idp', 'g-core', 2);
    PRAGMA user_version = 4;
  `);
  return db;
}

const roleSource = (db: DatabaseSync, sub: string): string | null =>
  (db.prepare("SELECT role_source FROM users WHERE sub = ?").get(sub) as { role_source: string | null })
    .role_source;

describe("migration v4 → v5", () => {
  it("keeps an existing role as an explicit override, so nobody's access moves", () => {
    const db = legacyDatabase();
    migrate(db);
    const repo = new Repo(db);

    // The pre-existing role still resolves and now REPLACES group mappings —
    // today's behaviour exactly, even though this user is in a mapped group.
    expect(repo.resolveOidcRoles("https://idp", "has-role", ["g-core"]).map((r) => r.name)).toEqual([
      "managers-ro",
    ]);
    expect(roleSource(db, "has-role")).toBe("admin");

    // A user without one now picks up every mapped group (the new behaviour).
    expect(repo.resolveOidcRoles("https://idp", "no-role", ["g-core"]).map((r) => r.name)).toEqual([
      "editor",
    ]);
    expect(roleSource(db, "no-role")).toBeNull();
  });

  it("creates the login-roles table, and re-running changes nothing", () => {
    const db = legacyDatabase();
    migrate(db);
    const repo = new Repo(db);
    repo.setLoginRoles(2, [1, 2]);
    expect(repo.loginRoles(2).map((r) => r.name)).toEqual(["editor", "viewer"]);

    // Re-entering the same migration must not throw (duplicate column/table)
    // nor disturb stored rows — the ADD COLUMN is guarded by a column check.
    db.exec("PRAGMA user_version = 4");
    expect(() => migrate(db)).not.toThrow();
    expect(repo.loginRoles(2)).toHaveLength(2);
    expect(roleSource(db, "no-role")).toBeNull();
  });

  it("carries a fresh database to the current schema version", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    // Bump with every new migration block — the assertion exists so adding one
    // without thinking about the upgrade path fails here first.
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
  });
});
