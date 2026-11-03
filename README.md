# oc-vault-extension

**The browser companion to [vault.ochk.io](https://vault.ochk.io).** Unlock once, fill anywhere, trust the origin.

A Manifest V3 browser extension that brings your OC Vault into the browser:
read your entries from a toolbar popup, and — origin-bound, never silent —
autofill logins on the sites they belong to.

It is a _client_, not a second vault. It holds the same passphrase-wrapped
key the web app holds, decrypts the same ciphertext, and syncs through the
same `vault.ochk.io` API. orangecheck never sees a plaintext secret, here
no more than anywhere else in the family.

---

## Ethos

oc-vault-extension inherits the OrangeCheck family's non-negotiables and the
oc-vault product's design:

- **No custody.** The vault key is never stored in the clear — not on a
  server, not in extension storage at rest. It lives in the background
  service worker's memory while unlocked, and nowhere else.
- **The server sees ciphertext.** Sync pulls double-encrypted blobs;
  decryption happens in the extension against the user-held key.
- **Origin is the trust anchor.** A credential is bound to the origin it
  was saved on. The extension offers it on that origin and nowhere else —
  which makes it phishing-resistant by construction, not by a blocklist.
- **No silent action.** Nothing is filled, saved, or revealed without an
  explicit user gesture. The extension never auto-submits a form.
- **Least privilege.** The shipped manifest requests the _minimum_
  permissions for the features that are actually live: `storage` and
  `alarms`, and host access to `vault.ochk.io` and `ochk.io` only. Autofill
  runs as a content script on every page (`matches: ['<all_urls>']` in
  `entrypoints/content.ts`), which detects login forms and fills only on a
  user gesture.
- **Minimal surface.** No analytics, no telemetry, no remote code. The
  build is reproducible; the source is auditable.

See [`SECURITY.md`](./SECURITY.md) for the full threat model and the rules
that govern where the vault key and plaintext are allowed to exist.

## Status

**Version `0.1.1` on main.** Phases 0–3 are done: unlock, sync, browse,
autofill, and capture all work, and the build is green for Chrome and
Firefox. Phase 4 has shipped passkey unlock (Chromium), the password
generator, live TOTP codes in the popup and the autofill picker; the rest of
it is in [`PLAN.md`](./PLAN.md). Firefox Add-ons lists `0.1.0` (read 2026-11-03);
the next store submission is in [`PUBLISHING.md`](./PUBLISHING.md).

## Stack

- **WXT** — the build framework for cross-browser MV3 extensions (Vite
  under the hood; the extension-domain equivalent of the family's Next.js).
- **React + TypeScript** for the popup UI; the family voice, dark by default.
- **`@orangecheck/vault-core`** — origin matching (the autofill trust
  check) and TOTP, the same code oc-vault-web runs.
- **`@orangecheck/lock-crypto` + `@noble/hashes`** — the exact crypto
  primitives oc-vault-web uses, for the key unwrap and entry decryption in
  `lib/crypto.ts`. No bespoke cryptography.

## Develop

```sh
npm install
npm run dev        # Chrome, with HMR
npm run dev:firefox
npm run build      # production build → .output/
```

[`TESTING.md`](./TESTING.md) is the click-by-click guide to loading the
extension into a browser and exercising every feature.

## Layout

```
entrypoints/
  background.ts     service worker — holds the key, syncs, decrypts
  popup/            toolbar popup — unlock gate, entry list (React)
  content.ts        page script — form detection + autofill (Phase 2)
  passkey/          the passkey window — set up / unlock with a passkey (Phase 4)
lib/
  crypto.ts         key unwrap + entry decryption (mirrors oc-vault-web)
  sync.ts           the vault.ochk.io /api/blobs client
  messaging.ts      typed message bus between worker / popup / content
  forms.ts          login-form heuristics (Phase 2)
  passkey.ts        passkey unlock: the PRF ceremonies and the key seal (Phase 4)
  password-gen.ts   the password / passphrase generator (Phase 4)
  picker.ts         what the autofill menu shows, from the worker's answers
  totp.ts           live TOTP codes from an entry's secret (vault-core's totp)
```

## Relationship to the family

oc-vault-extension is a sibling repo, distributed through the Chrome Web
Store and Firefox Add-ons rather than Vercel. It depends on `oc-vault-web`
only through the public `vault.ochk.io` API and the shared
`@orangecheck/*` npm packages — never an in-tree reference.

Origin matching and TOTP come from `@orangecheck/vault-core`. The key
unwrap and entry decryption are still re-implemented in `lib/crypto.ts`
against the formats oc-vault-web uses. Drift between the two is a
correctness hazard; `PLAN.md` tracks moving that path onto vault-core too,
so both consume one implementation.
