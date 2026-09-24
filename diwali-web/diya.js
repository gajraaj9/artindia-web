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
    en: { send: 'Send', skip: 'Skip for now', locked: 'Fill in the form above', sent: 'Thanks, that is noted.', back: 'Back to site', launch: 'Chat with Diya', sub: 'Brussels Diwali Festival · AI host',
      ph: 'Ask a question…', send: 'Send', close: 'Close chat', offline: "I can't reach the festival right now. Please try again in a moment.",
      name: 'Your name', email: 'Your email', consent: 'Send me festival news from Art India, unsubscribe anytime',
      keep: 'Keep me posted', later: 'Maybe later', have: 'I already have a ticket',
      badEmail: 'That email does not look right.', needConsent: 'Please tick the box so we may write to you.',
      foot: 'Diya is an AI assistant. Answers come from the festival FAQ.' },
    fr: { send: 'Envoyer', skip: 'Passer', locked: 'Complétez le formulaire ci-dessus', sent: "Merci, c'est noté.", back: 'Retour au site', launch: 'Discuter avec Diya', sub: 'Brussels Diwali Festival · hôtesse IA',
      ph: 'Posez une question…', send: 'Envoyer', close: 'Fermer le chat', offline: 'Je ne peux pas joindre le festival pour le moment. Réessayez dans un instant.',
      name: 'Votre nom', email: 'Votre e-mail', consent: "Envoyez-moi les actualités du festival d'Art India, désinscription à tout moment",
      keep: 'Tenez-moi au courant', later: 'Plus tard', have: "J'ai déjà un billet",
      badEmail: "Cette adresse e-mail ne semble pas correcte.", needConsent: 'Cochez la case pour que nous puissions vous écrire.',
      foot: 'Diya est une assistante IA. Les réponses viennent de la FAQ du festival.' },
    nl: { send: 'Verzenden', skip: 'Overslaan', locked: 'Vul het formulier hierboven in', sent: 'Bedankt, genoteerd.', back: 'Terug naar site', launch: 'Chat met Diya', sub: 'Brussels Diwali Festival · AI-gastvrouw',
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

  var leadCard = null;

  /* A card in the transcript, where Diya just asked the question, rather than
     a panel bolted under it. The old one left the free text box open next to
     it with no send button, so the only visible way to answer a question
     about your name and email was to type a sentence at it. */
  function showLead() {
    if (leadCard) return;

    var card = el('div', 'diya-lead');

    function field(id, labelText, type, autocomplete) {
      var wrap = el('div', 'diya-field');
      var lab = el('label', null, labelText);
      lab.htmlFor = id;
      var box = document.createElement('input');
      box.type = type; box.id = id; box.autocomplete = autocomplete;
      var err = el('div', 'diya-field-err');
      err.hidden = true;
      err.id = id + '-err';
      wrap.appendChild(lab); wrap.appendChild(box); wrap.appendChild(err);
      return { wrap: wrap, input: box, err: err };
    }

    var name = field('diya-name', COPY.name, 'text', 'given-name');
    var mail = field('diya-email', COPY.email, 'email', 'email');

    var consentWrap = el('div', 'diya-field');
    var consentRow = el('label', 'diya-consent');
    var tick = document.createElement('input');
    tick.type = 'checkbox';
    consentRow.appendChild(tick);
    consentRow.appendChild(document.createTextNode(COPY.consent));
    var consentErr = el('div', 'diya-field-err');
    consentErr.hidden = true;
    consentWrap.appendChild(consentRow);
    consentWrap.appendChild(consentErr);

    var send = el('button', 'diya-primary');
    send.type = 'button';
    var sendLabel = el('span', null, COPY.send);
    var spinner = el('span', 'diya-spin');
    spinner.hidden = true;
    send.appendChild(spinner);
    send.appendChild(sendLabel);

    var links = el('div', 'diya-lead-links');
    var skip = el('button', 'diya-textlink', COPY.skip);
    skip.type = 'button';
    /* Kept from the previous form: without it a buyer has no way to say who
       they are, which is the only route to their own ticket count. */
    var already = el('button', 'diya-textlink', COPY.have);
    already.type = 'button';
    links.appendChild(skip);
    links.appendChild(already);

    [name.wrap, mail.wrap, consentWrap, send, links]
      .forEach(function (n) { card.appendChild(n); });

    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    leadCard = card;
    lockInput(true);

    function clearErrors() {
      [name.err, mail.err, consentErr].forEach(function (e) { e.hidden = true; e.textContent = ''; });
      [name.input, mail.input].forEach(function (i) { i.classList.remove('is-bad'); i.removeAttribute('aria-invalid'); });
    }
    function failField(f, msg) {
      f.err.textContent = msg; f.err.hidden = false;
      f.input.classList.add('is-bad');
      f.input.setAttribute('aria-invalid', 'true');
      f.input.setAttribute('aria-describedby', f.err.id);
      f.input.focus();
    }
    var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

    function busy(on) {
      send.disabled = on;
      skip.disabled = on;
      already.disabled = on;
      spinner.hidden = !on;
    }

    function submit() {
      clearErrors();
      if (!EMAIL.test(mail.input.value.trim())) return failField(mail, COPY.badEmail);
      if (!tick.checked) {
        consentErr.textContent = COPY.needConsent;
        consentErr.hidden = false;
        tick.focus();
        return;
      }
      busy(true);
      fire('diya_lead');
      talk({ lead: { name: name.input.value.trim(), email: mail.input.value.trim(), consent: true } })
        .then(function (d) { if (d) hideLead(); else busy(false); });
    }

    function identify() {
      clearErrors();
      if (!EMAIL.test(mail.input.value.trim())) return failField(mail, COPY.badEmail);
      busy(true);
      talk({ identify: { email: mail.input.value.trim() } })
        .then(function (d) { if (d) hideLead(); else busy(false); });
    }

    send.addEventListener('click', submit);
    already.addEventListener('click', identify);
    skip.addEventListener('click', function () { hideLead(); });

    /* Enter from either field sends, which is what a two field form implies. */
    [name.input, mail.input].forEach(function (i) {
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      /* The keyboard shrinks the sheet; keep the card in the part that is left. */
      i.addEventListener('focus', function () {
        setTimeout(function () { card.scrollIntoView({ block: 'nearest' }); }, 250);
      });
    });

    name.input.focus();
  }

  /* The free text box has nothing useful to do while the form is open, and an
     enabled box with no send button is what caused the confusion. */
  function lockInput(on) {
    input.disabled = on;
    send.disabled = on;
    input.placeholder = on ? COPY.locked : COPY.ph;
    chips.hidden = on;
  }

  function hideLead() {
    if (leadCard) { leadCard.remove(); leadCard = null; }
    lockInput(false);
    log.scrollTop = log.scrollHeight;
  }

  /* ----------------------------------------------------------------- talk */

  function talk(payload) {
    thinking(true);
    var body = { lang: LANG, session: state.session };
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];

    return fetch('/api/chat', {
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
        return d;
      })
      .catch(function () {
        thinking(false);
        bubble('bot', COPY.offline);
        /* Resolves with nothing rather than rejecting, so a caller can tell a
           failed send from a successful one and leave the form up with what
           the visitor typed still in it. */
        return null;
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
