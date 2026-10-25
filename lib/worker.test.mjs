// node --test: the background worker acts on a message only as far as its sender may ask.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXT_ID, page, POPUP, startWorker } from './worker-harness.mjs';

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
