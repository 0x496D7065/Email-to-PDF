// Every user-visible string of the page, in French. Same keys as en.ts (the
// `Messages` type makes a missing or extra key a compile error); the
// comments there say where each text is shown.
//
// Rules for this file (on top of those of en.ts):
// - Formal "vous", plain calm words: "fichier e-mail", never jargon.
// - Same meaning as English, with the SAME caution: the mail-client help
//   keeps "généralement" / "peut" exactly where English says "usually" /
//   "may", and makes no new claim.
// - French typography. The two invisible spaces are written as escapes, so
//   they can be seen and never taken for a normal space:
//     \u00A0 (no-break space) before ":" and inside « guillemets »;
//     \u202F (narrow no-break space) before ";", "!" and "?".
//   Every visible character (é, à, ’, «, », …) is written as itself, so the
//   text stays readable for proofreading. src/ui/i18n/fr.test.ts checks the
//   spaces.
// - Numbers in `{count}` and the like are written by t() with the browser's
//   French rules (Intl), never by hand.
// - Not translated (user decision): the app's name, mail program names,
//   time zone names, MIME types, hashes. The PDF's file name is ASCII only.

import type { Messages } from './index';

export const fr: Messages = {
  app: {
    name: 'Email to PDF',
    promise: 'Tout reste sur votre ordinateur.',
  },

  donate: {
    label: 'Soutenez-moi sur Ko-fi (s’ouvre dans un nouvel onglet)',
  },

  language: {
    label: 'Langue',
    changed: 'La page est maintenant en français.',
  },

  privacy: {
    summary: 'Votre vie privée\u00A0: comment fonctionne cette page',
    does: {
      title: 'Ce que fait cette page',
      local: 'Vos fichiers e-mail sont lus uniquement dans cet onglet du navigateur, sur votre ordinateur.',
      noUpload: 'Rien ne quitte votre ordinateur.',
      noSaving:
        'Cette page n’enregistre rien de ce qui vous appartient\u00A0: aucun cookie, et rien de vos e-mails dans le navigateur. Votre navigateur garde seulement une copie des fichiers propres à cette page, pour qu’elle puisse s’ouvrir sans internet. Seul le PDF que vous choisissez de télécharger est enregistré, dans votre dossier de téléchargements.',
      wiped:
        'Fermer ou recharger cet onglet, ou appuyer sur «\u00A0Tout effacer\u00A0», retire tout de cette page. Un PDF déjà téléchargé reste dans vos téléchargements.',
      pdf: 'Le PDF est lui aussi créé ici. Une fois téléchargé, il n’existe que sur votre ordinateur.',
    },
    never: {
      title: 'Ce que cette page ne fait jamais',
      upload: 'Elle n’envoie jamais rien en ligne, et il n’y a pas de compte.',
      tracking: 'Elle ne vous suit jamais\u00A0: pas de mesure d’audience, personne ne compte ni ne suit ce que vous faites ici.',
      remote: 'Elle ne charge jamais depuis internet les images ou autres contenus vers lesquels un e-mail renvoie.',
      attachments:
        'Elle n’ouvre jamais les fichiers joints (documents, images, etc.)\u00A0: elle indique seulement leur nom, leur taille et leur type.',
    },
    check: {
      title: 'Comment le vérifier vous-même',
      offline:
        'Une fois la page chargée, coupez internet (ou activez le mode avion), puis utilisez l’outil\u00A0: il fonctionne toujours. Dans la plupart des navigateurs, une fois la page ouverte avec internet, vous pouvez aussi la recharger ou la rouvrir sans internet\u00A0: votre navigateur garde une copie des fichiers propres à cette page (jamais de vos e-mails).',
      network:
        'Pour les personnes techniques\u00A0: ouvrez les outils de développement de votre navigateur et allez dans l’onglet Réseau. Les fichiers propres à la page se chargent à son ouverture. Votre navigateur peut aussi les télécharger de nouveau depuis ce site en arrière-plan, pour tenir à jour sa copie utilisable sans internet, et il demande à ce site le fichier «\u00A0/sw.js\u00A0» pour savoir si une nouvelle version est sortie. Ensuite, observez pendant que vous utilisez l’outil\u00A0: rien ne part vers internet. Quelques lignes dont l’adresse commence par «\u00A0blob:\u00A0» sont des parties de cette page qui fonctionnent dans votre navigateur.',
      source: 'Le code de cette page est open source\u00A0: tout le monde peut le lire et vérifier ce qu’il fait.',
    },
    notes: {
      title: 'Bon à savoir',
      trust:
        'Votre confiance dépend du code que ce site envoie à votre navigateur. C’est pourquoi ce code est open source et peut être vérifié. Comme tout site web, le site qui héberge cette page peut voir que la page a été chargée, mais jamais vos e-mails.',
      console:
        'Les outils de développement de votre navigateur peuvent afficher des lignes d’erreur rouges qui mentionnent une «\u00A0Content Security Policy\u00A0». C’est le navigateur qui refuse des styles, des scripts ou des liens, par exemple ceux trouvés dans vos e-mails\u00A0: la protection fonctionne. Rien de ce que contiennent vos e-mails n’a été exécuté ni chargé.',
      scripts:
        'Dans le PDF, certaines écritures (par exemple l’hébreu, l’arabe, le chinois, le japonais, le coréen, le thaï ou l’hindi) et les emoji apparaissent sous forme de codes comme [U+05D0], car la police utilisée dans le PDF ne les contient pas. Le texte en alphabet latin, grec ou cyrillique s’affiche normalement. Le texte de vos fichiers d’origine n’est pas modifié.',
    },
  },

  disclaimer: {
    text: 'Cet outil est fourni tel quel, sans aucune garantie, et ne constitue pas un conseil juridique. Vérifiez le PDF avant de l’envoyer. Vos fichiers e-mail d’origine restent la référence.',
  },

  steps: {
    number: 'Étape {number}',
    add: {
      title: 'Ajoutez vos e-mails',
      intro: 'Utilisez les fichiers e-mail que vous avez enregistrés depuis votre messagerie (fichiers .eml ou .msg).',
    },
    check: {
      title: 'Vérifiez',
      intro: 'Relisez vos e-mails, classés par date, avant de créer le PDF.',
      waiting: 'Vos e-mails apparaîtront ici une fois que vous les aurez ajoutés.',
    },
    download: {
      title: 'Téléchargez le PDF',
      intro: 'Enregistrez un seul PDF avec tous vos e-mails, du plus ancien au plus récent.',
    },
  },

  help: {
    summary: 'Comment obtenir mes fichiers e-mail\u202F?',
    intro: 'Cet outil lit les fichiers .eml et .msg. Vous pouvez ajouter plusieurs fichiers à la fois.',
    clients: {
      outlookClassic: {
        name: 'Outlook (classique, sous Windows)',
        how: 'Faire glisser un e-mail de la liste vers un dossier ou vers le bureau crée généralement un fichier\u00A0: un fichier .eml ou .msg, selon votre version d’Outlook. Les deux fonctionnent ici. «\u00A0Enregistrer sous\u00A0» dans le menu Fichier peut aussi en enregistrer un.',
      },
      outlookNew: {
        name: 'Application Outlook et Outlook sur navigateur',
        how: 'Cela varie. Le menu «\u00A0...\u00A0» de l’e-mail peut proposer une option Télécharger ou Enregistrer qui donne un fichier .eml\u202F; faire glisser un e-mail peut ne pas créer de fichier.',
      },
      thunderbird: {
        name: 'Thunderbird',
        how: 'Faire glisser un e-mail vers un dossier, ou utiliser «\u00A0Enregistrer sous\u00A0» dans le menu Fichier, donne généralement un fichier .eml.',
      },
      appleMail: {
        name: 'Apple Mail',
        how: 'Faire glisser un e-mail vers un dossier du Finder donne généralement un fichier .eml.',
      },
      gmail: {
        name: 'Gmail (dans un navigateur web)',
        how: 'Ouvrez l’e-mail, puis cherchez «\u00A0Télécharger le message\u00A0» dans son menu à trois points. Cela donne généralement un fichier .eml.',
      },
    },
    note: 'Les noms des menus peuvent changer selon la version et la langue, les vôtres peuvent donc ne pas correspondre exactement.',
  },

  download: {
    unavailable: {
      'no-emails': 'Ajoutez d’abord vos e-mails à l’étape 1.',
      busy: 'Veuillez patienter\u00A0: vos e-mails sont encore en cours de lecture et de vérification.',
      'none-included': 'Cochez au moins un e-mail à l’étape 2 pour créer un PDF.',
      'labels-failed':
        'Le PDF ne peut pas être créé\u00A0: l’outil n’a pas pu déterminer ce qu’il doit contenir. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez de nouveau vos fichiers.',
    },
    available: 'Crée un seul PDF avec les e-mails cochés à l’étape 2, ici, sur cet ordinateur.',
    changed: 'Vos choix ont changé, le PDF précédent a donc été retiré. Créez de nouveau le PDF pour les prendre en compte.',
    changedAfter: '{news} {changed}',
    making: 'Création de votre PDF… Cela peut prendre un peu de temps s’il y a beaucoup d’e-mails. La page reste utilisable.',
    ready: {
      one: 'Votre PDF est prêt\u00A0: {fileName}, {count} page. Le téléchargement a commencé.',
      other: 'Votre PDF est prêt\u00A0: {fileName}, {count} pages. Le téléchargement a commencé.',
    },
    again: 'Télécharger de nouveau\u00A0: {fileName}',
    error: {
      timeout:
        'La création du PDF a pris trop de temps, elle a donc été arrêtée. Vous pouvez réessayer, ou décocher des e-mails à l’étape 2 pour créer un PDF plus petit.',
      'tool-error': 'L’outil n’a pas pu créer le PDF. Vos e-mails sont toujours là\u00A0: vous pouvez réessayer.',
      'not-started':
        'L’outil n’a pas pu commencer à créer le PDF dans ce navigateur. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez de nouveau vos fichiers.',
    },
  },

  drop: {
    zone: 'Faites glisser vos fichiers e-mail ici, ou choisissez-les.',
    accepted: 'Acceptés\u00A0: fichiers .eml et .msg. Vous pouvez ajouter d’autres fichiers à tout moment.',
    reading: 'Lecture du fichier {done} sur {total}…',
    readingOne: 'Lecture de votre fichier…',
    readingMany: 'Lecture de {total} fichiers. Cela peut prendre un moment\u202F; la barre de progression ci-dessous indique où en est la lecture.',
    organizing: 'Mise en ordre de vos e-mails…',
    queued: 'D’autres fichiers ont été ajoutés. Ils seront lus dès que la lecture en cours sera terminée.',
    outside: 'Rien n’a été ajouté. Pour ajouter des fichiers, déposez-les dans le cadre en pointillés de l’étape 1.',
    nothing: 'Rien n’a été ajouté\u00A0: seuls des fichiers peuvent être déposés ici.',
    folders: {
      one: '{count} dossier n’a pas pu être ajouté. Ouvrez-le et ajoutez plutôt les fichiers e-mail qu’il contient.',
      other: '{count} dossiers n’ont pas pu être ajoutés. Ouvrez-les et ajoutez plutôt les fichiers e-mail qu’ils contiennent.',
    },
  },

  added: {
    files: { one: '{count} fichier ajouté.', other: '{count} fichiers ajoutés.' },
    failed: { one: '{count} n’a pas pu être lu.', other: '{count} n’ont pas pu être lus.' },
    messages: { one: '{count} e-mail trouvé.', other: '{count} e-mails trouvés.' },
    merged: { one: '{count} copie identique fusionnée.', other: '{count} copies identiques fusionnées.' },
    failedTitle: 'Fichiers qui n’ont pas pu être lus',
    details: 'Détails techniques',
    noName: '(fichier sans nom)',
  },

  preview: {
    from: 'De',
    to: 'À',
    cc: 'Cc',
    bcc: 'Cci',
    date: 'Date',
    subject: 'Objet',
    attachments: 'Pièces jointes',
    noSubject: '(sans objet)',
    noDate: '(sans date)',
    noText: '(aucun texte)',
    itemFailed: 'Un problème est survenu pendant l’affichage de cet e-mail. Son texte, s’il en a un, est affiché ci-dessous tel quel.',
    zone: 'Afficher les dates dans ce fuseau horaire',
    zoneThisComputer: '{zone} (cet ordinateur)',
    zoneNotRecognized: 'Ce fuseau horaire n’a pas été reconnu\u00A0: les dates sont donc affichées en UTC, ici et dans le PDF.',
    showFolded: 'Afficher les citations et les signatures',
    listLabel: 'Vos e-mails, du plus ancien au plus récent',
    messageNumber: '#{number}',
    senderTime: 'Heure locale de l’expéditeur\u00A0: {time}',
    dateAsWritten: 'Date telle qu’écrite dans l’e-mail\u00A0: {text}',
    mailbox: '{name} <{address}>',
    alsoIn: 'Également dans',
    attachment: '{name} ({size}, {type})',
    attachmentNoType: '{name} ({size})',
    noAttachmentName: '(pièce jointe sans nom)',
    size: {
      bytes: { one: '{count} octet', other: '{count} octets' },
      kb: '{size} Ko',
      mb: '{size} Mo',
      unknown: 'taille inconnue',
    },
    foldLabel: '{kind}, {lines}',
    foldLabelFrom: '{kind}, {lines}, {from}',
    foldLines: { one: '{count} ligne', other: '{count} lignes' },
    foldFromOne: 'de l’e-mail {list}',
    foldFromMany: 'des e-mails {list}',
    foldOther: 'Texte replié',
    author: {
      from: 'De',
      sender: 'Envoyé par',
      none: 'Expéditeur inconnu',
    },
    order: {
      'file-order': 'Pas de date utilisable\u00A0: placé à la fin de la liste, dans l’ordre où les fichiers ont été ajoutés.',
      'before-parent': 'Pas de date utilisable\u00A0: placé juste avant l’e-mail auquel il est joint.',
    },
    fold: {
      'quoted-overlap': 'Texte d’un e-mail précédent',
      'quote-marker': 'Texte cité',
      'reply-header': 'E-mail précédent cité',
      signature: 'Signature ou mention répétée',
    },
  },

  counts: {
    sentence: '{text}.',
    files: { one: '{count} fichier', other: '{count} fichiers' },
    filesFailed: { one: '{count} n’a pas pu être lu', other: '{count} n’ont pas pu être lus' },
    // « dont » : the failed files are among the {files}.
    filesWithFailed: '{files}, dont {failed}',
    seeFailed: 'Voir pourquoi à l’étape 1.',
    messagesFound: { one: '{count} e-mail trouvé', other: '{count} e-mails trouvés' },
    duplicatesMerged: { one: '{count} copie identique fusionnée', other: '{count} copies identiques fusionnées' },
    rebuiltFound: { one: '{count} e-mail antérieur reconstitué à partir du texte cité', other: '{count} e-mails antérieurs reconstitués à partir du texte cité' },
    // The form follows {count} (the total), as in English, so the verb must
    // not agree with {included}: hence "E-mails dans le PDF : 1 sur 5".
    included: {
      one: 'E-mail dans le PDF\u00A0: {included} sur {count}.',
      other: 'E-mails dans le PDF\u00A0: {included} sur {count}.',
    },
    rebuiltIncluded: {
      one: 'E-mail reconstitué dans le PDF\u00A0: {included} sur {count}.',
      other: 'E-mails reconstitués dans le PDF\u00A0: {included} sur {count}.',
    },
    withNotes: {
      one: '{count} e-mail a des remarques, affichées avec lui ci-dessous.',
      other: '{count} e-mails ont des remarques, affichées avec chacun d’eux ci-dessous.',
    },
  },

  review: {
    excluded: 'Pas dans le PDF',
    notesLabel: 'Remarques sur cet e-mail',
    relatedOne: 'Voir l’e-mail {list}.',
    relatedMany: 'Voir les e-mails {list}.',
    relatedMoreFiles: { one: '{count} fichier de plus est concerné.', other: '{count} fichiers de plus sont concernés.' },
    relatedOnlyMore: { one: '{count} autre fichier est concerné.', other: '{count} autres fichiers sont concernés.' },
    pdfNote: {
      'pdf-kept-all-empty': 'L’e-mail entier sera dans le PDF\u00A0: l’outil n’a pas pu distinguer son propre texte de la citation.',
      'pdf-kept-all-empty-elsewhere': 'L’outil n’a pas pu distinguer son propre texte de la citation\u00A0: tout est dans le PDF, sauf les parties imprimées comme e-mails à part entière.',
      'pdf-fallback': 'L’e-mail entier sera dans le PDF\u00A0: l’outil n’a pas pu déterminer quelles parties laisser de côté.',
    },
    codedCharacters: 'Cet e-mail contient des caractères invisibles ou endommagés. Dans le PDF, ils peuvent apparaître sous forme de codes, comme [U+0000].',
  },

  rebuilt: {
    label: 'Reconstitué',
    noSubject: '(objet absent de la citation)',
    noteMarks: 'Reconstitué à partir du texte cité dans l’e-mail {number}. Signes de citation retirés\u202F; peut être incomplet ou inexact.',
    noteNoMarks: 'Reconstitué à partir du texte cité dans l’e-mail {number}. Peut être incomplet ou inexact.',
    alsoOne: 'Même texte cité aussi dans l’e-mail {list}.',
    alsoMany: 'Même texte cité aussi dans les e-mails {list}.',
    takenFrom: 'Tiré de',
    takenFromValue: 'l’e-mail {number}',
    listIncomplete: '(liste peut-être incomplète)',
    dateAbout: 'vers {date}',
    dateAsWritten: 'Telle qu’écrite dans la citation\u00A0: {text}',
    dateUnreadable: '(date illisible)',
    rebuildConversation: 'Reconstituer la conversation à partir des réponses',
    explain: 'Les e-mails reconstitués sont des e-mails antérieurs que l’outil a reconstitués à partir du texte cité dans une réponse. Ils peuvent être incomplets ou inexacts\u00A0: vérifiez-les avant de créer le PDF.',
    offWhileFullText: 'Indisponible tant que «\u00A0Imprimer le texte d’origine complet\u00A0» est coché.',
    itemFailed: 'Un problème est survenu à l’affichage de cet e-mail reconstitué. Son texte se trouve toujours dans l’e-mail d’où il est tiré.',
    sourceExcluded: 'Pas dans le PDF\u00A0: l’e-mail d’où il est tiré est laissé de côté',
    pdfSource: 'Dans le PDF\u00A0: tiré de {number}',
  },

  pdf: {
    everything: 'Imprimer le texte d’origine complet (citations et signatures comprises)',
    // Wording given by the user (2026-10-29, task 7.8c).
    everythingNote:
      'Si cette case est cochée, chaque e-mail coché figure en entier dans le PDF, e-mails antérieurs cités compris\u00A0: le même texte peut donc apparaître plusieurs fois. Laissez-la décochée pour un PDF plus clair.',
    updating: 'Vérification de ce qui va dans le PDF…',
    failed: 'L’outil n’a pas pu déterminer quelles parties le PDF laisse de côté, les parties repliées ne sont donc pas signalées.',
    label: {
      in: 'Dans le PDF\u00A0: {reasons}',
      out: 'Pas dans le PDF\u00A0: {reasons}',
      partly: 'En partie dans le PDF\u00A0: {reasons}',
    },
    reason: {
      text: 'texte écrit dans cet e-mail',
      'writer-quote': 'citation qui fait partie du texte de l’auteur',
      forwarded: 'e-mail transféré',
      'app-quoted-history': 'e-mail précédent cité par la messagerie',
      signature: 'signature',
      'repeated-signature': 'signature répétée',
    },
    repeatedFrom: 'même signature que dans l’e-mail {number}',
    repeatedFromMany: 'même signature que dans les e-mails {list}',
    printedAs: {
      email: 'Pas dans cet e-mail dans le PDF\u00A0: imprimé comme e-mail {number}',
      rebuilt: 'Pas dans cet e-mail dans le PDF\u00A0: imprimé comme e-mail reconstitué (E-mail {number} du PDF)',
      unticked: 'Pas dans le PDF\u00A0: e-mail transféré dont l’e-mail reconstitué est décoché',
      untickedAttached: 'Pas dans le PDF\u00A0: l’e-mail {number} (joint ici) est décoché',
    },
    messageFailed: 'L’outil n’a pas pu afficher ce que le PDF laisse de côté pour cet e-mail.',
    document: {
      title: 'Correspondance par e-mail',
      dates: 'Dates',
      dateRange: 'Du {first} au {last}',
      emails: 'E-mails',
      emailCount: { one: '{count} e-mail', other: '{count} e-mails' },
      generated: 'Créé le',
      timeZone: 'Fuseau horaire',
      people: 'Participants',
      index: 'Sommaire',
      column: {
        number: 'Nº',
        date: 'Date',
        dateInZone: 'Date ({zone})',
        from: 'De',
        subject: 'Objet',
        attachments: 'Pièces jointes',
        page: 'Page',
      },
      emailHeading: 'E-mail {number}',
      file: 'Fichier',
      attachedNoName: '(e-mail joint {number})',
      attachment: '({size}, {type})',
      attachmentNoType: '({size})',
      pageFooter: 'Page {page} sur {total}',
      coverBookmark: 'Page de garde',
      emailBookmark: '{number}. {date}, {from}\u00A0: {subject}',
      // ASCII only, like the English one.
      fileName: 'correspondance-{date}.pdf',
      fileNameNoDate: 'correspondance.pdf',
    },
  },

  warnings: {
    parse: {
      'missing-date': 'Aucune date n’a été trouvée dans cet e-mail.',
      'unparseable-date': 'La date de cet e-mail n’a pas pu être lue.',
      'unknown-time-zone': 'Le fuseau horaire de l’expéditeur n’est pas indiqué, l’heure peut donc être décalée de quelques heures.',
      'missing-message-id': 'Cet e-mail n’a pas de numéro de référence caché, les copies identiques sont donc plus difficiles à repérer.',
      'html-converted-body': 'Cet e-mail a été converti en texte simple à partir de sa version mise en forme. La présentation peut être différente.',
      'html-body-truncated': 'Cet e-mail est très long, son texte a donc été coupé ici. Le texte complet se trouve toujours dans le fichier d’origine.',
      'html-body-unreadable': 'Une partie de cet e-mail n’a pas pu être affichée (la version mise en forme n’a pas pu être lue).',
      'rtf-only-body': 'Le texte de cet e-mail est enregistré dans un format qui ne peut pas être affiché ici.',
      'text-encoding-uncertain': 'Certaines lettres de cet e-mail peuvent être mal affichées (son jeu de caractères n’est pas certain). L’original reste dans le fichier.',
      'no-body': 'Cet e-mail n’a pas de texte.',
      'forwarded-message-not-expanded':
        'Un e-mail ou un élément joint à celui-ci est seulement listé comme pièce jointe\u00A0: son texte n’est pas affiché. Il reste dans le fichier d’origine.',
    },
    dedupe: {
      'same-id-different-content': 'Un autre e-mail semble être le même message, mais son contenu est différent, les deux sont donc conservés.',
      'duplicate-date-differs': 'Une copie presque identique a une date différente, les deux sont donc conservées.',
      'duplicate-recipients-differ': 'Une copie presque identique indique d’autres destinataires, les deux sont donc conservées.',
      'duplicate-sender-differs': 'Une copie presque identique indique un autre expéditeur, les deux sont donc conservées.',
      'duplicate-threading-differs': 'Une copie presque identique contient d’autres informations de réponse, les deux sont donc conservées.',
      'possible-duplicate-not-merged': 'Ceci est peut-être une copie d’un autre e-mail, mais il a été conservé à part, par précaution.',
    },
    engine: {
      'detector-failed': 'Une partie du texte cité ou répété de cet e-mail n’a pas pu être vérifiée, il est donc affiché en entier.',
      'folding-disabled': 'Cet e-mail est affiché en entier\u202F; le texte cité n’a pas pu être replié.',
      'dedupe-failed': 'Les copies identiques n’ont pas pu être vérifiées, tous les e-mails sont donc conservés.',
    },
    rebuild: {
      'reconstruct-failed': 'Les e-mails antérieurs cités dans cet e-mail n’ont pas pu être reconstitués séparément. Tout le texte cité reste dans cet e-mail.',
      'reconstruct-limit': 'Les e-mails antérieurs cités dans cet e-mail n’ont pas tous pu être reconstitués (trop nombreux, ou e-mail trop long). Tout le texte cité reste dans cet e-mail.',
    },
  },

  errors: {
    file: {
      'too-large': 'Ce fichier est trop volumineux pour être lu.',
      'unsupported-type': 'Ce n’est pas un fichier e-mail (.eml ou .msg).',
      corrupt: 'Ce fichier n’a pas pu être lu. Il est peut-être endommagé.',
      timeout:
        'La lecture de ce fichier a pris trop de temps, elle a donc été arrêtée. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez-le de nouveau. Si elle s’arrête encore, le fichier est peut-être endommagé.',
      'tool-error':
        'L’outil n’a pas pu lire ce fichier. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez-le de nouveau. Si cela échoue encore, l’outil ne peut pas lire ce fichier.',
      unreadable:
        'Votre navigateur n’a pas pu ouvrir ce fichier. Il a peut-être été déplacé ou modifié depuis que vous l’avez choisi. Ajoutez-le de nouveau.',
    },
    batch: {
      'engine-timeout':
        'La mise en ordre de vos e-mails a pris trop de temps. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez moins de fichiers.',
      'engine-failed':
        'Vos e-mails n’ont pas pu être mis en ordre. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez de nouveau vos fichiers.',
      unexpected: 'Un problème est survenu. Pour réessayer, reconnectez-vous à internet, rechargez la page et ajoutez de nouveau vos fichiers.',
      cancelled: 'La lecture a été arrêtée parce que tout a été effacé.',
    },
  },

  clear: {
    note: 'Retire d’un coup tous vos e-mails de cette page. Cette page ne les enregistre jamais.',
    unavailable: 'Il n’y a rien à effacer\u00A0: aucun e-mail n’a été ajouté.',
    done: 'Tout a été effacé.',
  },

  actions: {
    chooseFiles: 'Choisir des fichiers e-mail',
    makePdf: 'Créer le PDF',
    clearEverything: 'Tout effacer',
    include: 'Inclure dans le PDF',
  },

  footer: {
    note: 'Fonctionne dans votre navigateur\u00A0: aucun envoi, aucun compte, aucun suivi.',
  },
};
