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

**Reach.** A Chrome Web Store listing installs natively on every major
Chromium browser — **Brave, Arc, Vivaldi, Opera**, and any other
CWS-compatible Chromium fork — without a second submission. Brave in
particular fetches and installs CWS extensions seamlessly; there is no
Brave extension store to mirror to. The CWS listing is the canonical
install path for ~85% of desktop users.

**Edge Add-ons (optional, recommended).** Microsoft Edge users _can_
install from the Chrome Web Store but Edge nudges them toward its own
store with a warning banner. A separate submission at
<https://partner.microsoft.com/dashboard/microsoftedge/overview> uses
the **same `-chrome.zip`** artifact; the account is free, review is
usually 24–48 h. Reuse the §4 listing copy verbatim (Edge accepts the
same description and screenshots).

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

## 4. Store listing copy — paste-ready

The same copy works across Chrome Web Store, Edge Add-ons, and Firefox AMO;
each store's character limits and required fields are called out below.
**Copy these verbatim** at submission time.

### Name (CWS ≤45 · Edge ≤50 · AMO ≤50)

```
OC Vault
```

### Short description / summary (CWS ≤132 · Edge ≤132 · AMO ≤250)

```
End-to-end encrypted password manager. Origin-bound autofill, no custody, no telemetry. Pairs with vault.ochk.io.
```

### Long description (CWS ≤16 000 · Edge ≤10 000 · AMO ≤15 000)

```
OC Vault is the browser companion to vault.ochk.io — a password manager
that physically cannot read your data.

Unlock your vault once and it is there in every tab: browse and copy your
entries from the toolbar popup, and autofill saved logins on the sites
they belong to.

• End-to-end encrypted. Your vault key is derived from your passphrase
  and never leaves your browser's memory. OrangeCheck stores ciphertext
  only — it cannot decrypt your vault.
• Origin-bound autofill. A credential is offered only on the exact site
  it was saved on, so look-alike phishing domains simply get nothing.
• Capture as you go. Log in somewhere new and OC Vault offers to save
  it; an unchanged password is never re-prompted.
• Live TOTP. Authenticator codes rotate in the popup and copy with one
  click.
• Locks itself. The vault re-locks when idle and whenever the browser
  suspends the extension. The key never touches disk.
• No account here, no second vault. The same vault as vault.ochk.io —
  set up, billing, and recovery live there. Sign in with your Bitcoin
  wallet (BIP-322) or with email-OTP.

No analytics. No telemetry. No remote code. The extension talks only to
your own vault.ochk.io account; OrangeCheck only ever serves ciphertext.

Open source, MIT licensed. Reproducible build. Audited crypto: AES-256-GCM
under a scrypt-derived (N=2^17) key.

Learn more — https://docs.ochk.io/vault/extension
Source     — https://github.com/orangecheck/oc-vault-extension
Privacy    — https://ochk.io/privacy
```

### Category

| Store            | Category                         |
| ---------------- | -------------------------------- |
| Chrome Web Store | **Productivity**                 |
| Edge Add-ons     | **Productivity** (sub: Security) |
| Firefox AMO      | **Privacy & Security**           |

### Search terms / keywords (CWS allows 5; AMO uses a 50-char-each tag list)

```
password manager, autofill, bitcoin, end-to-end encryption, zero-knowledge
```

### Required URLs

| Field          | Value                        |
| -------------- | ---------------------------- |
| Homepage       | `https://vault.ochk.io`      |
| Support        | `https://docs.ochk.io/vault` |
| Privacy policy | `https://ochk.io/privacy`    |
| Source (AMO)   | upload `-sources.zip` per §3 |

### Visual assets

| Asset                         | Size / format                        | Notes                                                                          |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| **Screenshots** (≥1, ≤5)      | 1280×800 or 640×400, PNG             | The popup entry list; the in-field OC mark on a login form; the unlock screen. |
| Small promo tile (CWS opt.)   | 440×280, PNG                         | Orange tile + keyhole; reuse the toolbar icon scaled up.                       |
| Marquee promo tile (CWS opt.) | 1400×560, PNG                        | Same brand; required only if featured. Skippable for v1.                       |
| AMO icon                      | 128×128, PNG (`public/icon/128.png`) | Already in the repo.                                                           |
| AMO header image (optional)   | 1680×340, PNG                        | Skippable for v1.                                                              |

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

**Firefox AMO data-consent declaration.** As of 2026, AMO requires every
new MV3 submission to declare its `browser_specific_settings.gecko.data_collection_permissions`.
OC Vault declares as **`required`** (the user cannot opt out — these are
the categories of data sealed inside the encrypted blobs the extension
syncs):

| Category                  | Why                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `authenticationInfo`      | The whole product purpose — saved logins, TOTP seeds, API keys.                                     |
| `personalIdentifyingInfo` | The `identity` entry type + the signed-in OC identity itself.                                       |
| `financialAndPaymentInfo` | The `card` entry type.                                                                              |
| `websiteContent`          | Capture reads values the user just typed into a login form; `note` entries store user-typed text.   |
| `websiteActivity`         | Origin matching reads `location.href` to decide whether to offer a credential for the current site. |

All five are E2E-encrypted under a key derived from the user's passphrase
before transmission; OrangeCheck holds ciphertext only. AMO wants the
_contents_ of the ciphertext disclosed regardless of encryption, which is
what these declarations describe. Matches the Chrome Web Store data-usage
checkboxes in §5.

**Spelling note.** The PII category is `personallyIdentifyingInfo` (the
double-L "personally"), not `personalIdentifyingInfo` — the latter fails
AMO's manifest validation.

**innerHTML warnings.** AMO's linter flags any `innerHTML` write as a
warning. The extension's own content script is free of `innerHTML` —
every SVG mark is built via `document.createElementNS`. Two remaining
warnings sit inside React 19's compiled bundle (its HTML-parsing
detection probe + one reconciler path); they are not in our code and
do not block submission.

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
