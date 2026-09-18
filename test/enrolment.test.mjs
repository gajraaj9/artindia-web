/**
 * The two pure pieces of the enrolment path that are worth pinning down:
 * turning a typed phone number into E.164, and turning an address into a
 * referral code. Everything else in those functions is HTTP.
 *
 *   node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalisePhone, referralCode, CODE_ALPHABET, CODE_RE,
} from '../functions/api/_shared.js';

test('Belgian numbers land on the same E.164 however they are written', () => {
  for (const written of [
    '0490 61 66 61',
    '+32 490 616661',
    '0032490616661',
    '+32490616661',
    '0490616661',
    '+32 (0)490 61 66 61',
    '0490/61.66.61',
    '  0490 61 66 61  ',
    '490616661',
  ]) {
    assert.equal(normalisePhone(written), '+32490616661', `from ${JSON.stringify(written)}`);
  }
});

test('a foreign number keeps its own country', () => {
  assert.equal(normalisePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalisePhone('0033 6 12 34 56 78'), '+33612345678');
  assert.equal(normalisePhone('+33 (0)6 12 34 56 78'), '+33612345678');
  assert.equal(normalisePhone('+31 6 12345678'), '+31612345678');
  assert.equal(normalisePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalisePhone('+44 (0)7700 900123'), '+447700900123');
});

test('an Italian landline keeps the zero that is part of the number', () => {
  assert.equal(normalisePhone('+39 06 6982'), '+39066982');
});

test('nothing usable comes back as an empty string, never a half number', () => {
  for (const junk of [null, undefined, '', '   ', 'n/a', '+', '12', 'abc']) {
    assert.equal(normalisePhone(junk), '', `from ${JSON.stringify(junk)}`);
  }
});

test('the code alphabet drops the characters that get misread', () => {
  assert.equal(CODE_ALPHABET.length, 32, 'exactly 32, so 5 bits maps with no bias');
  assert.equal(new Set(CODE_ALPHABET).size, 32, 'no repeats');
  for (const banned of ['0', 'O', '1', 'I']) {
    assert.ok(!CODE_ALPHABET.includes(banned), `${banned} must not be in the alphabet`);
  }
});

test('a code is six characters of that alphabet, and the same one every time', async () => {
  const first = await referralCode('ravi@artindia.be');
  assert.match(first, CODE_RE);
  assert.equal(first.length, 6);
  assert.equal(await referralCode('ravi@artindia.be'), first, 'stable across calls');
  assert.equal(await referralCode('  RAVI@ArtIndia.BE '), first, 'case and space insensitive');
  assert.notEqual(await referralCode('someone.else@artindia.be'), first);
});

test('the attempt counter walks a collision onto a different code', async () => {
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const code = await referralCode('ravi@artindia.be', i);
    assert.match(code, CODE_RE);
    seen.add(code);
  }
  assert.equal(seen.size, 8, 'each attempt gives a distinct code');
});

test('every character a generated code can contain is in the alphabet', async () => {
  for (let i = 0; i < 200; i++) {
    const code = await referralCode(`buyer${i}@example.com`);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${ch} in ${code}`);
    assert.match(code, CODE_RE);
  }
});
