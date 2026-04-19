-- Multi-Agent Workbench — make repos.project_id optional + add repos.default_branch.
--
-- Projects were demoted out of the spawn dialog: repos are now the top-level
-- entity, and new repos created from the spawn form have no project. SQLite
-- can't relax a NOT NULL constraint in place, so we rebuild the table (12-step
-- dance) and lift default_branch from projects onto each repo.

-- The migration runner wraps this file in a transaction, so `PRAGMA
-- foreign_keys = OFF` wouldn't take effect here. `defer_foreign_keys`
-- does work inside a tx: FK checks are postponed until COMMIT, by which
-- point `repos_new` has been renamed to `repos` with the same IDs and
-- the child rows in `worktrees`/`agents` still resolve.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE repos_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  path           TEXT NOT NULL,
  origin_url     TEXT,
  default_branch TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

INSERT INTO repos_new (id, user_id, project_id, path, origin_url, default_branch, created_at, updated_at)
SELECT r.id, r.user_id, r.project_id, r.path, r.origin_url,
       p.default_branch,
       r.created_at, r.updated_at
  FROM repos r
  LEFT JOIN projects p ON p.id = r.project_id;

DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;

CREATE INDEX idx_repos_project ON repos(project_id);
CREATE INDEX idx_repos_user ON repos(user_id);
