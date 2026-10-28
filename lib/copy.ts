/**
 * What the entry list's copy button asks the worker for. Pure, so it is tested
 * without a popup: a TOTP entry copies its current code, never its secret.
 */

import type { VaultEntryType } from './crypto';

/** The decrypted field each entry type copies from the list — its "primary" value. */
export const PRIMARY_FIELD: Record<Exclude<VaultEntryType, 'totp'>, string> = {
    password: 'password',
    note: 'body',
    'seed-phrase': 'phrase',
    'api-key': 'key',
    kv: 'value',
    card: 'number',
    identity: 'email',
    file: 'filename',
};

export type CopyRequest = { kind: 'totp-code' } | { kind: 'reveal-field'; field: string };

export function copyRequest(type: VaultEntryType): CopyRequest {
    return type === 'totp'
        ? { kind: 'totp-code' }
        : { kind: 'reveal-field', field: PRIMARY_FIELD[type] };
}
