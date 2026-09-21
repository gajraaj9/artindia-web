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

/**
 * The FAQ as the model should see it.
 *
 * Two things come out. HTML comments hide the prices that take effect on
 * 1 October — leaving them in would let the bot quote 12 EUR during the 10 EUR
 * presale, which is the single most expensive thing it could get wrong. Lines
 * marked [CONFIRM] are facts nobody has signed off yet; the bot must not say
 * them out loud.
 */
export function stripFaq(raw) {
  return String(raw || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(line => !line.includes('[CONFIRM]'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const FAQ = stripFaq(FAQ_RAW);

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
export function detectLang(text) {
  const s = String(text || '');
  if (!s.trim()) return '';
  const score = l => (s.match(MARKERS[l]) || []).length;
  const scores = { fr: score('fr'), nl: score('nl'), en: score('en') };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : '';
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

export const FALLBACK = {
  en: "Thanks for your message. I can't answer that here. Write to diwali@artindia.be or see diwali.artindia.be. Reply MENU for quick options. Type HUMAN to reach the team.",
  fr: "Merci pour votre message. Je ne peux pas répondre à cela ici. Écrivez à diwali@artindia.be ou consultez diwali.artindia.be. Répondez MENU pour les options rapides. Tapez HUMAIN pour joindre l'équipe.",
  nl: 'Bedankt voor uw bericht. Daar kan ik hier niet op antwoorden. Mail naar diwali@artindia.be of kijk op diwali.artindia.be. Antwoord MENU voor snelle opties. Typ MENS om het team te bereiken.',
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

const INSTRUCTIONS =
  DIYA + '\n\n'
  + 'Use ONLY the FAQ below. Maximum 3 short sentences, no markdown, no em dashes. '
  + 'Never invent prices, times, or promises. '
  + 'Do not add facts, adjectives or reassurances not in the FAQ. '
  + `If the FAQ does not cover the question, reply exactly: ${NOT_COVERED}\n\n`;

export const systemBlocks = lang => ([
  { type: 'text', text: INSTRUCTIONS + FAQ, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: `Reply in ${LANG_NAME[lang] || 'English'}.` },
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
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
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
export async function askFaq(env, { text, lang }) {
  if (!env.ANTHROPIC_API_KEY) {
    console.error('bot: ANTHROPIC_API_KEY unset');
    return { answer: '', reason: 'no_key' };
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: env.WA_BOT_MODEL || DEFAULT_MODEL,
      max_tokens: 300,
      system: systemBlocks(lang),
      messages: [{ role: 'user', content: String(text).slice(0, 2000) }],
    });

    const answer = tidyAnswer((res.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join(' '));

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

/** The UTC day the daily limit is counted against. */
export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/* Sorted newest-first by key, so the timestamp goes first and a counter after
   it keeps two questions in the same millisecond apart. */
let seq = 0;
export const stamp = () =>
  `${new Date().toISOString()}-${String(++seq % 1000).padStart(3, '0')}`;
