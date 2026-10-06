/**
 * GET /c/<CODE>   a team member's own page  ->  the box office
 *
 * The thing an artist actually sends. A code on its own is a string somebody
 * has to remember, retype and spell correctly; this is a link they can paste
 * into a family group with their own name on it.
 *
 * Both code shapes resolve: RAVI123 is what we mint now, SHREYA-7KQ4 is what
 * people already hold. A code that has been changed still works from its old
 * link and shows the new code, because the old key is only released when the
 * old discount really went with it.
 *
 * Nothing about the person leaves this page but their first name. A code that
 * is unknown, revoked or expired shows nobody and nothing: it is a 302 to the
 * box office, the same as a mistyped link.
 */

import { logClick, clickFrom } from '../api/_shared.js';
import {
  promoKey, getPerson, isTeamCode, say, LANGS, langOf, isDryId, codeExpiryUnix,
} from '../api/_accred.js';

/* The same box office /i/ and /r/ use. */
const BOX_OFFICE = 'https://tickets.artindia.be/events/artindia/2392534';
const SITE = 'https://diwali.artindia.be';

const boxOffice = (env, ref = '') => {
  const to = new URL(env.TICKET_URL || BOX_OFFICE);
  if (ref) to.searchParams.set('ref', ref);
  return to.toString();
};

const redirect = to => new Response(null, {
  status: 302,
  headers: { location: to, 'cache-control': 'no-store' },
});

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* The browser's own preference, narrowed to the three we speak. The link gets
   forwarded across a family that does not share one language, so the page
   guesses and then offers the other two at the top. */
function langFrom(request) {
  const header = String(request.headers.get('accept-language') || '').toLowerCase();
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim().slice(0, 2);
    if (LANGS.includes(tag)) return tag;
  }
  return 'en';
}

/**
 * Who this code belongs to, or null.
 *
 * Revoked, rejected and dry-run codes are nobody: the key may still be there
 * while the discount is gone, and sending somebody to a checkout with a code
 * Ticket Tailor will refuse is worse than sending them with none.
 */
async function holderOf(kv, code) {
  if (!kv || !isTeamCode(code)) return null;
  const held = await kv.get(promoKey(code), 'json');
  if (!held || !held.id) return null;
  const person = await getPerson(kv, held.id);
  if (!person || person.status !== 'approved') return null;
  if (!person.promo || !person.promo.code) return null;
  if (isDryId(person.promo.discountId)) return null;
  return person;
}

export async function onRequestGet(ctx) {
  const { request, params, env } = ctx;
  const asked = String(params.code || '').trim().toUpperCase();
  /* The browser decides, unless the switcher at the top has been used. */
  const wanted = new URL(request.url).searchParams.get('lang');
  const lang = wanted ? langOf(wanted) : langFrom(request);

  const person = await holderOf(env.ACCRED, asked);

  /* The code the person holds now, which after a change is not the code in
     the link. The link keeps working and shows the new one. */
  const code = person ? person.promo.code : '';

  await logClick(env, clickFrom(request, {
    cta: 'team',
    utm_source: 'team',
    utm_medium: 'whatsapp',
    ref: code ? `team-${code.toLowerCase()}` : '',
  }));

  /* Past the last day a code can be redeemed, every code is a dead code and
     the page would be an offer we cannot honour. */
  const expired = Date.now() / 1000 > codeExpiryUnix(env);
  if (!person || expired) {
    /* Nothing to show and nobody to name: they still wanted a ticket. */
    return redirect(boxOffice(env));
  }

  const t = key => say(key, lang);
  const first = person.firstName;
  const title = t('c_title').split('{FIRST}').join(first);
  const buy = boxOffice(env, `team-${code.toLowerCase()}`);

  const switcher = LANGS.map(l => (l === lang
    ? `<a href="?lang=${l}" aria-current="page">${l.toUpperCase()}</a>`
    : `<a href="?lang=${l}">${l.toUpperCase()}</a>`)).join(' &middot; ');

  return new Response(page({
    lang, title, first, code, buy, switcher,
    dateline: t('dateline'),
    offer: t('c_offer'),
    button: t('c_button'),
    hint: t('c_hint'),
    copied: t('c_copied'),
  }), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      /* Personal, and the code on it can change. Never cached, never indexed. */
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/* A HEAD is WhatsApp or a link checker looking at the headers. Same answer,
   no body, and the click is not counted twice. */
export async function onRequestHead(ctx) {
  const res = await onRequestGet(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}

const HREFLANG = { en: 'en', fr: 'fr', nl: 'nl-BE' };

function page(v) {
  return `<!doctype html>
<html lang="${HREFLANG[v.lang] || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(v.title)}</title>
<link rel="icon" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(v.offer)}">
<meta property="og:image" content="${SITE}/og-diwali${v.lang === 'en' ? '' : `-${v.lang}`}.png">
<meta property="og:locale" content="${esc(HREFLANG[v.lang] || 'en')}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/diwali.css">
<style>
/* The same family as the team form, and for the same reason: this is a page
   somebody lands on from a WhatsApp message, on a phone, once. */
.cc [hidden]{display:none!important}
.cc{max-width:460px;margin:0 auto;padding:0 20px 72px;text-align:center}
.cc-top{display:flex;align-items:center;gap:12px;text-align:left;
  padding:18px 0 16px;margin:0 0 30px;border-bottom:1px solid var(--line)}
.cc-mark{flex:0 0 auto;width:38px;height:38px;border-radius:10px;display:block}
.cc-word{flex:1 1 auto;min-width:0}
.cc-fest{display:block;font-family:var(--display);font-weight:400;
  font-size:clamp(17px,4.6vw,21px);line-height:1.1}
.cc-dates{display:block;margin-top:3px;font-size:12.5px;line-height:1.3;color:var(--ink-2)}
.cc-langs{flex:0 0 auto;font-size:13px;color:var(--ink-2);white-space:nowrap}
.cc-langs a{color:var(--ink-2);text-decoration:none;padding:2px 1px}
.cc-langs a[aria-current=page]{color:var(--marigold);font-weight:700}
.cc h1{margin:0 0 12px;font-family:var(--display);font-weight:400;
  font-size:clamp(27px,8vw,38px);line-height:1.08;overflow-wrap:anywhere}
.cc-offer{margin:0 0 30px;color:var(--ink-2);line-height:1.5}
.cc-code{display:block;margin:0 0 8px;padding:20px 14px;border-radius:14px;
  border:1px dashed var(--marigold);background:rgba(232,163,59,.08);
  color:var(--marigold);font:700 clamp(26px,9vw,38px)/1.1 var(--text);
  letter-spacing:.08em;word-break:break-all;-webkit-user-select:all;user-select:all}
.cc-copied{margin:0 0 10px;min-height:20px;font-size:14px;font-weight:700;color:var(--marigold)}
.cc-go{display:block;width:100%;box-sizing:border-box;margin:0 0 16px;padding:17px;
  font:700 17px/1 var(--text);text-align:center;text-decoration:none;cursor:pointer;
  color:#1b1205;background:var(--marigold);border:0;border-radius:999px}
.cc-hint{margin:0;font-size:14px;line-height:1.5;color:var(--ink-3)}
.cc a:focus-visible,.cc button:focus-visible{outline:3px solid var(--marigold);outline-offset:2px}
</style>
</head>
<body>
<main class="cc">
  <div class="cc-top">
    <img class="cc-mark" src="/favicon.svg" alt="" width="38" height="38">
    <span class="cc-word">
      <span class="cc-fest">Brussels Diwali Festival</span>
      <span class="cc-dates">${esc(v.dateline)}</span>
    </span>
    <span class="cc-langs">${v.switcher}</span>
  </div>

  <h1>${esc(v.title)}</h1>
  <p class="cc-offer">${esc(v.offer)}</p>

  <code class="cc-code" id="code">${esc(v.code)}</code>
  <p class="cc-copied" id="said" role="status"></p>

  <a class="cc-go" id="go" href="${esc(v.buy)}">${esc(v.button)}</a>
  <p class="cc-hint">${esc(v.hint)}</p>
</main>
<script>
(function () {
  var go = document.getElementById('go');
  var said = document.getElementById('said');
  var code = ${JSON.stringify(v.code)};
  var COPIED = ${JSON.stringify(v.copied)};

  /* Copy, then leave. The copy is best effort and the link is a real anchor,
     so with no script, no clipboard and no permission the button still takes
     them to the box office. */
  go.addEventListener('click', function () {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { said.textContent = COPIED; },
          function () { select(); });
      } else { select(); }
    } catch (e) { select(); }
  });

  /* The fallback: put the code under the cursor so one tap takes it. */
  function select() {
    try {
      var el = document.getElementById('code');
      var r = document.createRange();
      r.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      said.textContent = COPIED;
    } catch (e) { /* the code is on the screen either way */ }
  }
})();
</script>
</body>
</html>`;
}
