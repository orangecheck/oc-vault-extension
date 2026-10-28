// node --test: passkey unlock wraps the vault key under the PRF secret, gives it back only
// for that secret, that identity and that escrow, and is reachable only from extension pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { page, POPUP, startWorker } from './worker-harness.mjs';

const { aesGcmEncrypt, b64urlEncode } = await import('@orangecheck/lock-crypto');
const { scrypt } = await import('@noble/hashes/scrypt');
const { escrowFingerprint, unwrapUnderPrf, useSecret, wrapUnderPrf } = await import('./passkey.ts');

const BANK = {
    name: 'bank',
    fields: { url: 'https://bank.example/login', username: 'alice', password: 's3cret' },
};
const PASSPHRASE = 'correct horse battery staple';
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** The vault key wrapped under a passphrase, as vault.ochk.io escrows it (N at the floor, for speed). */
function escrowOf(key, passphrase = PASSPHRASE) {
    const salt = rand(16);
    const nonce = rand(12);
    const wrapKey = scrypt(new TextEncoder().encode(passphrase), salt, {
        N: 1 << 14,
        r: 8,
        p: 1,
        dkLen: 32,
    });
    return {
        wrapped_key: b64urlEncode(aesGcmEncrypt(wrapKey, nonce, key)),
        wrap_nonce: b64urlEncode(nonce),
        kdf: 'scrypt',
        kdf_salt: b64urlEncode(salt),
        kdf_n: 1 << 14,
        kdf_r: 8,
        kdf_p: 1,
    };
}

const ask = async (w, message, sender = POPUP) => w.send(message, sender);

/** A worker unlocked with the passphrase, so the key's escrow is known. */
async function unlockedByPassphrase(opts = {}) {
    const w = await startWorker([BANK], { escrow: (key) => escrowOf(key), ...opts });
    await ask(w, { kind: 'lock' });
    const r = await ask(w, { kind: 'unlock', passphrase: PASSPHRASE });
    assert.equal(r.data?.status, 'unlocked', JSON.stringify(r));
    return w;
}

async function enroll(w, secret = rand(32)) {
    const r = await ask(w, {
        kind: 'passkey-enroll',
        credentialId: b64urlEncode(rand(16)),
        prfSalt: b64urlEncode(rand(32)),
        prfSecret: b64urlEncode(secret),
    });
    assert.deepEqual(r, { ok: true, data: { enrolled: true } });
    return secret;
}

test('the wrap opens only with its own PRF secret', () => {
    const key = rand(32);
    const secret = rand(32);
    const w = wrapUnderPrf(key, secret);
    assert.deepEqual(unwrapUnderPrf(w, secret), key);
    assert.equal(unwrapUnderPrf(w, rand(32)), null);
    const tampered = {
        ...w,
        wrapped_key: w.wrapped_key.slice(0, -2) + (w.wrapped_key.endsWith('A') ? 'BA' : 'AA'),
    };
    assert.equal(unwrapUnderPrf(tampered, secret), null);
    // A wrap of something that is not a 32-byte key is no key.
    assert.equal(unwrapUnderPrf(wrapUnderPrf(rand(16), secret), secret), null);
});

test('a secret lent to useSecret is zeroed after use, and after a throw', () => {
    const secret = rand(32);
    let lent;
    const out = useSecret(b64urlEncode(secret), 'passkey secret', (bytes) => {
        lent = bytes;
        assert.deepEqual(bytes, secret, 'the bytes lent are the secret');
        return 'done';
    });
    assert.equal(out, 'done');
    assert.deepEqual(lent, new Uint8Array(32), 'zeroed once used');
    let thrown;
    assert.throws(
        () =>
            useSecret(b64urlEncode(rand(32)), 'passkey secret', (bytes) => {
                thrown = bytes;
                throw new Error('unwrap failed');
            }),
        /unwrap failed/
    );
    assert.deepEqual(thrown, new Uint8Array(32), 'zeroed after a throw');
    let called = false;
    assert.throws(
        () => useSecret('short', 'passkey secret', () => (called = true)),
        /malformed passkey secret/
    );
    assert.equal(called, false);
});

test('the escrow fingerprint changes when the escrowed wrap does', () => {
    const key = rand(32);
    const a = escrowOf(key);
    assert.equal(escrowFingerprint(a), escrowFingerprint({ ...a }));
    assert.notEqual(escrowFingerprint(a), escrowFingerprint(escrowOf(key)));
    assert.notEqual(
        escrowFingerprint(a),
        escrowFingerprint({ ...a, kdf_salt: b64urlEncode(rand(16)) })
    );
});

for (const message of [
    { kind: 'passkey-status' },
    { kind: 'passkey-enroll', credentialId: 'x', prfSalt: 'x', prfSecret: 'x' },
    { kind: 'passkey-unlock', prfSecret: 'x' },
    { kind: 'passkey-forget' },
]) {
    test(`a page cannot send ${message.kind}`, async () => {
        const w = await startWorker([BANK], { escrow: (key) => escrowOf(key) });
        assert.deepEqual(await ask(w, message, page('https://bank.example/login')), {
            ok: false,
            reason: 'not allowed from a page',
        });
    });
}

test('set up, lock, unlock with the passkey: the vault opens and decrypts', async () => {
    const w = await unlockedByPassphrase();
    const secret = await enroll(w);
    // What storage.local keeps holds no copy of the vault key.
    const kept = JSON.stringify([...w.local.entries()]);
    assert.ok(!kept.includes(b64urlEncode(w.key)), 'the vault key is not stored in the clear');
    assert.ok(w.local.has('oc-passkey-unlock'));
    const status = await ask(w, { kind: 'passkey-status' });
    assert.equal(status.data.enrolled, true);
    assert.ok(status.data.target.credentialId && status.data.target.prfSalt);
    assert.equal(
        Object.keys(status.data.target).length,
        2,
        'status names the passkey, nothing more'
    );

    await ask(w, { kind: 'lock' });
    const r = await ask(w, { kind: 'passkey-unlock', prfSecret: b64urlEncode(secret) });
    assert.equal(r.data?.status, 'unlocked', JSON.stringify(r));
    const field = await ask(w, { kind: 'reveal-field', entryId: w.ids[0], field: 'password' });
    assert.equal(field.data.value, 's3cret');
    assert.equal(
        w.session.get('oc-session-key'),
        b64urlEncode(w.key),
        'mirrored like a passphrase unlock'
    );
});

test('a wrong secret leaves the vault locked', async () => {
    const w = await unlockedByPassphrase();
    await enroll(w);
    await ask(w, { kind: 'lock' });
    const r = await ask(w, { kind: 'passkey-unlock', prfSecret: b64urlEncode(rand(32)) });
    assert.deepEqual(r, {
        ok: false,
        reason: "That passkey didn't unlock this vault. Use your passphrase.",
    });
    assert.equal((await ask(w, { kind: 'get-state' })).data.status, 'locked');
    assert.equal(w.session.get('oc-session-key'), undefined);
    for (const bad of ['', 'not-base64!', b64urlEncode(rand(31))]) {
        const m = await ask(w, { kind: 'passkey-unlock', prfSecret: bad });
        assert.deepEqual(m, { ok: false, reason: 'malformed passkey secret' });
    }
});

test('a changed escrow refuses the passkey and removes it', async () => {
    const w = await unlockedByPassphrase();
    const secret = await enroll(w);
    await ask(w, { kind: 'lock' });
    // A new passphrase: the same key, wrapped again.
    w.api.escrow = escrowOf(w.key, 'a new passphrase');
    const r = await ask(w, { kind: 'passkey-unlock', prfSecret: b64urlEncode(secret) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /changed since this passkey was set up/);
    assert.equal((await ask(w, { kind: 'get-state' })).data.status, 'locked');
    assert.equal((await ask(w, { kind: 'passkey-status' })).data.enrolled, false);
});

test("another identity's passkey is neither offered nor used", async () => {
    const first = await unlockedByPassphrase();
    const secret = await enroll(first);
    const stored = first.local.get('oc-passkey-unlock');
    const other = await startWorker([BANK], {
        escrow: (key) => escrowOf(key),
        identity: 'did:oc:someone-else',
        local: { 'oc-passkey-unlock': stored },
    });
    await ask(other, { kind: 'lock' });
    assert.equal((await ask(other, { kind: 'passkey-status' })).data.enrolled, false);
    const r = await ask(other, { kind: 'passkey-unlock', prfSecret: b64urlEncode(secret) });
    assert.deepEqual(r, {
        ok: false,
        reason: 'no passkey is set up for this vault in this browser',
    });
});

test('setting up needs an unlocked key whose escrow is known', async () => {
    // Restored from storage.session with no escrow on record (an older session).
    const restored = await startWorker([BANK], { escrow: (key) => escrowOf(key) });
    const r = await ask(restored, {
        kind: 'passkey-enroll',
        credentialId: 'abc',
        prfSalt: b64urlEncode(rand(32)),
        prfSecret: b64urlEncode(rand(32)),
    });
    assert.deepEqual(r, {
        ok: false,
        reason: 'lock, then unlock with your passphrase once, first',
    });
    await ask(restored, { kind: 'lock' });
    const locked = await ask(restored, {
        kind: 'passkey-enroll',
        credentialId: 'abc',
        prfSalt: b64urlEncode(rand(32)),
        prfSecret: b64urlEncode(rand(32)),
    });
    assert.deepEqual(locked, { ok: false, reason: 'unlock the vault before setting up a passkey' });
});

test('remove takes the passkey away', async () => {
    const w = await unlockedByPassphrase();
    const secret = await enroll(w);
    assert.deepEqual((await ask(w, { kind: 'passkey-forget' })).data, { enrolled: false });
    await ask(w, { kind: 'lock' });
    const r = await ask(w, { kind: 'passkey-unlock', prfSecret: b64urlEncode(secret) });
    assert.equal(r.ok, false);
});

test('an unlocked vault keeps its key; passkey-unlock then changes nothing', async () => {
    const w = await unlockedByPassphrase();
    await enroll(w);
    const r = await ask(w, { kind: 'passkey-unlock', prfSecret: b64urlEncode(rand(32)) });
    assert.equal(r.data?.status, 'unlocked');
    assert.equal(w.session.get('oc-session-key'), b64urlEncode(w.key));
});
