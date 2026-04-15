/**
 * Slugify a user-entered agent title into a filesystem-safe directory name.
 *
 * Used by the spawn flow to name the worktree dir (and branch-adjacent
 * artefacts). Lowercase kebab-case: strips diacritics, collapses any run of
 * non-[a-z0-9] into a single '-', trims leading/trailing dashes, caps at 60
 * chars. Returns '' if the input has no sluggable characters — the caller
 * must treat that as a validation error.
 */
export function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}
