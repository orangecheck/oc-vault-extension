# oc-vault-extension — security model

A browser extension that fills passwords is a high-value target. This
document is the threat model and the set of invariants the code must hold.
A change that violates §3 is a security regression regardless of what else
it does.

## 1. Assets

| Asset                                                          | Sensitivity                     | Where it is allowed to exist                                           |
| -------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Vault key `K` (32 bytes)                                       | critical                        | service-worker memory + `storage.session` (RAM, never disk), unlocked  |
| Vault passphrase                                               | critical                        | in transit through the popup → worker, then discarded                  |
| Decrypted entry fields (passwords, seed phrases, TOTP secrets) | critical                        | worker memory, transiently; one field in a content script at fill time |
| Ciphertext blobs                                               | low (server already holds them) | may be cached in `chrome.storage.local`                                |
| Entry metadata index (names, types, origins)                   | moderate                        | worker memory; popup, while open                                       |
| The `oc_session` cookie                                        | high                            | the browser's cookie store; never read by extension code               |

## 2. Trust boundaries

MV3's three worlds are the trust boundaries, deliberately:

- **Service worker** — the trusted core. Holds `K`. No DOM, no page
  contact. The only component that decrypts.
- **Popup** — semi-trusted. Extension-origin document, but a UI surface.
  Receives decrypted _metadata_ and, on request, one entry's fields. Holds
  nothing at rest.
- **Content script** — **untrusted-adjacent.** Shares a process-adjacent
  context with a hostile page. Treated as compromised in the threat model:
  it never holds `K` or the index, and the worst a fully-compromised
  content script can do is what the _page's own origin_ could already do —
  see §3 invariant 2 and §5.

Messages cross these boundaries through `lib/messaging.ts`. Every message
is treated as attacker-controlled and validated on receipt — including
messages _from_ the content script, which a hostile page may influence.

## 3. Invariants (load-bearing — do not break)

1. **`K` is never written to disk and never leaves the extension's trusted
   contexts.** While unlocked it lives in the service worker's memory and
   is mirrored into `storage.session` — RAM only, wiped on browser close —
   so it survives MV3 worker restarts (PLAN.md §7). It is never put in
   `storage.local`, IndexedDB, a message to the content script, a DOM, or
   a log.
2. **The content script never receives `K` or the full entry index.**
   After the user clicks the affordance (a gesture) it receives the
   **origin-matched summaries** for this page — names / types / urls, no
   secret — to render the picker; on a pick it receives that one entry's
   requested field **values**. Nothing else, ever — no unmatched entry, no
   unpicked entry's secret.
3. **No plaintext secret at rest.** The disk-backed stores —
   `storage.local` and IndexedDB — hold only ciphertext and non-secret
   settings. The one exception is `K` in the RAM-only `storage.session`
   (invariant 1), which never touches disk. A decrypted entry is never
   persisted anywhere.
4. **No fill, save, reveal, or copy without a user gesture.** The extension
   never auto-submits a form.
5. **A credential crosses into a page only when the page's (or filled
   frame's) origin matches the credential's stored origin** (§4).
6. **No remote code, no telemetry, no analytics.** The extension makes
   network requests to `vault.ochk.io` / `ochk.io` only. The build
   contains no `eval`, no remotely-loaded script.

CI / review must reject a diff that puts `K` or a decrypted field into a
message to the content script, into `storage`, or into a log.

## 4. Origin matching — the autofill trust check

A stored entry carries the URL it was saved on. `lib/origin.ts` decides
whether an entry may be offered on a given page.

- Compare by **registrable domain (eTLD+1)** using the Public Suffix List,
  with an **exact-origin** match preferred and surfaced first.
- **Scheme matters:** an `https` entry is never offered on `http`.
- **No path matching, no subdomain wildcards, no fuzzy/Levenshtein
  matching, no user-editable allowlist of "equivalent" domains** in v1.
  Each is a phishing vector; their absence is the design.
- A frame is filled only if **that frame's own origin** matches — never
  the top document's origin (§5).

Because credentials are origin-bound, a look-alike domain (`paypa1.com`)
simply has no matching entry. Phishing resistance is structural.

## 5. Threats & mitigations

- **Phishing / look-alike domains** — origin matching (§4); no fuzzy match.
- **Cross-origin iframe credential theft** — a frame receives a credential
  only if its _own_ origin matches; a parent-origin credential is never
  filled into a child frame of a different origin.
- **Clickjacking the affordance** — the inline affordance is a
  closed-shadow-DOM element; the page cannot read its state nor synthesize
  the trusted click that authorizes a fill. Fills require an
  `isTrusted` user event.
- **A hostile page scripting the content script** — the content script is
  assumed hostile-influenced; it holds no key and no index, so the blast
  radius of a fully-compromised content script is one field on one
  user-initiated fill.
- **DOM scraping after fill** — once a value is in a field, page JS can
  read it; this is intrinsic to autofill. Mitigated by: fill only on
  gesture, only on matching origin, never into mismatched frames.
- **Capture reads a password** — on a login submit the content script
  reads the values the user just typed into the page's OWN fields and
  sends them to the worker. The page already holds those values, so this
  is no new exposure. The captured password is held only in the worker's
  memory (the pending capture), never persisted, and is written to the
  vault only on an explicit Save click.
- **Service-worker / popup XSS** — no untrusted HTML is rendered; React
  with no `dangerouslySetInnerHTML`; entry names and field values are text
  nodes only. A strict extension CSP (`script-src 'self'`) blocks injected
  script.
- **Malicious extension update / supply chain** — minimal, pinned
  dependencies; reproducible build; `@orangecheck/*` and `@noble/*` only
  for crypto. Release artifacts to be checksummed; see PLAN §4 Phase 4.
- **Device theft while unlocked** — `K` (in RAM) survives only until the
  idle-lock timeout, an explicit lock, or the browser closing; the
  configurable idle timeout bounds the exposure window. `K` never reaches
  disk, so a powered-off / disk-image attack finds only ciphertext.
- **Brute-force of the escrowed `WrappedKey`** — inherited from oc-vault:
  scrypt N=2^17 plus a generated high-entropy passphrase. The extension
  adds no new brute-force surface.
- **Network MITM** — TLS only; `vault.ochk.io` host permission is `https`.
  No plaintext endpoint exists.

## 6. Out of scope (v1)

- A compromised OS / browser, or a malicious other extension with broad
  permissions — outside what any extension can defend against.
- TOTP autofill into the page — TOTP codes are copy-only in v1 (filling a
  rotating code into a page is low-value and widens the content-script
  contract).
- Filling into Shadow DOM / canvas / non-standard login widgets — detected
  best-effort, not guaranteed.

## 7. Reporting

Until a formal channel exists, security issues go to the OrangeCheck
contact path at `ochk.io`. Do not open public issues for vulnerabilities.
