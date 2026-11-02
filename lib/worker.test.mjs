// node --test: the background worker acts on a message only as far as its sender may ask.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escrowOf, EXT, EXT_ID, page, PASSPHRASE, POPUP, startWorker } from './worker-harness.mjs';

const BANK = {
    name: 'bank',
    fields: { url: 'https://bank.example/login', username: 'alice', password: 's3cret' },
};
const SHOP = {
    name: 'shop',
    fields: { url: 'https://shop.example/', username: 'bob', password: 'hunter2' },
};
const EVIL = page('https://evil.example/');
const BANK_PAGE = page('https://bank.example/login');

test('the popup can reveal, list and change settings', async () => {
    const w = await startWorker([BANK]);
    assert.equal((await w.send({ kind: 'reveal-entry', entryId: w.ids[0] }, POPUP)).ok, true);
    assert.equal((await w.send({ kind: 'list-entries' }, POPUP)).data.length, 1);
    const r = await w.send({ kind: 'reveal-field', entryId: w.ids[0], field: 'password' }, POPUP);
    assert.equal(r.data.value, 's3cret');
});

for (const message of [
    (ids) => ({ kind: 'reveal-entry', entryId: ids[0] }),
    (ids) => ({ kind: 'reveal-field', entryId: ids[0], field: 'password' }),
    () => ({ kind: 'list-entries' }),
    () => ({ kind: 'set-settings', settings: { idleLockMinutes: 0 } }),
    () => ({ kind: 'lock' }),
    () => ({ kind: 'unlock', passphrase: 'x' }),
    () => ({ kind: 'sync' }),
]) {
    test(`a page cannot send ${message(['id']).kind}`, async () => {
        const w = await startWorker([BANK]);
        const r = await w.send(message(w.ids), BANK_PAGE);
        assert.deepEqual(r, { ok: false, reason: 'not allowed from a page' });
        // Nothing was revealed, and the vault is still unlocked for the popup.
        assert.equal(r.data, undefined);
        assert.equal((await w.send({ kind: 'get-state' }, POPUP)).data.status, 'unlocked');
    });
}

test('only a URL that starts with the extension base counts as an extension page', async () => {
    const w = await startWorker([BANK]);
    for (const url of [
        `https://evil.example/?u=${EXT}popup.html`,
        `https://evil.example/#${EXT}`,
        `https://${EXT_ID}.evil.example/${EXT}`,
    ]) {
        const r = await w.send({ kind: 'reveal-entry', entryId: w.ids[0] }, page(url));
        assert.deepEqual(r, { ok: false, reason: 'not allowed from a page' }, url);
    }
});

test('a sender that is neither an extension page nor a tab is refused', async () => {
    const w = await startWorker([BANK]);
    for (const sender of [
        { id: 'another-extension', url: 'chrome-extension://another-extension/popup.html' },
        { id: 'another-extension', url: 'https://bank.example/login', tab: { id: 2 } },
        { id: EXT_ID, url: 'https://bank.example/' },
        { id: EXT_ID, url: 'about:blank', tab: { id: 1 } },
        { id: EXT_ID },
    ]) {
        assert.equal(
            (await w.send({ kind: 'get-state' }, sender)).ok,
            false,
            JSON.stringify(sender)
        );
    }
});

test("match-page answers for the sender's page, not the URL the message names", async () => {
    const w = await startWorker([BANK, SHOP]);
    const r = await w.send({ kind: 'match-page', pageUrl: 'https://bank.example/login' }, EVIL);
    assert.deepEqual(r.data, []);
    const own = await w.send({ kind: 'match-page', pageUrl: 'https://evil.example/' }, BANK_PAGE);
    assert.deepEqual(
        own.data.map((s) => s.name),
        ['bank']
    );
});

test("fill-values is refused unless the entry is for the sender's page", async () => {
    const w = await startWorker([BANK]);
    const refused = await w.send(
        { kind: 'fill-values', entryId: w.ids[0], fields: ['password'] },
        EVIL
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.data, undefined);
    const filled = await w.send(
        { kind: 'fill-values', entryId: w.ids[0], fields: ['password'] },
        BANK_PAGE
    );
    assert.deepEqual(filled.data, { values: { password: 's3cret' } });
});

test('fill-values comes only from a page', async () => {
    const w = await startWorker([BANK]);
    assert.equal(
        (await w.send({ kind: 'fill-values', entryId: w.ids[0], fields: ['password'] }, POPUP)).ok,
        false
    );
});

test("capture-login records the sender's site, not the URL the message names", async () => {
    const w = await startWorker([BANK]);
    const r = await w.send(
        {
            kind: 'capture-login',
            url: 'https://bank.example/login',
            username: 'alice',
            password: 'new-one',
        },
        EVIL
    );
    assert.equal(r.data.host, 'evil.example');
    const pending = await w.send({ kind: 'get-pending-capture' }, POPUP);
    assert.equal(pending.data.pending.host, 'evil.example');
});

test('a page sees and acts on a pending capture only for its own site', async () => {
    const w = await startWorker([BANK]);
    await w.send({ kind: 'capture-login', url: '', username: 'carol', password: 'pw' }, BANK_PAGE);
    // No pageUrl in the message: the sender's page is used anyway.
    assert.equal((await w.send({ kind: 'get-pending-capture' }, EVIL)).data.pending, null);
    assert.equal((await w.send({ kind: 'commit-capture' }, EVIL)).ok, false);
    assert.equal((await w.send({ kind: 'dismiss-capture' }, EVIL)).ok, false);
    assert.equal(w.puts.length, 0);
    assert.equal(
        (await w.send({ kind: 'get-pending-capture' }, BANK_PAGE)).data.pending.username,
        'carol'
    );
    assert.equal((await w.send({ kind: 'commit-capture' }, BANK_PAGE)).data.saved, true);
    assert.equal(w.puts.length, 1);
});

test('a page reads the lock state and nothing else about the account', async () => {
    const w = await startWorker([BANK]);
    const r = await w.send({ kind: 'get-state' }, EVIL);
    assert.deepEqual(r.data, {
        status: 'unlocked',
        entryCount: 0,
        lastSyncAt: null,
        identity: null,
    });
    const popup = await w.send({ kind: 'get-state' }, POPUP);
    assert.equal(popup.data.identity, 'did:oc:harness');
    assert.equal(popup.data.entryCount, 1);
});

test('a setting saved while the first settings read is in flight is the one that counts', async () => {
    const w = await startWorker([BANK]);
    const realGet = globalThis.browser.storage.local.get;
    let release;
    const gate = new Promise((r) => (release = r));
    let reading;
    const read = new Promise((r) => (reading = r));
    // The first read of the settings takes its snapshot, then is held until the save has landed.
    globalThis.browser.storage.local.get = async (k) => {
        const snapshot = await realGet(k);
        if (k === 'oc-settings') {
            reading();
            await gate;
        }
        return snapshot;
    };
    const first = w.send({ kind: 'get-settings' }, POPUP);
    await read;
    const saved = await w.send(
        {
            kind: 'set-settings',
            settings: { ...(await import('./settings.ts')).DEFAULT_SETTINGS, idleLockMinutes: 5 },
        },
        POPUP
    );
    assert.equal(saved.data.idleLockMinutes, 5);
    release();
    await first;
    globalThis.browser.storage.local.get = realGet;
    assert.equal((await w.send({ kind: 'get-settings' }, POPUP)).data.idleLockMinutes, 5);
});

test('a fill carries only a username and password; asking for the TOTP seed is refused', async () => {
    const w = await startWorker([
        { ...BANK, fields: { ...BANK.fields, totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } },
    ]);
    const ok = await w.send(
        { kind: 'fill-values', entryId: w.ids[0], fields: ['username', 'password'] },
        BANK_PAGE
    );
    assert.deepEqual(ok.data, { values: { username: 'alice', password: 's3cret' } });
    for (const fields of [['totp'], ['password', 'totp'], ['url'], 'password']) {
        const r = await w.send({ kind: 'fill-values', entryId: w.ids[0], fields }, BANK_PAGE);
        assert.deepEqual(
            r,
            { ok: false, reason: 'only a username and password fill a page' },
            JSON.stringify(fields)
        );
    }
});

/* ── an update never writes over another device's delete (oc-vault-web PUT ?if_rev) ── */

/** Another device's write to the bank entry: what the server holds from now on. */
function writtenElsewhere(w, change) {
    const blob = w.blobs[0];
    const entry = w.crypto.unpackEntryFromCloud(blob.ciphertext, w.key);
    const at = new Date(Date.now() + 60_000).toISOString();
    w.blobs[0] = {
        envelope_id: blob.envelope_id,
        updated_at: at,
        ciphertext: w.crypto.packEntryForCloud({ ...change(entry, at), updated_at: at }, w.key),
    };
}
const purged = (e, at) => ({
    ...e,
    name: '',
    nonce: '',
    ciphertext: '',
    deleted_at: at,
    purged_at: at,
});
const held = (w, id) => {
    const b = w.blobs.find((x) => x.envelope_id === id);
    return b && w.crypto.unpackEntryFromCloud(b.ciphertext, w.key);
};

/**
 * Capture a new password for the bank login and save it from the bank page.
 * `elsewhere` runs between the two, after the worker has synced: another
 * device's write the extension has not seen.
 */
async function updateBankPassword(w, elsewhere = () => {}) {
    await w.send({ kind: 'sync' }, POPUP);
    const c = await w.send(
        { kind: 'capture-login', url: '', username: 'alice', password: 'n3w-pass' },
        BANK_PAGE
    );
    assert.equal(c.data.decision, 'update');
    elsewhere();
    return w.send({ kind: 'commit-capture' }, BANK_PAGE);
}

test('an update is sent over the revision the extension read', async () => {
    const w = await startWorker([BANK]);
    const read = w.blobs[0].updated_at;
    const r = await updateBankPassword(w);
    assert.deepEqual(r.data, { saved: true });
    assert.deepEqual(w.puts, [`/api/blobs/${w.ids[0]}?if_rev=${encodeURIComponent(read)}`]);
    assert.equal(w.crypto.decryptFields(held(w, w.ids[0]), w.key).password, 'n3w-pass');
});

for (const [what, change] of [
    ['purged', purged],
    ['moved to Trash', (e, at) => ({ ...e, deleted_at: at })],
]) {
    test(`an update to a login ${what} on another device never brings it back; the change is saved as a new entry`, async () => {
        const w = await startWorker([BANK]);
        const r = await updateBankPassword(w, () => writtenElsewhere(w, change));

        // The deleted entry stays deleted on the server.
        const there = held(w, w.ids[0]);
        assert.ok(there.deleted_at, 'still deleted');
        // The edit is not lost: it is a new entry, and the person is told.
        const fresh = w.blobs.filter((b) => b.envelope_id !== w.ids[0]);
        assert.equal(fresh.length, 1);
        const copy = w.crypto.unpackEntryFromCloud(fresh[0].ciphertext, w.key);
        assert.equal(copy.name, 'bank');
        assert.equal(w.crypto.decryptFields(copy, w.key).password, 'n3w-pass');
        assert.match(r.data.notice, /deleted on another device/);
    });
}

test('an update to a login whose row is gone is saved as a new entry, never under the old id', async () => {
    const w = await startWorker([BANK]);
    const r = await updateBankPassword(w, () => w.blobs.splice(0, 1));
    assert.equal(held(w, w.ids[0]), undefined);
    assert.equal(w.blobs.length, 1);
    assert.equal(
        w.crypto.decryptFields(held(w, w.blobs[0].envelope_id), w.key).password,
        'n3w-pass'
    );
    assert.match(r.data.notice, /deleted on another device/);
});

const randomKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** A worker unlocked with the passphrase, so it knows which escrowed wrap its key came from. */
async function unlockedByPassphrase() {
    const w = await startWorker([BANK], { escrow: (key) => escrowOf(key) });
    await w.send({ kind: 'lock' }, POPUP);
    const r = await w.send({ kind: 'unlock', passphrase: PASSPHRASE }, POPUP);
    assert.equal(r.data?.status, 'unlocked', JSON.stringify(r));
    return w;
}

/** Another device rewrites the bank login under `otherKey`; returns what the server now holds. */
function sealedElsewhere(w, otherKey) {
    const at = new Date(Date.now() + 60_000).toISOString();
    const entry = w.crypto.unpackEntryFromCloud(w.blobs[0].ciphertext, w.key);
    const fields = w.crypto.encryptFields(w.crypto.decryptFields(entry, w.key), otherKey);
    const ciphertext = w.crypto.packEntryForCloud(
        { ...entry, ...fields, updated_at: at },
        otherKey
    );
    w.blobs[0] = { envelope_id: w.ids[0], updated_at: at, ciphertext };
    return ciphertext;
}

test('an update to a login rewritten under a key this extension does not hold keeps both, and says why', async () => {
    const w = await unlockedByPassphrase();
    let unreadable;
    // The vault's escrow is unchanged, so this extension's key is still the vault key.
    const r = await updateBankPassword(w, () => (unreadable = sealedElsewhere(w, randomKey())));

    // The copy this extension cannot read is left as it is.
    assert.equal(w.blobs.find((b) => b.envelope_id === w.ids[0]).ciphertext, unreadable);
    // The change is saved beside it, and the person is told why, not that it was deleted.
    const fresh = w.blobs.filter((b) => b.envelope_id !== w.ids[0]);
    assert.equal(fresh.length, 1);
    const copy = w.crypto.unpackEntryFromCloud(fresh[0].ciphertext, w.key);
    assert.equal(copy.name, 'bank (conflict copy)');
    assert.equal(w.crypto.decryptFields(copy, w.key).password, 'n3w-pass');
    assert.equal(r.data.saved, true);
    assert.match(r.data.notice, /cannot read/);
    assert.doesNotMatch(r.data.notice, /deleted/);
    // The popup lists the saved copy, not the old version it can no longer read.
    const listed = (await w.send({ kind: 'list-entries' }, POPUP)).data.map((e) => e.name);
    assert.deepEqual(listed, ['bank (conflict copy)']);
});

test('after the vault key changed elsewhere, nothing is sealed under the old one: the extension locks and keeps the change for the next unlock', async () => {
    const w = await unlockedByPassphrase();
    const otherKey = randomKey();
    let unreadable;
    const r = await updateBankPassword(w, () => {
        unreadable = sealedElsewhere(w, otherKey);
        w.api.escrow = escrowOf(otherKey);
    });

    assert.equal(r.ok, false);
    assert.match(r.reason, /locked without saving/);
    assert.deepEqual(
        w.blobs.map((b) => b.ciphertext),
        [unreadable]
    );
    assert.equal((await w.send({ kind: 'get-state' }, POPUP)).data.status, 'locked');

    // Unlocked again, now with the new key, the kept change goes on top of the version made there.
    const u = await w.send({ kind: 'unlock', passphrase: PASSPHRASE }, POPUP);
    assert.equal(u.data?.status, 'unlocked', JSON.stringify(u));
    await w.send({ kind: 'sync' }, POPUP);
    const again = await w.send({ kind: 'commit-capture' }, BANK_PAGE);
    assert.deepEqual(again.data, { saved: true });
    assert.equal(w.blobs.length, 1);
    const there = w.crypto.unpackEntryFromCloud(w.blobs[0].ciphertext, otherKey);
    assert.equal(w.crypto.decryptFields(there, otherKey).password, 'n3w-pass');
});

for (const [what, opts] of [
    // Restored from a session that did not note its escrow: whose key is current is unknown.
    ['with no record of the escrow it came from', { escrow: (key) => escrowOf(key) }],
    ['when the vault serves no escrow', {}],
]) {
    test(`a key ${what} never saves beside an unreadable copy`, async () => {
        const w = await startWorker([BANK], opts);
        const r = await updateBankPassword(w, () => sealedElsewhere(w, randomKey()));
        assert.equal(r.ok, false);
        assert.match(r.reason, /locked without saving/);
        assert.equal(w.blobs.length, 1);
        assert.notEqual((await w.send({ kind: 'get-state' }, POPUP)).data.status, 'unlocked');
    });
}

test('an update to a login edited on another device is put on top of that edit', async () => {
    const w = await startWorker([BANK]);
    const r = await updateBankPassword(w, () =>
        writtenElsewhere(w, (e) => ({ ...e, name: 'bank (renamed there)' }))
    );
    assert.deepEqual(r.data, { saved: true });
    const there = held(w, w.ids[0]);
    assert.equal(there.name, 'bank (renamed there)');
    assert.equal(w.crypto.decryptFields(there, w.key).password, 'n3w-pass');
    assert.equal(w.blobs.length, 1);
});
