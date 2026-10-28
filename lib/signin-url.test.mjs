// node --test: the popup's sign-in link comes back to the vault, not to a page ochk.io lacks.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIGNIN_URL } from './signin-url.ts';

test('sign-in returns to the vault dashboard on vault.ochk.io', () => {
    const url = new URL(SIGNIN_URL);
    assert.equal(url.origin + url.pathname, 'https://ochk.io/signin');
    assert.equal(url.searchParams.get('return_to'), 'https://vault.ochk.io/vault');
});
