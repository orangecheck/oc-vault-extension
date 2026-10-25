// node --test: the worker drops the key when a request finds the person signed out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lockOnSignOut } from './lock-on-sign-out.ts';

class NotSignedIn extends Error {}
const isSignedOut = (err) => err instanceof NotSignedIn;

test('a 401 drops the key and answers signed out', async () => {
    let locked = 0;
    const out = await lockOnSignOut(
        async () => {
            throw new NotSignedIn();
        },
        isSignedOut,
        () => {
            locked++;
            return 'signed-out';
        }
    );
    assert.equal(out, 'signed-out');
    assert.equal(locked, 1);
});

test('any other failure is passed on, and the key stays', async () => {
    let locked = 0;
    await assert.rejects(
        lockOnSignOut(
            async () => {
                throw new TypeError('Failed to fetch');
            },
            isSignedOut,
            () => locked++
        ),
        TypeError
    );
    assert.equal(locked, 0);
});

test('a request that succeeds answers as it did', async () => {
    assert.equal(
        await lockOnSignOut(
            async () => 'unlocked',
            isSignedOut,
            () => 'signed-out'
        ),
        'unlocked'
    );
});

test('the worker answers every request, and its restore sync, through it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    assert.match(
        src,
        /const message = admit\(raw, caller\);\s*return lockOnSignOut\(\s*\(\) => handle\(message, caller!\)/
    );
    assert.match(src, /lockOnSignOut\(sync, isSignedOut, lock\)/);
});
