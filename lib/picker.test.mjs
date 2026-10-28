// node --test: the autofill menu's decision, from the worker's answers, for an auto-open and a click.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./ts-alias-loader.mjs', import.meta.url);
const { afterMatches, afterState, onFailure, PICKER_TEXT } = await import('./picker.ts');

// What a page gets from get-state: the lock state, entryCount always 0 (lib/sender.ts).
const pageState = (status) => ({ status, entryCount: 0, lastSyncAt: null, identity: null });
const LOGIN = {
    id: 'e1',
    name: 'example.com',
    type: 'password',
    url: 'https://example.com/',
    favorite: false,
};

test('locked: an auto-open closes quietly, a click says it is locked', () => {
    assert.deepEqual(afterState(pageState('locked'), true), { kind: 'close' });
    assert.deepEqual(afterState(pageState('locked'), false), {
        kind: 'message',
        text: PICKER_TEXT.locked,
    });
});

test('signed out: an auto-open closes quietly, a click says to sign in', () => {
    assert.deepEqual(afterState(pageState('signed-out'), true), { kind: 'close' });
    assert.deepEqual(afterState(pageState('signed-out'), false), {
        kind: 'message',
        text: PICKER_TEXT.signedOut,
    });
});

test("unlocked: the page's logins are asked for, though a page's entry count is always 0", () => {
    assert.equal(afterState(pageState('unlocked'), true), 'ask');
    assert.equal(afterState(pageState('unlocked'), false), 'ask');
});

test('matches are listed; an auto-open whose field lost focus closes instead', () => {
    assert.deepEqual(afterMatches([LOGIN], true, true), { kind: 'list', matches: [LOGIN] });
    assert.deepEqual(afterMatches([LOGIN], false, false), { kind: 'list', matches: [LOGIN] });
    assert.deepEqual(afterMatches([LOGIN], true, false), { kind: 'close' });
});

test('no matches: an auto-open closes quietly, a click says there are none', () => {
    assert.deepEqual(afterMatches([], true, true), { kind: 'close' });
    assert.deepEqual(afterMatches([], false, true), {
        kind: 'message',
        text: 'No saved logins for this site.',
    });
});

test('no answer from the worker: an auto-open closes quietly, a click says so', () => {
    assert.deepEqual(onFailure(true), { kind: 'close' });
    assert.deepEqual(onFailure(false), { kind: 'message', text: 'Could not reach the vault.' });
});
