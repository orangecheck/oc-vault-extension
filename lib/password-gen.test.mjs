// node --test: the generator makes what its options ask for, uniformly, and says its entropy exactly.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./ts-alias-loader.mjs', import.meta.url);
const {
    generatePassphrase,
    generatePassword,
    passphraseEntropyBits,
    passwordAlphabet,
    passwordEntropyBits,
} = await import('./password-gen.ts');
const { WORDLIST } = await import('./wordlist.ts');

test('a password has the length asked for, from the classes turned on', () => {
    assert.equal(generatePassword({ length: 20 }).length, 20);
    assert.match(
        generatePassword({ length: 200, uppercase: false, digits: false, symbols: false }),
        /^[a-z]{200}$/
    );
    assert.match(
        generatePassword({ length: 200, lowercase: false, uppercase: false, symbols: false }),
        /^[0-9]{200}$/
    );
    assert.equal(generatePassword({ length: 0 }).length, 1);
    assert.equal(generatePassword({ length: 1000 }).length, 256);
});

test('look-alikes are left out when asked, and no class at all is refused', () => {
    const p = generatePassword({ length: 256, symbols: false, excludeAmbiguous: true });
    assert.doesNotMatch(p, /[0Oo1lI]/);
    assert.throws(
        () =>
            generatePassword({
                length: 8,
                lowercase: false,
                uppercase: false,
                digits: false,
                symbols: false,
            }),
        /at least one kind/
    );
});

test('every character of the alphabet comes up about equally often', () => {
    const alphabet = passwordAlphabet({ length: 1 });
    const n = 200_000;
    const counts = new Map();
    let drawn = '';
    while (drawn.length < n) drawn += generatePassword({ length: 256 });
    for (const c of drawn.slice(0, n)) counts.set(c, (counts.get(c) ?? 0) + 1);
    assert.equal(counts.size, alphabet.length);
    const expected = n / alphabet.length;
    // Chi-square over 87 symbols: the 99.99th percentile with 86 degrees of freedom is about 150.
    let chi = 0;
    for (const c of alphabet) chi += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    assert.ok(chi < 150, `chi-square ${chi.toFixed(1)}`);
});

test('a passphrase has the words, separator, capitals and number asked for', () => {
    const plain = generatePassphrase({ words: 6 }).split('-');
    assert.equal(plain.length, 6);
    for (const w of plain) assert.ok(WORDLIST.includes(w), w);
    const fancy = generatePassphrase({
        words: 4,
        separator: ' ',
        capitalize: true,
        includeNumber: true,
    }).split(' ');
    assert.equal(fancy.length, 5);
    for (const w of fancy.slice(0, 4)) assert.match(w, /^[A-Z][a-z]+$/);
    assert.match(fancy[4], /^[0-9]{2}$/);
    assert.equal(generatePassphrase({ words: 1 }).split('-').length, 2);
    assert.equal(generatePassphrase({ words: 99 }).split('-').length, 12);
});

test("the number's tens digit is uniform", () => {
    const counts = new Array(10).fill(0);
    const n = 20_000;
    for (let i = 0; i < n; i++) {
        const num = generatePassphrase({ words: 2, includeNumber: true }).split('-')[2];
        counts[Number(num[0])]++;
    }
    // Chi-square over the tens digit: the 99.99th percentile with 9 degrees of freedom is about 33.7.
    const chi = counts.reduce((s, c) => s + (c - n / 10) ** 2 / (n / 10), 0);
    assert.ok(chi < 33, `chi-square ${chi.toFixed(1)} over ${counts.join(',')}`);
});

test('entropy is exact for the options', () => {
    assert.equal(passwordEntropyBits({ length: 20 }), 20 * Math.log2(87));
    assert.equal(
        passwordEntropyBits({ length: 10, uppercase: false, symbols: false }),
        10 * Math.log2(36)
    );
    assert.equal(
        passwordEntropyBits({
            length: 10,
            lowercase: false,
            uppercase: false,
            digits: false,
            symbols: false,
        }),
        0
    );
    // Look-alikes out: 87 - 6 = 81 characters.
    assert.equal(passwordEntropyBits({ length: 20, excludeAmbiguous: true }), 20 * Math.log2(81));
    // The length is clamped to 1…256 before it counts.
    assert.equal(passwordEntropyBits({ length: 300 }), 256 * Math.log2(87));
    assert.equal(passwordEntropyBits({ length: 0 }), 1 * Math.log2(87));
    assert.equal(passphraseEntropyBits({ words: 6 }), 6 * Math.log2(WORDLIST.length));
    // The word count is clamped to 2…12 before it counts.
    assert.equal(passphraseEntropyBits({ words: 1 }), 2 * Math.log2(WORDLIST.length));
    assert.equal(passphraseEntropyBits({ words: 99 }), 12 * Math.log2(WORDLIST.length));
    assert.equal(
        passphraseEntropyBits({ words: 6, includeNumber: true }),
        6 * Math.log2(WORDLIST.length) + Math.log2(100)
    );
});
