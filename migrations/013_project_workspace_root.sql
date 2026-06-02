-- Multi-Agent Workbench — add the optional shared-parent ("workspace root")
-- path to projects.
--
-- A polyrepo workspace is several independent git repos that live as siblings
-- under one parent directory. `workspace_root` records that parent so the
-- project page can group the repos and offer batch import. Nullable: not every
-- project is a polyrepo workspace, and the column is set lazily on the first
-- batch import from a workspace folder.
ALTER TABLE projects ADD COLUMN workspace_root TEXT;
