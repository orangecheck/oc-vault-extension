// node --test: live TOTP codes match RFC 6238's vectors, come from the right field, and only to the popup.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { page, POPUP, startWorker } from './worker-harness.mjs';

register('./ts-alias-loader.mjs', import.meta.url);
const { codeAt, totpSourceOf } = await import('./totp.ts');

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII "12345678901234567890", 8 digits, 30 s steps.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
];

test("RFC 6238's SHA-1 test vectors", () => {
    for (const [t, code] of RFC) {
        const r = codeAt({ secret: RFC_SECRET, digits: 8, period: 30 }, t * 1000);
        assert.equal(r.code, code, `T=${t}`);
        assert.equal(r.remaining, 30 - (t % 30), `remaining at T=${t}`);
    }
    // Six digits are the last six of the same value.
    assert.equal(codeAt({ secret: RFC_SECRET, digits: 6, period: 30 }, 59_000).code, '287082');
    // Lower case, spaces and padding in the secret read the same.
    const loose = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq====';
    assert.equal(codeAt({ secret: loose, digits: 8, period: 30 }, 59_000).code, '94287082');
});

test('a secret that is not base32, or decodes to nothing, makes no code', () => {
    assert.throws(() => codeAt({ secret: 'not base32!', digits: 6, period: 30 }, 0));
    assert.throws(() => codeAt({ secret: '====', digits: 6, period: 30 }, 0), /no TOTP secret/);
});

test("the secret comes from a TOTP entry's secret or a login's totp field", () => {
    assert.deepEqual(totpSourceOf('totp', { secret: RFC_SECRET, digits: 8, period: 60 }), {
        secret: RFC_SECRET,
        digits: 8,
        period: 60,
    });
    // Out-of-range digits and periods fall back to 6 and 30.
    assert.deepEqual(totpSourceOf('totp', { secret: RFC_SECRET, digits: 9, period: 0 }), {
        secret: RFC_SECRET,
        digits: 6,
        period: 30,
    });
    assert.deepEqual(totpSourceOf('totp', { secret: RFC_SECRET, digits: 7, period: 1.5 }), {
        secret: RFC_SECRET,
        digits: 7,
        period: 30,
    });
    assert.deepEqual(totpSourceOf('password', { password: 'x', totp: RFC_SECRET, digits: 8 }), {
        secret: RFC_SECRET,
        digits: 6,
        period: 30,
    });
    assert.equal(totpSourceOf('password', { password: 'x' }), null);
    assert.equal(totpSourceOf('totp', { secret: '   ' }), null);
    assert.equal(totpSourceOf('note', { body: 'x', secret: RFC_SECRET }), null);
});

const GITHUB = {
    name: 'github 2fa',
    type: 'totp',
    fields: { issuer: 'GitHub', account: 'alice', secret: RFC_SECRET, digits: 8, period: 30 },
};
const LOGIN = {
    name: 'example.com',
    fields: { url: 'https://example.com/', username: 'alice', password: 'pw', totp: RFC_SECRET },
};
const PLAIN = {
    name: 'plain',
    fields: { url: 'https://plain.example/', username: 'bob', password: 'pw' },
};
const BAD = { name: 'bad', type: 'totp', fields: { secret: 'NOT-BASE32-1!' } };

/** Ask at a chosen time. */
async function codeFrom(w, entryId, t, sender = POPUP) {
    const real = Date.now;
    Date.now = () => t * 1000;
    try {
        return await w.send({ kind: 'totp-code', entryId }, sender);
    } finally {
        Date.now = real;
    }
}

test('the popup gets the code the worker makes; a page gets nothing', async () => {
    const w = await startWorker([GITHUB, LOGIN, PLAIN, BAD]);
    assert.deepEqual((await codeFrom(w, w.ids[0], 59)).data, {
        code: '94287082',
        digits: 8,
        period: 30,
        remaining: 1,
    });
    assert.equal((await codeFrom(w, w.ids[1], 1111111111)).data.code, '050471');
    assert.deepEqual(await codeFrom(w, w.ids[2], 59), {
        ok: false,
        reason: 'this entry has no TOTP secret',
    });
    const bad = await codeFrom(w, w.ids[3], 59);
    assert.deepEqual(bad, { ok: false, reason: "this entry's TOTP secret is not valid base32" });
    assert.deepEqual(await codeFrom(w, w.ids[0], 59, page('https://github.com/login')), {
        ok: false,
        reason: 'not allowed from a page',
    });
    // Nothing the worker keeps holds a code.
    const kept = JSON.stringify([...w.session.entries(), ...w.local.entries()]);
    for (const code of ['94287082', '050471']) assert.ok(!kept.includes(code), code);
});
