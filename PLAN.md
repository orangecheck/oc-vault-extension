# oc-vault-extension — architecture & build plan

> The plan is the contract. No phase ships before its section here and the
> rules in `SECURITY.md` are satisfied.

## 1. What it is, and what it is not

oc-vault-extension is a **read-and-fill client** for an existing OC Vault.

It **is**: a toolbar popup that lists your decrypted entries; an autofill
engine that offers origin-matched credentials on login pages; a capture
prompt that saves new logins back to the vault.

It is **not**: a second vault, a second key, a second account. There is
exactly one vault per Bitcoin identity. The extension unlocks _that_ vault.
It never invents storage the web app cannot see. Setup, billing, recovery
codes, and team vaults stay in the web app — the extension links out.

This keeps the surface small and the trust story honest: anything the
extension can do, the web app can already do; the extension just does it
without a tab.

## 2. The actors (Manifest V3)

MV3 splits the extension into three isolated worlds. The split _is_ the
security architecture — see `SECURITY.md` §2.

| Actor                         | Runs in                                 | Holds                                                                                | Never holds                                              |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **background service worker** | extension origin, no DOM                | the unlocked vault key; the decrypted entry index; the lock timer                    | —                                                        |
| **popup**                     | extension origin, its own document      | renders entries it requests from the worker; the unlock passphrase _in transit_ only | the key at rest                                          |
| **content script**            | injected into web pages, isolated world | after a gesture: the origin-matched summaries, then one picked entry's field values  | the vault key; the full entry index; any unpicked secret |

The vault key lives in **exactly one place: the service worker's memory.**
The popup and content script ask the worker to act; they never receive the
key. This is the single most important invariant in the codebase.

## 3. Trust & key model

Identical to oc-vault-web — the extension is just another client of the
same wrapped key.

```
passphrase ──scrypt(N=2^17)──▶ wrap key ──AES-256-GCM──▶ unwrap ──▶ K (32 bytes)
                                                                     │
vault.ochk.io  ──GET /api/vault-key──▶  escrow: WrappedKey  ──────────┘
vault.ochk.io  ──GET /api/blobs/[id]─▶  double-encrypted entry blob ──decrypt(K)──▶ entry
```

- **Auth** rides the `oc_session` cookie. The user signs in once at
  `ochk.io` in a normal tab; the extension's `fetch` to `vault.ochk.io`
  carries the cookie (host permission granted). No separate login, no
  token storage. Not signed in → the popup links to `ochk.io/signin`.
- **Unlock** = fetch the escrowed `WrappedKey`, take the passphrase, derive
  the scrypt wrap key, unwrap to `K`. `K` is held in the worker; the
  passphrase is discarded immediately.
- **Recovery codes, passkeys** — the same break-glass paths the web app
  exposes. Passkey unlock (WebAuthn PRF) is a Phase 4 port of the web app's
  implementation; it is the _recommended_ extension unlock because the
  popup is a frequent, low-friction surface.
- **Lock** drops `K` from worker memory. It is dropped on: explicit lock,
  the idle timer, and — by MV3's own lifecycle — service-worker
  termination. SW death-as-lock is a feature, not a bug (see §7).

## 4. Sync

Read path, mirroring oc-vault-web's `unlockVault` + `syncEntries` pull:

1. `GET /api/vault-key` → `escrow.passphrase` (`WrappedKey`).
2. Unwrap with the passphrase → `K`.
3. `GET /api/blobs` → `[{ envelope_id, updated_at }]`.
4. Per blob, `GET /api/blobs/[id]` → packed ciphertext → `unpackEntryFromCloud(·, K)`.
5. The decrypted `VaultEntry[]` index lives in the worker. Entry _fields_
   are decrypted lazily, per entry, only when the popup or an autofill
   asks — never decrypted in bulk and never cached decrypted.

Write path (Phase 3, capture): build a `VaultEntry`, double-encrypt under
`K`, `PUT /api/blobs/[id]`. Compare-and-swap and conflict handling are the
web app's concern; the extension does plain creates and last-writer-wins
edits, and defers to the web app for anything contentious.

**Caching.** The worker may cache the _ciphertext_ blobs in
`chrome.storage.local` so a cold start is not a full re-sync — ciphertext
at rest is exactly what the server already holds, so this leaks nothing.
Decrypted entries are **never** persisted.

## 5. Autofill (Phase 2) — the hard part

Autofill is the highest-risk surface in any password manager. The design
is conservative by default.

- **Origin matching is the gate.** `origin.ts` compares the page's origin
  against each entry's stored URL by registrable domain (eTLD+1) with an
  exact-origin preference. A credential is offered **only** on a matching
  origin. No fuzzy matching, no path matching, no blocklists — the match
  is the security check. (`SECURITY.md` §4.)
- **Never silent.** The content script may _draw_ an affordance on a
  recognized login field, but a value crosses into the page only after the
  user clicks it (or picks the entry in the popup). The extension never
  auto-submits.
- **iframes.** A credential for origin `A` is filled into a frame only if
  that frame's own origin is `A`. A cross-origin iframe never receives a
  parent-origin credential — this defeats the classic iframe-exfiltration
  trick.
- **The affordance is not spoofable.** The inline UI is a closed
  shadow-DOM element the page's script cannot read or drive; it reflects
  worker state, and the _click_ is a real user gesture the page cannot
  synthesize into a fill.
- **Minimal disclosure, gated on a gesture.** Before the affordance is
  clicked the content script knows nothing of the vault. On the click it
  gets the origin-matched **summaries** (no secret) to render the picker;
  on a pick, only that one entry's requested field **values**. Never the
  full index, never an unpicked entry's secret (`SECURITY.md` §3).

Phishing resistance falls out for free: origin-bound credentials are not
offered on look-alike domains. This is a headline feature, not a footnote.

## 6. Capture (Phase 3)

On a submitted login form whose origin has no matching entry — or whose
password differs from the stored one — the content script signals the
worker, which prompts (in the popup or a non-spoofable overlay) to save or
update. Saving writes a new blob; the user confirms every write.

## 7. The MV3 service-worker lifecycle

MV3 terminates the service worker after ~30s idle. The worker's in-memory
`K` dies with it. Consequences, by design:

- **Termination is a lock.** A cold popup after the worker slept shows the
  unlock gate. For a vault, "locks itself when idle" is the correct
  default — we lean into it rather than fight it.
- **"Stay unlocked on this device"** (opt-in, mirroring oc-vault-web #62):
  `K` is wrapped under a non-extractable WebCrypto `CryptoKey` persisted in
  IndexedDB; the worker re-derives `K` on wake without a prompt. This
  trades the idle-lock for convenience and is **off by default**. An
  explicit lock always clears it.
- **Idle timer.** Independent of SW lifecycle, an explicit auto-lock timer
  (configurable) drops `K` and clears any "stay unlocked" wrap.

## 8. Permissions — least privilege, phased

The manifest grows with the features. Each phase requests only what it uses.

| Phase                  | Permissions                  | Host permissions                               |
| ---------------------- | ---------------------------- | ---------------------------------------------- |
| 0–1 (popup, read-only) | `storage`                    | `https://vault.ochk.io/*`, `https://ochk.io/*` |
| 2 (autofill)           | `+ activeTab`, `+ scripting` | `+ <all_urls>` for content-script injection    |
| 3 (capture)            | (no new)                     | (no new)                                       |

`<all_urls>` is unavoidable for an autofill extension, and is the moment
the trust ask gets real — which is exactly why the content script is
built to hold nothing (§2). No `tabs`, no `webRequest`, no `cookies`
permission: the session cookie rides ordinary `fetch`.

## 9. Build plan

- **Phase 0 — groundwork** ✓ _done._ WXT + React + TS scaffold; MV3
  manifest; the entrypoints; the `lib/` modules; the typed message bus; a
  dark popup. Repo, README, PLAN, SECURITY.
- **Phase 1 — read-only vault** ✓ _done._ Unlock against the escrow API;
  sync; decrypt; the popup entry list with search, a type filter and a
  detail/reveal view; the idle lock; the ciphertext cache. Remaining
  polish: copy auto-clear.
- **Phase 2 — autofill** ✓ _done._ `forms.ts` detection; `origin.ts`
  matching; the closed-shadow-DOM affordance + picker; fill-on-gesture;
  the per-frame iframe rule. The `fill-values` message resolves one
  picked entry's fields. Remaining polish: registrable-domain matching
  via the full PSL (currently the compact known-suffix set).
- **Phase 3 — capture** ✓ _done._ On a login submit the content script
  hands the typed values to the worker, which judges them new / changed
  and holds an in-memory pending capture; a non-spoofable prompt (inline,
  or on the page the navigation lands on) offers to save / update, and on
  confirm the worker writes the blob. The pending capture holds a
  password, so it is memory-only — never persisted. Known gap: forms with
  no `<form>` element (a `<div>` + button) are not captured in v1.
- **Phase 4 — polish & ship.** Passkey unlock; the password generator;
  settings (idle timeout, stay-unlocked); Firefox parity; store listing,
  icons, privacy disclosure; a reproducible-build note. Submit to the
  Chrome Web Store and Firefox Add-ons.

## 10. Open decisions (tracked, not yet closed)

- **`@orangecheck/vault-core`.** The key-unwrap + blob-decrypt path is
  re-implemented in `lib/crypto.ts` against oc-vault-web's formats. Two
  implementations of one crypto format is a drift hazard — a wrong byte
  silently breaks a vault. Before Phase 3 (which _writes_ blobs), extract
  the shared read/write path from oc-vault-web into an `@orangecheck/`
  package both consume. Until then, `lib/crypto.ts` carries a conformance
  note pinning it to the web app's format version.
- **Source visibility.** Family web repos are private. A security tool
  distributed as a binary benefits from public, auditable source. Recommend
  **public** — but this is the user's call when the GitHub remote is
  created; nothing here assumes it.
- **Workspace registration.** When the remote exists, add an
  `oc-vault-extension` row to the family table in the workspace `CLAUDE.md`.
