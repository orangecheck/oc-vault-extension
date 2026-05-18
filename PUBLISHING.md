# Publishing oc-vault-extension

How to ship OC Vault to the Chrome Web Store and Firefox Add-ons. The
build is reproducible and the artifacts are produced by `wxt zip`; the
account-gated submission steps need OrangeCheck's developer accounts.

---

## 0. Test it first — non-negotiable

A password manager does not go to a store untested. Before anything else:

```sh
npm install
npm run dev           # loads into a fresh Chrome with the extension
```

Then exercise the whole path on real sites:

- **Unlock** — the popup unlocks against your vault passphrase.
- **List / detail** — entries appear; the detail view reveals fields.
- **Autofill** — visit a login page you have a credential for; the OC
  affordance appears on the field; clicking it lists the origin match;
  picking it fills username + password.
- **Origin safety** — on a _different_ site, that credential is NOT
  offered.
- **Capture** — log in somewhere new; the save prompt appears; saving
  writes the entry (confirm it in the web app at vault.ochk.io).
- **Idle lock** — set a short idle timeout in settings; confirm it locks.

Fix anything that misbehaves before submitting.

## 1. Build the artifacts

```sh
npm run build              # sanity check — chrome-mv3
npx wxt zip                # → .output/oc-vault-extension-<v>-chrome.zip
npx wxt zip -b firefox     # → ...-firefox.zip  and  ...-sources.zip
```

Three files land in `.output/`:

| File                                 | For                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `oc-vault-extension-<v>-chrome.zip`  | Chrome Web Store upload                                                           |
| `oc-vault-extension-<v>-firefox.zip` | Firefox AMO upload                                                                |
| `oc-vault-extension-<v>-sources.zip` | Firefox AMO **source** upload (AMO requires source for built/minified extensions) |

Bump `version` in `package.json` for every new submission.

## 2. Chrome Web Store

**Account.** A Chrome Web Store developer account — a one-time **US$5**
registration at <https://chrome.google.com/webstore/devconsole>, on
OrangeCheck's Google account. Group publishing under an OrangeCheck-owned
account, never a personal one.

**Submit.**

1. Developer Dashboard → **Add new item** → upload the `-chrome.zip`.
2. Fill the **store listing** (copy in §4).
3. Fill **Privacy practices** (answers in §5) — this is where a password
   manager is scrutinised; the answers are pre-written, use them verbatim.
4. **Screenshots** — 1280×800 PNG, at least one. Capture the popup
   (entry list) and an autofill affordance on a login page.
5. Set **visibility** (Public) and submit for review.

Review for an extension with `<all_urls>` + autofill typically takes a
few days and may ask for a justification — §5 covers it.

## 3. Firefox Add-ons (AMO)

**Account.** A free Mozilla account at <https://addons.mozilla.org>.

**Submit.**

1. Developer Hub → **Submit a New Add-on** → upload the `-firefox.zip`.
2. When asked, upload `-sources.zip` as the **source code** — AMO
   requires it because WXT/Vite produces a bundled build. Include a build
   note: `npm install && npx wxt build -b firefox` reproduces the
   artifact.
3. Fill the listing (the §4 copy applies).
4. Submit; AMO review is usually faster than CWS.

## 4. Store listing copy

**Name:** `OC Vault`

**Summary** (≤132 chars):

> Unlock your OrangeCheck vault in the browser — origin-bound autofill, end-to-end encrypted, no custody.

**Category:** Productivity

**Description:**

> OC Vault is the browser companion to vault.ochk.io — the Bitcoin-identity password manager.
>
> Unlock your vault once and it is there in every tab: browse and copy your entries from the toolbar popup, and autofill saved logins on the sites they belong to.
>
> • End-to-end encrypted. Your vault key is derived from your passphrase and never leaves your browser's memory. OrangeCheck stores ciphertext only — it cannot read your vault.
> • Origin-bound autofill. A credential is offered only on the exact site it was saved on, so look-alike phishing domains simply get nothing.
> • Capture as you go. Log in somewhere new and OC Vault offers to save it.
> • Locks itself. The vault re-locks when idle and whenever the browser suspends the extension.
> • No account here, no second vault. It is the same vault as vault.ochk.io — set up, billing and recovery live there.
>
> No analytics. No telemetry. No remote code. The extension talks only to your own vault.ochk.io account.

**Support / homepage:** `https://vault.ochk.io`

## 5. Privacy practices — pre-written answers

**Single purpose:**

> A password manager: it unlocks the user's OrangeCheck vault and autofills their saved logins on the sites those logins belong to.

**Permission justifications:**

| Permission                                          | Justification                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                           | Caches the user's _encrypted_ vault blobs (ciphertext only) and non-secret settings locally, so the popup opens without a full re-sync.         |
| `alarms`                                            | Drives the idle auto-lock timer that re-locks the vault after inactivity.                                                                       |
| host `https://vault.ochk.io/*`, `https://ochk.io/*` | To sync the user's own encrypted vault from their OrangeCheck account.                                                                          |
| content script `<all_urls>`                         | To detect login forms and offer autofill on whatever site the user has a saved credential for. The content script never receives the vault key. |

**Remote code:** No — the extension executes only the code in its package.

**Data usage / collection:** The extension does **not** collect, transmit,
or sell user data to the developer or any third party. It communicates
solely with the user's own `vault.ochk.io` account to sync their
encrypted vault. There is no analytics and no telemetry. Decrypted secrets
never leave the user's browser memory; only ciphertext is ever stored or
sent.

## 6. After it is live

- Record the Chrome Web Store and AMO listing URLs.
- Update `vault.ochk.io` to link to them (task #78) so users can install
  it from the product page.
- Add an `oc-vault-extension` row to the family table in
  `~/Projects/ochk/CLAUDE.md`.
- Tag the release in git (`v0.1.0`).

## 7. Open items before v1.0

Tracked in `PLAN.md` §9 (Phase 4): passkey unlock, the password
generator, "stay unlocked", the full Public Suffix List, and a
reproducible-build attestation. None block a `0.1.0` beta submission, but
the PSL swap should land before a `1.0` that markets phishing resistance.
