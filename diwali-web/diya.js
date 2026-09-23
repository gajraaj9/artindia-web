/**
 * Diya on the website.
 *
 *   <script src="/diya.js" defer></script>
 *
 * Injects its own stylesheet, a launcher and a WhatsApp button, and talks to
 * /api/chat. No framework, no CDN, no cookies. The transcript and the session
 * token live in sessionStorage so a page navigation does not lose the thread,
 * and nothing survives the tab closing.
 *
 * Every message is put on the page as a text node, never as HTML: the words
 * come from a model and from whoever is typing, and neither gets to write
 * markup into the page. Links are found afterwards and built as real anchors.
 */
(function () {
  'use strict';

  var PATH = window.location.pathname;
  /* The widget has no business on the admin pages or on a redirect stub. */
  if (/^\/(admin|r|i)(\/|$)/.test(PATH)) return;
  if (window.__diya) return;
  window.__diya = true;

  var KEY = 'artindia.diya';
  var WA = 'https://wa.me/32490616661?text=Hi';
  var AVATAR = '/diya.png';
  var MAX_KEPT = 30;

  var LANG = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
  if (['en', 'fr', 'nl'].indexOf(LANG) === -1) LANG = 'en';

  var COPY = {
    en: { launch: 'Chat with Diya', wa: 'WhatsApp', sub: 'Brussels Diwali Festival · AI host',
      ph: 'Ask a question…', send: 'Send', close: 'Close chat', offline: "I can't reach the festival right now. Please try again in a moment.",
      name: 'Your name', email: 'Your email', consent: 'Send me festival news from Art India, unsubscribe anytime',
      keep: 'Keep me posted', later: 'Maybe later', have: 'I already have a ticket',
      badEmail: 'That email does not look right.', needConsent: 'Please tick the box so we may write to you.',
      foot: 'Diya is an AI assistant. Answers come from the festival FAQ.' },
    fr: { launch: 'Discuter avec Diya', wa: 'WhatsApp', sub: 'Brussels Diwali Festival · hôtesse IA',
      ph: 'Posez une question…', send: 'Envoyer', close: 'Fermer le chat', offline: 'Je ne peux pas joindre le festival pour le moment. Réessayez dans un instant.',
      name: 'Votre nom', email: 'Votre e-mail', consent: "Envoyez-moi les actualités du festival d'Art India, désinscription à tout moment",
      keep: 'Tenez-moi au courant', later: 'Plus tard', have: "J'ai déjà un billet",
      badEmail: "Cette adresse e-mail ne semble pas correcte.", needConsent: 'Cochez la case pour que nous puissions vous écrire.',
      foot: 'Diya est une assistante IA. Les réponses viennent de la FAQ du festival.' },
    nl: { launch: 'Chat met Diya', wa: 'WhatsApp', sub: 'Brussels Diwali Festival · AI-gastvrouw',
      ph: 'Stel een vraag…', send: 'Versturen', close: 'Chat sluiten', offline: 'Ik kan het festival nu niet bereiken. Probeer het zo meteen opnieuw.',
      name: 'Uw naam', email: 'Uw e-mail', consent: 'Stuur me festivalnieuws van Art India, uitschrijven kan altijd',
      keep: 'Houd me op de hoogte', later: 'Later misschien', have: 'Ik heb al een ticket',
      badEmail: 'Dit e-mailadres lijkt niet te kloppen.', needConsent: 'Vink het vakje aan zodat we u mogen schrijven.',
      foot: 'Diya is een AI-assistent. Antwoorden komen uit de FAQ van het festival.' },
  }[LANG];

  /* --------------------------------------------------------------- state */

  var state = { session: null, transcript: [], lang: LANG, open: false };
  try {
    var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved) {
      /* sessionStorage is per origin, and /, /fr/ and /nl/ share one. A
         transcript carried from the English page was being replayed on the
         French one, which is why the greeting and the buttons came back in
         the wrong language. Crossing languages drops the transcript and asks
         for a fresh greeting; the session token survives, so a buyer stays a
         buyer and nobody is asked for their email twice. */
      var sameLang = (saved.lang || 'en') === LANG;
      state = {
        session: saved.session,
        transcript: sameLang ? (saved.transcript || []) : [],
        lang: LANG,
        open: false,
      };
    }
  } catch (e) { /* private mode; the widget just starts fresh */ }

  function persist() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        session: state.session, lang: LANG, transcript: state.transcript.slice(-MAX_KEPT),
      }));
    } catch (e) { /* nothing to do about a full or blocked store */ }
  }

  /* ----------------------------------------------------------------- dom */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  var LINK_RE = /(https?:\/\/[^\s<>"')]+|mailto:[^\s<>"')]+)/g;

  /** Text into a bubble, with bare URLs turned into anchors and nothing else. */
  function withLinks(target, text) {
    var last = 0;
    String(text).replace(LINK_RE, function (url, _m, index) {
      if (index > last) target.appendChild(document.createTextNode(text.slice(last, index)));
      var a = el('a', null, url.replace(/^mailto:/, ''));
      a.href = url;
      if (url.indexOf('mailto:') !== 0) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      target.appendChild(a);
      last = index + url.length;
      return url;
    });
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
  }

  var root = el('div', 'diya-root');
  var launchers = el('div', 'diya-launchers');

  var waBtn = document.createElement('a');
  waBtn.className = 'diya-fab diya-wa';
  waBtn.href = WA;
  waBtn.target = '_blank';
  waBtn.rel = 'noopener noreferrer';
  waBtn.setAttribute('aria-label', COPY.wa);
  waBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 2a10 10 0 00-8.6 15L2 22l5.2-1.4A10 10 0 1012 2zm0 18a8 8 0 01-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1112 20zm4.4-5.8c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.8 1-.3.2-.5.1a6.5 6.5 0 01-3.2-2.8c-.2-.4.2-.4.6-1.2.1-.2 0-.3 0-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 00-.7.3A3 3 0 006 8.6c0 1.8 1.3 3.5 1.5 3.7s2.5 3.8 6 5.3c2.1.9 2.9.9 4 .8.6-.1 1.4-.6 1.7-1.2s.2-1.1.1-1.2z"/></svg>';
  waBtn.appendChild(el('span', 'diya-fab-label', COPY.wa));

  var launch = el('button', 'diya-fab');
  launch.type = 'button';
  launch.setAttribute('aria-label', COPY.launch);
  var avatar = document.createElement('img');
  avatar.src = AVATAR;
  avatar.alt = '';
  avatar.width = 44;
  avatar.height = 44;
  launch.appendChild(avatar);
  launch.appendChild(el('span', 'diya-fab-label', COPY.launch));

  launchers.appendChild(waBtn);
  launchers.appendChild(launch);

  var panel = el('div', 'diya-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', COPY.launch);
  panel.hidden = true;

  var head = el('div', 'diya-head');
  var headImg = document.createElement('img');
  headImg.src = AVATAR;
  headImg.alt = '';
  head.appendChild(headImg);
  var who = el('div');
  who.appendChild(el('b', null, 'Diya'));
  who.appendChild(el('span', null, COPY.sub));
  head.appendChild(who);
  var close = el('button', 'diya-x', '×');
  close.type = 'button';
  close.setAttribute('aria-label', COPY.close);
  head.appendChild(close);

  var log = el('div', 'diya-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  var chips = el('div', 'diya-chips');
  var leadBox = el('div', 'diya-form');
  leadBox.hidden = true;

  var bar = el('div', 'diya-bar');
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = COPY.ph;
  input.setAttribute('aria-label', COPY.ph);
  var send = el('button', 'diya-send', '↑');
  send.type = 'button';
  send.setAttribute('aria-label', COPY.send);
  bar.appendChild(input);
  bar.appendChild(send);

  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(chips);
  panel.appendChild(leadBox);
  panel.appendChild(bar);
  panel.appendChild(el('div', 'diya-foot', COPY.foot));

  root.appendChild(launchers);
  root.appendChild(panel);

  /* ------------------------------------------------------------ painting */

  function bubble(who_, text) {
    var b = el('div', 'diya-msg ' + who_);
    withLinks(b, text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function remember(who_, text) {
    state.transcript.push({ who: who_, text: text });
    state.transcript = state.transcript.slice(-MAX_KEPT);
    persist();
  }

  function paintChips(buttons) {
    chips.innerHTML = '';
    (buttons || []).forEach(function (b) {
      var node;
      if (b.href) {
        node = document.createElement('a');
        node.href = b.href;
        if (b.href.indexOf('mailto:') !== 0) { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      } else {
        node = document.createElement('button');
        node.type = 'button';
        node.addEventListener('click', function () { chips.innerHTML = ''; talk({ action: b.id }); });
      }
      node.className = 'diya-chip';
      node.textContent = b.label;
      chips.appendChild(node);
    });
  }

  var dots = null;
  function thinking(on) {
    if (on && !dots) {
      dots = el('div', 'diya-dots');
      dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
      log.appendChild(dots);
      log.scrollTop = log.scrollHeight;
    } else if (!on && dots) {
      dots.remove();
      dots = null;
    }
    send.disabled = on;
  }

  /* ------------------------------------------------------------- the lead */

  function showLead() {
    leadBox.innerHTML = '';
    leadBox.hidden = false;

    var err = el('div', 'diya-err');
    err.hidden = true;

    var nameLabel = el('label', null, COPY.name);
    nameLabel.htmlFor = 'diya-name';
    var name = document.createElement('input');
    name.type = 'text'; name.id = 'diya-name'; name.autocomplete = 'given-name';

    var mailLabel = el('label', null, COPY.email);
    mailLabel.htmlFor = 'diya-email';
    var mail = document.createElement('input');
    mail.type = 'email'; mail.id = 'diya-email'; mail.autocomplete = 'email';

    var consentRow = el('label', 'diya-consent');
    var tick = document.createElement('input');
    tick.type = 'checkbox';
    consentRow.appendChild(tick);
    consentRow.appendChild(document.createTextNode(COPY.consent));

    var actions = el('div', 'diya-actions');
    var keep = el('button', 'diya-chip', COPY.keep);
    keep.type = 'button';
    var later = el('button', 'diya-chip', COPY.later);
    later.type = 'button';
    actions.appendChild(keep);
    actions.appendChild(later);

    var already = el('button', 'diya-chip', COPY.have);
    already.type = 'button';
    already.style.marginTop = '.5rem';

    [err, nameLabel, name, mailLabel, mail, consentRow, actions, already]
      .forEach(function (n) { leadBox.appendChild(n); });

    function fail(msg) { err.textContent = msg; err.hidden = false; }

    keep.addEventListener('click', function () {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(mail.value.trim())) return fail(COPY.badEmail);
      if (!tick.checked) return fail(COPY.needConsent);
      hideLead();
      fire('diya_lead');
      talk({ lead: { name: name.value.trim(), email: mail.value.trim(), consent: true } });
    });
    later.addEventListener('click', hideLead);
    already.addEventListener('click', function () {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(mail.value.trim())) return fail(COPY.badEmail);
      hideLead();
      talk({ identify: { email: mail.value.trim() } });
    });
    name.focus();
  }

  function hideLead() { leadBox.hidden = true; leadBox.innerHTML = ''; input.focus(); }

  /* ----------------------------------------------------------------- talk */

  function talk(payload) {
    thinking(true);
    var body = { lang: LANG, session: state.session };
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        thinking(false);
        if (d.session) { state.session = d.session; persist(); }
        if (d.reply) { bubble('bot', d.reply); remember('bot', d.reply); }
        paintChips(d.buttons);
        if (d.askLead) {
          if (d.leadPrompt) { bubble('bot', d.leadPrompt); remember('bot', d.leadPrompt); }
          showLead();
        }
      })
      .catch(function () {
        thinking(false);
        bubble('bot', COPY.offline);
      });
  }

  function say() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    bubble('me', text);
    remember('me', text);
    chips.innerHTML = '';
    fire('diya_question');
    talk({ message: text });
  }

  send.addEventListener('click', say);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); say(); } });

  /* ------------------------------------------------------------ open/close */

  var lastFocus = null;

  function openPanel() {
    lastFocus = document.activeElement;
    panel.hidden = false;
    launchers.hidden = true;
    state.open = true;

    /* A returning page keeps its thread and asks only for the buttons, which
       are not part of the transcript; a fresh one opens with the greeting.
       Either way the server is told, so it can mint or refresh the session. */
    if (!log.childElementCount) {
      state.transcript.forEach(function (m) { bubble(m.who, m.text); });
      talk(state.transcript.length ? { resume: true } : {});
    }
    input.focus();
    fire('diya_open');
  }

  function closePanel() {
    panel.hidden = true;
    launchers.hidden = false;
    state.open = false;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  launch.addEventListener('click', openPanel);
  close.addEventListener('click', closePanel);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) closePanel();
    if (e.key !== 'Tab' || !state.open) return;
    /* Focus stays inside the panel while it is open. */
    var f = panel.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* Whatever the site happens to use, if anything. */
  function fire(name) {
    try {
      if (typeof window.plausible === 'function') window.plausible(name);
      else if (typeof window.gtag === 'function') window.gtag('event', name);
    } catch (e) { /* analytics must never break the chat */ }
  }

  /* --------------------------------------------------------------- start */

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/diya.css';
  document.head.appendChild(css);
  document.body.appendChild(root);
})();
