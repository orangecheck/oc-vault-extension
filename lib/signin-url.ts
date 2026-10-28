/**
 * Where the popup sends someone to sign in. ochk.io's /signin takes an
 * absolute https *.ochk.io return_to (auth-client familyReturnTarget); a bare
 * "/vault" would land on ochk.io/vault, which does not exist.
 */
export const VAULT_DASHBOARD = 'https://vault.ochk.io/vault';

export const SIGNIN_URL = `https://ochk.io/signin?return_to=${encodeURIComponent(VAULT_DASHBOARD)}`;
