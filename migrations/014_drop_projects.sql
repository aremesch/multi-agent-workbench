-- Multi-Agent Workbench — remove the Projects / polyrepo-workspace layer.
--
-- Projects added no functional value: workspace_root was written once at
-- import and never read, and agents always spawn scoped to a single repo.
-- Repos are now the only top-level entity. Rebuild `repos` without the
-- vestigial `project_id` (the 12-step dance, same as migration 004), then
-- drop the `projects` table.
--
-- The migration runner wraps this file in a transaction, so `PRAGMA
-- foreign_keys = OFF` wouldn't take effect here. `defer_foreign_keys` does
-- work inside a tx: FK checks are postponed until COMMIT, by which point
-- `repos_new` has been renamed to `repos` with the same IDs and the child
-- rows in `worktrees`/`agents` still resolve. Dropping repos' FK to projects
-- (via the rebuild) must happen before `DROP TABLE projects`.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE repos_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  origin_url     TEXT,
  default_branch TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Coalesce so repos that still inherited their branch from a project (stored
-- NULL on the repo) keep the effective branch they resolved to before.
INSERT INTO repos_new (id, user_id, path, origin_url, default_branch, created_at, updated_at)
SELECT r.id, r.user_id, r.path, r.origin_url,
       COALESCE(r.default_branch, p.default_branch),
       r.created_at, r.updated_at
  FROM repos r
  LEFT JOIN projects p ON p.id = r.project_id;

DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;

CREATE INDEX idx_repos_user ON repos(user_id);
-- idx_repos_project intentionally not recreated — project_id column is gone.

DROP INDEX IF EXISTS idx_projects_user;
DROP TABLE projects;
