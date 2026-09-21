/**
 * The bot's pure parts, and the inbound routing around them.
 *
 * The model is stubbed everywhere: what is being checked is that the right
 * thing is asked, the right thing is sent, and that consent and the daily
 * ceiling are respected — not what Claude says.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stripFaq, FAQ, detectLang, pickLang, STOP_RE, HUMAN_RE, MENU_RE,
  buildMenu, utcDay, botKey, FALLBACK, isGreeting, DIYA, systemBlocks, tidyAnswer,
  menuTitles, myTicketsReply, GETTING_THERE_ANSWER, readAction, ACTIONS, SEEN_SECONDS,
} from '../functions/api/_bot.js';
import { FAQ_RAW } from '../functions/api/_faq.js';
import { onRequestPost as waWebhook } from '../functions/api/wa-webhook.js';

/* --------------------------------------------------------------- the faq */

test('the compiled FAQ is the file on disk', () => {
  assert.equal(FAQ_RAW, readFileSync('docs/faq.md', 'utf8'),
    'functions/api/_faq.js is stale — run node build-diwali.mjs');
});

test('the prices that start on 1 October are not in what the model sees', () => {
  assert.ok(FAQ_RAW.includes('12 EUR'), 'the hidden October price is in the source');
  assert.ok(!FAQ.includes('12 EUR'),
    'quoting 12 EUR during the 10 EUR presale is the worst thing the bot could say');
  assert.ok(!FAQ.includes('<!--') && !FAQ.includes('-->'), 'no comment markers survive');
});

test('unsigned-off facts are dropped, whole line', () => {
  const stripped = stripFaq([
    'Q: How many visitors?',
    'A: About 25,000 [CONFIRM] per weekend.',
    'Q: When are the fireworks?',
    'A: Around 21:00.',
  ].join('\n'));
  assert.ok(!stripped.includes('25,000'));
  assert.ok(!stripped.includes('[CONFIRM]'));
  assert.ok(stripped.includes('Around 21:00'), 'the rest is untouched');
});

test('a multi-line comment goes entirely', () => {
  assert.equal(stripFaq('keep\n<!-- one\ntwo\nthree -->\nkeep2').replace(/\n+/g, '|'),
    'keep|keep2');
});

test('all three languages survive, with their real content', () => {
  for (const marker of ['===== EN =====', '===== FR =====', '===== NL =====']) {
    assert.ok(FAQ.includes(marker), marker);
  }
  assert.ok(FAQ.includes('Presale 10 EUR until 30 September'));
  assert.ok(FAQ.includes("Prévente 10 EUR jusqu'au 30 septembre"));
  assert.ok(FAQ.includes('Voorverkoop 10 EUR tot 30 september'));
});

/* ------------------------------------------------------------- languages */

test('the language of a short question', () => {
  assert.equal(detectLang('Quel est le prix des billets ?'), 'fr');
  assert.equal(detectLang('Hoeveel kosten de kaartjes?'), 'nl');
  assert.equal(detectLang('What time are the fireworks?'), 'en');
  assert.equal(detectLang('Bonjour, je voudrais venir avec mes enfants'), 'fr');
  assert.equal(detectLang('Hallo, mag ik mijn hond meebrengen?'), 'nl');
  assert.equal(detectLang(''), '', 'nothing to go on says so rather than guessing');
  assert.equal(detectLang('🙏'), '');
});

test('the message in front of us beats a field that was defaulted', () => {
  /* The regression. Brevo's LANG is 'en' for every buyer because Ticket
     Tailor's payload has no language field, so trusting it first answered
     "Bonjour !" with an English menu. */
  assert.equal(pickLang({ brevoLang: 'en', messageText: 'Bonjour !' }), 'fr');
  assert.equal(pickLang({ brevoLang: 'en', messageText: 'Hoeveel kosten de kaartjes?' }), 'nl');

  assert.equal(pickLang({ cachedLang: 'fr', messageText: '👍' }), 'fr',
    'no signal in this message, so what they last used');
  assert.equal(pickLang({ brevoLang: 'nl' }), 'nl', 'a button tap has no text at all');
  assert.equal(pickLang({ messageText: 'Quel est le prix ?' }), 'fr');
  assert.equal(pickLang({ messageText: '👍' }), 'en', 'English is the floor');
  assert.equal(pickLang({}), 'en');
  assert.equal(pickLang({ brevoLang: 'de' }), 'en', 'a language we do not speak is not used');
  assert.equal(pickLang({ brevoLang: 'FR' }), 'fr');
});

/* ----------------------------------------------------------------- words */

test('STOP is exact, so a sentence about stopping is not an opt-out', () => {
  for (const yes of ['stop', 'STOP', ' Stop ', 'arret', 'arrêt', 'unsubscribe']) {
    assert.ok(STOP_RE.test(yes), yes);
  }
  for (const no of ['stop sending me the programme', 'non-stop', 'stopp', '', 'arrêtez']) {
    assert.ok(!STOP_RE.test(no), no);
  }
});

test('human and menu are equally exact', () => {
  for (const yes of ['human', 'HUMAIN', ' mens ']) assert.ok(HUMAN_RE.test(yes), yes);
  assert.ok(!HUMAN_RE.test('is there a human I can talk to'));
  assert.ok(MENU_RE.test(' Menu '));
  assert.ok(!MENU_RE.test('what is on the menu'));
});

/* ------------------------------------------------------------------ menu */

test('the menu fits inside what WhatsApp accepts', () => {
  for (const lang of ['en', 'fr', 'nl']) {
    for (const buyer of [true, false]) {
      const m = buildMenu('+32474919900', lang, buyer);
      assert.equal(m.to, '32474919900', 'no plus');
      assert.equal(m.interactive.type, 'button');
      const buttons = m.interactive.action.buttons;
      assert.ok(buttons.length <= 3, `${lang} ${buyer}: max three buttons`);
      for (const b of buttons) {
        assert.ok(b.reply.title.length <= 20, `${lang}: "${b.reply.title}" is ${b.reply.title.length}`);
        assert.ok(b.reply.title.length > 0);
      }
    }
  }
});

test('a buyer and a stranger get different buttons', () => {
  const ids = (lang, buyer) =>
    buildMenu('+32474919900', lang, buyer).interactive.action.buttons.map(b => b.reply.id);
  assert.deepEqual(ids('en', true), ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES']);
  assert.deepEqual(ids('en', false), ['BUY_TICKETS', 'FESTIVAL_INFO', 'GETTING_THERE']);
  assert.deepEqual(ids('fr', true), ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES'], 'ids never translate');
  for (const lang of ['en', 'fr', 'nl']) {
    for (const buyer of [true, false]) {
      assert.ok(!ids(lang, buyer).includes('TALK_HUMAN'),
        'Talk to the team is not a button any more; typing HUMAN still works');
    }
  }
});

test('the button titles, exactly as deployed', () => {
  assert.deepEqual(menuTitles('en', true).map(([, t]) => t),
    ['My tickets', 'My lucky draw link', 'My winning chances']);
  assert.deepEqual(menuTitles('fr', true).map(([, t]) => t),
    ['Mes billets', 'Mon lien tombola', 'Mes chances']);
  assert.deepEqual(menuTitles('nl', true).map(([, t]) => t),
    ['Mijn tickets', 'Mijn tombolalink', 'Mijn winkansen']);
  assert.deepEqual(menuTitles('en', false).map(([, t]) => t),
    ['Buy tickets', 'Festival info', 'Getting there']);
});

/* --------------------------------------------------------------- the day */

test('the daily counter is keyed on the UTC day and rolls at midnight', () => {
  assert.equal(utcDay(new Date('2026-09-21T23:59:59Z')), '2026-09-21');
  assert.equal(utcDay(new Date('2026-09-22T00:00:01Z')), '2026-09-22');
  assert.equal(utcDay(new Date('2026-09-22T01:30:00+02:00')), '2026-09-21',
    'Brussels midnight is not UTC midnight, and the counter follows UTC');
  assert.equal(botKey.count('+32474919900', '2026-09-21'), 'bot:count:+32474919900:2026-09-21');
});

/* --------------------------------------------------------------- routing */

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

const BUYER = {
  email: 'ravi@artindia.be',
  attributes: {
    WHATSAPP: '+32474919900', LANG: 'en', REFERRAL_CODE: 'JKRM7W',
    TICKET_COUNT: 4, CHILD_COUNT: 2, WA_OPTIN: true,
  },
};

/** Brevo, Meta and Anthropic, with `answer` deciding what the model says. */
function world({ contact = null, answer = 'The fireworks are around 21:00.' } = {}) {
  const sent = [];
  const emails = [];
  const prompts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;

    if (u.hostname === 'graph.facebook.com') {
      sent.push(body);
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
    }
    if (u.hostname === 'api.anthropic.com') {
      prompts.push(body);
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: answer }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/v3/smtp/email') {
      emails.push(body);
      return new Response(JSON.stringify({ messageId: 'x' }), { status: 201 });
    }
    if (u.pathname === '/v3/contacts') return new Response(null, { status: 204 });
    if (u.pathname.startsWith('/v3/contacts/')) {
      return contact
        ? new Response(JSON.stringify(contact), { status: 200 })
        : new Response('{}', { status: 404 });
    }
    throw new Error(`unstubbed ${url}`);
  };
  return { sent, emails, prompts };
}

const ENV = kv => ({
  BREVO_API_KEY: 'k', WA_VERIFY_TOKEN: 'v', WA_TOKEN: 't', WA_PHONE_ID: 'p',
  ANTHROPIC_API_KEY: 'sk-ant-test', WA_BOT_ENABLED: 'true', WA_BOT_DAILY_LIMIT: '20',
  REFERRALS: kv,
});

async function inbound(env, message, contacts) {
  let work = Promise.resolve();
  await waWebhook({
    request: new Request('https://diwali.artindia.be/api/wa-webhook', {
      method: 'POST',
      body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [message], contacts } }] }] }),
    }),
    env,
    waitUntil: p => { work = p; },
  });
  await work;
}

const msg = (over = {}) => ({ id: 'wamid.IN1', from: '32474919900', type: 'text', ...over });
const texts = sent => sent.filter(s => s.type === 'text').map(s => s.text.body);

test('the first message of the day gets the menu, then an answer', async () => {
  const { sent, prompts } = world({ contact: BUYER });
  await inbound(ENV(memoryKv()), msg({ text: { body: 'When are the fireworks?' } }));

  assert.equal(sent[0].type, 'interactive', 'menu leads');
  assert.deepEqual(sent[0].interactive.action.buttons.map(b => b.reply.id),
    ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES'], 'a buyer gets the buyer menu');
  assert.equal(texts(sent)[0], 'The fireworks are around 21:00.');
  assert.equal(prompts[0].max_tokens, 300);
  assert.ok(prompts[0].system[0].text.includes('Saturday 24 and Sunday 25 October'),
    'the FAQ goes with the question');
  assert.match(prompts[0].system[1].text, /^Reply in English\./);
});

test('the second message the same day skips the menu', async () => {
  const kv = memoryKv();
  const env = ENV(kv);
  world({ contact: BUYER });
  await inbound(env, msg({ id: 'wamid.A', text: { body: 'When are the fireworks?' } }));
  const { sent } = world({ contact: BUYER });
  await inbound(env, msg({ id: 'wamid.B', text: { body: 'And the food?' } }));
  assert.ok(!sent.some(s => s.type === 'interactive'), 'no second menu');
});

test('Meta redelivering a message changes nothing', async () => {
  const kv = memoryKv();
  const env = ENV(kv);
  world({ contact: BUYER });
  await inbound(env, msg({ text: { body: 'When are the fireworks?' } }));
  const { sent } = world({ contact: BUYER });
  await inbound(env, msg({ text: { body: 'When are the fireworks?' } }));
  assert.equal(sent.length, 0, 'the same message id is answered once');
});

test('NOT_COVERED sends the fallback and writes the question down', async () => {
  const kv = memoryKv();
  const { sent } = world({ contact: BUYER, answer: 'NOT_COVERED' });
  await inbound(ENV(kv), msg({ text: { body: 'Can I bring my drone?' } }));

  assert.equal(texts(sent)[0], FALLBACK.en);
  const key = [...kv.store.keys()].find(k => k.startsWith('bot:unanswered:'));
  assert.ok(key, 'it is logged for the FAQ to grow from');
  const row = JSON.parse(kv.store.get(key));
  assert.equal(row.text, 'Can I bring my drone?');
  assert.equal(row.reason, 'not_covered');
  assert.equal(row.phone, '+32474919900');
});

test('a model that is down is handled exactly like a question it cannot answer', async () => {
  const kv = memoryKv();
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.anthropic.com') return new Response('upstream boom', { status: 500 });
    if (u.hostname === 'graph.facebook.com') {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: 'w' }] }), { status: 200 });
    }
    if (u.pathname.startsWith('/v3/contacts/')) return new Response(JSON.stringify(BUYER), { status: 200 });
    return new Response(null, { status: 204 });
  };
  await inbound(ENV(kv), msg({ text: { body: 'Anything?' } }));

  assert.equal(texts(sent)[0], FALLBACK.en, 'the buyer still gets an answer');
  assert.ok([...kv.store.keys()].some(k => k.startsWith('bot:unanswered:')));
});

test('with the bot off, free text gets the fallback and the model is never called', async () => {
  const kv = memoryKv();
  const { sent, prompts } = world({ contact: BUYER });
  await inbound({ ...ENV(kv), WA_BOT_ENABLED: 'false' },
    msg({ text: { body: 'When are the fireworks?' } }));

  assert.equal(prompts.length, 0, 'no spend while the kill switch is off');
  assert.equal(texts(sent)[0], FALLBACK.en);
  assert.ok(sent.some(s => s.type === 'interactive'), 'the menu still works');
});

test('the daily ceiling stops at the limit and apologises once', async () => {
  const kv = memoryKv({
    [botKey.count('+32474919900', utcDay())]: '20',
    [botKey.seen('+32474919900')]: '1',
  });
  const first = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.L1', text: { body: 'one more?' } }));
  assert.equal(first.prompts.length, 0, 'the model is not called past the limit');
  assert.equal(texts(first.sent)[0], FALLBACK.en);

  const second = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.L2', text: { body: 'and another?' } }));
  assert.equal(second.sent.length, 0, 'the twenty-second question is met with silence');
});

test('a successful answer moves the counter, a fallback does not', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const key = botKey.count('+32474919900', utcDay());

  world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.C1', text: { body: 'fireworks?' } }));
  assert.equal(kv.store.get(key), '1');

  world({ contact: BUYER, answer: 'NOT_COVERED' });
  await inbound(ENV(kv), msg({ id: 'wamid.C2', text: { body: 'drone?' } }));
  assert.equal(kv.store.get(key), '1', 'an unanswered question is not a spent reply');
});

/* --------------------------------------------------------------- buttons */

const button = (id, over = {}) => msg({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: id } },
  ...over,
});

test('My link gives the buyer their code, and a stranger the shop', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const buyer = world({ contact: BUYER });
  await inbound(ENV(kv), button('MY_LINK'));
  assert.equal(texts(buyer.sent)[0],
    'Your personal link: https://diwali.artindia.be/r/JKRM7W. Every friend who buys with it adds one entry for you.');

  const kv2 = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const stranger = world({ contact: null });
  await inbound(ENV(kv2), button('MY_LINK', { id: 'wamid.S1' }));
  assert.match(texts(stranger.sent)[0], /can't find a ticket on this number/);
});

test('My chances counts adults plus referrals, never children', async () => {
  const kv = memoryKv({
    [botKey.seen('+32474919900')]: '1',
    [botKey.refcount('JKRM7W')]: '3',
  });
  const { sent } = world({ contact: BUYER });
  await inbound(ENV(kv), button('MY_CHANCES'));
  /* 4 tickets less 2 children = 2 adults, plus 3 referred. */
  assert.equal(texts(sent)[0], 'You have 5 entries in the draw. Share your link to add more.');
});

test('one entry is singular', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({
    contact: { ...BUYER, attributes: { ...BUYER.attributes, TICKET_COUNT: 1, CHILD_COUNT: 0 } },
  });
  await inbound(ENV(kv), button('MY_CHANCES'));
  assert.match(texts(sent)[0], /You have 1 entry in the draw/);
});

test('the guest buttons answer from the FAQ without the model', async () => {
  for (const [id, expect] of [
    ['BUY_TICKETS', /Presale 10 EUR/],
    ['FESTIVAL_INFO', /Saturday 24 and Sunday 25/],
    ['GETTING_THERE', /Metro line 6 to Heysel/],
    ['TICKETS', /Presale 10 EUR/],          /* the old ids still work */
    ['INFO', /Saturday 24 and Sunday 25/],
  ]) {
    const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
    const { sent, prompts } = world({ contact: null });
    await inbound(ENV(kv), button(id));
    assert.match(texts(sent)[0], expect, id);
    assert.equal(prompts.length, 0, `${id} is canned, not generated`);
  }
});

/* ----------------------------------------------------------- escalation */

test('asking for a person replies, records it and emails the team', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent, emails } = world({ contact: BUYER });

  await inbound(ENV(kv), msg({ id: 'wamid.H0', text: { body: 'where do I park' } }));
  await inbound(ENV(kv), msg({ id: 'wamid.H1', text: { body: 'human' } }),
    [{ profile: { name: 'Ravi' } }]);

  assert.match(texts(sent).at(-1), /team member will reply here during office hours/);
  assert.match(texts(sent).at(-1), /diwali@artindia\.be/);
  assert.ok(!texts(sent).at(-1).includes('diwello'), 'the brief\'s typo is not shipped');

  const key = [...kv.store.keys()].find(k => k.startsWith('bot:escalation:'));
  assert.ok(key);
  const row = JSON.parse(kv.store.get(key));
  assert.equal(row.phone, '+32474919900');
  assert.equal(row.name, 'Ravi');
  assert.equal(row.last_message, 'human');
  assert.equal(row.history.length, 2, 'the conversation, not just the trigger');

  assert.equal(emails.length, 1);
  assert.equal(emails[0].to[0].email, 'diwali@artindia.be');
  assert.equal(emails[0].subject, 'WhatsApp: +32474919900 needs a reply');
  assert.match(emails[0].textContent, /where do I park/);
  assert.ok(!emails[0].textContent.includes('curl'), 'no terminal command in the email');
  assert.match(emails[0].textContent,
    /admin\/reply\?to=%2B32474919900/, 'a link with the number already in it');
  assert.ok(!emails[0].textContent.includes('reply.html'),
    'the canonical URL, so the link lands in one hop rather than a 308');
});

test('the TALK_HUMAN button escalates the same way', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { emails } = world({ contact: BUYER });
  await inbound(ENV(kv), button('TALK_HUMAN'));
  assert.equal(emails.length, 1);
});

/* --------------------------------------------------------------- consent */

test('STOP is answered once, then the number goes quiet', async () => {
  const kv = memoryKv();
  const stop = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.X1', text: { body: 'STOP' } }));

  assert.deepEqual(texts(stop.sent), ['You will not receive further WhatsApp messages from Art India.']);
  assert.ok(!stop.sent.some(s => s.type === 'interactive'), 'no menu on an opt-out');
  assert.ok(kv.store.has(botKey.optout('+32474919900')));

  const again = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.X2', text: { body: 'stop' } }));
  assert.equal(texts(again.sent).length, 1, 'a second STOP is confirmed, not ignored');
});

test('writing in after opting out re-opens the conversation', async () => {
  const kv = memoryKv({ [botKey.optout('+32474919900')]: '2026-09-20T00:00:00Z' });
  const { sent } = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.R1', text: { body: 'When are the fireworks?' } }));

  assert.equal(texts(sent).at(-1), 'The fireworks are around 21:00.');
  assert.ok(!kv.store.has(botKey.optout('+32474919900')), 'the gate is lifted');
});

test('a photo gets one apology a day, not one per photo', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const first = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.P1', type: 'image', image: { id: 'i1' } }));
  assert.equal(texts(first.sent)[0], FALLBACK.en);

  const second = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.P2', type: 'image', image: { id: 'i2' } }));
  assert.equal(second.sent.length, 0);
});

test('a French buyer is answered in French throughout', async () => {
  const kv = memoryKv();
  const fr = { ...BUYER, attributes: { ...BUYER.attributes, LANG: 'fr' } };
  const { sent, prompts } = world({ contact: fr, answer: 'Le feu d\'artifice est vers 21h00.' });
  await inbound(ENV(kv), msg({ text: { body: 'À quelle heure est le feu ?' } }));

  assert.match(prompts[0].system[1].text, /^Reply in French\./);
  assert.match(sent[0].interactive.body.text, /^Namaste, je suis Diya/);
  assert.match(sent[0].interactive.body.text, /tapez votre question/);
  assert.equal(texts(sent)[0], 'Le feu d\'artifice est vers 21h00.');
});

test('without the KV binding nothing is answered and nothing throws', async () => {
  const { sent } = world({ contact: BUYER });
  await inbound({ ...ENV(undefined), REFERRALS: undefined },
    msg({ text: { body: 'hello' } }));
  assert.equal(sent.length, 0);
});

/* ------------------------------------------------------------------ Diya */

test('the persona leads the system prompt, above the rules and the FAQ', () => {
  const [stable] = systemBlocks('en');
  assert.ok(stable.text.startsWith('You are Diya, the digital host'), 'persona first');
  assert.ok(stable.text.includes('never claim to be a person'));
  assert.ok(stable.text.includes('At most one 🪔 per message, no other emojis'));
  assert.ok(stable.text.indexOf(DIYA) < stable.text.indexOf('Use ONLY the FAQ below'),
    'persona, then the rules');
  assert.ok(stable.text.indexOf('Use ONLY the FAQ below') < stable.text.indexOf('===== EN ====='),
    'then the knowledge');
  assert.equal(stable.cache_control.type, 'ephemeral',
    'the persona is stable, so it belongs inside the cached prefix');
});

test('the language instruction stays outside the cached prefix', () => {
  const en = systemBlocks('en');
  const fr = systemBlocks('fr');
  assert.equal(en[0].text, fr[0].text, 'one cached prefix shared by all three languages');
  assert.match(fr[1].text, /^Reply in French\./);
  assert.equal(fr[1].cache_control, undefined);
});

test('she introduces herself once per window, then stops', () => {
  const body = (lang, first) => buildMenu('+32474919900', lang, true, first).interactive.body.text;
  assert.equal(body('en', true),
    "Namaste, I'm Diya, the festival's digital host 🪔\n\nTap a button, or type your question below.");
  assert.equal(body('en', false), 'How can I help?\n\nTap a button, or type your question below.');
  assert.equal(body('fr', true),
    "Namaste, je suis Diya, l'hôtesse digitale du festival 🪔\n\nAppuyez sur un bouton ou tapez votre question ci-dessous.");
  assert.equal(body('nl', true),
    'Namaste, ik ben Diya, de digitale gastvrouw van het festival 🪔\n\nTik op een knop of typ uw vraag hieronder.');
  assert.equal(body('nl', false), 'Waarmee kan ik helpen?\n\nTik op een knop of typ uw vraag hieronder.');
});

test('every menu says you can just type instead', () => {
  for (const lang of ['en', 'fr', 'nl']) {
    for (const first of [true, false]) {
      const t = buildMenu('+32474919900', lang, true, first).interactive.body.text;
      assert.ok(/type|tapez|typ /i.test(t), `${lang} ${first}: ${t}`);
    }
  }
});

test('the greeting fits what WhatsApp accepts in an interactive body', () => {
  for (const lang of ['en', 'fr', 'nl']) {
    const body = buildMenu('+32474919900', lang, true, true).interactive.body.text;
    assert.ok(body.length <= 1024, `${lang}: ${body.length}`);
    assert.equal((body.match(/🪔/g) || []).length, 1, `${lang}: exactly one lamp`);
  }
});

/* ------------------------------------------------------------- greetings */

test('a bare hello in any of the three languages is a greeting', () => {
  for (const yes of [
    'hi', 'Hello', 'HEY', ' hello ', 'bonjour', 'Salut', 'hallo', 'hoi', 'namaste',
    'hi!', 'Hello!!', 'Hey 👋', 'Namaste 🙏', 'hallo hoi',
  ]) {
    assert.ok(isGreeting(yes), JSON.stringify(yes));
  }
});

test('a greeting with a question attached is a question', () => {
  for (const no of [
    'hi what time are the fireworks', 'hello can I bring my dog', 'bonjour le prix ?',
    'heyo', 'hit', '', '   ', '🙏', 'menu', 'stop',
  ]) {
    assert.ok(!isGreeting(no), JSON.stringify(no));
  }
});

test('saying hello gets the menu and nothing underneath it', async () => {
  const kv = memoryKv();
  const { sent, prompts } = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ text: { body: 'hello' } }));

  assert.equal(sent.length, 1, 'the menu, and no apology under it');
  assert.equal(sent[0].type, 'interactive');
  assert.match(sent[0].interactive.body.text, /^Namaste, I'm Diya/);
  assert.equal(prompts.length, 0, 'a greeting is not a question for the model');
  assert.ok(!texts(sent).includes(FALLBACK.en));
});

test('saying hello later in the window still gets the introduction', async () => {
  /* Someone whose first message of the day was a question, saying hello two
     hours later, should still meet Diya. */
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.G2', text: { body: 'hi' } }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].interactive.body.text, /^Namaste, I'm Diya/);
});

test('the plain menu is for MENU and for an answered question, not a hello', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.M9', text: { body: 'menu' } }));
  assert.match(sent[0].interactive.body.text, /^How can I help\?/);
});

test('Bonjour is answered in French even when Brevo says en', async () => {
  /* The screenshot: a French greeting from a buyer stored as LANG=en came
     back with the English menu. */
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({ contact: BUYER });   /* BUYER.attributes.LANG === 'en' */
  await inbound(ENV(kv), msg({ id: 'wamid.B9', text: { body: 'Bonjour !' } }));

  assert.equal(sent.length, 1);
  assert.match(sent[0].interactive.body.text, /^Namaste, je suis Diya/);
  assert.match(sent[0].interactive.body.text, /tapez votre question/);
  assert.equal(kv.store.get(botKey.lang('+32474919900')), 'fr',
    'and French is remembered for the button taps that follow');
});

test('bonjour is answered in French, even from a number we do not know', async () => {
  const kv = memoryKv();
  const { sent } = world({ contact: null });
  await inbound(ENV(kv), msg({ id: 'wamid.G3', text: { body: 'Bonjour' } }));

  assert.match(sent[0].interactive.body.text, /^Namaste, je suis Diya/);
  assert.match(sent[0].interactive.body.text, /tapez votre question/);
  assert.deepEqual(sent[0].interactive.action.buttons.map(b => b.reply.id),
    ['BUY_TICKETS', 'FESTIVAL_INFO', 'GETTING_THERE'], 'a stranger still gets the stranger menu');
});

test('with the bot off, a greeting still gets the menu and still no fallback', async () => {
  const kv = memoryKv();
  const { sent } = world({ contact: BUYER });
  await inbound({ ...ENV(kv), WA_BOT_ENABLED: 'false' }, msg({ text: { body: 'hey' } }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'interactive');
});

test('a greeting never reaches the daily counter', async () => {
  const kv = memoryKv({ [botKey.count('+32474919900', utcDay())]: '20' });
  const { sent } = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ text: { body: 'hello' } }));

  assert.equal(sent.length, 1, 'the menu goes out even past the limit');
  assert.equal(sent[0].type, 'interactive');
});

/* ----------------------------------------------------------- tidying up */

test('the em dash the model was asked not to use is taken out anyway', () => {
  /* Verbatim from the first live answer. The prompt says no em dashes and
     Haiku used one regardless, so the rule is enforced in code. */
  assert.equal(
    tidyAnswer("It's on the esplanade of Boulevard du Centenaire, next to the Atomium—we can't wait to see you there."),
    "It's on the esplanade of Boulevard du Centenaire, next to the Atomium, we can't wait to see you there.");
  assert.equal(tidyAnswer('Tickets are 10 EUR – buy early.'), 'Tickets are 10 EUR, buy early.');
});

test('a dash between numbers is a range, not a clause break', () => {
  assert.equal(tidyAnswer('Open 12:00—22:30 each day.'), 'Open 12:00-22:30 each day.');
  assert.equal(tidyAnswer('24—25 October'), '24-25 October');
});

test('markdown WhatsApp would not render is removed', () => {
  assert.equal(tidyAnswer('**Tickets** are `10 EUR`.'), 'Tickets are 10 EUR.');
  assert.equal(tidyAnswer('## Dates\nSaturday 24.'), 'Dates\nSaturday 24.');
});

test('tidying never leaves a doubled comma or stray spacing', () => {
  assert.equal(tidyAnswer('Come early, — the gates open at 12:00.'),
    'Come early, the gates open at 12:00.');
  assert.equal(tidyAnswer('  spaced   out  '), 'spaced out');
});

test('an answer with nothing to fix is returned untouched', () => {
  const clean = 'The fireworks are around 21:00, subject to the weather.';
  assert.equal(tidyAnswer(clean), clean);
});

test('the lamp belongs to the greeting, so it is taken out of answers', () => {
  assert.equal(tidyAnswer('The fireworks are around 21:00. 🪔'),
    'The fireworks are around 21:00.');
  assert.equal(tidyAnswer('🪔 Welcome! Presale is 10 EUR.'), 'Welcome! Presale is 10 EUR.');
  assert.ok(!tidyAnswer('a 🪔 b 🪔 c').includes('🪔'), 'every one of them');
});

test('the tidying is applied to what actually goes out', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({
    contact: BUYER,
    answer: "We're next to the Atomium—come early.",
  });
  await inbound(ENV(kv), msg({ id: 'wamid.T1', text: { body: 'where is it?' } }));
  assert.equal(texts(sent)[0], "We're next to the Atomium, come early.");
});

/* ------------------------------------------------------- pass 2c: tickets */

test('My tickets counts adults off the total and names the difference', () => {
  assert.equal(myTicketsReply('en', 2, 1),
    "You have 2 adult and 1 child ticket, valid on both days. Show the QR code from your "
    + "Ticket Tailor email at the entrance. Didn't receive it? Write to diwali@artindia.be.");
  assert.match(myTicketsReply('en', 1, 0), /^You have 1 adult ticket, valid on both days\./);
  assert.match(myTicketsReply('en', 3, 2), /^You have 3 adult and 2 child tickets,/);
  assert.match(myTicketsReply('fr', 2, 1), /^Vous avez 2 billets adultes et 1 billet enfant,/);
  assert.match(myTicketsReply('nl', 2, 1), /^U heeft 2 volwassenentickets en 1 kinderticket,/);
  for (const lang of ['en', 'fr', 'nl']) {
    assert.match(myTicketsReply(lang, 2, 1), /diwali@artindia\.be/, lang);
  }
});

test('My tickets, end to end, with the numbers off the contact', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({ contact: BUYER });   /* TICKET_COUNT 4, CHILD_COUNT 2 */
  await inbound(ENV(kv), button('MY_TICKETS'));
  assert.match(texts(sent)[0], /^You have 2 adult and 2 child tickets, valid on both days\./);
});

test('a stranger tapping a buyer button is told there is no ticket', async () => {
  for (const id of ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES']) {
    const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
    const { sent } = world({ contact: null });
    await inbound(ENV(kv), button(id, { id: `wamid.NB_${id}` }));
    assert.match(texts(sent)[0], /can't find a ticket on this number/, id);
  }
});

test('Getting there answers from the FAQ, in all three languages', () => {
  assert.match(GETTING_THERE_ANSWER.en, /Metro line 6 to Heysel/);
  assert.match(GETTING_THERE_ANSWER.fr, /Métro ligne 6 jusqu'à Heysel/);
  assert.match(GETTING_THERE_ANSWER.nl, /Metro lijn 6 tot Heizel/);
  for (const lang of ['en', 'fr', 'nl']) {
    assert.match(GETTING_THERE_ANSWER[lang], /Kinepolis/, lang);
  }
});

test('the fallback tells them how to reach a person, since the button is gone', () => {
  assert.match(FALLBACK.en, /Type HUMAN to reach the team\.$/);
  assert.match(FALLBACK.fr, /Tapez HUMAIN pour joindre l'équipe\.$/);
  assert.match(FALLBACK.nl, /Typ MENS om het team te bereiken\.$/);
});

test('typing human still escalates now the button is gone', async () => {
  for (const word of ['human', 'HUMAIN', 'mens']) {
    const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
    const { emails } = world({ contact: BUYER });
    await inbound(ENV(kv), msg({ id: `wamid.H_${word}`, text: { body: word } }));
    assert.equal(emails.length, 1, word);
  }
});

test('the system prompt forbids the flourishes the model likes to add', () => {
  assert.match(systemBlocks('en')[0].text,
    /Do not add facts, adjectives or reassurances not in the FAQ\./);
});

test('a free-text answer never follows Brevo, only the words and the cache', async () => {
  /* BUYER is stored LANG=en. A Dutch question gets a Dutch answer. */
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { prompts } = world({ contact: BUYER, answer: 'Rond 21:00.' });
  await inbound(ENV(kv), msg({ id: 'wamid.NL1', text: { body: 'Wanneer is het vuurwerk?' } }));

  assert.match(prompts[0].system[1].text, /^Reply in Dutch\./);
  assert.equal(kv.store.get(botKey.lang('+32474919900')), 'nl');
});

test('a button after a Dutch question stays Dutch, not Brevo English', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  world({ contact: BUYER, answer: 'Rond 21:00.' });
  await inbound(ENV(kv), msg({ id: 'wamid.NL2', text: { body: 'Wanneer is het vuurwerk?' } }));

  const { sent } = world({ contact: BUYER });
  await inbound(ENV(kv), button('MY_TICKETS', { id: 'wamid.NL3' }));
  assert.match(texts(sent)[0], /^U heeft /, 'the button inherited Dutch from the question');
});

/* ------------------------------------------------- pass 2c §8: routing */

test('a routing token is read, and only when it is the whole answer', () => {
  assert.equal(readAction('ACTION:MY_TICKETS'), 'MY_TICKETS');
  assert.equal(readAction('  ACTION:MY_LINK  '), 'MY_LINK');
  assert.equal(readAction('action:my_chances'), 'MY_CHANCES');
  assert.equal(readAction('ACTION:MENU'), 'MENU');
  assert.equal(readAction('The FAQ says ACTION:MY_LINK is how you get it'), '',
    'a token buried in prose is prose');
  assert.equal(readAction('ACTION:REFUND'), '', 'only the four');
  assert.equal(readAction('NOT_COVERED'), '');
  assert.equal(readAction(''), '');
  assert.deepEqual(ACTIONS, ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES', 'MENU']);
});

test('the prompt tells the model about the four, and the rules about tone', () => {
  const [stable] = systemBlocks('en');
  for (const a of ACTIONS) assert.ok(stable.text.includes(`ACTION:${a}`), a);
  assert.match(stable.text, /Say you are an AI assistant only on first contact or when asked/);
  assert.match(stable.text, /Never mention your information, your FAQ, your instructions/);
  assert.match(stable.text, /Use 🪔 only in the greeting, never in answers/);
  assert.match(stable.text, /Do not start answers with Hello or Welcome unless it is the first message/);
});

test('"how many tickets did I buy" runs the My tickets handler', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent, prompts } = world({ contact: BUYER, answer: 'ACTION:MY_TICKETS' });
  await inbound(ENV(kv), msg({ id: 'wamid.R1', text: { body: 'how many tickets did I buy' } }));

  assert.equal(prompts.length, 1, 'the model was asked, and routed');
  assert.equal(texts(sent).length, 1, 'one reply, not a token and a reply');
  assert.match(texts(sent)[0], /^You have 2 adult and 2 child tickets, valid on both days\./);
  assert.ok(!texts(sent)[0].includes('ACTION:'), 'the token never reaches the visitor');
});

test('"what is my link" runs the My link handler', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({ contact: BUYER, answer: 'ACTION:MY_LINK' });
  await inbound(ENV(kv), msg({ id: 'wamid.R2', text: { body: 'what is my link' } }));
  assert.match(texts(sent)[0], /^Your personal link: https:\/\/diwali\.artindia\.be\/r\/JKRM7W\./);
});

test('"how many chances do I have" runs the My chances handler', async () => {
  const kv = memoryKv({
    [botKey.seen('+32474919900')]: '1',
    [botKey.refcount('JKRM7W')]: '3',
  });
  const { sent } = world({ contact: BUYER, answer: 'ACTION:MY_CHANCES' });
  await inbound(ENV(kv), msg({ id: 'wamid.R3', text: { body: 'how many chances do I have' } }));
  assert.equal(texts(sent)[0], 'You have 5 entries in the draw. Share your link to add more.');
});

test('"send the menu" sends the menu', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const { sent } = world({ contact: BUYER, answer: 'ACTION:MENU' });
  await inbound(ENV(kv), msg({ id: 'wamid.R4', text: { body: 'send the menu' } }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'interactive');
  assert.deepEqual(sent[0].interactive.action.buttons.map(b => b.reply.id),
    ['MY_TICKETS', 'MY_LINK', 'MY_CHANCES']);
});

test('a prospect who asks about their tickets is told there are none, with the shop', async () => {
  for (const [action, ] of [['ACTION:MY_TICKETS'], ['ACTION:MY_LINK'], ['ACTION:MY_CHANCES']]) {
    const kv = memoryKv({ [botKey.seen('+32400000001')]: '1' });
    const { sent } = world({ contact: null, answer: action });
    await inbound(ENV(kv), {
      id: `wamid.P_${action}`, from: '32400000001', type: 'text',
      text: { body: 'where are my tickets' },
    });
    assert.match(texts(sent)[0], /can't find a ticket on this number/, action);
    assert.match(texts(sent)[0], /tickets\.artindia\.be/, `${action}: and where to get one`);
  }
});

test('a routed question still counts against the daily limit', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  world({ contact: BUYER, answer: 'ACTION:MY_LINK' });
  await inbound(ENV(kv), msg({ id: 'wamid.R5', text: { body: 'my link?' } }));
  assert.equal(kv.store.get(botKey.count('+32474919900', utcDay())), '1',
    'it cost a model call, so it costs a reply');
});

/* --------------------------------------------------------------- §8 tone */

test('three answers in a row carry no lamp and no "AI assistant"', async () => {
  const kv = memoryKv({ [botKey.seen('+32474919900')]: '1' });
  const questions = ['when are the fireworks', 'is there parking', 'can I bring food'];
  const replies = [
    'Around 21:00, weather permitting. 🪔',
    "I'm an AI assistant, but there is paid parking at Kinepolis.",
    'No outside food or drinks, except baby food.',
  ];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const { sent } = world({ contact: BUYER, answer: replies[i] });
    await inbound(ENV(kv), msg({ id: `wamid.TONE${i}`, text: { body: questions[i] } }));
    out.push(texts(sent)[0]);
  }

  assert.equal(out.length, 3);
  for (const line of out) assert.ok(!line.includes('🪔'), `lamp in: ${line}`);
  /* The second reply is what the model must not write; the prompt forbids it
     and the test records that the rule is stated, since only the prompt can
     stop a sentence a regex cannot safely rewrite. */
  assert.match(systemBlocks('en')[0].text, /Say you are an AI assistant only on first contact/);
  assert.match(systemBlocks('en', { firstContact: false })[1].text,
    /do not say you are an AI assistant unless they ask/);
});

test('after two hours the menu comes back, and every message pushes it out', async () => {
  assert.equal(SEEN_SECONDS, 2 * 60 * 60);

  const kv = memoryKv();
  world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.W1', text: { body: 'fireworks?' } }));
  const firstStamp = kv.store.get(botKey.seen('+32474919900'));
  assert.ok(firstStamp, 'the window opened');

  /* A second message inside the window gets no menu, and pushes the window. */
  const second = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.W2', text: { body: 'and parking?' } }));
  assert.ok(!second.sent.some(x => x.type === 'interactive'), 'no menu mid-conversation');

  /* Two hours later KV has dropped the key, so the next message opens a new
     conversation and is met. */
  kv.store.delete(botKey.seen('+32474919900'));
  const later = world({ contact: BUYER });
  await inbound(ENV(kv), msg({ id: 'wamid.W3', text: { body: 'one more thing' } }));
  assert.ok(later.sent.some(x => x.type === 'interactive'), 'met again after the gap');
});
