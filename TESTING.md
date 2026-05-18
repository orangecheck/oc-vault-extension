# Loading & testing oc-vault-extension

Click-by-click: how to build the extension, load it into a browser, and
exercise every feature. Do this before any store submission
(`PUBLISHING.md`).

---

## 1. One-time setup

```sh
cd ~/Projects/ochk/oc-vault-extension
npm install
```

`npm install` also runs `wxt prepare` (generates `.wxt/`). You only need
this once (and after a `git pull` that changes dependencies).

## 2. Build

```sh
npm run build
```

This writes the loadable extension to **`.output/chrome-mv3/`**.

## 3. Load it into Chrome

**Use your normal Chrome** — the one where you are (or can be) signed in
to `vault.ochk.io`. The extension authenticates with your existing
OrangeCheck session cookie; a fresh/empty Chrome profile has no session.

1. Open Chrome.
2. In the address bar type **`chrome://extensions`** and press Enter.
3. Top-right — turn **Developer mode** ON.
4. Click **Load unpacked** (top-left).
5. In the file picker, select the folder:
   `~/Projects/ochk/oc-vault-extension/.output/chrome-mv3`
   (select the **chrome-mv3 folder itself**, then "Select").
6. An **OC Vault** card appears. Click the **puzzle-piece** icon in the
   Chrome toolbar, then the **pin** next to "OC Vault" so its icon stays
   visible.

## 4. Test — the full path

1. **Be signed in.** Open `https://vault.ochk.io` in a tab; if it shows
   your vault (or asks for your passphrase), you're signed in. If it asks
   you to sign in, do that first.
2. **Open the popup.** Click the pinned OC Vault toolbar icon.
    - "sign in at ochk.io" → you're not signed in (see step 1).
    - a passphrase field → good, continue.
3. **Unlock.** Enter your vault passphrase → **unlock**. The entry list
   appears.
4. **Browse.** Type in the search box. Click an entry → the **detail**
   view: secret fields are masked — click **show** to reveal, **copy** to
   copy. Click **← back**.
5. **Settings.** Click **settings** (top of the popup) → set **auto-lock
   when idle** to `5 min`. Click **← back**.
6. **Autofill.** Open a website you have a saved login for. Click into its
   username or password field — a small **orange OC mark** appears at the
   field's right edge. Click it → a picker lists the matching entry →
   click the entry → the username and password fill in.
7. **Origin safety.** Open a _different_ website. Click the OC mark on its
   login field → the picker should say **"no saved logins for this
   site."** (This is the phishing-resistance check — a credential is
   offered only on its own site.)
8. **Capture.** Log in to a site you do **not** have saved. After you
   submit the login, a **"Save this login?"** prompt appears bottom-right.
   Click **save** → open `vault.ochk.io` and confirm the new entry is
   there.
9. **Lock.** Click **lock** in the popup. Re-open it → the unlock gate
   shows. (It also auto-locks after the idle timeout from step 5.)

## 5. After you change code

```sh
npm run build
```

Then on `chrome://extensions`, click the **↻ refresh** icon on the OC
Vault card. (Or use `npm run dev` — see below — for automatic reload.)

## 6. `npm run dev` (live-reload, optional)

```sh
npm run dev
```

WXT opens a **separate** Chrome window with the extension loaded and
hot-reload on. Because it is a fresh profile, sign in to `ochk.io` inside
that window before testing the vault.

## 7. Firefox

```sh
npm run build:firefox
```

Then: Firefox → `about:debugging` → **This Firefox** → **Load Temporary
Add-on** → select `.output/firefox-mv2/manifest.json`. (Temporary add-ons
clear on restart — reload them the same way.)

## 8. If something's wrong

- **Popup says "signed out" but you ARE signed in at ochk.io** — note it
  and report it: there is a browser-cookie scoping case (`SameSite`) to
  verify for extension-origin requests.
- **No OC mark on a login field** — the form may not be detected
  (`lib/forms.ts` heuristics); note the site.
- **Autofill doesn't stick in a React/Vue field** — note the site; the
  fill uses the native value setter but some widgets need more.
- **Inspect the worker** — `chrome://extensions` → OC Vault → "service
  worker" link opens its console. The popup: right-click the popup →
  Inspect.
