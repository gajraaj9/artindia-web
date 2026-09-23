/**
 * /i/<n> — the per-post Instagram link.
 *
 * It exists as a function because Pages will not substitute a :placeholder
 * inside a destination's query string; the rule that was tried first arrived
 * at the box office as ref=ig-%3An, literally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/i/[n].js';

const BOX = 'https://tickets.artindia.be/events/artindia/2392534';
const go = (n, env = {}) => onRequestGet({ params: { n }, env });
const where = res => new URL(res.headers.get('location'));

test('a post tag lands on the box office with ref and campaign', () => {
  const res = go('1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const u = where(res);
  assert.equal(u.origin + u.pathname, BOX);
  assert.equal(u.searchParams.get('ref'), 'ig-1');
  assert.equal(u.searchParams.get('utm_source'), 'instagram');
  assert.equal(u.searchParams.get('utm_medium'), 'social');
  assert.equal(u.searchParams.get('utm_campaign'), 'ig-1');
});

test('the Location is exactly what the brief asks for', () => {
  assert.equal(where(go('1')).search,
    '?utm_source=instagram&utm_medium=social&ref=ig-1&utm_campaign=ig-1');
  assert.ok(!where(go('1')).search.includes('%3A'),
    'the placeholder bug this function was written to fix');
});

test('lowercase, digits and hyphens, up to twenty characters', () => {
  for (const n of ['1', '42', 'launch', 'launch-week-2', 'a', '12345678901234567890']) {
    assert.equal(where(go(n)).searchParams.get('ref'), `ig-${n}`, n);
  }
});

test('anything else still reaches the box office, just untagged', () => {
  for (const n of [
    'Launch',                    /* uppercase */
    'launch_week',               /* underscore */
    'week 2',                    /* space */
    '123456789012345678901',     /* twenty-one characters */
    '../../etc',                 /* path traversal */
    '<script>',                  /* markup */
    'ig-1&utm_source=evil',      /* trying to write their own parameters */
    '',
  ]) {
    const u = where(go(n));
    assert.equal(u.origin + u.pathname, BOX, JSON.stringify(n));
    assert.equal(u.searchParams.get('ref'), null, `${JSON.stringify(n)}: no ref`);
    assert.equal(u.searchParams.get('utm_campaign'), null, `${JSON.stringify(n)}: no campaign`);
    /* The visit still came from Instagram and is still worth counting. */
    assert.equal(u.searchParams.get('utm_source'), 'instagram');
  }
});

test('a tag cannot smuggle extra query parameters', () => {
  const u = where(go('1&ref=ABC234'));
  assert.equal(u.searchParams.get('ref'), null, 'rejected outright, not escaped in');
  assert.equal(u.searchParams.getAll('ref').length, 0);
});

test('the box office can be moved without a deploy', () => {
  const u = where(go('7', { TICKET_URL: 'https://example.com/box' }));
  assert.equal(u.origin + u.pathname, 'https://example.com/box');
  assert.equal(u.searchParams.get('ref'), 'ig-7');
});

test('HEAD answers exactly as GET, so a link checker sees the redirect', async () => {
  const { onRequestHead } = await import('../functions/i/[n].js');
  const head = onRequestHead({ params: { n: '1' }, env: {} });
  const get = go('1');
  assert.equal(head.status, get.status);
  assert.equal(head.headers.get('location'), get.headers.get('location'));
});
