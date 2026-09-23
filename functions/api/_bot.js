/**
 * The WhatsApp bot: what it knows, what it says, and how it says it.
 *
 * Underscore-prefixed, so Pages treats it as a module to import rather than a
 * route. Everything above the Anthropic call is a pure function, which is what
 * the tests exercise.
 *
 * The knowledge base is docs/faq.md, compiled into _faq.js at build time. A
 * Worker cannot read the filesystem, and fetching the knowledge at runtime
 * would mean the bot's answers depend on the site being up — so it ships
 * inside the bundle.
 */

import Anthropic from '@anthropic-ai/sdk';
import { FAQ_RAW } from './_faq.js';

/* --------------------------------------------------------------- the faq */

/* The day the presale price gives way to the October one, in Brussels. */
export const PRICE_CUTOVER = '2026-10-01';
const UNTIL_TAG = '[UNTIL 30 SEP]';
const FROM_TAG = '[1 OCT]';

/** Today's date in Brussels, as YYYY-MM-DD. Not UTC: the price changes here. */
export function brusselsDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const at = t => (parts.find(x => x.type === t) || {}).value || '';
  return `${at('year')}-${at('month')}-${at('day')}`;
}

/**
 * One line, with whichever dated variant is in force today.
 *
 * Two shapes appear in the FAQ and both have to work:
 *
 *   A [UNTIL 30 SEP] 10 EUR [1 OCT] 12 EUR ticket, with children free.
 *   A: [UNTIL 30 SEP] Presale 10 EUR until 30 September...
 *   A: [1 OCT] 12 EUR online...
 *
 * A line carrying one tag belongs entirely to that variant: kept without the
 * tag, or dropped. A line carrying both is a swap inside a sentence, where
 * the second variant runs for as many words as the first — that is the only
 * thing that says where it ends, the sentence carrying on afterwards. Any
 * punctuation clinging to the end of the second variant belongs to the
 * sentence rather than the price, so it is handed back to it.
 *
 * Returns null for a line that today should not exist at all.
 */
function resolveDated(line, fromOctober) {
  const hasUntil = line.includes(UNTIL_TAG);
  const hasFrom = line.includes(FROM_TAG);
  if (!hasUntil && !hasFrom) return line;

  const i = line.indexOf(UNTIL_TAG);
  const j = line.indexOf(FROM_TAG, i >= 0 ? i : 0);

  if (hasUntil && hasFrom && i >= 0 && j > i) {
    const before = line.slice(0, i);
    const untilSpan = line.slice(i + UNTIL_TAG.length, j).trim();
    const after = line.slice(j + FROM_TAG.length).replace(/^\s*/, '');

    /* Split keeping the gaps, so words sit at even indices and the spacing
       between them survives. */
    const bits = after.split(/(\s+)/);
    const wanted = untilSpan.split(/\s+/).filter(Boolean).length;
    let taken = '';
    let words = 0;
    let k = 0;
    while (k < bits.length && words < wanted) {
      taken += bits[k];
      if (k % 2 === 0 && bits[k]) words += 1;
      k += 1;
    }
    let fromSpan = taken.trim();
    let tail = bits.slice(k).join('');

    const trailing = /[,.;:!?]+$/.exec(fromSpan);
    if (trailing && !/[,.;:!?]+$/.test(untilSpan)) {
      fromSpan = fromSpan.slice(0, -trailing[0].length);
      tail = trailing[0] + tail;
    }

    return `${before}${fromOctober ? fromSpan : untilSpan}${tail}`.replace(/[ \t]{2,}/g, ' ');
  }

  /* One tag: the whole line is that variant's. */
  const inForce = hasFrom ? fromOctober : !fromOctober;
  if (!inForce) return null;
  return line
    .replace(UNTIL_TAG, '')
    .replace(FROM_TAG, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^(\s*[A-Z]:)\s+/, '$1 ');
}

/**
 * The FAQ as the model should see it.
 *
 * Three things come out. The editing notes above the first language section,
 * which are instructions to whoever maintains the file and not knowledge —
 * and which themselves mention the date tags, so leaving them in would put a
 * worked example of both prices in front of the model. Lines marked
 * [CONFIRM], which are facts nobody has signed off yet. And whichever dated
 * variant is not in force today, so the bot can never quote the October price
 * during the presale, or the presale price after it has ended.
 */
export function stripFaq(raw, now = new Date()) {
  let text = String(raw || '').replace(/<!--[\s\S]*?-->/g, '');

  /* Everything before the first language banner is for editors. */
  const firstSection = text.indexOf('# =====');
  if (firstSection > 0) text = text.slice(firstSection);

  const fromOctober = brusselsDay(now) >= PRICE_CUTOVER;

  return text
    .split('\n')
    .filter(line => !line.includes('[CONFIRM]'))
    .map(line => resolveDated(line, fromOctober))
    .filter(line => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Computed per Brussels day rather than once per isolate: a worker can live
   for hours, and one that started on 30 September must not still be quoting
   the presale on 1 October. */
const faqByDay = new Map();

export function faqFor(now = new Date()) {
  const day = brusselsDay(now);
  if (!faqByDay.has(day)) faqByDay.set(day, stripFaq(FAQ_RAW, now));
  return faqByDay.get(day);
}

/* ------------------------------------------------------------- languages */

export const LANGS = ['en', 'fr', 'nl'];
const LANG_NAME = { en: 'English', fr: 'French', nl: 'Dutch' };

/* Words that only really turn up in one of the three. Short and common, since
   a WhatsApp message is often four words long. Accents are left in: someone
   typing "où" has told us more than someone typing "ou". */
const MARKERS = {
  fr: /\b(le|la|les|un|une|des|est|quel|quelle|quand|où|ou|comment|combien|prix|bonjour|merci|je|vous|nous|pour|avec|billet|billets|enfant|enfants|heure|feu|gratuit|puis|dois|votre|c'est)\b/gi,
  nl: /\b(het|de|een|is|zijn|wat|hoe|waar|wanneer|hoeveel|prijs|hallo|bedankt|dank|ik|jij|uw|voor|met|kaartje|kaartjes|ticket|kinderen|uur|vuurwerk|gratis|mag|moet|kan)\b/gi,
  en: /\b(the|a|an|is|are|what|how|where|when|much|price|hello|hi|thanks|thank|i|you|your|for|with|ticket|tickets|children|kids|time|fireworks|free|can|do|does)\b/gi,
};

/**
 * A guess at the language of a message.
 *
 * Deliberately a heuristic and not a model call: it has to work for a button
 * tap and a STOP, where there is no question to send anywhere and no budget
 * for a round trip. On free text the model is told to answer in the language
 * of the question anyway, so a wrong guess here costs a menu in the wrong
 * language, not a wrong answer.
 */
export function scoreLangs(text) {
  const s = String(text || '');
  const score = l => (s.match(MARKERS[l]) || []).length;
  return { fr: score('fr'), nl: score('nl'), en: score('en') };
}

export function detectLang(text) {
  if (!String(text || '').trim()) return '';
  const scores = scoreLangs(text);
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : '';
}

/**
 * The language of a message, but only when it clearly beats the one we were
 * already told.
 *
 * On WhatsApp any signal is better than none, because there is nothing else
 * to go on. On the website there is: the page carries <html lang>, chosen by
 * the visitor when they picked that version of the site. Overriding that
 * needs more than a single stray marker — "a question" typed on the French
 * page is not a request to be answered in English, and one weak hit used to
 * be enough to switch.
 */
export function confidentLang(text, pageLang) {
  const fallback = LANGS.includes(pageLang) ? pageLang : 'en';
  if (!String(text || '').trim()) return fallback;
  const scores = scoreLangs(text);
  const [best, count] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return count >= 2 && count > (scores[fallback] || 0) ? best : fallback;
}

/**
 * Which language to answer in.
 *
 * Text decides for itself; a button inherits whatever the last text settled
 * on. Reverse the Brevo rule the day Ticket Tailor exposes the checkout
 * locale and LANG starts carrying a real choice rather than a default.
 */
export function pickLang({ brevoLang, cachedLang, messageText } = {}) {
  const ok = v => (LANGS.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : '');

  /* When there are words in front of us they decide it, falling back to what
     this number last used. Brevo is deliberately not consulted: Ticket
     Tailor's payload carries no language field, so every buyer is stored as
     'en' whatever they speak, and letting that win is what answered
     "Bonjour !" with an English menu. */
  if (String(messageText || '').trim()) {
    return ok(detectLang(messageText)) || ok(cachedLang) || 'en';
  }

  /* No words: a button tap, or a photo. What they last used, and only then
     Brevo — which at first contact is the only thing there is. */
  return ok(cachedLang) || ok(brevoLang) || 'en';
}

/* ------------------------------------------------------------- what it says */

export const STOP_RE = /^\s*(stop|arret|arrêt|unsubscribe)\s*$/i;
export const HUMAN_RE = /^\s*(human|humain|mens)\s*$/i;
export const MENU_RE = /^\s*(menu)\s*$/i;

const GREETINGS = new Set(['hi', 'hello', 'hey', 'bonjour', 'salut', 'hallo', 'hoi', 'namaste']);

/**
 * "Hello" on its own, in any of the three languages.
 *
 * A greeting is an opening, not a question, so it gets the menu and nothing
 * else — sending "I can't answer that here" to someone who said hi is the
 * rudest thing the bot could do, and it is what happened before. Punctuation
 * and emoji are dropped first, so "Hey 👋" and "Namaste 🙏" count; anything
 * with a real word in it does not, and goes to the FAQ.
 */
export function isGreeting(text) {
  const cleaned = String(text || '').toLowerCase().replace(/[^\p{L}\s]/gu, '').trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/);
  return words.length <= 3 && words.every(w => GREETINGS.has(w));
}

/* The part both channels say. WhatsApp adds the HUMAN line to it; the web
   widget has buttons instead, so it uses the base on its own. */
export const FALLBACK_BASE = {
  en: "Thanks for your message. I can't answer that here. Write to diwali@artindia.be or see diwali.artindia.be.",
  fr: 'Merci pour votre message. Je ne peux pas répondre à cela ici. Écrivez à diwali@artindia.be ou consultez diwali.artindia.be.',
  nl: 'Bedankt voor uw bericht. Daar kan ik hier niet op antwoorden. Mail naar diwali@artindia.be of kijk op diwali.artindia.be.',
};

const REACH_A_PERSON = {
  en: ' Reply MENU for quick options. Type HUMAN to reach the team.',
  fr: " Répondez MENU pour les options rapides. Tapez HUMAIN pour joindre l'équipe.",
  nl: ' Antwoord MENU voor snelle opties. Typ MENS om het team te bereiken.',
};

export const FALLBACK = {
  en: FALLBACK_BASE.en + REACH_A_PERSON.en,
  fr: FALLBACK_BASE.fr + REACH_A_PERSON.fr,
  nl: FALLBACK_BASE.nl + REACH_A_PERSON.nl,
};

export const OPTOUT_CONFIRM = {
  en: 'You will not receive further WhatsApp messages from Art India.',
  fr: "Vous ne recevrez plus de messages WhatsApp d'Art India.",
  nl: 'U ontvangt geen WhatsApp-berichten meer van Art India.',
};

/* The address in the brief was diwello@artindia.be. Corrected here: a typo in
   the one line that tells someone how to reach a human is the worst place for
   one. */
export const ESCALATION_REPLY = {
  en: 'A team member will reply here during office hours. For urgent matters: diwali@artindia.be',
  fr: "Un membre de l'équipe vous répondra ici pendant les heures de bureau. Pour les urgences : diwali@artindia.be",
  nl: 'Een teamlid antwoordt hier tijdens de kantooruren. Voor dringende zaken: diwali@artindia.be',
};

export const NOT_A_BUYER = {
  en: "We can't find a ticket on this number. Tickets: https://tickets.artindia.be",
  fr: "Nous ne trouvons pas de billet sur ce numéro. Billets : https://tickets.artindia.be",
  nl: 'We vinden geen ticket op dit nummer. Tickets: https://tickets.artindia.be',
};

export const myLinkReply = (lang, code) => ({
  en: `Your personal link: https://diwali.artindia.be/r/${code}. Every friend who buys with it adds one entry for you.`,
  fr: `Votre lien personnel : https://diwali.artindia.be/r/${code}. Chaque ami qui achète avec ce lien vous ajoute une participation.`,
  nl: `Uw persoonlijke link: https://diwali.artindia.be/r/${code}. Elke vriend die ermee koopt, geeft u een extra deelname.`,
}[lang] || '');

export const myChancesReply = (lang, n) => ({
  en: `You have ${n} ${n === 1 ? 'entry' : 'entries'} in the draw. Share your link to add more.`,
  fr: `Vous avez ${n} participation${n === 1 ? '' : 's'} au tirage. Partagez votre lien pour en ajouter.`,
  nl: `U heeft ${n} deelname${n === 1 ? '' : 's'} aan de trekking. Deel uw link om er meer te krijgen.`,
}[lang] || '');

/* ----------------------------------------------------------------- web */

/* The greeting the widget opens with: the same introduction WhatsApp uses,
   with an invitation instead of a menu prompt. */
export const WEB_GREETING = {
  en: "Namaste, I'm Diya, the festival's digital host 🪔 Ask me anything about the Brussels Diwali Festival.",
  fr: "Namaste, je suis Diya, l'hôtesse digitale du festival 🪔 Posez-moi vos questions sur le Brussels Diwali Festival.",
  nl: 'Namaste, ik ben Diya, de digitale gastvrouw van het festival 🪔 Stel me uw vragen over het Brussels Diwali Festival.',
};

/**
 * The website's own fallback.
 *
 * Separate from the WhatsApp one on purpose: WhatsApp tells people to type
 * HUMAN, which is meaningless in a widget with buttons, and the web can point
 * at the team directly because the two chips under it do the pointing.
 * Changing this must not change what WhatsApp says.
 */
export const WEB_FALLBACK = {
  en: "Thanks for your message. I can't answer that here, but the team can.",
  fr: "Merci pour votre message. Je ne peux pas répondre à cela ici, mais l'équipe le peut.",
  nl: 'Bedankt voor uw bericht. Daar kan ik hier niet op antwoorden, maar het team wel.',
};

/**
 * What the web says instead of somebody's referral code.
 *
 * The widget is on a public page with no proof of who is reading it: a shared
 * screen, a borrowed laptop, a session token pasted to a friend. A referral
 * code is worth money in the draw, so the website never says one out loud —
 * not even to a visitor who has identified as a buyer. It is in their
 * WhatsApp and in their email, both of which needed their phone or their
 * inbox to reach.
 */
export const LINK_IS_ELSEWHERE = {
  en: 'Your personal link and your entries are in the WhatsApp and the email you received after buying.',
  fr: "Votre lien personnel et vos participations se trouvent dans le WhatsApp et l'e-mail reçus après votre achat.",
  nl: 'Uw persoonlijke link en uw deelnames staan in de WhatsApp en de e-mail die u na uw aankoop ontving.',
};

export const WEB_MY_TICKETS = (lang, adults, children) => ({
  en: `You have ${adults} adult and ${children} child ticket${children === 1 ? '' : 's'}, valid on both days. The QR code is in your Ticket Tailor email.`,
  fr: `Vous avez ${adults} billet${adults === 1 ? '' : 's'} adulte${adults === 1 ? '' : 's'} et ${children} billet${children === 1 ? '' : 's'} enfant${children === 1 ? '' : 's'}, valables les deux jours. Le QR code est dans votre e-mail Ticket Tailor.`,
  nl: `U heeft ${adults} volwassenenticket${adults === 1 ? '' : 's'} en ${children} kinderticket${children === 1 ? '' : 's'}, geldig op beide dagen. De QR-code staat in uw Ticket Tailor e-mail.`,
}[lang] || '');

export const NO_TICKET_FOR_EMAIL = {
  en: "I can't find a ticket for this email. Tickets: https://tickets.artindia.be",
  fr: "Je ne trouve pas de billet pour cette adresse e-mail. Billets : https://tickets.artindia.be",
  nl: 'Ik vind geen ticket voor dit e-mailadres. Tickets: https://tickets.artindia.be',
};

/* The three FAQ answers the web menu offers that WhatsApp does not. */
export const FOOD_ANSWER = {
  en: 'Indian food stalls on site, with vegetarian, non-vegetarian and vegan options, and bars serving beer, wine, cocktails and soft drinks. Cards are accepted everywhere. No outside food or drinks, except baby food.',
  fr: "Des stands de cuisine indienne sur place, avec options végétariennes, non végétariennes et véganes, et des bars servant bière, vin, cocktails et boissons sans alcool. La carte est acceptée partout. Pas de nourriture ni de boisson extérieure, sauf pour les bébés.",
  nl: 'Indiase eetstanden op het terrein, met vegetarische, niet-vegetarische en veganistische opties, en bars met bier, wijn, cocktails en frisdrank. Kaart wordt overal aanvaard. Geen eten of drinken van buitenaf, behalve babyvoeding.',
};

export const PROGRAMME_ANSWER = {
  en: 'Indian music and dance on stage across both days, with fireworks around 21:00, weather permitting. The full programme is at https://diwali.artindia.be',
  fr: "Musique et danse indiennes sur scène les deux jours, avec un feu d'artifice vers 21h00 selon la météo. Le programme complet est sur https://diwali.artindia.be",
  nl: 'Indiase muziek en dans op het podium op beide dagen, met vuurwerk rond 21:00, afhankelijk van het weer. Het volledige programma staat op https://diwali.artindia.be',
};

export const DRAW_ANSWER = {
  en: 'Every adult ticket is one entry, and every friend who buys with your personal link adds another. The draw is live on stage on Sunday 25 October; the winner is contacted by WhatsApp and email. Rules: https://diwali.artindia.be/draw',
  fr: "Chaque billet adulte vaut une participation, et chaque ami qui achète avec votre lien personnel en ajoute une. Le tirage a lieu en direct sur scène le dimanche 25 octobre ; le gagnant est contacté par WhatsApp et e-mail. Règlement : https://diwali.artindia.be/draw",
  nl: 'Elk volwassenenticket is één deelname, en elke vriend die via uw persoonlijke link koopt, geeft er nog een. De trekking is live op het podium op zondag 25 oktober; de winnaar wordt via WhatsApp en e-mail gecontacteerd. Reglement: https://diwali.artindia.be/draw',
};

export const ASK_PROMPT = {
  en: 'Go ahead, ask me anything about the festival.',
  fr: 'Allez-y, posez-moi votre question sur le festival.',
  nl: 'Ga uw gang, stel me uw vraag over het festival.',
};

/* Button labels for the widget. Ids never translate. */
export const WEB_MENU = {
  en: {
    guest: [['TICKETS', 'Tickets'], ['GETTING_THERE', 'Getting there'], ['FOOD', 'Food & drink'], ['ASK', 'Ask me anything']],
    buyer: [['GETTING_THERE', 'Getting there'], ['PROGRAMME', 'Programme'], ['DRAW', 'Lucky draw'], ['ASK', 'Ask me anything']],
    contact: 'Email the team',
    whatsapp: 'Continue on WhatsApp',
    whatsappHelp: 'Chat on WhatsApp',
    buy: 'Buy tickets',
  },
  fr: {
    guest: [['TICKETS', 'Billets'], ['GETTING_THERE', 'Comment venir'], ['FOOD', 'Boire et manger'], ['ASK', 'Poser une question']],
    buyer: [['GETTING_THERE', 'Comment venir'], ['PROGRAMME', 'Programme'], ['DRAW', 'Tombola'], ['ASK', 'Poser une question']],
    contact: "Écrire à l'équipe",
    whatsapp: 'Continuer sur WhatsApp',
    whatsappHelp: 'Discuter sur WhatsApp',
    buy: 'Acheter un billet',
  },
  nl: {
    guest: [['TICKETS', 'Tickets'], ['GETTING_THERE', 'Bereikbaarheid'], ['FOOD', 'Eten en drinken'], ['ASK', 'Stel een vraag']],
    buyer: [['GETTING_THERE', 'Bereikbaarheid'], ['PROGRAMME', 'Programma'], ['DRAW', 'Tombola'], ['ASK', 'Stel een vraag']],
    contact: 'Mail het team',
    whatsapp: 'Verder op WhatsApp',
    whatsappHelp: 'Chat via WhatsApp',
    buy: 'Tickets kopen',
  },
};

/* The lead form, and the two answers to it. */
export const LEAD_PROMPT = {
  en: 'Want me to keep you posted on the festival? Leave your name and email.',
  fr: 'Vous voulez que je vous tienne au courant du festival ? Laissez votre nom et votre e-mail.',
  nl: 'Wilt u op de hoogte blijven van het festival? Laat uw naam en e-mailadres achter.',
};

export const LEAD_THANKS = (lang, name) => ({
  en: `Thanks ${name}, you're on the list.`,
  fr: `Merci ${name}, vous êtes sur la liste.`,
  nl: `Bedankt ${name}, u staat op de lijst.`,
}[lang] || '');

export const WELCOME_BACK = (lang, name) => ({
  en: `Welcome back, ${name}, you have a ticket 🪔`,
  fr: `Content de vous revoir, ${name}, vous avez un billet 🪔`,
  nl: `Welkom terug, ${name}, u heeft een ticket 🪔`,
}[lang] || '');

export const webKey = {
  session: id => `web:sess:${id}`,
  log: id => `web:log:${id}`,
  count: (id, day) => `web:count:${id}:${day}`,
  ip: (hash, day) => `web:ip:${hash}:${day}`,
};

/* ------------------------------------------------------------------ menu */

/* WhatsApp allows three reply buttons and twenty characters of title. Both
   limits are hard: Meta rejects the whole message rather than truncating, so
   every title below is checked by a test.

   Talk to the team is deliberately not a button. It was taking a third of the
   menu on every conversation to serve the rare one, and typing HUMAN still
   reaches a person — the fallback says so. */
const MENU_COPY = {
  en: {
    header: 'Brussels Diwali Festival',
    greeting: "Namaste, I'm Diya, the festival's digital host 🪔",
    body: 'How can I help?',
    tap: 'Tap a button, or type your question below.',
    buyer: [
      ['MY_TICKETS', 'My tickets'],
      ['MY_LINK', 'My lucky draw link'],
      ['MY_CHANCES', 'My winning chances'],
    ],
    guest: [
      ['BUY_TICKETS', 'Buy tickets'],
      ['FESTIVAL_INFO', 'Festival info'],
      ['GETTING_THERE', 'Getting there'],
    ],
  },
  fr: {
    header: 'Brussels Diwali Festival',
    greeting: "Namaste, je suis Diya, l'hôtesse digitale du festival 🪔",
    body: 'Comment puis-je vous aider ?',
    tap: 'Appuyez sur un bouton ou tapez votre question ci-dessous.',
    buyer: [
      ['MY_TICKETS', 'Mes billets'],
      ['MY_LINK', 'Mon lien tombola'],
      ['MY_CHANCES', 'Mes chances'],
    ],
    guest: [
      ['BUY_TICKETS', 'Acheter un billet'],
      ['FESTIVAL_INFO', 'Infos festival'],
      ['GETTING_THERE', 'Comment venir'],
    ],
  },
  nl: {
    header: 'Brussels Diwali Festival',
    greeting: 'Namaste, ik ben Diya, de digitale gastvrouw van het festival 🪔',
    body: 'Waarmee kan ik helpen?',
    tap: 'Tik op een knop of typ uw vraag hieronder.',
    buyer: [
      ['MY_TICKETS', 'Mijn tickets'],
      ['MY_LINK', 'Mijn tombolalink'],
      ['MY_CHANCES', 'Mijn winkansen'],
    ],
    guest: [
      ['BUY_TICKETS', 'Tickets kopen'],
      ['FESTIVAL_INFO', 'Festivalinfo'],
      ['GETTING_THERE', 'Bereikbaarheid'],
    ],
  },
};

/**
 * The menu.
 *
 * `firstContact` is the first time this number has written in a 24h window,
 * and is the only time Diya introduces herself. Every later menu in the same
 * window opens with the question instead — being told who she is four times
 * in an hour reads like a bot, which is the one thing the persona is there to
 * avoid. The line under it is always there, because a menu with no visible
 * way to ask something else reads like a dead end.
 */
export function buildMenu(phone, lang, isBuyer, firstContact = false) {
  const copy = MENU_COPY[lang] || MENU_COPY.en;
  const buttons = (isBuyer ? copy.buyer : copy.guest).slice(0, 3);
  return {
    messaging_product: 'whatsapp',
    to: phone.replace(/^\+/, ''),
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: copy.header },
      body: { text: `${firstContact ? copy.greeting : copy.body}\n\n${copy.tap}` },
      action: {
        buttons: buttons.map(([id, title]) => ({
          type: 'reply',
          reply: { id, title: title.slice(0, 20) },
        })),
      },
    },
  };
}

/** Every button title, for the tests and for the deploy report. */
export const menuTitles = (lang, isBuyer) =>
  (MENU_COPY[lang] || MENU_COPY.en)[isBuyer ? 'buyer' : 'guest'].map(([id, t]) => [id, t]);

/* ---------------------------------------------------------- canned answers */

/**
 * What they bought, counted off the Brevo contact.
 *
 * TICKET_COUNT is everyone on the order and CHILD_COUNT the under-12s, so the
 * adults are the difference. The noun agrees with whichever number comes last,
 * which is how the sentence reads out loud.
 */
export function myTicketsReply(lang, adults, children) {
  const a = Math.max(0, adults);
  const c = Math.max(0, children);
  const s = n => (n === 1 ? '' : 's');

  const counted = {
    en: c > 0
      ? `You have ${a} adult and ${c} child ticket${s(c)}`
      : `You have ${a} adult ticket${s(a)}`,
    fr: c > 0
      ? `Vous avez ${a} billet${s(a)} adulte${s(a)} et ${c} billet${s(c)} enfant${s(c)}`
      : `Vous avez ${a} billet${s(a)} adulte${s(a)}`,
    nl: c > 0
      ? `U heeft ${a} volwassenenticket${s(a)} en ${c} kinderticket${s(c)}`
      : `U heeft ${a} volwassenenticket${s(a)}`,
  }[lang] || '';

  return {
    en: `${counted}, valid on both days. Show the QR code from your Ticket Tailor email at the entrance. Didn't receive it? Write to diwali@artindia.be.`,
    fr: `${counted}, valables les deux jours. Présentez le QR code de votre e-mail Ticket Tailor à l'entrée. Vous ne l'avez pas reçu ? Écrivez à diwali@artindia.be.`,
    nl: `${counted}, geldig op beide dagen. Toon de QR-code uit uw Ticket Tailor e-mail aan de ingang. Niet ontvangen? Mail naar diwali@artindia.be.`,
  }[lang] || '';
}

/* The three prospect answers, lifted from the FAQ so there is one source for
   them and no model call to serve a button. */
export const TICKETS_ANSWER = {
  en: 'Presale 10 EUR until 30 September, 15 EUR at the gate, children under 12 free. Buy at https://tickets.artindia.be',
  fr: "Prévente 10 EUR jusqu'au 30 septembre, 15 EUR à l'entrée, gratuit pour les moins de 12 ans. Achetez sur https://tickets.artindia.be",
  nl: 'Voorverkoop 10 EUR tot 30 september, 15 EUR aan de ingang, kinderen onder 12 gratis. Koop op https://tickets.artindia.be',
};

export const INFO_ANSWER = {
  en: 'Saturday 24 and Sunday 25 October 2026, 12:00 to 22:30, on the esplanade of Boulevard du Centenaire next to the Atomium. Fireworks around 21:00, weather permitting. More: https://diwali.artindia.be',
  fr: "Samedi 24 et dimanche 25 octobre 2026, de 12h00 à 22h30, sur l'esplanade du Boulevard du Centenaire à côté de l'Atomium. Feu d'artifice vers 21h00, selon la météo. Plus : https://diwali.artindia.be",
  nl: 'Zaterdag 24 en zondag 25 oktober 2026, van 12:00 tot 22:30, op de esplanade van de Eeuwfeestlaan naast het Atomium. Vuurwerk rond 21:00, afhankelijk van het weer. Meer: https://diwali.artindia.be',
};

export const GETTING_THERE_ANSWER = {
  en: 'Metro line 6 to Heysel, then 5 minutes on foot. Trams 3, 7 and 9 also stop at Heysel. There is paid public parking at Kinepolis, but we strongly recommend public transport.',
  fr: "Métro ligne 6 jusqu'à Heysel, puis 5 minutes à pied. Les trams 3, 7 et 9 s'arrêtent aussi à Heysel. Parking public payant au Kinepolis, mais nous recommandons vivement les transports en commun.",
  nl: 'Metro lijn 6 tot Heizel, dan 5 minuten te voet. Trams 3, 7 en 9 stoppen ook aan Heizel. Er is betalende openbare parking aan Kinepolis, maar we raden het openbaar vervoer sterk aan.',
};

/* ----------------------------------------------------------------- model */

/* The brief names this exact string. Anthropic's own reference lists the id
   without a date suffix, so if sends start coming back 404 the model id is the
   first thing to try — it is an env var precisely so that is a dashboard edit
   and not a deploy. */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export const NOT_COVERED = 'NOT_COVERED';

/* The model may hand the question back rather than answer it, when the answer
   is a fact about this particular buyer that only Brevo and KV know. Exactly
   these four, and nothing else on the line. */
export const ACTIONS = ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES', 'MENU'];
const ACTION_RE = new RegExp(`^ACTION:(${ACTIONS.join('|')})\\b`, 'i');

export const readAction = text => {
  const m = ACTION_RE.exec(String(text || '').trim());
  return m ? m[1].toUpperCase() : '';
};

/* Stable first, volatile last: the FAQ is the same on every call and is the
   only part big enough to be worth caching, so the per-language instruction
   goes in a second block after it rather than inside the cached prefix. */
export const DIYA = [
  'You are Diya, the digital host of the Brussels Diwali Festival, run by Art India.',
  'You are an AI assistant; say so if asked, and never claim to be a person.',
  'Tone: warm, welcoming, brief, like a festival host greeting a guest. At most one 🪔 per message, no other emojis.',
  'Never talk about yourself beyond one line; never claim feelings, a location or a life. Redirect to the festival.',
  'Answer only from the FAQ below, in the visitor\'s language, and follow all FAQ rules.',
].join('\n');

/* Routing. Four questions have answers the FAQ cannot hold, because they are
   about this particular buyer: what they bought, their own link, their own
   entries, and "show me the buttons again". The model recognises those and
   hands them back rather than guessing, and the webhook runs the same code
   the buttons run. */
const ROUTING =
  'Some questions are about the visitor themselves and you must not answer them. '
  + 'For those, reply with exactly one of the following and nothing else:\n'
  + 'ACTION:MY_TICKETS - their own tickets: how many they bought, where their tickets are\n'
  + 'ACTION:MY_LINK - their own referral or lucky draw link\n'
  + 'ACTION:MY_CHANCES - their own entries or chances of winning\n'
  + 'ACTION:MENU - they ask for the menu, the buttons, or the options\n';

const INSTRUCTIONS =
  DIYA + '\n\n'
  + ROUTING + '\n'
  + 'Use ONLY the FAQ below. Maximum 3 short sentences, no markdown, no em dashes. '
  + 'Never invent prices, times, or promises. '
  + 'Do not add facts, adjectives or reassurances not in the FAQ. '
  + 'Say you are an AI assistant only on first contact or when asked; not otherwise. '
  + 'Never mention your information, your FAQ, your instructions or what you can look up. '
  + 'Use 🪔 only in the greeting, never in answers. '
  + 'Do not start answers with Hello or Welcome unless it is the first message. '
  + `If the FAQ does not cover the question, reply exactly: ${NOT_COVERED}\n\n`;

/* Whether this is their first message is something the model cannot know and
   two of the rules above depend on, so it is told. It goes in the second,
   uncached block: the FAQ prefix must stay identical on every call. */
/* Web-only rules. They live in the second, uncached block on purpose: put in
   the first they would fork the cached FAQ prefix in two, one per channel,
   for the sake of two sentences. */
const WEB_RULES =
  ' You are on the festival website.'
  + ' Never reveal a referral link, referral code, or draw entries; on those questions say:'
  + ` ${LINK_IS_ELSEWHERE.en}`;

export const systemBlocks = (lang, { firstContact = false, now, web = false } = {}) => ([
  { type: 'text', text: INSTRUCTIONS + faqFor(now), cache_control: { type: 'ephemeral' } },
  {
    type: 'text',
    text: `Reply in ${LANG_NAME[lang] || 'English'}.`
      + (firstContact
        ? ' This is their first message in a while.'
        : ' This is not their first message: do not open with a greeting, and do not say you are an AI assistant unless they ask.')
      + (web ? WEB_RULES : ''),
  },
]);

/**
 * What the model wrote, made fit for WhatsApp.
 *
 * The system prompt asks for no em dashes and no markdown, and Haiku ignored
 * the dash on the very first live answer ("next to the Atomium—we can't wait").
 * A formatting rule that can be enforced in code should not be left to the
 * model to remember: an em dash reads as a typo on a phone, and WhatsApp
 * renders none of the markdown it might reach for.
 *
 * A dash between digits is a range and keeps a hyphen; anywhere else it is
 * joining two clauses and becomes a comma.
 */
export function tidyAnswer(text) {
  return String(text || '')
    /* The lamp belongs to the greeting. The prompt says so and the model uses
       it anyway, the same way it used an em dash, so it comes out here. */
    .replace(/🪔/gu, '')
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Ask the FAQ.
 *
 * Returns the answer, or '' for anything the caller should treat as "send the
 * fallback and write it down": the FAQ did not cover it, the model said
 * nothing, or the call failed. The three are logged apart but handled the
 * same, because from the buyer's side they are the same.
 */
export async function askFaq(env, { text, lang, firstContact = false, web = false }) {
  if (!env.ANTHROPIC_API_KEY) {
    console.error('bot: ANTHROPIC_API_KEY unset');
    return { answer: '', reason: 'no_key' };
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: env.WA_BOT_MODEL || DEFAULT_MODEL,
      max_tokens: 300,
      system: systemBlocks(lang, { firstContact, web }),
      messages: [{ role: 'user', content: String(text).slice(0, 2000) }],
    });

    const raw = (res.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join(' ').trim();

    /* Read before tidying: tidyAnswer would not break a routing token, but
       the token is a control word, not prose, and should never be groomed. */
    const action = readAction(raw);
    if (action) {
      console.log('bot routed', JSON.stringify({ lang, action }));
      return { answer: '', action, reason: 'routed' };
    }

    const answer = tidyAnswer(raw);

    console.log('bot answered', JSON.stringify({
      lang, in: res.usage && res.usage.input_tokens,
      cached: res.usage && res.usage.cache_read_input_tokens,
      out: res.usage && res.usage.output_tokens,
      covered: answer !== NOT_COVERED && answer !== '',
    }));

    if (!answer) return { answer: '', reason: 'empty' };
    if (answer === NOT_COVERED || answer.startsWith(NOT_COVERED)) {
      return { answer: '', reason: 'not_covered' };
    }
    return { answer, reason: 'ok' };
  } catch (e) {
    /* Never fatal. A model that is slow or down means the fallback goes out
       and the question is written down for Ravi, which is what happens for an
       unanswerable question anyway. */
    console.error('bot: model call failed', String(e));
    return { answer: '', reason: 'error' };
  }
}

/* ------------------------------------------------------------- whatsapp io */

const WA_API = 'https://graph.facebook.com/v21.0';

/** One outbound message. Returns Meta's own answer rather than throwing. */
export async function sendToMeta(env, payload) {
  if (!env.WA_TOKEN || !env.WA_PHONE_ID) {
    console.error('bot: WA_TOKEN or WA_PHONE_ID unset, not sending');
    return { ok: false, status: 0, error: 'not_configured', code: null };
  }
  try {
    const res = await fetch(`${WA_API}/${env.WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WA_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* kept as text */ }
    const messageId = (parsed && parsed.messages && parsed.messages[0] && parsed.messages[0].id) || '';
    if (!res.ok) console.error('bot: send failed', res.status, body.slice(0, 500));
    return {
      ok: res.ok,
      status: res.status,
      messageId,
      error: (parsed && parsed.error) || body.slice(0, 500),
      code: Number(parsed && parsed.error && parsed.error.code) || null,
    };
  } catch (e) {
    console.error('bot: send threw', String(e));
    return { ok: false, status: 0, error: String(e), code: null };
  }
}

export const textMessage = (phone, body) => ({
  messaging_product: 'whatsapp',
  to: String(phone).replace(/^\+/, ''),
  type: 'text',
  /* Link previews off: the reply is short and a preview card pushes it off
     the screen on a phone. */
  text: { preview_url: false, body: String(body).slice(0, 4096) },
});

export const sendText = (env, phone, body) => sendToMeta(env, textMessage(phone, body));

/* ------------------------------------------------------------------- kv */

export const botKey = {
  lang: phone => `bot:lang:${phone}`,
  log: phone => `bot:log:${phone}`,
  welcome: phone => `bot:welcome:${phone}`,
  count: (phone, day) => `bot:count:${phone}:${day}`,
  seen: phone => `bot:seen:${phone}`,
  optout: phone => `bot:optout:${phone}`,
  history: phone => `bot:history:${phone}`,
  message: id => `bot:msg:${id}`,
  unanswered: ts => `bot:unanswered:${ts}`,
  escalation: ts => `bot:escalation:${ts}`,
  refcount: code => `refcount:${code}`,
};

export const DAY_SECONDS = 24 * 60 * 60;
export const KEEP_SECONDS = 90 * DAY_SECONDS;
export const LOG_SECONDS = 30 * DAY_SECONDS;
/* How long a conversation stays "in progress". Past it the next message opens
   a new one and gets the menu again — two hours, so somebody who comes back
   after lunch is met rather than dropped mid-thought. Refreshed on every
   message, so it runs from the last one and not from the first. */
export const SEEN_SECONDS = 2 * 60 * 60;
export const LOG_MESSAGES = 40;

/**
 * One conversation, as the dashboard reads it.
 *
 * Stored per phone rather than per message so the dashboard can list every
 * conversation without a Brevo call each: the name, whether they bought and
 * what language they are using ride along with the messages. `messages` is
 * the last forty, oldest first, which is enough to see how a conversation got
 * where it is and short enough to keep one KV value small.
 *
 * Read-then-write, so two messages in the same instant could lose one line of
 * a transcript. That is a cosmetic loss in a log, not a lost reply.
 */
export async function logMessage(kv, phone, entry, about = {}) {
  if (!kv || !phone) return;
  const key = botKey.log(phone);
  let record = null;
  try { record = await kv.get(key, 'json'); } catch { /* first message */ }

  const messages = Array.isArray(record && record.messages) ? record.messages : [];
  messages.push({
    ts: new Date().toISOString(),
    dir: entry.dir,
    kind: entry.kind,
    text: String(entry.text || '').slice(0, 700),
  });

  const next = {
    phone,
    name: about.name || (record && record.name) || '',
    buyer: about.buyer === undefined ? Boolean(record && record.buyer) : Boolean(about.buyer),
    lang: about.lang || (record && record.lang) || '',
    updatedAt: new Date().toISOString(),
    messages: messages.slice(-LOG_MESSAGES),
  };

  try { await kv.put(key, JSON.stringify(next), { expirationTtl: LOG_SECONDS }); }
  catch (e) { console.error('bot: log write failed', phone, String(e)); }
}

/** Every key under a prefix, following the cursor to the end. */
export async function listAll(kv, prefix, cap = 1000) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete || keys.length >= cap ? null : page.cursor;
  } while (cursor);
  return keys.slice(0, cap);
}

/** The UTC day the daily limit is counted against. */
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/* Sorted newest-first by key, so the timestamp goes first and a counter after
   it keeps two questions in the same millisecond apart. */
let seq = 0;
export const stamp = () =>
  `${new Date().toISOString()}-${String(++seq % 1000).padStart(3, '0')}`;
