// Every user-visible string of the page, in Dutch. Same keys as en.ts (the
// `Messages` type makes a missing or extra key a compile error); the
// comments there say where each text is shown.
//
// Rules for this file (on top of those of en.ts):
// - Formal "u", plain calm words: "e-mailbestand", never jargon. Standard
//   Dutch that reads naturally in Belgium and in the Netherlands alike (no
//   words used in only one of them).
// - Same meaning as English, with the SAME caution: the mail-client help
//   keeps "meestal" / "mogelijk" exactly where English says "usually" /
//   "may", and makes no new claim. The Dutch menu names there are a best
//   guess: help.note says menu names differ by version and language.
// - Dutch typography: double quotation marks “…” (never "…" or „…”), the
//   typographic apostrophe ’ ("pagina’s"), and no special space before
//   punctuation (unlike French). Every character is written as itself, so
//   the text stays readable for proofreading. Source/web-page/translations/nl.test.ts checks
//   these rules.
// - Numbers in `{count}` and the like are written by t() with the browser's
//   Dutch rules (Intl), never by hand.
// - Not translated (user decision): the app's name, mail program names,
//   "UTC", MIME types, hashes. The PDF's file name is ASCII only.

import type { Messages } from './index';

export const nl: Messages = {
    app: {
        name: 'Email to PDF',
        promise: 'Alles blijft op uw computer.',
    },

    donate: {
        label: 'Steun mij op Ko-fi (opent in een nieuw tabblad)',
    },

    language: {
        label: 'Taal',
        changed: 'De pagina is nu in het Nederlands.',
    },

    privacy: {
        summary: 'Uw privacy: hoe deze pagina werkt',
        does: {
            title: 'Wat deze pagina doet',
            local: 'Uw e-mailbestanden worden alleen in dit tabblad van de browser gelezen, op uw computer.',
            noUpload: 'Niets verlaat uw computer.',
            noSaving:
                'Deze pagina bewaart niets van u: geen cookies, en niets uit uw e-mails in de browser. Uw browser bewaart alleen een kopie van de eigen bestanden van deze pagina, zodat de pagina ook zonder internet kan openen. Alleen de PDF die u zelf downloadt, wordt opgeslagen, in uw downloadmap.',
            wiped:
                'Dit tabblad sluiten of opnieuw laden, of op “Alles wissen” drukken, haalt alles van deze pagina weg. Een PDF die u al hebt gedownload, blijft in uw downloads.',
            pdf: 'Ook de PDF wordt hier gemaakt. Zodra u hem downloadt, staat hij alleen op uw computer.',
        },
        never: {
            title: 'Wat deze pagina nooit doet',
            upload: 'Ze verstuurt nooit iets via internet, en er zijn geen accounts.',
            tracking: 'Ze volgt u nooit: geen bezoekersstatistieken, niemand telt of volgt wat u hier doet.',
            remote: 'Ze laadt nooit afbeeldingen of iets anders van internet waarnaar een e-mail verwijst.',
            attachments: 'Ze opent nooit bijgevoegde bestanden (documenten, afbeeldingen enzovoort): ze toont alleen hun naam, grootte en type.',
        },
        check: {
            title: 'Hoe u het zelf kunt controleren',
            offline:
                'Zet uw internet uit nadat de pagina is geladen (of gebruik de vliegtuigmodus), en gebruik dan de tool: hij werkt nog steeds. In de meeste browsers kunt u de pagina, als u ze één keer met internet hebt geopend, ook zonder internet opnieuw laden of opnieuw openen: uw browser bewaart een kopie van de eigen bestanden van deze pagina (nooit van uw e-mails).',
            network:
                'Voor technische mensen: open de ontwikkelaarstools van uw browser en ga naar het tabblad Netwerk. Bij het openen worden de eigen bestanden van de pagina geladen. Uw browser kan ze ook op de achtergrond opnieuw van deze site ophalen, om zijn kopie voor gebruik zonder internet bij te werken, en hij vraagt deze site om het bestand “/sw.js” om te zien of er een nieuwe versie is. Kijk daarna mee terwijl u de tool gebruikt: er gaat niets naar internet. Een paar regels waarvan het adres begint met “blob:” zijn delen van deze pagina die in uw browser werken.',
            source: 'De code van deze pagina is open source: iedereen kan hem lezen en controleren wat hij doet.',
        },
        notes: {
            title: 'Goed om te weten',
            trust:
                'Uw vertrouwen hangt af van de code die deze site naar uw browser stuurt. Daarom is de code open source en kan iedereen hem controleren. Zoals bij elke website kan de site waarop deze pagina staat zien dat de pagina is geladen, maar nooit uw e-mails.',
            console:
                'De ontwikkelaarstools van uw browser kunnen rode foutregels tonen waarin “Content Security Policy” staat. Dat is de browser die stijlen, scripts of links weigert, bijvoorbeeld die uit uw e-mails: de beveiliging werkt. Niets uit uw e-mails is uitgevoerd of geladen.',
            scripts:
                'In de PDF worden sommige schriften (bijvoorbeeld Hebreeuws, Arabisch, Chinees, Japans, Koreaans, Thais of Hindi) en emoji getoond als codes zoals [U+05D0], omdat het lettertype van de PDF ze niet bevat. Tekst in het Latijnse, Griekse en Cyrillische schrift wordt gewoon getoond. De tekst in uw originele bestanden blijft ongewijzigd.',
        },
    },

    disclaimer: {
        text: 'Deze tool wordt aangeboden in de huidige staat, zonder enige garantie, en is geen juridisch advies. Controleer de PDF voordat u hem verstuurt. Uw originele e-mailbestanden blijven leidend.',
    },

    steps: {
        number: 'Stap {number}',
        add: {
            title: 'Voeg uw e-mails toe',
            intro: 'Gebruik de e-mailbestanden die u vanuit uw e-mailprogramma hebt opgeslagen (.eml- of .msg-bestanden).',
        },
        check: {
            title: 'Controleer',
            intro: 'Bekijk uw e-mails, op datum gesorteerd, voordat u de PDF maakt.',
            waiting: 'Uw e-mails verschijnen hier zodra u ze hebt toegevoegd.',
        },
        download: {
            title: 'Download de PDF',
            intro: 'Sla één PDF op met al uw e-mails, de oudste eerst.',
        },
    },

    help: {
        summary: 'Hoe krijg ik mijn e-mailbestanden?',
        intro: 'Deze tool leest .eml- en .msg-bestanden. U kunt meerdere bestanden tegelijk toevoegen.',
        clients: {
            outlookClassic: {
                name: 'Outlook (klassiek, op Windows)',
                how: 'Een e-mail uit de lijst naar een map of naar het bureaublad slepen maakt meestal een bestand: een .eml- of .msg-bestand, afhankelijk van uw Outlook-versie. Beide werken hier. Ook “Opslaan als” in het menu Bestand slaat er mogelijk een op.',
            },
            outlookNew: {
                name: 'Nieuwe Outlook en Outlook op het web',
                how: 'Dit verschilt. Mogelijk staat er in het menu “...” van de e-mail een optie Downloaden of Opslaan die een .eml-bestand geeft; een e-mail slepen maakt mogelijk geen bestand.',
            },
            thunderbird: {
                name: 'Thunderbird',
                how: 'Een e-mail naar een map slepen, of “Opslaan als” in het menu Bestand gebruiken, geeft meestal een .eml-bestand.',
            },
            appleMail: {
                name: 'Apple Mail',
                how: 'Een e-mail naar een map in de Finder slepen geeft meestal een .eml-bestand.',
            },
            gmail: {
                name: 'Gmail (in een webbrowser)',
                how: 'Open de e-mail en zoek dan “Bericht downloaden” in het menu met de drie puntjes. Dat geeft meestal een .eml-bestand.',
            },
        },
        note: 'Menunamen kunnen per versie en per taal verschillen. Bij u zijn ze dus mogelijk niet precies hetzelfde.',
    },

    download: {
        unavailable: {
            'no-emails': 'Voeg eerst uw e-mails toe in stap 1.',
            busy: 'Even geduld: uw e-mails worden nog gelezen en gecontroleerd.',
            'none-included': 'Vink in stap 2 minstens één e-mail aan om een PDF te maken.',
            'none-with-text': 'Geen van de aangevinkte e-mails heeft tekst, dus er is niets om in een PDF te zetten.',
            'labels-failed':
                'De PDF kan niet worden gemaakt: de tool kon niet bepalen wat erin moet. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg uw bestanden nog eens toe.',
        },
        available: 'Maakt één PDF van de e-mails die in stap 2 zijn aangevinkt, hier op deze computer.',
        changed: 'Uw keuzes zijn gewijzigd, dus de vorige PDF is verwijderd. Maak de PDF opnieuw om ze mee te nemen.',
        changedAfter: '{news} {changed}',
        making: 'Uw PDF wordt gemaakt… Bij veel e-mails kan dit even duren. U kunt de pagina intussen gewoon gebruiken.',
        ready: {
            one: 'Uw PDF is klaar: {fileName}, {count} pagina. Het downloaden is begonnen.',
            other: 'Uw PDF is klaar: {fileName}, {count} pagina’s. Het downloaden is begonnen.',
        },
        again: 'Opnieuw downloaden: {fileName}',
        error: {
            timeout:
                'Het maken van de PDF duurde te lang en is daarom gestopt. U kunt het opnieuw proberen, of in stap 2 een paar e-mails uitvinken om een kleinere PDF te maken.',
            'tool-error': 'De tool kon de PDF niet maken. Uw e-mails zijn er nog: u kunt het opnieuw proberen.',
            'not-started':
                'De tool kon in deze browser niet beginnen met het maken van de PDF. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg uw bestanden nog eens toe.',
        },
    },

    drop: {
        zone: 'Sleep uw e-mailbestanden hierheen, of kies ze.',
        accepted: 'Toegestaan: .eml- en .msg-bestanden. U kunt op elk moment meer bestanden toevoegen.',
        reading: 'Bestand {done} van {total} wordt gelezen…',
        readingOne: 'Uw bestand wordt gelezen…',
        readingMany: '{total} bestanden worden gelezen. Dit kan even duren; de voortgangsbalk hieronder toont hoe ver het is.',
        organizing: 'Uw e-mails worden op volgorde gezet…',
        queued: 'Er zijn meer bestanden toegevoegd. Ze worden gelezen zodra de huidige klaar zijn.',
        outside: 'Er is niets toegevoegd. Laat bestanden los op het vak met de gestreepte rand in stap 1 om ze toe te voegen.',
        nothing: 'Er is niets toegevoegd: hier kunnen alleen bestanden worden neergezet.',
        folders: {
            one: '{count} map kon niet worden toegevoegd. Open de map en voeg in plaats daarvan de e-mailbestanden toe die erin staan.',
            other: '{count} mappen konden niet worden toegevoegd. Open ze en voeg in plaats daarvan de e-mailbestanden toe die erin staan.',
        },
    },

    added: {
        files: { one: '{count} bestand toegevoegd.', other: '{count} bestanden toegevoegd.' },
        failed: { one: '{count} kon niet worden gelezen.', other: '{count} konden niet worden gelezen.' },
        messages: { one: '{count} e-mail gevonden.', other: '{count} e-mails gevonden.' },
        messagesAttached: { one: '{count} e-mail gevonden ({attached}).', other: '{count} e-mails gevonden ({attached}).' },
        merged: { one: '{count} identieke kopie samengevoegd.', other: '{count} identieke kopieën samengevoegd.' },
        failedTitle: 'Bestanden die niet konden worden gelezen',
        details: 'Technische details',
        noName: '(bestand zonder naam)',
    },

    preview: {
        from: 'Van',
        to: 'Aan',
        cc: 'Cc',
        bcc: 'Bcc',
        date: 'Datum',
        subject: 'Onderwerp',
        attachments: 'Bijlagen',
        noSubject: '(geen onderwerp)',
        noDate: '(geen datum)',
        noText: '(geen tekst)',
        notInPdfNoText: 'Niet in de PDF: deze e-mail heeft geen tekst.',
        itemFailed: 'Er ging iets mis bij het tonen van deze e-mail. De tekst ervan, als die er is, staat hieronder zoals hij is.',
        showFolded: 'Geciteerde tekst en handtekeningen tonen',
        listLabel: 'Uw e-mails, de oudste eerst',
        messageNumber: '#{number}',
        dateAsWritten: 'Zoals geschreven in de e-mail: {text}',
        mailbox: '{name} <{address}>',
        alsoIn: 'Ook in',
        attachedTo: 'Bijgevoegd bij',
        attachedToOne: 'e-mail {list}',
        attachedToMany: 'e-mails {list}',
        attachedEmails: 'Bijgevoegde e-mails',
        attachment: '{name} ({size}, {type})',
        attachmentNoType: '{name} ({size})',
        noAttachmentName: '(bijlage zonder naam)',
        size: {
            bytes: { one: '{count} byte', other: '{count} bytes' },
            kb: '{size} KB',
            mb: '{size} MB',
            unknown: 'grootte onbekend',
        },
        foldLabel: '{kind}, {lines}',
        foldLabelFrom: '{kind}, {lines}, {from}',
        foldLines: { one: '{count} regel', other: '{count} regels' },
        foldFromOne: 'uit e-mail {list}',
        foldFromMany: 'uit e-mails {list}',
        foldOther: 'Ingeklapte tekst',
        author: {
            from: 'Van',
            sender: 'Verzonden door',
            none: 'Onbekende afzender',
        },
        order: {
            'file-order': 'Geen bruikbare datum: achteraan in de lijst gezet, in de volgorde waarin de bestanden zijn toegevoegd.',
            'before-parent': 'Geen bruikbare datum: vlak voor de e-mail gezet waarbij hij is gevoegd.',
        },
        fold: {
            'quoted-overlap': 'Tekst uit een eerdere e-mail',
            'quote-marker': 'Geciteerde tekst',
            'reply-header': 'Geciteerde eerdere e-mail',
            signature: 'Handtekening of herhaalde mededeling',
        },
    },

    counts: {
        sentence: '{text}.',
        files: { one: '{count} bestand', other: '{count} bestanden' },
        // Only used inside filesWithFailed, after "waarvan": hence the verb at the end.
        filesFailed: { one: '{count} niet kon worden gelezen', other: '{count} niet konden worden gelezen' },
        // "waarvan": the failed files are among the {files}.
        filesWithFailed: '{files}, waarvan {failed}',
        seeFailed: 'Zie stap 1 voor de reden.',
        messagesFound: { one: '{count} e-mail gevonden', other: '{count} e-mails gevonden' },
        messagesFoundAttached: '{found} ({attached})',
        attachedFound: { one: '{count} bijgevoegd bij een andere e-mail', other: '{count} bijgevoegd bij andere e-mails' },
        duplicatesMerged: { one: '{count} identieke kopie samengevoegd', other: '{count} identieke kopieën samengevoegd' },
        rebuiltFound: { one: '{count} eerdere e-mail gereconstrueerd uit geciteerde tekst', other: '{count} eerdere e-mails gereconstrueerd uit geciteerde tekst' },
        // The form follows {count} (the total), as in English, so no verb that
        // would have to agree with {included}: hence "In de PDF: 1 van 5 e-mails".
        included: {
            one: 'In de PDF: {included} van {count} e-mail.',
            other: 'In de PDF: {included} van {count} e-mails.',
        },
        noTextLeftOut: { one: '{count} weggelaten omdat er geen tekst in staat', other: '{count} weggelaten omdat er geen tekst in staat' },
        printedAllElsewhereLeftOut: {
            one: '{count} weggelaten: de tekst ervan staat al in andere e-mails',
            other: '{count} weggelaten: hun tekst staat al in andere e-mails',
        },
        rebuiltIncluded: {
            one: 'In de PDF: {included} van {count} gereconstrueerde e-mail.',
            other: 'In de PDF: {included} van {count} gereconstrueerde e-mails.',
        },
        rebuiltLeftOut: 'Weggelaten: {reasons}',
        rebuiltLeftOutReason: {
            'no-text': { one: '{count} heeft geen tekst', other: '{count} hebben geen tekst' },
            unticked: { one: '{count} is niet aangevinkt', other: '{count} zijn niet aangevinkt' },
            'source-left-out': { one: '{count} komt uit een e-mail die wordt weggelaten', other: '{count} komen uit e-mails die worden weggelaten' },
        },
        withNotes: {
            one: '{count} e-mail heeft opmerkingen, die hieronder bij de e-mail staan.',
            other: '{count} e-mails hebben opmerkingen, die hieronder bij elke e-mail staan.',
        },
    },

    review: {
        excluded: 'Niet in de PDF',
        notesLabel: 'Opmerkingen over deze e-mail',
        relatedOne: 'Zie e-mail {list}.',
        relatedMany: 'Zie e-mails {list}.',
        relatedMoreFiles: { one: 'Er is nog {count} bestand bij betrokken.', other: 'Er zijn nog {count} bestanden bij betrokken.' },
        relatedOnlyMore: { one: 'Er is {count} ander bestand bij betrokken.', other: 'Er zijn {count} andere bestanden bij betrokken.' },
        pdfNote: {
            'pdf-kept-all-empty': 'De hele e-mail komt in de PDF: de tool kon de eigen tekst niet van het citaat onderscheiden.',
            'pdf-kept-all-empty-elsewhere': 'De tool kon de eigen tekst niet van het citaat onderscheiden: alles staat in de PDF, behalve de delen die als aparte e-mails zijn afgedrukt.',
            'pdf-fallback': 'De hele e-mail komt in de PDF: de tool kon niet bepalen welke delen moeten worden weggelaten.',
            'pdf-all-printed-elsewhere': 'Niet in de PDF: al zijn tekst staat in andere e-mails of is weggelaten, zoals hieronder aangegeven.',
        },
        codedCharacters: 'Deze e-mail bevat onzichtbare of beschadigde tekens. In de PDF kunnen die als codes staan, zoals [U+0000].',
    },

    rebuilt: {
        label: 'Gereconstrueerd',
        noSubject: '(onderwerp staat niet in het citaat)',
        noteMarks: 'Gereconstrueerd uit de geciteerde tekst in e-mail {number}. Citaattekens verwijderd; mogelijk onvolledig of onnauwkeurig.',
        noteNoMarks: 'Gereconstrueerd uit de geciteerde tekst in e-mail {number}. Mogelijk onvolledig of onnauwkeurig.',
        alsoOne: 'Dezelfde geciteerde tekst staat ook in e-mail {list}.',
        alsoMany: 'Dezelfde geciteerde tekst staat ook in e-mails {list}.',
        takenFrom: 'Overgenomen uit',
        takenFromValue: 'e-mail {number}',
        listIncomplete: '(lijst mogelijk onvolledig)',
        dateAsWritten: 'Zoals geschreven in het citaat: {text}',
        dateUnreadable: '(datum kon niet worden gelezen)',
        rebuildConversation: 'Gesprek reconstrueren uit de antwoorden',
        explain: 'Gereconstrueerde e-mails zijn eerdere e-mails die de tool heeft gereconstrueerd uit de geciteerde tekst in een antwoord. Ze kunnen onvolledig of onnauwkeurig zijn, dus controleer ze voordat u de PDF maakt.',
        offWhileFullText: 'Niet beschikbaar zolang “Volledige originele tekst afdrukken” is aangevinkt.',
        itemFailed: 'Er ging iets mis bij het tonen van deze gereconstrueerde e-mail. De tekst staat nog in de e-mail waaruit hij is overgenomen.',
        sourceExcluded: 'Niet in de PDF: de e-mail waaruit hij is overgenomen, wordt weggelaten',
        pdfSource: 'In de PDF: overgenomen uit {number}',
    },

    pdf: {
        everything: 'Volledige originele tekst afdrukken (geciteerde tekst en handtekeningen inbegrepen)',
        // Wording given by the user (2026-10-29, task 7.8c).
        everythingNote:
            'Als dit is aangevinkt, komt elke aangevinkte e-mail volledig in de PDF, met de geciteerde eerdere e-mails erbij, dus dezelfde tekst kan meer dan eens voorkomen. Laat dit uitgevinkt voor een overzichtelijkere PDF.',
        updating: 'Controleren wat er in de PDF komt…',
        failed: 'De tool kon niet bepalen welke delen de PDF weglaat, dus de ingeklapte delen zijn niet gemarkeerd.',
        label: {
            in: 'In de PDF: {reasons}',
            out: 'Niet in de PDF: {reasons}',
            partly: 'Deels in de PDF: {reasons}',
        },
        reason: {
            text: 'tekst geschreven in deze e-mail',
            'writer-quote': 'citaat dat deel is van de tekst van de schrijver',
            forwarded: 'doorgestuurde e-mail',
            'app-quoted-history': 'eerdere e-mail die het e-mailprogramma citeerde',
            signature: 'handtekening',
            'repeated-signature': 'herhaalde handtekening',
        },
        repeatedFrom: 'dezelfde handtekening als in e-mail {number}',
        repeatedFromMany: 'dezelfde handtekening als in e-mails {list}',
        printedAs: {
            email: 'Niet in deze e-mail in de PDF: afgedrukt als e-mail {number}',
            rebuilt: 'Niet in deze e-mail in de PDF: afgedrukt als gereconstrueerde e-mail (E-mail {number} in de PDF)',
            unticked: 'Niet in de PDF: doorgestuurde e-mail waarvan de gereconstrueerde e-mail niet is aangevinkt',
            untickedAttached: 'Niet in de PDF: e-mail {number} (hier bijgevoegd) is niet aangevinkt',
            // NEEDS USER PROOFREADING (task 9.9b)
            noTextAttached: 'Niet in de PDF: e-mail {number} (hier bijgevoegd) heeft geen tekst',
            // NEEDS USER PROOFREADING (task 9.9b)
            noText: 'Niet in de PDF: geciteerde e-mail zonder tekst (alleen kopregels)',
            // NEEDS USER PROOFREADING (task 9.9b)
            notRebuilt: 'Niet in de PDF: geciteerd deel dat niet als e-mail kon worden gereconstrueerd',
        },
        messageFailed: 'De tool kon niet tonen wat de PDF van deze e-mail weglaat.',
        document: {
            title: 'E-mailcorrespondentie',
            dates: 'Datums',
            dateRange: 'Van {first} tot {last}',
            emails: 'E-mails',
            emailCount: { one: '{count} e-mail', other: '{count} e-mails' },
            generated: 'Gemaakt op',
            people: 'Personen',
            index: 'Inhoudsopgave',
            column: {
                number: 'Nr.',
                date: 'Datum',
                from: 'Van',
                subject: 'Onderwerp',
                attachments: 'Bijlagen',
                page: 'Pagina',
            },
            emailHeading: 'E-mail {number}',
            file: 'Bestand',
            attachedNoName: '(bijgevoegde e-mail {number})',
            attachment: '({size}, {type})',
            attachmentNoType: '({size})',
            pageFooter: 'Pagina {page} van {total}',
            coverBookmark: 'Voorblad',
            emailBookmark: '{number}. {date}, {from}: {subject}',
            // ASCII only, like the English one.
            fileName: 'correspondentie-{date}.pdf',
            fileNameNoDate: 'correspondentie.pdf',
        },
    },

    warnings: {
        parse: {
            'missing-date': 'Er is geen datum gevonden in deze e-mail.',
            'unparseable-date': 'De datum van deze e-mail kon niet worden gelezen.',
            'unknown-time-zone': 'De tijdzone van de afzender staat er niet bij. De tijd wordt getoond zoals geschreven, maar de plaats van deze e-mail in de lijst kan afwijken.',
            'missing-message-id': 'Deze e-mail heeft geen verborgen referentienummer, dus identieke kopieën zijn moeilijker te herkennen.',
            'html-converted-body': 'Deze e-mail is van de opgemaakte versie omgezet naar gewone tekst. De opmaak kan er anders uitzien.',
            'html-body-truncated': 'Deze e-mail is erg lang, dus de tekst is hier ingekort. De volledige tekst staat nog in het originele bestand.',
            'html-body-unreadable': 'Een deel van deze e-mail kon niet worden getoond (de opgemaakte versie kon niet worden gelezen).',
            'rtf-only-body': 'De tekst van deze e-mail is opgeslagen in een formaat dat hier niet kan worden getoond.',
            'text-encoding-uncertain': 'Sommige letters in deze e-mail kunnen verkeerd worden getoond (de tekenset is niet zeker). Het origineel staat nog in het bestand.',
            'no-body': 'Deze e-mail heeft geen tekst.',
            'forwarded-message-not-expanded':
                'Een e-mail of item die bij deze e-mail is gevoegd, staat alleen in de lijst als bijlage: de tekst ervan wordt niet getoond. Dit staat nog in het originele bestand.',
        },
        dedupe: {
            'same-id-different-content': 'Een andere e-mail lijkt hetzelfde bericht te zijn, maar de inhoud verschilt, dus beide worden bewaard.',
            'duplicate-date-differs': 'Een bijna identieke kopie heeft een andere datum, dus beide worden bewaard.',
            'duplicate-recipients-differ': 'Een bijna identieke kopie vermeldt andere ontvangers, dus beide worden bewaard.',
            'duplicate-sender-differs': 'Een bijna identieke kopie noemt een andere afzender, dus beide worden bewaard.',
            'duplicate-threading-differs': 'Een bijna identieke kopie heeft andere antwoordgegevens, dus beide worden bewaard.',
            'possible-duplicate-not-merged': 'Dit is mogelijk een kopie van een andere e-mail, maar voor de zekerheid is deze apart bewaard.',
        },
        engine: {
            'detector-failed': 'Een deel van de geciteerde of herhaalde tekst in deze e-mail kon niet worden gecontroleerd, dus de e-mail wordt volledig getoond.',
            'folding-disabled': 'Deze e-mail wordt volledig getoond; geciteerde tekst kon niet worden ingeklapt.',
            'dedupe-failed': 'Identieke kopieën konden niet worden gecontroleerd, dus elke e-mail wordt bewaard.',
        },
        rebuild: {
            'reconstruct-failed': 'De eerdere e-mails die in deze e-mail worden geciteerd, konden niet als afzonderlijke e-mails worden gereconstrueerd. De geciteerde tekst staat nog volledig in deze e-mail.',
            'reconstruct-limit': 'Niet alle eerdere e-mails die in deze e-mail worden geciteerd, konden worden gereconstrueerd (te veel, of de e-mail is te lang). De geciteerde tekst staat nog volledig in deze e-mail.',
        },
        attached: {
            'attached-unread':
                'Een e-mail die als bestand bij deze e-mail is gevoegd, is niet gelezen, dus de tekst ervan wordt niet getoond. Hij staat bij de bijlagen en staat nog in het originele bestand.',
            'attached-unread-inside':
                'Een e-mail in deze e-mail heeft een als bestand bijgevoegde e-mail die niet is gelezen, dus de tekst ervan wordt niet getoond. Hij staat bij de bijlagen en staat nog in het originele bestand.',
        },
    },

    errors: {
        file: {
            'too-large': 'Dit bestand is te groot om te lezen.',
            'unsupported-type': 'Dit is geen e-mailbestand (.eml of .msg).',
            corrupt: 'Dit bestand kon niet worden gelezen. Het is mogelijk beschadigd.',
            timeout:
                'Het lezen van dit bestand duurde te lang en is daarom gestopt. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg het bestand nog eens toe. Als het weer stopt, is het bestand mogelijk beschadigd.',
            'tool-error':
                'De tool kon dit bestand niet lezen. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg het bestand nog eens toe. Als het weer mislukt, kan de tool dit bestand niet lezen.',
            unreadable: 'Uw browser kon dit bestand niet openen. Het is mogelijk verplaatst of gewijzigd sinds u het koos. Voeg het opnieuw toe.',
        },
        batch: {
            'engine-timeout':
                'Het op volgorde zetten van uw e-mails duurde te lang. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg minder bestanden toe.',
            'engine-failed':
                'Uw e-mails konden niet op volgorde worden gezet. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg uw bestanden nog eens toe.',
            unexpected: 'Er ging iets mis. Wilt u het opnieuw proberen? Maak dan weer verbinding met internet, laad de pagina opnieuw en voeg uw bestanden nog eens toe.',
            cancelled: 'Het lezen is gestopt omdat alles is gewist.',
        },
    },

    clear: {
        note: 'Haalt al uw e-mails in één keer van deze pagina weg. Deze pagina bewaart ze nooit.',
        unavailable: 'Er is niets te wissen: er zijn geen e-mails toegevoegd.',
        done: 'Alles is gewist.',
    },

    actions: {
        chooseFiles: 'E-mailbestanden kiezen',
        makePdf: 'De PDF maken',
        clearEverything: 'Alles wissen',
        include: 'Opnemen in de PDF',
    },

    footer: {
        note: 'Werkt in uw browser: niets wordt verstuurd, geen account, niemand volgt u.',
    },
};
