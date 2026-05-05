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
  'sidebar.editRepo': 'Modifier le d\u00e9p\u00f4t',

  // ── Edit repo dialog ─────────────────────────────────────────────
  'repoEdit.title': 'Modifier le d\u00e9p\u00f4t',
  'repoEdit.path': 'Chemin',
  'repoEdit.pathReadOnlyHint':
    'lecture seule \u2014 modifier le chemin casserait les worktrees existants',
  'repoEdit.save': 'Enregistrer',
  'repoEdit.saving': 'Enregistrement\u2026',
  'repoEdit.loading': 'Chargement\u2026',
  'repoEdit.failedLoad': '\u00c9chec du chargement du d\u00e9p\u00f4t',
  'repoEdit.failedSave': '\u00c9chec de l\u2019enregistrement du d\u00e9p\u00f4t',

  // ── Login ────────────────────────────────────────────────────────
  'login.title': 'Connexion',
  'login.email': 'E-mail',
  'login.password': 'Mot de passe',
  'login.submit': 'Se connecter',
  'login.error.required': 'E-mail et mot de passe requis',
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
  'settings.git.title': 'Identit\u00e9 Git',
  'settings.git.desc':
    'Signez les commits de vos agents avec un nom et un e-mail de votre choix. Laissez vide pour utiliser votre nom d\u2019utilisateur.',
  'settings.git.nameLabel': 'Nom de l\u2019auteur',
  'settings.git.emailLabel': 'E-mail de l\u2019auteur',
  'settings.git.githubNoreplyHint':
    'Astuce\u00a0: pour les d\u00e9p\u00f4ts publics GitHub, utilisez votre e-mail priv\u00e9 au format <id>+<username>@users.noreply.github.com \u2014 disponible dans GitHub \u2192 Settings \u2192 Emails.',
  'settings.git.appliesToNewAgents': "S\u2019applique aux agents lanc\u00e9s apr\u00e8s l\u2019enregistrement.",
  'settings.git.save': 'Enregistrer l\u2019identit\u00e9',
  'settings.git.saved': 'Identit\u00e9 Git enregistr\u00e9e.',
  'settings.git.error.nameRequired': 'Le nom de l\u2019auteur est obligatoire',
  'settings.git.error.nameInvalid': 'Le nom de l\u2019auteur contient des caract\u00e8res invalides',
  'settings.git.error.emailRequired': 'L\u2019e-mail de l\u2019auteur est obligatoire',
  'settings.git.error.emailInvalid': 'Saisissez une adresse e-mail valide',
  'settings.mobileQuickKeys.title': 'Touches rapides mobiles',
  'settings.mobileQuickKeys.desc':
    'Touches que le clavier virtuel masque (fl\u00e8ches, Maj+Tab, \u00c9chap, Ctrl+C) affich\u00e9es sous le terminal.',
  'settings.mobileQuickKeys.mode.auto': 'Automatique',
  'settings.mobileQuickKeys.mode.auto.desc': 'Visible sur appareils tactiles, masqu\u00e9 ailleurs.',
  'settings.mobileQuickKeys.mode.always': 'Toujours',
  'settings.mobileQuickKeys.mode.always.desc': 'Toujours visible, m\u00eame sur ordinateur.',
  'settings.mobileQuickKeys.mode.never': 'Jamais',
  'settings.mobileQuickKeys.mode.never.desc': 'Masqu\u00e9 partout.',
  'banner.gitIdentityUnset':
    'Votre identit\u00e9 d\u2019auteur Git n\u2019est pas d\u00e9finie \u2014 les commits des agents seront attribu\u00e9s \u00e0 votre nom d\u2019utilisateur avec un e-mail synth\u00e9tique.',
  'banner.gitIdentityAction': 'Configurer maintenant',

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
  'spawn.httpsOriginUrl': 'URL d\u2019origine HTTP(S)',
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

  // \u2500\u2500 Champs de spawn pour agent navigateur \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'spawn.sessionLabel': 'Libell\u00e9 de session',
  'spawn.previewUrl': 'URL d\u2019aper\u00e7u',
  'spawn.previewUrl.help':
    'http://localhost:<port> \u2014 m\u00eame h\u00f4te que MAW. Le proxy redirige vers 127.0.0.1.',
  'spawn.error.browserUrl.empty': 'L\u2019URL d\u2019aper\u00e7u est obligatoire',
  'spawn.error.browserUrl.invalid': 'L\u2019URL d\u2019aper\u00e7u n\u2019est pas valide',
  'spawn.error.browserUrl.scheme':
    'L\u2019URL d\u2019aper\u00e7u doit utiliser http:// (pas https://)',
  'spawn.error.browserUrl.host':
    'L\u2019h\u00f4te de l\u2019URL doit \u00eatre localhost ou 127.0.0.1',
  'spawn.error.browserUrl.port':
    'L\u2019URL d\u2019aper\u00e7u doit inclure un port (p. ex. :5173)',

  // \u2500\u2500 Vue agent navigateur \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'browser.iframeTitle': 'Iframe d\u2019aper\u00e7u',
  'browser.reload': 'Recharger l\u2019aper\u00e7u',
  'browser.openExternal': 'Ouvrir dans un nouvel onglet',
  'browser.rotate': 'Pivoter le viewport',
  'browser.viewport.label': 'Taille du viewport',
  'browser.viewport.width': 'Largeur',
  'browser.viewport.height': 'Hauteur',
  'browser.preset.mobile': 'Mobile',
  'browser.preset.tablet': 'Tablette',
  'browser.preset.desktop': 'Bureau',
  'browser.preset.fit': 'Ajuster',
  'browser.preset.custom': 'Personnalis\u00e9',
  'browser.unreachable.title': 'Serveur de dev injoignable',
  'browser.unreachable.body':
    'Impossible d\u2019atteindre {url} \u2014 d\u00e9marrez votre serveur de dev et r\u00e9essayez.',
  'browser.unreachable.retry': 'R\u00e9essayer',
  'browser.stop.title': 'Arr\u00eater la session navigateur',
  'browser.stop.label': 'Arr\u00eater',
  'browser.stop.confirmTitle': 'Confirmer l\u2019arr\u00eat \u2014 d\u00e9place l\u2019agent vers les archives',
  'browser.stop.confirmLabel': 'Confirmer',
  'browser.stop.stopping': 'Arr\u00eat\u2026',
  'browser.stop.cancel': 'Annuler',
  'browser.stop.error': '\u00c9chec de l\u2019arr\u00eat : {message}',
  'browser.target.urlLabel': 'URL d\u2019aper\u00e7u',
  'browser.target.apply': 'Appliquer',
  'browser.target.commonPorts': 'Ports rapides',
  'browser.target.saveFailed': '\u00c9chec de l\u2019enregistrement de l\u2019URL',

  // \u2500\u2500 Vue stream rendu par le serveur \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'stream.back': 'Pr\u00e9c\u00e9dent',
  'stream.forward': 'Suivant',
  'stream.reload': 'Recharger',
  'stream.go': 'Aller',
  'stream.connecting': 'Connexion au navigateur\u2026',
  'stream.imageAlt': 'Aper\u00e7u du navigateur rendu par le serveur',

  // ── Agent card / terminal ────────────────────────────────────────
  'agent.openTerminal': 'Ouvrir le terminal pour {roleName}',
  'agent.tmuxGone': '(session tmux termin\u00e9e)',
  'agent.loading': 'chargement\u2026',
  'agent.empty': '(vide)',
  'agent.promptDetected': 'Invite d\u00e9tect\u00e9e',
  'agent.spawnAgent': 'Lancer un agent',
  'agent.noLiveAgents': 'Aucun agent actif. Cliquez sur + pour en lancer un.',
  'agent.failedLoadLog': '\u00c9chec du chargement du log\u00a0: {error}',
  'agent.loadingLog': 'Chargement du log\u2026',
  'agent.quickKeysLabel': 'Touches rapides du terminal',
  'agentTerminal.region': 'Terminal de l’agent',
  'agentTerminal.image.attach': 'Joindre une image',
  'agentTerminal.image.dropOverlay': 'Déposez l’image ici',
  'agentTerminal.image.uploading': 'Téléversement de l’image…',
  'agentTerminal.image.toastInjected':
    'Image jointe : {filename} — {path} inséré',
  'agentTerminal.image.error.mime':
    'Format d’image non pris en charge. Utilisez PNG, JPEG, GIF ou WebP.',
  'agentTerminal.image.error.size': 'Image trop volumineuse. Maximum 5 Mo.',
  'agentTerminal.image.error.upload': 'Échec du téléversement. Réessayez.',
  'agent.dragHandle': 'Glisser pour réorganiser',

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
  'archive.refresh.btn': 'Rafra\u00eechir les commits',
  'archive.refresh.preserved':
    'Commits existants conserv\u00e9s ; la branche ou la base a disparu.',
  'archive.refresh.error': 'Rafra\u00eechissement \u00e9chou\u00e9 : {message}',
  'archive.commit.stale': 'Objet local manquant ; le lien peut \u00eatre obsol\u00e8te.',

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
  'common.error.repoNotFound': 'D\u00e9p\u00f4t introuvable',
  'common.error.gitInitFailed':
    "\u00c9chec de l'initialisation du r\u00e9pertoire vide en d\u00e9p\u00f4t Git\u00a0: {message}",
  'common.error.notGitNotEmpty':
    "Le chemin n'est pas un d\u00e9p\u00f4t Git et n'est pas vide. Videz le r\u00e9pertoire ou ex\u00e9cutez `git init` manuellement.",
  'common.error.noBranch':
    "Le d\u00e9p\u00f4t n'a pas de branche '{branch}' ni de branche 'master' \u00e0 renommer. Cr\u00e9ez '{branch}' manuellement et r\u00e9essayez.",
  'common.error.cloneInvalidUrl': 'URL de clone non prise en charge\u00a0: {message}',
  'common.error.cloneAuthFailed':
    '\u00c9chec du clone \u2014 authentification refus\u00e9e. V\u00e9rifiez les cl\u00e9s SSH ou les identifiants HTTPS du serveur. ({message})',
  'common.error.cloneFailed': '\u00c9chec du clone\u00a0: {message}',
  'common.error.cloneNotEmpty':
    'Clone impossible dans un r\u00e9pertoire non vide. Choisissez un dossier vide ou omettez l\u2019URL d\u2019origine SSH.',

  // ── Directory picker ─────────────────────────────────────────────
  'picker.title': 'S\u00e9lectionner un r\u00e9pertoire',
  'picker.browse': 'Parcourir\u2026',
  'picker.up': 'Haut',
  'picker.selectHere': 'S\u00e9lectionner ce r\u00e9pertoire',
  'picker.showHidden': 'Afficher les fichiers cach\u00e9s',
  'picker.empty': 'Ce r\u00e9pertoire n\u2019a pas de sous-r\u00e9pertoires.',
  'picker.loading': 'Chargement\u2026',
  'picker.gitRepo': 'git',
  'picker.newDirectory': 'Nouveau dossier',
  'picker.newDirectory.namePlaceholder': 'Nom du dossier',
  'picker.newDirectory.create': 'Cr\u00e9er',
  'picker.newDirectory.creating': 'Cr\u00e9ation\u2026',
  'picker.newDirectory.cancel': 'Annuler',
  'picker.sshOriginUrl': 'URL d\u2019origine SSH (pour le clone)',
  'picker.sshOriginUrlHint':
    'Facultatif. Si renseign\u00e9e, le r\u00e9pertoire est peupl\u00e9 via `git clone` en utilisant la cl\u00e9 SSH du serveur.',
  'picker.selectedPath': 'S\u00e9lectionn\u00e9\u00a0: {path}',
  'picker.selectNothing': '(aucun dossier s\u00e9lectionn\u00e9)',
  'picker.error.load': '\u00c9chec du chargement du r\u00e9pertoire',
  'picker.error.outsideRoot': 'Le chemin est en dehors de la racine autoris\u00e9e',
  'picker.error.mkdirInvalidName':
    'Nom de dossier invalide. Utilisez lettres, chiffres, espaces, point, tiret ou underscore.',
  'picker.error.mkdirExists': 'Un dossier avec ce nom existe d\u00e9j\u00e0.',
  'picker.error.mkdirFailed': '\u00c9chec de la cr\u00e9ation du dossier\u00a0: {message}',

  // \u2500\u2500 Foreground alert toasts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'toast.openAgent': 'Ouvrir l\u2019agent',
  'toast.dismiss': 'Fermer',
  'toast.permissionNeeded': 'Autorisation requise',
  'toast.taskComplete': 'T\u00e2che termin\u00e9e',

  // \u2500\u2500 Agent-window kebab menu \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'agentMenu.button': 'Menu de l\u2019agent',
  'agentMenu.showPlan': 'Afficher le plan',
  'agentMenu.showLog': 'Afficher le journal',
  'agentMenu.exitAgent': 'Quitter l\u2019agent',

  // \u2500\u2500 Plan viewer modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'plan.modal.title': 'Plan\u00a0: {name}',
  'plan.modal.titleEmpty': 'Plan',
  'plan.modal.titleError': 'Plan',
  'plan.modal.titleLoading': 'Plan',
  'plan.modal.empty': 'Aucun fichier de plan trouv\u00e9 dans {dir}',
  'plan.modal.switcherLabel': 'Changer de plan',
  'plan.modal.loading': 'Chargement du plan\u2026',
  'plan.modal.error': 'Impossible de charger le plan\u00a0: {error}',
  'plan.modal.retry': 'R\u00e9essayer',

  // \u2500\u2500 Agent log modal title \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'agent.logTitle': 'Journal\u00a0: {name}',

  // \u2500\u2500 Exit agent confirmation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'exitAgent.confirm.title': 'Quitter l\u2019agent',
  'exitAgent.confirm.body':
    'Arr\u00eater cet agent et fermer sa session tmux\u00a0? Le processus CLI sera termin\u00e9 et tout \u00e9tat m\u00e9moire non sauvegard\u00e9 sera perdu.',
  'exitAgent.confirm.cancel': 'Annuler',
  'exitAgent.confirm.confirm': 'Arr\u00eater l\u2019agent',
  'exitAgent.error': 'Impossible d\u2019arr\u00eater l\u2019agent\u00a0: {error}'
};

export default fr;
