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
  var AVATAR = '/diya.png';
  var MAX_KEPT = 30;

  var LANG = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
  if (['en', 'fr', 'nl'].indexOf(LANG) === -1) LANG = 'en';

  var COPY = {
    en: { back: 'Back to site', launch: 'Chat with Diya', sub: 'Brussels Diwali Festival · AI host',
      ph: 'Ask a question…', send: 'Send', close: 'Close chat', offline: "I can't reach the festival right now. Please try again in a moment.",
      name: 'Your name', email: 'Your email', consent: 'Send me festival news from Art India, unsubscribe anytime',
      keep: 'Keep me posted', later: 'Maybe later', have: 'I already have a ticket',
      badEmail: 'That email does not look right.', needConsent: 'Please tick the box so we may write to you.',
      foot: 'Diya is an AI assistant. Answers come from the festival FAQ.' },
    fr: { back: 'Retour au site', launch: 'Discuter avec Diya', sub: 'Brussels Diwali Festival · hôtesse IA',
      ph: 'Posez une question…', send: 'Envoyer', close: 'Fermer le chat', offline: 'Je ne peux pas joindre le festival pour le moment. Réessayez dans un instant.',
      name: 'Votre nom', email: 'Votre e-mail', consent: "Envoyez-moi les actualités du festival d'Art India, désinscription à tout moment",
      keep: 'Tenez-moi au courant', later: 'Plus tard', have: "J'ai déjà un billet",
      badEmail: "Cette adresse e-mail ne semble pas correcte.", needConsent: 'Cochez la case pour que nous puissions vous écrire.',
      foot: 'Diya est une assistante IA. Les réponses viennent de la FAQ du festival.' },
    nl: { back: 'Terug naar site', launch: 'Chat met Diya', sub: 'Brussels Diwali Festival · AI-gastvrouw',
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

  launchers.appendChild(launch);

  var backdrop = el('div', 'diya-backdrop');

  var panel = el('div', 'diya-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', COPY.launch);
  panel.hidden = true;

  var grab = el('div', 'diya-grab');

  var head = el('div', 'diya-head');
  var back = el('button', 'diya-back');
  back.type = 'button';
  back.appendChild(document.createTextNode('\u2039 ' + COPY.back));
  head.appendChild(back);
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

  panel.appendChild(grab);
  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(chips);
  panel.appendChild(leadBox);
  panel.appendChild(bar);
  panel.appendChild(el('div', 'diya-foot', COPY.foot));

  root.appendChild(launchers);
  root.appendChild(backdrop);
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
      node.className = 'diya-chip' + (b.id === 'WHATSAPP' ? ' wa' : '');
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
    backdrop.classList.add('is-open');
    launchers.hidden = true;
    state.open = true;
    syncViewport();

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
    backdrop.classList.remove('is-open');
    root.style.setProperty('--dy-drag', '0px');
    launchers.hidden = false;
    state.open = false;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  launch.addEventListener('click', openPanel);
  close.addEventListener('click', closePanel);
  back.addEventListener('click', closePanel);
  backdrop.addEventListener('click', closePanel);

  /* ------------------------------------------------- keyboard and swipe */

  /* The sheet tracks the visual viewport rather than the layout one. When the
     keyboard opens, the visual viewport shrinks and is offset; without this
     the composer ends up behind the keyboard and the only way back to it is a
     scroll that does not exist. */
  function syncViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--dy-kb', Math.round(keyboard) + 'px');
    root.style.setProperty('--dy-vvh', Math.round(vv.height) + 'px');
    if (state.open) log.scrollTop = log.scrollHeight;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('orientationchange', syncViewport);
  syncViewport();

  /* Pull the sheet down to dismiss it. Only from the handle and the header,
     so a swipe inside the transcript still scrolls the transcript. */
  var dragFrom = null;
  function dragStart(e) {
    if (panel.hidden) return;
    dragFrom = e.touches ? e.touches[0].clientY : null;
    if (dragFrom !== null) panel.classList.add('is-dragging');
  }
  function dragMove(e) {
    if (dragFrom === null) return;
    var dy = e.touches[0].clientY - dragFrom;
    if (dy > 0) root.style.setProperty('--dy-drag', Math.round(dy) + 'px');
  }
  function dragEnd(e) {
    if (dragFrom === null) return;
    var dy = (e.changedTouches ? e.changedTouches[0].clientY : dragFrom) - dragFrom;
    panel.classList.remove('is-dragging');
    root.style.setProperty('--dy-drag', '0px');
    dragFrom = null;
    if (dy > 80) closePanel();
  }
  [grab, head].forEach(function (n) {
    n.addEventListener('touchstart', dragStart, { passive: true });
    n.addEventListener('touchmove', dragMove, { passive: true });
    n.addEventListener('touchend', dragEnd);
    n.addEventListener('touchcancel', dragEnd);
  });

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

  /* The site pins a ticket bar to the bottom of the screen below 720px once
     the hero has scrolled away. The launcher sits above it when it is up and
     drops back to 16px when it is not, so the two never cover each other. */
  function watchStickyBar() {
    var bar = document.getElementById('stickybar');
    if (!bar) return;
    function sync() {
      var up = bar.classList.contains('show')
        && getComputedStyle(bar).display !== 'none';
      root.style.setProperty('--dy-lift', up ? (bar.offsetHeight + 12) + 'px' : '0px');
    }
    try {
      new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { /* very old browser: the launcher just stays at 16px */ }
    window.addEventListener('resize', sync);
    sync();
  }

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/diya.css';
  document.head.appendChild(css);
  document.body.appendChild(root);
  watchStickyBar();
})();
