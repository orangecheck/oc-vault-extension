/**
 * Vault crypto — the read path.
 *
 * CONFORMANCE: this mirrors oc-vault-web's `lib/vault-key.ts` and
 * `lib/sync.ts` byte-for-byte. The wrapped-key blob, the scrypt
 * parameters, the double-encrypted cloud-blob envelope and the entry
 * field encryption MUST stay identical — a one-byte divergence silently
 * breaks a real vault. Pinned to oc-vault-web blob format v1.
 *
 * PLAN.md §10 tracks extracting this into a shared `@orangecheck/`
 * package so the web app and the extension stop carrying two copies.
 *
 * Nothing here decrypts anything the caller did not already authorize:
 * `unwrapVaultKey` needs the passphrase; `decryptFields` needs the key.
 */

import { scrypt } from '@noble/hashes/scrypt';

import {
    aesGcmDecrypt,
    aesGcmEncrypt,
    b64urlDecode,
    b64urlEncode,
    hexEncode,
    randomBytesN,
    utf8Decode,
    utf8Encode,
} from '@orangecheck/lock-crypto';

const VAULT_KEY_LEN = 32;
const NONCE_LEN = 12;
const BLOB_VERSION = 1;

export type VaultEntryType =
    | 'password'
    | 'note'
    | 'seed-phrase'
    | 'totp'
    | 'api-key'
    | 'kv'
    | 'card'
    | 'identity'
    | 'file';

/** A vault key wrapped under a passphrase — the only at-rest form of `K`. */
export interface WrappedKey {
    wrapped_key: string;
    wrap_nonce: string;
    kdf: 'scrypt';
    kdf_salt: string;
    kdf_n: number;
    kdf_r: number;
    kdf_p: number;
}

/** A decrypted entry record. `ciphertext` (the secret fields) stays sealed. */
export interface VaultEntry {
    id: string;
    type: VaultEntryType;
    name: string;
    /** b64url(12-byte nonce) for the inner field ciphertext. */
    nonce: string;
    /** b64url(AES-256-GCM(JSON(fields), K)). */
    ciphertext: string;
    created_at: string;
    updated_at: string;
    favorite?: boolean;
    tags?: string[];
    folder?: string;
    deleted_at?: string;
    purged_at?: string;
}

/** The decrypted inner fields — shape varies by entry type. */
export type VaultEntryFields = Record<string, unknown>;

/**
 * The metadata-only projection of an entry safe to hand the popup. It
 * carries NO secret — see SECURITY.md §1. `url` is plaintext metadata,
 * used for origin matching.
 */
export interface VaultEntrySummary {
    id: string;
    type: VaultEntryType;
    name: string;
    favorite: boolean;
    /** The associated URL, when the entry type carries one. Plaintext. */
    url?: string;
    /** The entry's folder, when filed in one. Plaintext metadata. */
    folder?: string;
}

/** Thrown when a key unwrap fails — a wrong passphrase or a corrupt blob. */
export class WrongPassphrase extends Error {
    constructor() {
        super('wrong passphrase');
        this.name = 'WrongPassphrase';
    }
}

/**
 * Unwrap the vault key from its escrowed `WrappedKey` using the passphrase.
 * scrypt-derives the wrap key, then AES-256-GCM-decrypts. Throws
 * `WrongPassphrase` on any failure — never returns a bogus key.
 */
/**
 * Accepted scrypt work factors.
 *
 * The blob carries its own N, r and p, and the blob comes from the server.
 * scrypt's memory cost is 128 · N · r bytes, so a blob declaring N = 2^24 with
 * r = 8 asks for 17 GiB — in a service worker, before the passphrase is
 * tested. Bounded here rather than trusted; the same bound is in
 * @orangecheck/vault-core, which is where this whole module should eventually
 * come from (origin matching already does).
 */
const MIN_KDF_N = 1 << 14;
const MAX_KDF_N = 1 << 20;
const MAX_KDF_R = 16;
const MAX_KDF_P = 4;

function assertAcceptableKdfParams(w: Pick<WrappedKey, 'kdf_n' | 'kdf_r' | 'kdf_p'>): void {
    const ok = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0;
    if (!ok(w.kdf_n) || !ok(w.kdf_r) || !ok(w.kdf_p)) {
        throw new Error('unsupported key-derivation parameters');
    }
    // scrypt requires a power of two; otherwise it fails deep in the library.
    if ((w.kdf_n & (w.kdf_n - 1)) !== 0) {
        throw new Error('unsupported key-derivation parameters');
    }
    if (w.kdf_n < MIN_KDF_N || w.kdf_n > MAX_KDF_N) {
        throw new Error('unsupported key-derivation parameters');
    }
    if (w.kdf_r > MAX_KDF_R || w.kdf_p > MAX_KDF_P) {
        throw new Error('unsupported key-derivation parameters');
    }
}

export function unwrapVaultKey(w: WrappedKey, passphrase: string): Uint8Array {
    // Checked before any memory is spent, and deliberately NOT a
    // WrongPassphrase: a blob asking for 17 GiB is not a typo.
    assertAcceptableKdfParams(w);
    const wrapKey = scrypt(utf8Encode(passphrase), b64urlDecode(w.kdf_salt), {
        N: w.kdf_n,
        r: w.kdf_r,
        p: w.kdf_p,
        dkLen: VAULT_KEY_LEN,
    });
    try {
        const key = aesGcmDecrypt(wrapKey, b64urlDecode(w.wrap_nonce), b64urlDecode(w.wrapped_key));
        if (key.length !== VAULT_KEY_LEN) throw new Error('unexpected key length');
        return key;
    } catch {
        throw new WrongPassphrase();
    }
}

interface CloudBlob {
    v: number;
    blob_nonce: string;
    blob_ct: string;
}

/**
 * Unpack a cloud blob — the outer AES-GCM layer that keeps the server
 * blind to entry names and types — back to a `VaultEntry`.
 */
export function unpackEntryFromCloud(payload: string, key: Uint8Array): VaultEntry {
    const blob = JSON.parse(payload) as CloudBlob;
    if (blob.v !== BLOB_VERSION) throw new Error(`unsupported blob version: ${blob.v}`);
    const plaintext = aesGcmDecrypt(key, b64urlDecode(blob.blob_nonce), b64urlDecode(blob.blob_ct));
    return JSON.parse(utf8Decode(plaintext)) as VaultEntry;
}

/** Decrypt an entry's inner fields. Call lazily — never cache the result. */
export function decryptFields(
    entry: Pick<VaultEntry, 'nonce' | 'ciphertext'>,
    key: Uint8Array
): VaultEntryFields {
    const plaintext = aesGcmDecrypt(key, b64urlDecode(entry.nonce), b64urlDecode(entry.ciphertext));
    return JSON.parse(utf8Decode(plaintext)) as VaultEntryFields;
}

/** Project an entry to its non-secret summary for the popup. */
export function toSummary(entry: VaultEntry, fields?: VaultEntryFields): VaultEntrySummary {
    const url = fields && typeof fields.url === 'string' ? fields.url : undefined;
    return {
        id: entry.id,
        type: entry.type,
        name: entry.name,
        favorite: Boolean(entry.favorite),
        url,
        folder: typeof entry.folder === 'string' && entry.folder ? entry.folder : undefined,
    };
}

/** A live (non-trashed, non-tombstoned) entry — mirrors oc-vault-web. */
export function isLiveEntry(entry: VaultEntry): boolean {
    return !entry.deleted_at && !entry.purged_at;
}

/* ── write path (Phase 3, capture) ──────────────────────────────────────
   The inverse of the read path above, and likewise pinned byte-for-byte
   to oc-vault-web. PLAN.md §10: extract a shared `@orangecheck/` package
   now that BOTH directions are duplicated. */

/** A fresh 32-hex entry id — 16 random bytes, hex-encoded. */
export function generateEntryId(): string {
    return hexEncode(randomBytesN(16));
}

/** Encrypt an entry's inner fields under the vault key. */
export function encryptFields(
    fields: VaultEntryFields,
    key: Uint8Array
): { nonce: string; ciphertext: string } {
    const nonce = randomBytesN(NONCE_LEN);
    const ct = aesGcmEncrypt(key, nonce, utf8Encode(JSON.stringify(fields)));
    return { nonce: b64urlEncode(nonce), ciphertext: b64urlEncode(ct) };
}

/**
 * Pack an entry into a cloud blob — the outer AES-GCM layer that keeps the
 * server blind to entry names and types. The inverse of
 * `unpackEntryFromCloud`.
 */
export function packEntryForCloud(entry: VaultEntry, key: Uint8Array): string {
    const nonce = randomBytesN(NONCE_LEN);
    const ct = aesGcmEncrypt(key, nonce, utf8Encode(JSON.stringify(entry)));
    return JSON.stringify({
        v: BLOB_VERSION,
        blob_nonce: b64urlEncode(nonce),
        blob_ct: b64urlEncode(ct),
    });
}
