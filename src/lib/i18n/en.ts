/**
 * English dictionary — the source of truth for all i18n keys.
 * Other locale files are typed as Partial<typeof en>.
 */
const en = {
  // ── Navigation / layout ──────────────────────────────────────────
  'nav.appTitle': 'Multi-Agent Workbench',
  'nav.settings': 'Settings',
  'nav.account': 'Account',
  'nav.about': 'About',
  'nav.logout': 'Logout',
  'nav.userMenu': 'User menu',
  'nav.showSidebar': 'Show sidebar',
  'nav.hideSidebar': 'Hide sidebar',

  // ── About dialog ─────────────────────────────────────────────────
  'about.title': 'About',
  'about.version': 'Version',
  'about.build': 'Build',
  'about.buildDate': 'Build date',
  'about.tagline':
    'Self-hosted workbench for orchestrating LLM coding agents across git repos.',

  // ── Sidebar ──────────────────────────────────────────────────────
  'sidebar.repositories': 'Repositories',
  'sidebar.archive': 'Archive',
  'sidebar.noRepos': 'No repositories yet.',
  'sidebar.noArchived': 'No archived agents.',
  'sidebar.collapse': 'Collapse',
  'sidebar.expand': 'Expand',
  'sidebar.editRepo': 'Edit repository',

  // ── Edit repo dialog ─────────────────────────────────────────────
  'repoEdit.title': 'Edit repository',
  'repoEdit.path': 'Path',
  'repoEdit.pathReadOnlyHint': 'read-only — changing the path would break existing worktrees',
  'repoEdit.save': 'Save',
  'repoEdit.saving': 'Saving\u2026',
  'repoEdit.loading': 'Loading\u2026',
  'repoEdit.failedLoad': 'Failed to load repository',
  'repoEdit.failedSave': 'Failed to save repository',

  // ── Login ────────────────────────────────────────────────────────
  'login.title': 'Sign in',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.error.required': 'Username and password required',
  'login.error.invalid': 'Invalid credentials',
  'login.error.rateLimited': 'Too many attempts — wait a minute and try again',

  // ── Account ──────────────────────────────────────────────────────
  'account.title': 'Account',
  'account.signedInAs': 'Signed in as {username}',
  'account.changePassword': 'Change password',
  'account.currentPw': 'Current password',
  'account.newPw': 'New password',
  'account.confirmPw': 'Confirm new password',
  'account.updatePw': 'Update password',
  'account.pwUpdated': 'Password updated. Other sessions have been signed out.',
  'account.error.notSignedIn': 'Not signed in',
  'account.error.allRequired': 'All fields are required',
  'account.error.minLength': 'New password must be at least 8 characters',
  'account.error.mismatch': 'New passwords do not match',
  'account.error.samePw': 'New password must differ from current password',
  'account.error.wrongCurrent': 'Current password incorrect',

  // ── Settings ─────────────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.subtitle': 'Tune the workbench to your preferences.',
  'settings.appearance': 'Appearance',
  'settings.appearanceDesc':
    'Pick a theme. Changes apply immediately and sync across tabs on reload.',
  'settings.themeLabel': 'Theme',
  'settings.language': 'Language',
  'settings.languageDesc': 'Select your preferred language.',
  'settings.agentDefaults': 'Agent Defaults',
  'settings.agentDefaultsDesc':
    'Default spawn flags for each CLI kind. Override per-agent when spawning.',
  'settings.noOptionalFlags': 'No optional flags.',
  'settings.notifications': 'Notifications',
  'settings.notificationsDesc':
    'Push notifications let your phone buzz when agents need attention.',
  'settings.pushNotConfigured':
    'VAPID keys not configured. Run pnpm vapid:gen and add keys to .env to enable push.',
  'settings.pushEnable': 'Enable push notifications',
  'settings.pushEnabled': 'Push notifications enabled',
  'settings.notifyWhen': 'Notify me when:',
  'settings.notify.prompt_detected': 'Agent needs permission',
  'settings.notify.task_done': 'Agent finishes task',
  'settings.notify.error': 'Agent hits an error',
  'settings.notify.exited': 'Agent exits unexpectedly',
  'settings.git.title': 'Git identity',
  'settings.git.desc':
    'Author your agents\u2019 commits with a name and email of your choice. Leave empty to fall back to your username.',
  'settings.git.nameLabel': 'Author name',
  'settings.git.emailLabel': 'Author email',
  'settings.git.githubNoreplyHint':
    'Tip: for public GitHub repos, use your privacy email in the form <id>+<username>@users.noreply.github.com \u2014 find it at GitHub \u2192 Settings \u2192 Emails.',
  'settings.git.appliesToNewAgents': 'Applies to agents spawned after saving.',
  'settings.git.save': 'Save identity',
  'settings.git.saved': 'Git identity saved.',
  'settings.git.error.nameRequired': 'Author name is required',
  'settings.git.error.nameInvalid': 'Author name contains invalid characters',
  'settings.git.error.emailRequired': 'Author email is required',
  'settings.git.error.emailInvalid': 'Enter a valid email address',
  'settings.mobileQuickKeys.title': 'Mobile quick keys',
  'settings.mobileQuickKeys.desc':
    'Keys the soft keyboard hides (arrows, Shift+Tab, Esc, Ctrl+C) shown as a touch bar under the terminal.',
  'settings.mobileQuickKeys.mode.auto': 'Auto',
  'settings.mobileQuickKeys.mode.auto.desc': 'Visible on touch devices, hidden elsewhere.',
  'settings.mobileQuickKeys.mode.always': 'Always',
  'settings.mobileQuickKeys.mode.always.desc': 'Always visible, even on desktop.',
  'settings.mobileQuickKeys.mode.never': 'Never',
  'settings.mobileQuickKeys.mode.never.desc': 'Hidden everywhere.',

  // ── Banners ──────────────────────────────────────────────────────
  'banner.gitIdentityUnset':
    'Your git author identity is not set \u2014 agent commits will be attributed to your username with a synthetic email.',
  'banner.gitIdentityAction': 'Configure now',

  // Theme descriptions (keyed by theme id)
  'theme.desc.dark-slate': 'Near-black neutrals with a cool blue accent.',
  'theme.desc.dark-midnight': 'Deep blue-tinged surfaces, softer contrast.',
  'theme.desc.amoled': 'True-black for OLED displays, violet accent.',
  'theme.desc.light-default': 'M3 baseline light with a violet primary.',
  'theme.desc.expressive-plum': 'M3 expressive: warm plum surfaces, teal accent.',

  // ── Spawn agent form ─────────────────────────────────────────────
  'spawn.title': 'Spawn agent',
  'spawn.role': 'Role',
  'spawn.repo': 'Repo',
  'spawn.project': 'Project',
  'spawn.cliKind': 'CLI kind',
  'spawn.name': 'Name',
  'spawn.taskTitle': 'Task title',
  'spawn.taskBody': 'Task body',
  'spawn.optional': 'optional',
  'spawn.sentAsInitialInput': 'optional, sent as initial input',
  'spawn.absPath': 'absolute filesystem path',
  'spawn.originUrl': 'Origin URL',
  'spawn.defaultBranch': 'Default branch',
  'spawn.projectName': 'Project name',
  'spawn.systemPrompt': 'System prompt',
  'spawn.cancel': 'Cancel',
  'spawn.spawn': 'Spawn',
  'spawn.spawning': 'Spawning\u2026',
  'spawn.creating': 'Creating\u2026',
  'spawn.adding': 'Adding\u2026',
  'spawn.createRole': 'Create role',
  'spawn.addRepo': 'Add repo',
  'spawn.createProject': 'Create project',
  'spawn.newRole': '+ Role',
  'spawn.newRepo': '+ Repo',
  'spawn.newProject': '+ Project',
  'spawn.collapseRole': '\u2212',
  'spawn.collapseRepo': '\u2212',
  'spawn.collapseProject': '\u2212',
  'spawn.titleCreateRole': 'Create new role',
  'spawn.titleAddRepo': 'Add new repo',
  'spawn.titleCreateProject': 'Create new project',
  'spawn.error.roleRepoRequired': 'Role and repo are required',
  'spawn.error.unknownRole': 'Unknown role',
  'spawn.error.unknownRepo': 'Unknown repo',
  'spawn.error.unknownCliKind': 'Unknown CLI kind',
  'spawn.error.orphanedRepo': 'Repo is orphaned (no project)',
  'spawn.error.titleRequired': 'Title is required',
  'spawn.error.titleUnslugifiable': 'Title must contain at least one letter or digit',
  'spawn.error.titleTaken': 'Title already used — pick a different one',
  'spawn.error.spawnFailed': 'Spawn failed',
  'spawn.error.worktreeFailed': 'Worktree creation failed: {message}',
  'spawn.error.failedCreateRole': 'Failed to create role',
  'spawn.error.failedCreateProject': 'Failed to create project',
  'spawn.error.failedAddRepo': 'Failed to add repo',
  'spawn.error.networkError': 'Network error',
  'spawn.advanced': 'Advanced',

  // ── Agent card / terminal ────────────────────────────────────────
  'agent.openTerminal': 'Open terminal for {roleName}',
  'agent.tmuxGone': '(tmux session gone)',
  'agent.loading': 'loading\u2026',
  'agent.empty': '(empty)',
  'agent.promptDetected': 'Prompt detected',
  'agent.spawnAgent': 'Spawn agent',
  'agent.noLiveAgents': 'No live agents. Click the + button to spawn one.',
  'agent.failedLoadLog': 'Failed to load log: {error}',
  'agent.loadingLog': 'Loading log\u2026',
  'agent.quickKeysLabel': 'Terminal quick keys',

  // ── Roles ────────────────────────────────────────────────────────
  'roles.title': 'Roles',
  'roles.newRole': 'New role',
  'roles.noRoles': 'No roles yet. A role bundles a CLI adapter + system prompt.',
  'roles.backToDashboard': '\u2190 Back to dashboard',

  // ── New role ─────────────────────────────────────────────────────
  'newRole.title': 'New role',

  // ── Projects ─────────────────────────────────────────────────────
  'projects.newProject': 'New project',
  'projects.defaultBranch': 'default branch {branch}',
  'projects.repositories': 'Repositories ({count})',
  'projects.newRepo': 'New repo',
  'projects.noRepos': 'No repos attached yet.',
  'projects.backToDashboard': '\u2190 Back to dashboard',

  // ── New project ──────────────────────────────────────────────────
  'newProject.title': 'New project',

  // ── Repos / new repo ─────────────────────────────────────────────
  'newRepo.title': 'New repo',
  'newRepo.attachDesc': 'Attach an existing git working tree to {projectName}.',
  'newRepo.absolutePath': 'Absolute path',
  'newRepo.attachRepo': 'Attach repo',

  // ── Archive ──────────────────────────────────────────────────────
  'archive.title': 'Archive',
  'archive.noArchived': 'No archived agents for this repo.',
  'archive.viewLogs': 'View logs',
  'archive.collapseCommits': 'Collapse commits',
  'archive.expandCommits': 'Expand commits',
  'archive.th.title': 'Title',
  'archive.th.role': 'Role',
  'archive.th.cli': 'CLI',
  'archive.th.status': 'Status',
  'archive.th.exit': 'Exit',
  'archive.th.started': 'Started',
  'archive.th.ended': 'Ended',
  'archive.th.total': 'Total',
  'archive.th.active': 'Active',
  'archive.th.idle': 'Idle',
  'archive.th.in': 'In',
  'archive.th.out': 'Out',
  'archive.th.cacheW': 'Cache W',
  'archive.th.cacheR': 'Cache R',
  'archive.note':
    "Active/idle is a 30s-gap heuristic over the persisted terminal log. Token counts are sourced from Claude Code's JSONL transcript (available for claude-code agents only).",
  'archive.th.total.row': 'Total',
  'archive.delete.btn': 'Delete',
  'archive.delete.title': 'Delete archived agent',
  'archive.delete.confirm':
    'Permanently delete this agent and remove its worktree from disk? This cannot be undone.',
  'archive.delete.confirmDirty':
    'This worktree has uncommitted changes that will be lost if you delete it:',
  'archive.delete.dirtyMore': '… and {count} more',
  'archive.delete.confirmBtn': 'Delete',
  'archive.delete.forceBtn': 'Delete anyway',
  'archive.delete.error': 'Delete failed: {message}',

  // ── Archive overview (cross-repo) ────────────────────────────────
  'archive.overview.title': 'Archive overview',
  'archive.overview.empty': 'No archived agents across any repo.',
  'archive.overview.th.project': 'Project',
  'archive.overview.th.repo': 'Repo',
  'archive.overview.th.agents': 'Agents',
  'archive.overview.note':
    'One row per repo with archived agents. Click a row to see its per-agent breakdown.',

  // ── Common / API errors ──────────────────────────────────────────
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.error.unauthorized': 'Unauthorized',
  'common.error.invalidJson': 'Invalid JSON',
  'common.error.invalidTheme': 'Invalid theme',
  'common.error.invalidLocale': 'Invalid locale',
  'common.error.projectNotFound': 'Project not found',
  'common.error.forbidden': 'Forbidden',
  'common.error.nameRequired': 'Name is required',
  'common.error.invalidBranch': 'Default branch contains invalid characters',
  'common.error.pathRequired': 'Path is required',
  'common.error.pathNotAbsolute': 'Path must be absolute',
  'common.error.pathNotExist': 'Path does not exist on disk',
  'common.error.pathNotDir': 'Path is not a directory',
  'common.error.agentNotFound': 'Agent not found',
  'common.error.repoNotFound': 'Repository not found',
  'common.error.gitInitFailed': 'Failed to initialize empty directory as git repo: {message}',
  'common.error.notGitNotEmpty':
    'Path is not a git repository and is not empty. Either clear the directory or run `git init` yourself.',
  'common.error.noBranch':
    "Repo has no branch '{branch}' and no 'master' branch to rename. Create '{branch}' manually and try again."
} as const;

export type TranslationKey = keyof typeof en;
export default en;
