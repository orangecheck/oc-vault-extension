/**
 * Live TOTP codes (RFC 6238), made in the worker from the secret an entry holds.
 *
 * The code itself comes from @orangecheck/vault-core's `totp()` (HMAC-SHA1, as
 * vault.ochk.io and every common authenticator use), so the extension and the
 * web app make the same code from the same entry. This module picks the secret
 * out of an entry, as the web app's detail view does, and states the period
 * the code is good for. Neither the secret nor a code is stored or logged.
 */

import { base32Decode, totp } from '@orangecheck/vault-core';

import type { VaultEntryFields, VaultEntryType } from './crypto';

/** Where an entry keeps its TOTP secret, and the code's shape. */
export interface TotpSource {
    secret: string;
    digits: number;
    period: number;
}

/** A code, and how long it has left. */
export interface TotpNow {
    code: string;
    digits: number;
    period: number;
    /** Whole seconds until the next code: 1…period. */
    remaining: number;
}

const DIGITS = new Set([6, 7, 8]);

/**
 * The TOTP an entry holds, or null. A `totp` entry keeps it in `secret` with its
 * own digits and period; a login may carry one in `totp`, at the defaults.
 * Digits outside 6–8 and a period that is not a whole number of seconds from 1
 * to 300 fall back to 6 and 30, as vault.ochk.io's view does.
 */
export function totpSourceOf(type: VaultEntryType, fields: VaultEntryFields): TotpSource | null {
    const f = fields as Record<string, unknown>;
    if (type === 'password') {
        return typeof f.totp === 'string' && f.totp.trim()
            ? { secret: f.totp, digits: 6, period: 30 }
            : null;
    }
    if (type !== 'totp' || typeof f.secret !== 'string' || !f.secret.trim()) return null;
    const digits = typeof f.digits === 'number' && DIGITS.has(f.digits) ? f.digits : 6;
    const period =
        typeof f.period === 'number' &&
        Number.isInteger(f.period) &&
        f.period >= 1 &&
        f.period <= 300
            ? f.period
            : 30;
    return { secret: f.secret, digits, period };
}

/**
 * The fields an entry's detail view leaves out, sent only on an explicit show or
 * copy: a TOTP entry's secret and a login's TOTP seed. The code box needs neither.
 */
export function withheldFields(type: VaultEntryType): string[] {
    return type === 'totp' ? ['secret'] : type === 'password' ? ['totp'] : [];
}

/** The code for `src` at `nowMs`. Throws when the secret is not base32 or is empty. */
export function codeAt(src: TotpSource, nowMs: number): TotpNow {
    if (base32Decode(src.secret).length === 0) throw new Error('this entry has no TOTP secret');
    const code = totp(src.secret, { digits: src.digits, period: src.period, now: nowMs });
    const remaining = src.period - (Math.floor(nowMs / 1000) % src.period);
    return { code, digits: src.digits, period: src.period, remaining };
}
