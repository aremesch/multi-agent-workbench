import type { TranslationKey } from './en';

const de: Partial<Record<TranslationKey, string>> = {
  // ── Navigation / layout ──────────────────────────────────────────
  'nav.appTitle': 'Multi-Agent Workbench',
  'nav.settings': 'Einstellungen',
  'nav.account': 'Konto',
  'nav.logout': 'Abmelden',
  'nav.userMenu': 'Benutzermen\u00fc',
  'nav.showSidebar': 'Seitenleiste einblenden',
  'nav.hideSidebar': 'Seitenleiste ausblenden',

  // ── Sidebar ──────────────────────────────────────────────────────
  'sidebar.repositories': 'Repositories',
  'sidebar.archive': 'Archiv',
  'sidebar.noRepos': 'Noch keine Repositories.',
  'sidebar.noArchived': 'Keine archivierten Agenten.',
  'sidebar.collapse': 'Einklappen',
  'sidebar.expand': 'Ausklappen',

  // ── Login ────────────────────────────────────────────────────────
  'login.title': 'Anmelden',
  'login.username': 'Benutzername',
  'login.password': 'Passwort',
  'login.submit': 'Anmelden',
  'login.error.required': 'Benutzername und Passwort erforderlich',
  'login.error.invalid': 'Ung\u00fcltige Anmeldedaten',

  // ── Account ──────────────────────────────────────────────────────
  'account.title': 'Konto',
  'account.signedInAs': 'Angemeldet als {username}',
  'account.changePassword': 'Passwort \u00e4ndern',
  'account.currentPw': 'Aktuelles Passwort',
  'account.newPw': 'Neues Passwort',
  'account.confirmPw': 'Neues Passwort best\u00e4tigen',
  'account.updatePw': 'Passwort aktualisieren',
  'account.pwUpdated': 'Passwort aktualisiert. Andere Sitzungen wurden abgemeldet.',
  'account.error.notSignedIn': 'Nicht angemeldet',
  'account.error.allRequired': 'Alle Felder sind erforderlich',
  'account.error.minLength': 'Neues Passwort muss mindestens 8 Zeichen lang sein',
  'account.error.mismatch': 'Neue Passw\u00f6rter stimmen nicht \u00fcberein',
  'account.error.samePw': 'Neues Passwort muss sich vom aktuellen unterscheiden',
  'account.error.wrongCurrent': 'Aktuelles Passwort falsch',

  // ── Settings ─────────────────────────────────────────────────────
  'settings.title': 'Einstellungen',
  'settings.subtitle': 'Passe die Workbench an deine Vorlieben an.',
  'settings.appearance': 'Erscheinungsbild',
  'settings.appearanceDesc':
    'W\u00e4hle ein Theme. \u00c4nderungen werden sofort \u00fcbernommen und nach dem Neuladen synchronisiert.',
  'settings.themeLabel': 'Theme',
  'settings.language': 'Sprache',
  'settings.languageDesc': 'W\u00e4hle deine bevorzugte Sprache.',
  'settings.agentDefaults': 'Agent-Standardwerte',
  'settings.agentDefaultsDesc':
    'Standard-Startoptionen f\u00fcr jeden CLI-Typ. Kann beim Starten pro Agent \u00fcberschrieben werden.',
  'settings.noOptionalFlags': 'Keine optionalen Flags.',

  'theme.desc.dark-slate': 'Fast schwarze Neutrale mit k\u00fchlem Blauakzent.',
  'theme.desc.dark-midnight': 'Tiefblau get\u00f6nte Fl\u00e4chen, weicherer Kontrast.',
  'theme.desc.amoled': 'Reinschwarz f\u00fcr OLED-Displays, Violettakzent.',
  'theme.desc.light-default': 'M3 Basis-Light mit violettem Prim\u00e4rton.',
  'theme.desc.expressive-plum': 'M3 expressiv: warme Pflaumenfl\u00e4chen, Petrolakzent.',

  // ── Spawn agent form ─────────────────────────────────────────────
  'spawn.title': 'Agent starten',
  'spawn.role': 'Rolle',
  'spawn.repo': 'Repo',
  'spawn.project': 'Projekt',
  'spawn.cliKind': 'CLI-Typ',
  'spawn.name': 'Name',
  'spawn.taskTitle': 'Aufgabentitel',
  'spawn.taskBody': 'Aufgabeninhalt',
  'spawn.optional': 'optional',
  'spawn.sentAsInitialInput': 'optional, wird als Anfangseingabe gesendet',
  'spawn.absPath': 'absoluter Dateipfad',
  'spawn.originUrl': 'Origin-URL',
  'spawn.defaultBranch': 'Standard-Branch',
  'spawn.projectName': 'Projektname',
  'spawn.systemPrompt': 'Systemprompt',
  'spawn.cancel': 'Abbrechen',
  'spawn.spawn': 'Starten',
  'spawn.spawning': 'Wird gestartet\u2026',
  'spawn.creating': 'Wird erstellt\u2026',
  'spawn.adding': 'Wird hinzugef\u00fcgt\u2026',
  'spawn.createRole': 'Rolle erstellen',
  'spawn.addRepo': 'Repo hinzuf\u00fcgen',
  'spawn.createProject': 'Projekt erstellen',
  'spawn.newRole': '+ Rolle',
  'spawn.newRepo': '+ Repo',
  'spawn.newProject': '+ Projekt',
  'spawn.titleCreateRole': 'Neue Rolle erstellen',
  'spawn.titleAddRepo': 'Neues Repo hinzuf\u00fcgen',
  'spawn.titleCreateProject': 'Neues Projekt erstellen',
  'spawn.error.roleRepoRequired': 'Rolle und Repo sind erforderlich',
  'spawn.error.unknownRole': 'Unbekannte Rolle',
  'spawn.error.unknownRepo': 'Unbekanntes Repo',
  'spawn.error.unknownCliKind': 'Unbekannter CLI-Typ',
  'spawn.error.orphanedRepo': 'Repo ist verwaist (kein Projekt)',
  'spawn.error.spawnFailed': 'Start fehlgeschlagen',
  'spawn.error.worktreeFailed': 'Worktree-Erstellung fehlgeschlagen: {message}',
  'spawn.error.failedCreateRole': 'Rolle konnte nicht erstellt werden',
  'spawn.error.failedCreateProject': 'Projekt konnte nicht erstellt werden',
  'spawn.error.failedAddRepo': 'Repo konnte nicht hinzugef\u00fcgt werden',
  'spawn.error.networkError': 'Netzwerkfehler',
  'spawn.advanced': 'Erweitert',

  // ── Agent card / terminal ────────────────────────────────────────
  'agent.openTerminal': 'Terminal \u00f6ffnen f\u00fcr {roleName}',
  'agent.tmuxGone': '(tmux-Sitzung beendet)',
  'agent.loading': 'Laden\u2026',
  'agent.empty': '(leer)',
  'agent.promptDetected': 'Eingabeaufforderung erkannt',
  'agent.sendPlaceholder': 'Nachricht eingeben, Enter zum Senden',
  'agent.send': 'Senden',
  'agent.spawnAgent': 'Agent starten',
  'agent.noLiveAgents': 'Keine aktiven Agenten. Klicke auf + um einen zu starten.',
  'agent.failedLoadLog': 'Log konnte nicht geladen werden: {error}',
  'agent.loadingLog': 'Log wird geladen\u2026',

  // ── Roles ────────────────────────────────────────────────────────
  'roles.title': 'Rollen',
  'roles.newRole': 'Neue Rolle',
  'roles.noRoles': 'Noch keine Rollen. Eine Rolle b\u00fcndelt einen CLI-Adapter + Systemprompt.',
  'roles.backToDashboard': '\u2190 Zur\u00fcck zum Dashboard',

  'newRole.title': 'Neue Rolle',

  // ── Projects ─────────────────────────────────────────────────────
  'projects.newProject': 'Neues Projekt',
  'projects.defaultBranch': 'Standard-Branch {branch}',
  'projects.repositories': 'Repositories ({count})',
  'projects.newRepo': 'Neues Repo',
  'projects.noRepos': 'Noch keine Repos angeh\u00e4ngt.',
  'projects.backToDashboard': '\u2190 Zur\u00fcck zum Dashboard',

  'newProject.title': 'Neues Projekt',

  // ── Repos / new repo ─────────────────────────────────────────────
  'newRepo.title': 'Neues Repo',
  'newRepo.attachDesc': 'Existierendes Git-Arbeitsverzeichnis an {projectName} anh\u00e4ngen.',
  'newRepo.absolutePath': 'Absoluter Pfad',
  'newRepo.attachRepo': 'Repo anh\u00e4ngen',

  // ── Archive ──────────────────────────────────────────────────────
  'archive.title': 'Archiv',
  'archive.noArchived': 'Keine archivierten Agenten f\u00fcr dieses Repo.',
  'archive.viewLogs': 'Logs ansehen',
  'archive.collapseCommits': 'Commits einklappen',
  'archive.expandCommits': 'Commits ausklappen',
  'archive.th.title': 'Titel',
  'archive.th.role': 'Rolle',
  'archive.th.cli': 'CLI',
  'archive.th.status': 'Status',
  'archive.th.exit': 'Exit',
  'archive.th.started': 'Gestartet',
  'archive.th.ended': 'Beendet',
  'archive.th.total': 'Gesamt',
  'archive.th.active': 'Aktiv',
  'archive.th.idle': 'Leerlauf',
  'archive.th.in': 'Ein',
  'archive.th.out': 'Aus',
  'archive.th.cacheW': 'Cache S',
  'archive.th.cacheR': 'Cache L',
  'archive.note':
    'Aktiv/Leerlauf basiert auf einer 30s-L\u00fccken-Heuristik \u00fcber das Terminal-Log. Token-Zahlen stammen aus Claude Codes JSONL-Transkript (nur f\u00fcr claude-code Agenten verf\u00fcgbar).',

  // ── Common / API errors ──────────────────────────────────────────
  'common.close': 'Schlie\u00dfen',
  'common.cancel': 'Abbrechen',
  'common.error.unauthorized': 'Nicht autorisiert',
  'common.error.invalidJson': 'Ung\u00fcltiges JSON',
  'common.error.invalidTheme': 'Ung\u00fcltiges Theme',
  'common.error.invalidLocale': 'Ung\u00fcltige Sprache',
  'common.error.projectNotFound': 'Projekt nicht gefunden',
  'common.error.forbidden': 'Zugriff verweigert',
  'common.error.nameRequired': 'Name ist erforderlich',
  'common.error.invalidBranch': 'Standard-Branch enth\u00e4lt ung\u00fcltige Zeichen',
  'common.error.pathRequired': 'Pfad ist erforderlich',
  'common.error.pathNotAbsolute': 'Pfad muss absolut sein',
  'common.error.pathNotExist': 'Pfad existiert nicht auf der Festplatte',
  'common.error.pathNotDir': 'Pfad ist kein Verzeichnis',
  'common.error.agentNotFound': 'Agent nicht gefunden',
  'common.error.gitInitFailed':
    'Leeres Verzeichnis konnte nicht als Git-Repo initialisiert werden: {message}',
  'common.error.notGitNotEmpty':
    'Pfad ist kein Git-Repository und nicht leer. Entweder das Verzeichnis leeren oder `git init` manuell ausf\u00fchren.',
  'common.error.noBranch':
    "Repo hat keinen Branch '{branch}' und keinen 'master'-Branch zum Umbenennen. Erstelle '{branch}' manuell und versuche es erneut."
};

export default de;
