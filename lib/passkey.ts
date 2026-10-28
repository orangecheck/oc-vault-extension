/**
 * Passkey unlock — WebAuthn PRF, ported from oc-vault-web `src/lib/passkey.ts`
 * and the passkey half of its `src/lib/vault.ts` (PLAN.md §3).
 *
 * The PRF extension turns a passkey into a hardware-gated KDF: for a fixed
 * salt the authenticator returns the same 32-byte secret every time, and only
 * behind user verification (Touch ID, Windows Hello, a security-key PIN). The
 * vault key is wrapped under sha256 of that secret, exactly as the web app does,
 * and the wrap is kept in `storage.local`. The secret itself is never stored:
 * it is derived fresh on each unlock, crosses once to the worker, and is dropped.
 *
 * The passkey belongs to this extension: its relying party is the extension's
 * own origin, the way the web app's is vault.ochk.io's. It is a second unlock
 * factor on this browser, like the web app's — it survives a lock and is
 * removed in settings — and it is bound to the identity and the escrowed key it
 * was made for (see `escrowFingerprint`).
 *
 * The ceremony runs in its own extension window (entrypoints/passkey), never in
 * the toolbar popup, which closes when it loses focus to the authenticator.
 */

import {
    aesGcmDecrypt,
    aesGcmEncrypt,
    b64urlDecode,
    b64urlEncode,
    randomBytesN,
    sha256Bytes,
} from '@orangecheck/lock-crypto';

import type { WrappedKey } from './crypto';

/** The vault key wrapped under a passkey's PRF secret — the web app's KeyWrappedUnderKey. */
export interface KeyUnderPasskey {
    /** b64url(AES-256-GCM(vault key, sha256(prf secret))) */
    wrapped_key: string;
    /** b64url(12-byte nonce) */
    wrap_nonce: string;
}

/** What `storage.local` keeps for one identity. Nothing here unlocks anything without the passkey. */
export interface PasskeyRecord {
    /** b64url credential raw id, replayed in `allowCredentials`. */
    credentialId: string;
    /** b64url 32-byte PRF salt. */
    prfSalt: string;
    wrapped: KeyUnderPasskey;
    /** The escrowed passphrase wrap this key came from; see `escrowFingerprint`. */
    escrow: string;
    createdAt: string;
}

/** What the worker hands an extension page to run the unlock ceremony. Not secret. */
export interface PasskeyTarget {
    credentialId: string;
    prfSalt: string;
}

const STORE_KEY = 'oc-passkey-unlock';
const KEY_LEN = 32;
const NONCE_LEN = 12;

/** The sentence a person reads when this browser or passkey cannot do PRF. */
export const PRF_TEXT =
    "This browser or passkey can't unlock the vault: it lacks the passkey feature this needs. Use your passphrase.";

/**
 * A fingerprint of the escrowed, passphrase-wrapped key. A passkey wraps the
 * key that was live when it was made; if the escrow changes (a new passphrase,
 * or a new vault key) the passkey is refused and must be set up again, so a
 * stale key can never unlock — and never write blobs the vault cannot read.
 */
export function escrowFingerprint(w: WrappedKey): string {
    const text = [w.wrapped_key, w.wrap_nonce, w.kdf_salt].join('.');
    return b64urlEncode(sha256Bytes(new TextEncoder().encode(text)));
}

export function wrapUnderPrf(vaultKey: Uint8Array, prfSecret: Uint8Array): KeyUnderPasskey {
    const nonce = randomBytesN(NONCE_LEN);
    return {
        wrapped_key: b64urlEncode(aesGcmEncrypt(sha256Bytes(prfSecret), nonce, vaultKey)),
        wrap_nonce: b64urlEncode(nonce),
    };
}

/** The vault key, or null when this secret is not the one it was wrapped under. */
export function unwrapUnderPrf(w: KeyUnderPasskey, prfSecret: Uint8Array): Uint8Array | null {
    try {
        const key = aesGcmDecrypt(
            sha256Bytes(prfSecret),
            b64urlDecode(w.wrap_nonce),
            b64urlDecode(w.wrapped_key)
        );
        return key.length === KEY_LEN ? key : null;
    } catch {
        return null;
    }
}

/* ── storage.local: one record per identity ─────────────────────────────── */

async function readAll(): Promise<Record<string, PasskeyRecord>> {
    const got = await browser.storage.local.get(STORE_KEY);
    const all = got[STORE_KEY];
    return all && typeof all === 'object' ? (all as Record<string, PasskeyRecord>) : {};
}

export async function readPasskey(identity: string): Promise<PasskeyRecord | null> {
    return (await readAll())[identity] ?? null;
}

export async function writePasskey(identity: string, record: PasskeyRecord): Promise<void> {
    await browser.storage.local.set({ [STORE_KEY]: { ...(await readAll()), [identity]: record } });
}

export async function forgetPasskey(identity: string): Promise<void> {
    const all = await readAll();
    delete all[identity];
    await browser.storage.local.set({ [STORE_KEY]: all });
}

/* ── the WebAuthn ceremonies — extension pages only ─────────────────────── */

interface PrfOutputs {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

/** A fresh plain ArrayBuffer, as WebAuthn's BufferSource fields want. */
function buf(u: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(u.length);
    copy.set(u);
    return copy.buffer;
}

export class PrfUnsupported extends Error {
    constructor() {
        super(PRF_TEXT);
        this.name = 'PrfUnsupported';
    }
}

export function isPasskeySupported(): boolean {
    return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

/**
 * Make a passkey for this extension and read its PRF secret. Platforms that
 * return the secret at create time need one prompt; the rest get a follow-up
 * `get()`. Throws PrfUnsupported when the authenticator cannot do PRF.
 */
export async function createPasskey(): Promise<{ target: PasskeyTarget; prfSecret: Uint8Array }> {
    if (!isPasskeySupported()) throw new PrfUnsupported();
    const prfSalt = randomBytesN(32);
    const cred = (await navigator.credentials.create({
        publicKey: {
            rp: { name: 'OC Vault extension', id: location.hostname },
            user: {
                id: buf(randomBytesN(16)),
                name: 'oc-vault-extension',
                displayName: 'OC Vault extension',
            },
            challenge: buf(randomBytesN(32)),
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
            timeout: 60_000,
            extensions: {
                prf: { eval: { first: buf(prfSalt) } },
            } as unknown as AuthenticationExtensionsClientInputs,
        },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PrfUnsupported();
    const ext = cred.getClientExtensionResults() as unknown as PrfOutputs;
    if (!ext.prf?.enabled && !ext.prf?.results?.first) throw new PrfUnsupported();
    const target: PasskeyTarget = {
        credentialId: b64urlEncode(new Uint8Array(cred.rawId)),
        prfSalt: b64urlEncode(prfSalt),
    };
    const atCreate = ext.prf?.results?.first;
    const prfSecret = atCreate ? new Uint8Array(atCreate) : await evaluatePasskey(target);
    if (!prfSecret) throw new PrfUnsupported();
    return { target, prfSecret };
}

/** The PRF secret from an existing passkey, or null when the person cancels or it declines. */
export async function evaluatePasskey(target: PasskeyTarget): Promise<Uint8Array | null> {
    if (!isPasskeySupported()) return null;
    try {
        const assertion = (await navigator.credentials.get({
            publicKey: {
                challenge: buf(randomBytesN(32)),
                rpId: location.hostname,
                allowCredentials: [
                    { type: 'public-key', id: buf(b64urlDecode(target.credentialId)) },
                ],
                userVerification: 'required',
                timeout: 60_000,
                extensions: {
                    prf: { eval: { first: buf(b64urlDecode(target.prfSalt)) } },
                } as unknown as AuthenticationExtensionsClientInputs,
            },
        })) as PublicKeyCredential | null;
        const first = (assertion?.getClientExtensionResults() as unknown as PrfOutputs)?.prf
            ?.results?.first;
        return first ? new Uint8Array(first) : null;
    } catch {
        return null;
    }
}
