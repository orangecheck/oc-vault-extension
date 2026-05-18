/**
 * The vault.ochk.io API client.
 *
 * Auth is the `oc_session` cookie — the user signs in once at ochk.io in a
 * normal tab and every request here carries the cookie (`credentials:
 * 'include'`, host permission granted). The extension stores no token and
 * reads no cookie itself. A 401 means "not signed in" → `NotSignedIn`.
 *
 * Every endpoint returns ciphertext only; decryption is `lib/crypto.ts`.
 */

import type { WrappedKey } from './crypto';

const API_ORIGIN = 'https://vault.ochk.io';

/** Thrown on a 401 — the user has no live `oc_session`. */
export class NotSignedIn extends Error {
    constructor() {
        super('not signed in');
        this.name = 'NotSignedIn';
    }
}

/** Thrown when cloud sync is not paid for on this identity (HTTP 402). */
export class SyncNotPaid extends Error {
    constructor() {
        super('cloud sync is not enabled for this account');
        this.name = 'SyncNotPaid';
    }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${API_ORIGIN}${path}`, {
            credentials: 'include',
            headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
            ...init,
        });
    } catch (err) {
        throw new Error(`network error reaching vault.ochk.io: ${String(err)}`);
    }
    if (res.status === 401) throw new NotSignedIn();
    if (res.status === 402) throw new SyncNotPaid();
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string } & T;
    if (!res.ok || json.ok === false) {
        throw new Error(json.reason ?? `request failed · ${res.status}`);
    }
    return json;
}

/**
 * Fetch the escrowed, passphrase-wrapped vault key for the signed-in
 * identity. Returns null when this identity has never set up a vault.
 */
export async function fetchEscrow(): Promise<WrappedKey | null> {
    const { escrow } = await api<{ escrow: { passphrase: WrappedKey } | null }>('/api/vault-key');
    return escrow?.passphrase ?? null;
}

export interface BlobRef {
    envelope_id: string;
    updated_at: string;
}

/** The change manifest — envelope ids + timestamps, no ciphertext. */
export async function listBlobs(): Promise<BlobRef[]> {
    const { blobs } = await api<{ blobs: BlobRef[] }>('/api/blobs');
    return blobs ?? [];
}

/** Fetch one blob's packed ciphertext, or null when it is gone. */
export async function fetchBlob(envelopeId: string): Promise<string | null> {
    try {
        const { ciphertext } = await api<{ ciphertext: string }>(
            `/api/blobs/${encodeURIComponent(envelopeId)}`
        );
        return ciphertext ?? null;
    } catch {
        return null;
    }
}

/** Upsert one blob's packed ciphertext. Used by capture (Phase 3). */
export async function putBlob(envelopeId: string, ciphertext: string): Promise<void> {
    await api(`/api/blobs/${encodeURIComponent(envelopeId)}`, {
        method: 'PUT',
        body: JSON.stringify({ ciphertext }),
    });
}
