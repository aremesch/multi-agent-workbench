import type { TranslationKey } from './en';

const fr: Partial<Record<TranslationKey, string>> = {
  // ── Navigation / layout ──────────────────────────────────────────
  'nav.appTitle': 'Multi-Agent Workbench',
  'nav.settings': 'Param\u00e8tres',
  'nav.account': 'Compte',
  'nav.logout': 'D\u00e9connexion',
  'nav.userMenu': 'Menu utilisateur',
  'nav.showSidebar': 'Afficher la barre lat\u00e9rale',
  'nav.hideSidebar': 'Masquer la barre lat\u00e9rale',

  // ── Sidebar ──────────────────────────────────────────────────────
  'sidebar.repositories': 'D\u00e9p\u00f4ts',
  'sidebar.archive': 'Archives',
  'sidebar.noRepos': 'Aucun d\u00e9p\u00f4t pour le moment.',
  'sidebar.noArchived': 'Aucun agent archiv\u00e9.',
  'sidebar.collapse': 'R\u00e9duire',
  'sidebar.expand': 'D\u00e9velopper',

  // ── Login ────────────────────────────────────────────────────────
  'login.title': 'Connexion',
  'login.username': "Nom d'utilisateur",
  'login.password': 'Mot de passe',
  'login.submit': 'Se connecter',
  'login.error.required': "Nom d'utilisateur et mot de passe requis",
  'login.error.invalid': 'Identifiants invalides',

  // ── Account ──────────────────────────────────────────────────────
  'account.title': 'Compte',
  'account.signedInAs': 'Connect\u00e9 en tant que {username}',
  'account.changePassword': 'Changer le mot de passe',
  'account.currentPw': 'Mot de passe actuel',
  'account.newPw': 'Nouveau mot de passe',
  'account.confirmPw': 'Confirmer le nouveau mot de passe',
  'account.updatePw': 'Mettre \u00e0 jour le mot de passe',
  'account.pwUpdated': 'Mot de passe mis \u00e0 jour. Les autres sessions ont \u00e9t\u00e9 d\u00e9connect\u00e9es.',
  'account.error.notSignedIn': 'Non connect\u00e9',
  'account.error.allRequired': 'Tous les champs sont requis',
  'account.error.minLength': 'Le nouveau mot de passe doit contenir au moins 8 caract\u00e8res',
  'account.error.mismatch': 'Les nouveaux mots de passe ne correspondent pas',
  'account.error.samePw': 'Le nouveau mot de passe doit diff\u00e9rer de l\u2019actuel',
  'account.error.wrongCurrent': 'Mot de passe actuel incorrect',

  // ── Settings ─────────────────────────────────────────────────────
  'settings.title': 'Param\u00e8tres',
  'settings.subtitle': 'Personnalisez le workbench selon vos pr\u00e9f\u00e9rences.',
  'settings.appearance': 'Apparence',
  'settings.appearanceDesc':
    'Choisissez un th\u00e8me. Les modifications sont appliqu\u00e9es imm\u00e9diatement et synchronis\u00e9es au rechargement.',
  'settings.themeLabel': 'Th\u00e8me',
  'settings.language': 'Langue',
  'settings.languageDesc': 'S\u00e9lectionnez votre langue pr\u00e9f\u00e9r\u00e9e.',
  'settings.agentDefaults': 'Param\u00e8tres par d\u00e9faut des agents',
  'settings.agentDefaultsDesc':
    'Options de lancement par d\u00e9faut pour chaque type CLI. Modifiable par agent au lancement.',
  'settings.noOptionalFlags': 'Aucun flag optionnel.',
  'settings.notifications': 'Notifications',
  'settings.notificationsDesc':
    'Les notifications push vous alertent quand vos agents ont besoin d\u2019attention.',
  'settings.pushNotConfigured':
    'Cl\u00e9s VAPID non configur\u00e9es. Ex\u00e9cutez pnpm vapid:gen et ajoutez les cl\u00e9s dans .env.',
  'settings.pushEnable': 'Activer les notifications push',
  'settings.pushEnabled': 'Notifications push activ\u00e9es',
  'settings.notifyWhen': 'Me notifier quand\u00a0:',
  'settings.notify.prompt_detected': 'Agent a besoin d\u2019une autorisation',
  'settings.notify.task_done': 'Agent a termin\u00e9 la t\u00e2che',
  'settings.notify.error': 'Agent rencontre une erreur',
  'settings.notify.exited': 'Agent s\u2019arr\u00eate de mani\u00e8re inattendue',

  'theme.desc.dark-slate': 'Tons neutres quasi noirs avec un accent bleu froid.',
  'theme.desc.dark-midnight': 'Surfaces teint\u00e9es bleu profond, contraste plus doux.',
  'theme.desc.amoled': 'Noir pur pour \u00e9crans OLED, accent violet.',
  'theme.desc.light-default': 'M3 clair de base avec un ton primaire violet.',
  'theme.desc.expressive-plum': 'M3 expressif\u00a0: surfaces prune chaudes, accent sarcelle.',

  // ── Spawn agent form ─────────────────────────────────────────────
  'spawn.title': 'Lancer un agent',
  'spawn.role': 'R\u00f4le',
  'spawn.repo': 'D\u00e9p\u00f4t',
  'spawn.project': 'Projet',
  'spawn.cliKind': 'Type CLI',
  'spawn.name': 'Nom',
  'spawn.taskTitle': 'Titre de la t\u00e2che',
  'spawn.taskBody': 'Contenu de la t\u00e2che',
  'spawn.optional': 'facultatif',
  'spawn.sentAsInitialInput': "facultatif, envoy\u00e9 comme entr\u00e9e initiale",
  'spawn.absPath': 'chemin absolu',
  'spawn.originUrl': 'URL d\u2019origine',
  'spawn.defaultBranch': 'Branche par d\u00e9faut',
  'spawn.projectName': 'Nom du projet',
  'spawn.systemPrompt': 'Prompt syst\u00e8me',
  'spawn.cancel': 'Annuler',
  'spawn.spawn': 'Lancer',
  'spawn.spawning': 'Lancement\u2026',
  'spawn.creating': 'Cr\u00e9ation\u2026',
  'spawn.adding': 'Ajout\u2026',
  'spawn.createRole': 'Cr\u00e9er un r\u00f4le',
  'spawn.addRepo': 'Ajouter un d\u00e9p\u00f4t',
  'spawn.createProject': 'Cr\u00e9er un projet',
  'spawn.newRole': '+ R\u00f4le',
  'spawn.newRepo': '+ D\u00e9p\u00f4t',
  'spawn.newProject': '+ Projet',
  'spawn.titleCreateRole': 'Cr\u00e9er un nouveau r\u00f4le',
  'spawn.titleAddRepo': 'Ajouter un nouveau d\u00e9p\u00f4t',
  'spawn.titleCreateProject': 'Cr\u00e9er un nouveau projet',
  'spawn.error.roleRepoRequired': 'R\u00f4le et d\u00e9p\u00f4t requis',
  'spawn.error.unknownRole': 'R\u00f4le inconnu',
  'spawn.error.unknownRepo': 'D\u00e9p\u00f4t inconnu',
  'spawn.error.unknownCliKind': 'Type CLI inconnu',
  'spawn.error.orphanedRepo': 'D\u00e9p\u00f4t orphelin (aucun projet)',
  'spawn.error.titleRequired': 'Le titre est requis',
  'spawn.error.titleUnslugifiable': 'Le titre doit contenir au moins une lettre ou un chiffre',
  'spawn.error.titleTaken': 'Titre d\u00e9j\u00e0 utilis\u00e9 — choisissez-en un autre',
  'spawn.error.spawnFailed': '\u00c9chec du lancement',
  'spawn.error.worktreeFailed': '\u00c9chec de la cr\u00e9ation du worktree\u00a0: {message}',
  'spawn.error.failedCreateRole': '\u00c9chec de la cr\u00e9ation du r\u00f4le',
  'spawn.error.failedCreateProject': '\u00c9chec de la cr\u00e9ation du projet',
  'spawn.error.failedAddRepo': '\u00c9chec de l\u2019ajout du d\u00e9p\u00f4t',
  'spawn.error.networkError': 'Erreur r\u00e9seau',
  'spawn.advanced': 'Avanc\u00e9',

  // ── Agent card / terminal ────────────────────────────────────────
  'agent.openTerminal': 'Ouvrir le terminal pour {roleName}',
  'agent.tmuxGone': '(session tmux termin\u00e9e)',
  'agent.loading': 'chargement\u2026',
  'agent.empty': '(vide)',
  'agent.promptDetected': 'Invite d\u00e9tect\u00e9e',
  'agent.sendPlaceholder': 'Tapez un message, Entr\u00e9e pour envoyer',
  'agent.send': 'Envoyer',
  'agent.spawnAgent': 'Lancer un agent',
  'agent.noLiveAgents': 'Aucun agent actif. Cliquez sur + pour en lancer un.',
  'agent.failedLoadLog': '\u00c9chec du chargement du log\u00a0: {error}',
  'agent.loadingLog': 'Chargement du log\u2026',

  // ── Roles ────────────────────────────────────────────────────────
  'roles.title': 'R\u00f4les',
  'roles.newRole': 'Nouveau r\u00f4le',
  'roles.noRoles': 'Aucun r\u00f4le pour le moment. Un r\u00f4le regroupe un adaptateur CLI + un prompt syst\u00e8me.',
  'roles.backToDashboard': '\u2190 Retour au tableau de bord',

  'newRole.title': 'Nouveau r\u00f4le',

  // ── Projects ─────────────────────────────────────────────────────
  'projects.newProject': 'Nouveau projet',
  'projects.defaultBranch': 'branche par d\u00e9faut {branch}',
  'projects.repositories': 'D\u00e9p\u00f4ts ({count})',
  'projects.newRepo': 'Nouveau d\u00e9p\u00f4t',
  'projects.noRepos': 'Aucun d\u00e9p\u00f4t rattach\u00e9 pour le moment.',
  'projects.backToDashboard': '\u2190 Retour au tableau de bord',

  'newProject.title': 'Nouveau projet',

  // ── Repos / new repo ─────────────────────────────────────────────
  'newRepo.title': 'Nouveau d\u00e9p\u00f4t',
  'newRepo.attachDesc': 'Rattacher un r\u00e9pertoire de travail Git existant \u00e0 {projectName}.',
  'newRepo.absolutePath': 'Chemin absolu',
  'newRepo.attachRepo': 'Rattacher le d\u00e9p\u00f4t',

  // ── Archive ──────────────────────────────────────────────────────
  'archive.title': 'Archives',
  'archive.noArchived': 'Aucun agent archiv\u00e9 pour ce d\u00e9p\u00f4t.',
  'archive.viewLogs': 'Voir les logs',
  'archive.collapseCommits': 'R\u00e9duire les commits',
  'archive.expandCommits': 'D\u00e9velopper les commits',
  'archive.th.title': 'Titre',
  'archive.th.role': 'R\u00f4le',
  'archive.th.cli': 'CLI',
  'archive.th.status': 'Statut',
  'archive.th.exit': 'Sortie',
  'archive.th.started': 'D\u00e9but',
  'archive.th.ended': 'Fin',
  'archive.th.total': 'Total',
  'archive.th.active': 'Actif',
  'archive.th.idle': 'Inactif',
  'archive.th.in': 'Entr.',
  'archive.th.out': 'Sort.',
  'archive.th.cacheW': 'Cache \u00c9',
  'archive.th.cacheR': 'Cache L',
  'archive.note':
    "Actif/inactif repose sur une heuristique de 30s sur le log du terminal. Les compteurs de tokens proviennent du transcript JSONL de Claude Code (disponible uniquement pour les agents claude-code).",

  // ── Common / API errors ──────────────────────────────────────────
  'common.close': 'Fermer',
  'common.cancel': 'Annuler',
  'common.error.unauthorized': 'Non autoris\u00e9',
  'common.error.invalidJson': 'JSON invalide',
  'common.error.invalidTheme': 'Th\u00e8me invalide',
  'common.error.invalidLocale': 'Langue invalide',
  'common.error.projectNotFound': 'Projet introuvable',
  'common.error.forbidden': 'Acc\u00e8s interdit',
  'common.error.nameRequired': 'Le nom est requis',
  'common.error.invalidBranch': 'La branche par d\u00e9faut contient des caract\u00e8res invalides',
  'common.error.pathRequired': 'Le chemin est requis',
  'common.error.pathNotAbsolute': 'Le chemin doit \u00eatre absolu',
  'common.error.pathNotExist': 'Le chemin n\u2019existe pas sur le disque',
  'common.error.pathNotDir': 'Le chemin n\u2019est pas un r\u00e9pertoire',
  'common.error.agentNotFound': 'Agent introuvable',
  'common.error.gitInitFailed':
    "\u00c9chec de l'initialisation du r\u00e9pertoire vide en d\u00e9p\u00f4t Git\u00a0: {message}",
  'common.error.notGitNotEmpty':
    "Le chemin n'est pas un d\u00e9p\u00f4t Git et n'est pas vide. Videz le r\u00e9pertoire ou ex\u00e9cutez `git init` manuellement.",
  'common.error.noBranch':
    "Le d\u00e9p\u00f4t n'a pas de branche '{branch}' ni de branche 'master' \u00e0 renommer. Cr\u00e9ez '{branch}' manuellement et r\u00e9essayez."
};

export default fr;
