/**
 * The password generator — a random password or a diceware-style passphrase,
 * with the same options and character sets as vault.ochk.io's generator
 * (oc-vault-web src/lib/password-gen.ts and passphrase.ts).
 *
 * Every draw is uniform: 32-bit values from `crypto.getRandomValues` (through
 * lock-crypto's `randomBytesN`), with rejection sampling so a set whose size
 * does not divide 2^32 has no modulo bias. That makes the entropy figures below
 * exact rather than estimates. Nothing here is stored or sent anywhere.
 */

import { randomBytesN } from '@orangecheck/lock-crypto';

import { WORDLIST } from './wordlist';

export interface PasswordOptions {
    /** Clamped to 1…256. */
    length: number;
    lowercase?: boolean;
    uppercase?: boolean;
    digits?: boolean;
    symbols?: boolean;
    /** Drop the look-alikes 0/O/o and 1/l/I, for a password read off a screen. */
    excludeAmbiguous?: boolean;
}

export interface PassphraseOptions {
    /** Clamped to 2…12. */
    words: number;
    /** Joins the words. Default '-'. */
    separator?: string;
    /** Capitalize each word's first letter. */
    capitalize?: boolean;
    /** Append two digits, for sites that demand a number. */
    includeNumber?: boolean;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?';
const AMBIGUOUS = new Set(['0', 'O', 'o', '1', 'l', 'I']);

/** `count` uniform picks from [0, size), with no modulo bias. */
function uniform(count: number, size: number): number[] {
    const max = Math.floor(0x1_0000_0000 / size) * size;
    const out: number[] = [];
    while (out.length < count) {
        const bytes = randomBytesN(4 * (count - out.length));
        for (let i = 0; i + 4 <= bytes.length && out.length < count; i += 4) {
            const u =
                ((bytes[i]! << 24) |
                    (bytes[i + 1]! << 16) |
                    (bytes[i + 2]! << 8) |
                    bytes[i + 3]!) >>>
                0;
            if (u < max) out.push(u % size);
        }
    }
    return out;
}

/** The characters a password with these options is drawn from. */
export function passwordAlphabet(opts: PasswordOptions): string {
    let alphabet = '';
    if (opts.lowercase ?? true) alphabet += LOWER;
    if (opts.uppercase ?? true) alphabet += UPPER;
    if (opts.digits ?? true) alphabet += DIGITS;
    if (opts.symbols ?? true) alphabet += SYMBOLS;
    if (opts.excludeAmbiguous) alphabet = [...alphabet].filter((c) => !AMBIGUOUS.has(c)).join('');
    return alphabet;
}

function clampLength(n: number): number {
    return Math.max(1, Math.min(256, Math.floor(n) || 1));
}

function clampWords(n: number): number {
    return Math.max(2, Math.min(12, Math.floor(n) || 2));
}

export function generatePassword(opts: PasswordOptions): string {
    const alphabet = passwordAlphabet(opts);
    if (alphabet.length === 0) throw new Error('turn on at least one kind of character');
    return uniform(clampLength(opts.length), alphabet.length)
        .map((i) => alphabet[i]!)
        .join('');
}

export function generatePassphrase(opts: PassphraseOptions): string {
    const sep = opts.separator ?? '-';
    const words = uniform(clampWords(opts.words), WORDLIST.length).map((i) => {
        const w = WORDLIST[i]!;
        return opts.capitalize ? w[0]!.toUpperCase() + w.slice(1) : w;
    });
    if (opts.includeNumber) words.push(String(uniform(1, 100)[0]!).padStart(2, '0'));
    return words.join(sep);
}

/** Exact entropy in bits of a password made with these options. */
export function passwordEntropyBits(opts: PasswordOptions): number {
    const size = passwordAlphabet(opts).length;
    return size === 0 ? 0 : clampLength(opts.length) * Math.log2(size);
}

/** Exact entropy in bits of a passphrase made with these options. */
export function passphraseEntropyBits(opts: PassphraseOptions): number {
    return (
        clampWords(opts.words) * Math.log2(WORDLIST.length) +
        (opts.includeNumber ? Math.log2(100) : 0)
    );
}
