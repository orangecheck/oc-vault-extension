// The background worker under test: a mocked browser.runtime and storage, a fake
// vault.ochk.io, an unlocked vault holding the given entries, and the real handler.
import { register } from 'node:module';

register('./ts-alias-loader.mjs', import.meta.url);

export const EXT_ID = 'ocvaulttestextensionid';
export const EXT = `chrome-extension://${EXT_ID}/`;
export const POPUP = { id: EXT_ID, url: `${EXT}popup.html` };
/** A content script running in a page (or frame) at `url`. */
export const page = (url) => ({
    id: EXT_ID,
    url,
    origin: new URL(url).origin,
    tab: { id: 7, url },
});

globalThis.defineBackground = (main) => ({ main });
const { b64urlEncode } = await import('@orangecheck/lock-crypto');
const crypto = await import('./crypto.ts');
const background = (await import('../entrypoints/background.ts')).default;

function area(map) {
    return {
        get: async (k) => (map.has(k) ? { [k]: structuredClone(map.get(k)) } : {}),
        set: async (o) => {
            for (const [k, v] of Object.entries(o)) map.set(k, structuredClone(v));
        },
        remove: async (k) => void map.delete(k),
    };
}

/**
 * Start a fresh worker. `entries` are `{ name, fields }`; the vault is unlocked
 * with them (the session key and the ciphertext cache, as after a restart).
 * `opts.escrow(key)` makes the escrowed WrappedKey /api/vault-key serves (none by
 * default); `opts.identity` is the signed-in did:oc; `opts.local` seeds storage.local.
 */
export async function startWorker(entries = [], opts = {}) {
    const session = new Map();
    const local = new Map();
    let listener = null;
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    for (const [k, v] of Object.entries(opts.local ?? {})) local.set(k, structuredClone(v));
    const api = {
        escrow: opts.escrow ? opts.escrow(key) : null,
        identity: opts.identity ?? 'did:oc:harness',
    };
    const now = new Date().toISOString();
    const blobs = entries.map(({ name, fields }) => {
        const id = crypto.generateEntryId();
        const entry = {
            id,
            type: 'password',
            name,
            ...crypto.encryptFields(fields, key),
            created_at: now,
            updated_at: now,
        };
        return {
            envelope_id: id,
            updated_at: now,
            ciphertext: crypto.packEntryForCloud(entry, key),
        };
    });
    session.set('oc-session-key', b64urlEncode(key));
    local.set('oc-blob-cache', blobs);
    const puts = [];
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        const json = (body) => new Response(JSON.stringify(body), { status: 200 });
        if (path === '/api/auth/me') return json({ account: { did_oc: api.identity } });
        if (path === '/api/blobs')
            return json({
                blobs: blobs.map(({ envelope_id, updated_at }) => ({ envelope_id, updated_at })),
            });
        if (path.startsWith('/api/blobs/') && init.method === 'PUT') {
            puts.push(path);
            return json({ ok: true });
        }
        if (path === '/api/vault-key')
            return json({ escrow: api.escrow ? { passphrase: api.escrow } : null });
        return new Response('{}', { status: 404 });
    };
    globalThis.browser = {
        runtime: {
            id: EXT_ID,
            getURL: (p) => `${EXT}${p}`,
            onMessage: { addListener: (fn) => (listener = fn) },
        },
        storage: { session: area(session), local: area(local) },
        alarms: { clear: async () => true, create: () => {}, onAlarm: { addListener: () => {} } },
        action: { openPopup: async () => {} },
    };
    background.main();
    const ids = blobs.map((b) => b.envelope_id);
    /** Send one message as `sender` and resolve with the worker's reply envelope. */
    const send = (message, sender) =>
        new Promise((resolve) => {
            const kept = listener(message, sender, resolve);
            if (kept !== true) resolve({ ok: false, reason: 'listener did not answer' });
        });
    return { send, ids, session, local, puts, key, api };
}
