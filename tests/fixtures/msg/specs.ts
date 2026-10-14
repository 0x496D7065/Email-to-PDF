// SYNTHETIC classic-Outlook (.msg) fixtures, as plain data (README.md, rule R7).
// builder.ts turns each spec into real .msg bytes in memory at test time.
// Invented people and companies only; domains only *.test / *.invalid
// (enforced by synthetic-guard.test.ts). Expected parse results: manifest.ts.

import type { MsgMailboxSpec, MsgSpec } from './builder';

const ALICE: MsgMailboxSpec = { name: 'Alice Example', smtp: 'alice@example.test' };
const CAROL: MsgMailboxSpec = { name: 'Carol Test - Équipe Livraisons', smtp: 'carol@sample.invalid' };
/** Bob is an internal Exchange user of his (fictional) company: X.500 DN + SMTP fallback. */
const BOB: MsgMailboxSpec = {
  name: 'Bob Sample',
  smtp: 'bob@furniture.example.test',
  exchangeDn: '/O=EXAMPLE TEST ORGANIZATION/OU=EXCHANGE ADMINISTRATIVE GROUP (FYDIBOHF23SPDLT)/CN=RECIPIENTS/CN=BOB.SAMPLE',
};
/** The planning desk of Bob's (fictional) company: a shared Exchange mailbox that sends on Bob's behalf. */
const PLANNING: MsgMailboxSpec = {
  name: 'Sample Furniture Planning',
  smtp: 'planning@furniture.example.test',
  exchangeDn: '/O=EXAMPLE TEST ORGANIZATION/OU=EXCHANGE ADMINISTRATIVE GROUP (FYDIBOHF23SPDLT)/CN=RECIPIENTS/CN=PLANNING',
};

// Same signature/disclaimer text as Bob's .eml fixtures, so the repeated-block
// detection (Milestone 3) can be tested across both formats.
const ALICE_SIG = '-- \nAlice Example\nSent from my laptop';
const BOB_SIG = 'Met vriendelijke groeten,\nBob Sample\nSample Furniture (fictional company)';
const BOB_DISCLAIMER =
  'DISCLAIMER: This e-mail and any attachments are confidential and intended\n' +
  'solely for the addressee. If you have received it in error, please notify\n' +
  'the sender and delete it. Sample Furniture accepts no liability for its\n' +
  'content.';
const CAROL_SIG = 'Cordialement,\nCarol Test\nÉquipe Livraisons, Mobilier Exemple (fictional company)';

const CHAIN_1 = `Beste Alice,

Hierbij mijn offerte voor de vergadertafel en zes stoelen: EUR 2.400,
btw inbegrepen. De offerte is 30 dagen geldig.

${BOB_SIG}

${BOB_DISCLAIMER}`;

const CHAIN_2 = `Hello Bob,

Thank you, the quote is accepted. Could you deliver in May?

Alice

________________________________
De : Bob Sample <bob@furniture.example.test>
Envoyé : mercredi 2 avril 2025 11:00
À : Alice Example <alice@example.test>
Objet : Offerte vergadertafel

${CHAIN_1}`;

const CHAIN_3 = `Beste Alice,

Mei is goed: ik noteer maandag 5 mei.

${BOB_SIG}

${BOB_DISCLAIMER}

________________________________
Van: Alice Example <alice@example.test>
Verzonden: woensdag 2 april 2025 14:15
Aan: Bob Sample <bob@furniture.example.test>
Onderwerp: RE: Offerte vergadertafel

${CHAIN_2}`;

/** Exactly the text body of eml/11-order-2-bob-outlook-en.eml (cross-format duplicate). */
const ORDER_2 = `Hello Alice,

Thank you for your message. I can come by on Wednesday 5 March at 10:00
to measure the room. The quote will follow after the visit.

${BOB_SIG}

${BOB_DISCLAIMER}

________________________________
From: Alice Example <alice@example.test>
Sent: Monday, March 3, 2025 9:15 AM
To: Bob Sample <bob@furniture.example.test>
Subject: Office desks and chairs

Hi Bob,

We are furnishing a small office for four people and need four desks
and four chairs. Could you send me a quote? Someone is at the office
most mornings if you want to see the room first.

Thanks,
Alice

${ALICE_SIG}`;

/** Inert-but-tricky HTML: nothing in it may ever run or load (README.md, rules R1 and R4). */
const CATALOGUE_HTML = `<html><head>
<link rel="stylesheet" href="https://cdn.invalid/outlook.css">
<script>document.title = 'MSG-SCRIPT-RAN'; fetch('https://tracker.invalid/msg');</script>
</head>
<body onload="alert('MSG-ONLOAD-RAN')">
<p>Bonjour Alice,</p>
<p>Voici notre <b>catalogue de printemps</b>.</p>
<img src="https://tracker.invalid/msg-pixel.png" width="1" height="1" alt="">
<a href="javascript:alert('MSG-JS-LINK-RAN')">Se d&eacute;sinscrire</a>
</body></html>`;

/**
 * HTML-only body (no plain-text body), as it would arrive in the same batch
 * as everything else: its text must come from the inert converter, with
 * nothing in it run or loaded (README.md, rules R1 and R4).
 */
const SHOWROOM_HTML = `<html><head>
<link rel="stylesheet" href="https://cdn.invalid/msg13.css">
<script>document.title = 'MSG13-SCRIPT-RAN';</script>
</head><body>
<p>Hello Alice,</p>
<p>The showroom visit is on <b>Friday 25 April</b> at 14:00.</p>
<img src="https://tracker.invalid/msg13-pixel.png" width="1" height="1" alt="" onerror="document.title = 'MSG13-ONERROR-RAN'">
<p><a href="https://shop.invalid/route">Plan your route</a></p>
<p>Carol</p>
</body></html>`;

export const MSG_SPECS: readonly MsgSpec[] = [
  {
    id: 'msg-01-plain-unicode',
    description: 'Plain Unicode message (FR/NL accents, en dash, euro sign), To + Cc, sent and received times.',
    strings: 'unicode',
    subject: 'Réunion de livraison – planning',
    sender: ALICE,
    recipients: [
      { ...BOB, type: 'to' },
      { ...CAROL, type: 'cc' },
    ],
    bodyText: `Bonjour Bob,

Pour la réunion de livraison : mercredi à 9h, café prévu.
Daarna bespreken we de planning (één uur, € 0 extra).

Alice

${ALICE_SIG}`,
    submitTime: '2025-04-01T07:30:00Z',
    deliveryTime: '2025-04-01T07:30:04Z',
    messageId: '<msg-plain-1.alice@example.test>',
  },
  {
    id: 'msg-02-chain-1-bob',
    description: 'Reply chain 1/3: Dutch quote from an Exchange sender (X.500 DN + SMTP fallback), signature + disclaimer.',
    strings: 'unicode',
    subject: 'Offerte vergadertafel',
    sender: BOB,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: CHAIN_1,
    submitTime: '2025-04-02T09:00:00Z',
    messageId: '<msg-chain-1.bob@furniture.example.test>',
  },
  {
    id: 'msg-03-chain-2-alice-fr',
    description: 'Reply chain 2/3: reply quoting with a French Outlook header block (De/Envoyé/À/Objet).',
    strings: 'unicode',
    subject: 'RE: Offerte vergadertafel',
    sender: ALICE,
    recipients: [{ ...BOB, type: 'to' }],
    bodyText: CHAIN_2,
    submitTime: '2025-04-02T12:15:00Z',
    messageId: '<msg-chain-2.alice@example.test>',
    inReplyTo: '<msg-chain-1.bob@furniture.example.test>',
    references: '<msg-chain-1.bob@furniture.example.test>',
  },
  {
    id: 'msg-04-chain-3-bob-nl',
    description:
      'Reply chain 3/3: Dutch Outlook header block (Van/Verzonden/Aan/Onderwerp), received copy with transport headers.',
    strings: 'unicode',
    subject: 'RE: Offerte vergadertafel',
    sender: BOB,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: CHAIN_3,
    submitTime: '2025-04-03T06:40:00Z',
    deliveryTime: '2025-04-03T06:40:03Z',
    messageId: '<msg-chain-3.bob@furniture.example.test>',
    inReplyTo: '<msg-chain-2.alice@example.test>',
    references: '<msg-chain-1.bob@furniture.example.test> <msg-chain-2.alice@example.test>',
    transportHeaders: `Received: from mail.furniture.example.test (mail.furniture.example.test [192.0.2.10])
\tby mx.example.test; Thu, 3 Apr 2025 08:40:03 +0200
From: Bob Sample <bob@furniture.example.test>
To: Alice Example <alice@example.test>
Subject: RE: Offerte vergadertafel
Date: Thu, 3 Apr 2025 08:40:00 +0200
Message-ID: <msg-chain-3.bob@furniture.example.test>
In-Reply-To: <msg-chain-2.alice@example.test>
References: <msg-chain-1.bob@furniture.example.test> <msg-chain-2.alice@example.test>
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"
X-Synthetic-Fixture: true

`,
  },
  {
    id: 'msg-05-html-and-plain',
    description: 'Plain body + HTML body (PR_HTML, UTF-8) with inert script, tracking pixel, event handlers.',
    strings: 'unicode',
    subject: 'Nouveau catalogue',
    sender: CAROL,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: `Bonjour Alice,

Voici notre catalogue de printemps.

${CAROL_SIG}`,
    bodyHtml: CATALOGUE_HTML,
    submitTime: '2025-04-04T10:00:00Z',
    messageId: '<msg-catalogue-1.carol@sample.invalid>',
  },
  {
    id: 'msg-06-attachment',
    description: 'One small text attachment (metadata listing), Exchange sender, signature + disclaimer.',
    strings: 'unicode',
    subject: 'Pakbon 2025-021',
    sender: BOB,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: `Beste Alice,

In bijlage de pakbon voor de vergadertafel en de stoelen.

${BOB_SIG}

${BOB_DISCLAIMER}`,
    submitTime: '2025-04-10T13:00:00Z',
    messageId: '<msg-pakbon-2025-021.bob@furniture.example.test>',
    attachments: [
      {
        fileName: 'pakbon-2025-021.txt',
        mimeType: 'text/plain',
        content: 'SYNTHETIC TEST DOCUMENT - NOT A REAL DOCUMENT\nPakbon 2025-021\n1 x vergadertafel, 6 x stoel\nTotaal: 2.400,00 EUR, btw inbegrepen\n',
      },
    ],
  },
  {
    id: 'msg-07-no-sent-time',
    description: 'No sent time and no received time (e.g. a saved draft): date must be missing, not invented.',
    strings: 'unicode',
    subject: 'Note: spare chair',
    sender: ALICE,
    recipients: [{ ...BOB, type: 'to' }],
    bodyText: 'Bob, the spare chair is in the storage room.\n\nAlice',
    messageId: '<msg-draft-1.alice@example.test>',
  },
  {
    id: 'msg-08-ansi-cp1252',
    description: 'Old-style ANSI (8-bit) strings in code page 1252 (PR_MESSAGE_CODEPAGE = 1252), accented French.',
    strings: 'ansi-1252',
    subject: 'Accusé de réception',
    sender: CAROL,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: `Bonjour,

Nous accusons réception de votre commande.
Livraison prévue à la fin avril. Crème, château, Noël, ça va.

${CAROL_SIG}`,
    submitTime: '2025-04-15T08:20:00Z',
    messageId: '<msg-ack-1.carol@sample.invalid>',
  },
  {
    id: 'msg-09-dup-of-eml-order-2',
    description: 'Cross-format duplicate: the same message as eml/11-order-2-bob-outlook-en.eml, saved from Outlook.',
    strings: 'unicode',
    subject: 'RE: Office desks and chairs',
    sender: BOB,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: ORDER_2,
    submitTime: '2025-03-03T13:02:00Z',
    messageId: '<order-2.bob@furniture.example.test>',
    inReplyTo: '<order-1.alice@example.test>',
    references: '<order-1.alice@example.test>',
  },
  {
    id: 'msg-10-on-behalf',
    description:
      'Sent on behalf of: the planning mailbox (PR_SENDER_*) sends for Bob (PR_SENT_REPRESENTING_*), both Exchange users with SMTP fallbacks.',
    strings: 'unicode',
    subject: 'Levering vergadertafel',
    sender: PLANNING,
    sentRepresenting: BOB,
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: `Beste Alice,

De vergadertafel en de zes stoelen worden op maandag 5 mei tussen 9:00 en
11:00 geleverd.

${BOB_SIG}

${BOB_DISCLAIMER}`,
    submitTime: '2025-04-28T07:45:00Z',
    messageId: '<msg-levering-1.planning@furniture.example.test>',
  },
  {
    id: 'msg-11-bcc-own-copy',
    description: "The sender's own copy (Sent Items): To Bob, Bcc Carol, plus an empty Bcc row that must be skipped.",
    strings: 'unicode',
    subject: 'Chairs for the meeting room',
    sender: ALICE,
    // PR_SENT_REPRESENTING_* equal to the sender, as Outlook writes it for
    // one's own mailbox: no separate sender.
    sentRepresenting: ALICE,
    recipients: [
      { ...BOB, type: 'to' },
      { ...CAROL, type: 'bcc' },
      { name: '', smtp: '', type: 'bcc' },
    ],
    bodyText: `Hello Bob,

Could you add two extra chairs for the meeting room to the delivery?

Alice

${ALICE_SIG}`,
    submitTime: '2025-04-29T09:10:00Z',
    messageId: '<msg-chairs-1.alice@example.test>',
  },
  {
    id: 'msg-12-represented-is-sender',
    description:
      'PR_SENT_REPRESENTING_* names the same Exchange mailbox as PR_SENDER_* (no SMTP fallback of its own): no separate sender.',
    strings: 'unicode',
    subject: 'Stoelen vergaderzaal',
    sender: BOB,
    sentRepresenting: { ...BOB, smtpFallback: false },
    recipients: [{ ...ALICE, type: 'to' }],
    bodyText: `Beste Alice,

Twee extra stoelen zijn geen probleem.

${BOB_SIG}

${BOB_DISCLAIMER}`,
    submitTime: '2025-04-29T11:30:00Z',
    messageId: '<msg-stoelen-1.bob@furniture.example.test>',
  },
  {
    id: 'msg-13-html-only',
    description: 'HTML-only body (no plain body): remote stylesheet, script, tracking pixel with an onerror handler, link.',
    strings: 'unicode',
    subject: 'Showroom visit on Friday',
    sender: { name: 'Carol Test', smtp: 'carol@sample.invalid' },
    recipients: [{ ...ALICE, type: 'to' }],
    bodyHtml: SHOWROOM_HTML,
    submitTime: '2025-04-22T09:00:00Z',
    messageId: '<msg-showroom-1.carol@sample.invalid>',
  },
];
