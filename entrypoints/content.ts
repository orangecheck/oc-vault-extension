/**
 * Content script — autofill + capture (PLAN.md §5–6, SECURITY.md §4–5).
 *
 * Runs in every frame. The UNTRUSTED-ADJACENT actor: it never holds the
 * vault key or the entry index. It draws a subtle affordance on a
 * *focused* login field, fills on a user pick, and offers to save a
 * submitted login. The iframe rule is structural — per-frame injection
 * means every `match-page` carries this frame's own origin.
 */

import type { VaultEntrySummary } from '@/lib/crypto';
import { detectLoginForms, type LoginForm } from '@/lib/forms';
import { send } from '@/lib/messaging';

const ORANGE = '#ea580c';
const Z = '2147483646';

export default defineContentScript({
    matches: ['<all_urls>'],
    allFrames: true,
    runAt: 'document_idle',
    main() {
        if (typeof document === 'undefined') return;

        // Settings — fetched once; the affordance and capture honour them.
        let showFieldIcon = true;
        let captureEnabled = true;
        void send({ kind: 'get-settings' })
            .then((s) => {
                showFieldIcon = s.showFieldIcon;
                captureEnabled = s.captureEnabled;
            })
            .catch(() => undefined);

        /** Detected login field → its form. Rebuilt on each scan. */
        let fieldForm = new WeakMap<HTMLInputElement, LoginForm>();
        let picker: HTMLElement | null = null;
        let savePrompt: HTMLElement | null = null;

        /* ── filling ────────────────────────────────────────────────────── */

        function setValue(input: HTMLInputElement, value: string): void {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value'
            )?.set;
            if (setter) setter.call(input, value);
            else input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        async function fillEntry(form: LoginForm, entryId: string): Promise<void> {
            try {
                const { values } = await send({
                    kind: 'fill-values',
                    entryId,
                    fields: ['username', 'password'],
                });
                for (const field of form.fields) {
                    const value = values[field.role];
                    if (value) setValue(field.element, value);
                }
            } catch {
                // resolution failed (re-locked) — leave the form be
            }
            closePicker();
        }

        /* ── shared shadow-DOM panel chrome ─────────────────────────────── */

        /** Build the panel chrome (style + header) inside a shadow root. */
        function panel(root: ShadowRoot): HTMLElement {
            root.innerHTML = '';
            const style = document.createElement('style');
            style.textContent = `
                .panel { font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
                    background:#141414; color:#e5e5e5; border:1px solid #2a2a2a;
                    border-radius:8px; width:264px; overflow:hidden;
                    box-shadow:0 10px 32px rgba(0,0,0,.55); }
                .head { display:flex; align-items:center; gap:6px; padding:8px 11px;
                    border-bottom:1px solid #2a2a2a; color:#8a8a8a; font-size:9.5px;
                    letter-spacing:.16em; text-transform:uppercase; }
                .head svg { display:block; }
                .head strong { color:${ORANGE}; }
                .msg { padding:11px; color:#9a9a9a; line-height:1.55; }
                .who { padding:0 11px 10px; color:#e5e5e5; word-break:break-all; }
                .row { display:flex; align-items:center; gap:8px; width:100%;
                    text-align:left; cursor:pointer; background:none; border:none;
                    border-bottom:1px solid #2a2a2a; color:#e5e5e5; font:inherit;
                    padding:10px 11px; }
                .row:last-child { border-bottom:none; }
                .row:hover { background:#1f1f1f; }
                .row .t { margin-left:auto; color:#8a8a8a; font-size:9px;
                    letter-spacing:.12em; text-transform:uppercase; }
                .actions { display:flex; gap:7px; padding:9px 11px;
                    border-top:1px solid #2a2a2a; }
                .act { flex:1; cursor:pointer; font:inherit; font-size:11px;
                    padding:8px; border-radius:5px; border:1px solid #2a2a2a;
                    background:none; color:#e5e5e5; }
                .act:hover { border-color:${ORANGE}; }
                .act-primary { background:${ORANGE}; color:#fff; border-color:${ORANGE}; }
            `;
            root.append(style);
            const wrap = document.createElement('div');
            wrap.className = 'panel';
            const head = document.createElement('div');
            head.className = 'head';
            head.innerHTML = `${markSvg(13, '#8a8a8a')}<span>oc <strong>vault</strong></span>`;
            wrap.append(head);
            root.append(wrap);
            return wrap;
        }

        function panelMessage(p: HTMLElement, text: string): void {
            const div = document.createElement('div');
            div.className = 'msg';
            div.textContent = text;
            p.append(div);
        }

        /** The OC keyhole mark, drawn at `size` px in `color`. */
        function markSvg(size: number, color: string): string {
            return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}" aria-hidden="true"><circle cx="12" cy="9" r="4.3"/><path d="M9.3 12 h5.4 l1.5 8 h-8.4 z"/></svg>`;
        }

        /* ── the picker ─────────────────────────────────────────────────── */

        function closePicker(): void {
            picker?.remove();
            picker = null;
        }

        async function openPicker(form: LoginForm, anchor: HTMLInputElement): Promise<void> {
            closePicker();
            const host = document.createElement('div');
            const rect = anchor.getBoundingClientRect();
            host.style.cssText = `position:fixed; z-index:${Z}; left:${Math.max(
                8,
                rect.left
            )}px; top:${rect.bottom + 5}px;`;
            const root = host.attachShadow({ mode: 'closed' });
            document.body.append(host);
            picker = host;

            const p = panel(root);
            panelMessage(p, 'checking your vault…');
            try {
                const state = await send({ kind: 'get-state' });
                p.lastElementChild?.remove();
                if (state.status !== 'unlocked') {
                    panelMessage(p, 'OC Vault is locked — open the OC toolbar icon to unlock.');
                    return;
                }
                if (state.entryCount === 0) {
                    panelMessage(
                        p,
                        'No synced entries — open the OC toolbar icon to check your vault.'
                    );
                    return;
                }
                const matches = await send({ kind: 'match-page', pageUrl: location.href });
                renderMatches(p, matches, form);
            } catch {
                p.lastElementChild?.remove();
                panelMessage(p, 'could not reach the vault.');
            }
        }

        function renderMatches(
            p: HTMLElement,
            matches: VaultEntrySummary[],
            form: LoginForm
        ): void {
            if (matches.length === 0) {
                panelMessage(p, 'no saved logins for this site.');
                return;
            }
            for (const entry of matches) {
                const row = document.createElement('button');
                row.className = 'row';
                row.innerHTML = `${markSvg(12, ORANGE)}<span></span><span class="t"></span>`;
                (row.querySelector('span:not(.t)') as HTMLElement).textContent = entry.name;
                (row.querySelector('.t') as HTMLElement).textContent = entry.type;
                row.addEventListener('click', () => void fillEntry(form, entry.id));
                p.append(row);
            }
        }

        /* ── the field affordance — subtle, focus-triggered ─────────────── */

        let affordance: HTMLElement | null = null;
        let affordanceField: HTMLInputElement | null = null;
        let hideTimer: ReturnType<typeof setTimeout> | null = null;

        function ensureAffordance(): HTMLElement {
            if (affordance) return affordance;
            const host = document.createElement('div');
            host.style.cssText = `position:fixed; z-index:${Z}; display:none;`;
            const root = host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = `
                .mark { width:20px; height:20px; padding:0; border:none;
                    background:transparent; cursor:pointer; display:flex;
                    align-items:center; justify-content:center; color:#8b8b8b;
                    opacity:.65; transition:opacity .12s,color .12s; }
                .mark:hover, .mark:focus-visible { color:${ORANGE}; opacity:1;
                    outline:none; }
            `;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mark';
            btn.title = 'OC Vault — fill a saved login';
            btn.setAttribute('aria-label', 'fill with OC Vault');
            btn.innerHTML = markSvg(15, 'currentColor');
            // Keep the field focused when the mark is pressed.
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (affordanceField) {
                    const form = fieldForm.get(affordanceField);
                    if (form) void openPicker(form, affordanceField);
                }
            });
            root.append(style, btn);
            document.body.append(host);
            affordance = host;
            return host;
        }

        function placeAffordance(field: HTMLInputElement): void {
            const host = ensureAffordance();
            const r = field.getBoundingClientRect();
            if (r.width < 24 || r.height < 12) {
                host.style.display = 'none';
                return;
            }
            host.style.display = '';
            host.style.left = `${r.right - 24}px`;
            host.style.top = `${r.top + (r.height - 20) / 2}px`;
        }

        function showAffordance(field: HTMLInputElement): void {
            if (!showFieldIcon) return;
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            affordanceField = field;
            placeAffordance(field);
        }

        function hideAffordanceSoon(): void {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (affordance) affordance.style.display = 'none';
                affordanceField = null;
            }, 200);
        }

        function repositionAffordance(): void {
            if (affordanceField && affordance && affordance.style.display !== 'none') {
                placeAffordance(affordanceField);
            }
        }

        /* ── capture save prompt (PLAN.md §6) ───────────────────────────── */

        function closePrompt(): void {
            savePrompt?.remove();
            savePrompt = null;
        }

        function showSavePrompt(info: {
            mode: 'new' | 'update';
            host: string;
            username: string;
        }): void {
            if (window.top !== window) return; // top frame only
            closePrompt();
            const host = document.createElement('div');
            // Top-right, near the toolbar — not a bottom-of-page banner.
            host.style.cssText = `position:fixed; z-index:${Z}; right:14px; top:14px;`;
            const root = host.attachShadow({ mode: 'closed' });
            document.body.append(host);
            savePrompt = host;

            const p = panel(root);
            const msg = document.createElement('div');
            msg.className = 'msg';
            msg.textContent =
                info.mode === 'update'
                    ? `Update the saved login for ${info.host}?`
                    : `Save this login for ${info.host} to OC Vault?`;
            p.append(msg);
            if (info.username) {
                const who = document.createElement('div');
                who.className = 'who';
                who.textContent = info.username;
                p.append(who);
            }
            const actions = document.createElement('div');
            actions.className = 'actions';
            const dismiss = document.createElement('button');
            dismiss.className = 'act';
            dismiss.textContent = 'not now';
            dismiss.addEventListener('click', () => {
                void send({ kind: 'dismiss-capture' }).catch(() => undefined);
                closePrompt();
            });
            const save = document.createElement('button');
            save.className = 'act act-primary';
            save.textContent = info.mode === 'update' ? 'update' : 'save';
            save.addEventListener('click', () => {
                save.textContent = 'saving…';
                void send({ kind: 'commit-capture' })
                    .then(() => closePrompt())
                    .catch((err: unknown) => {
                        save.textContent = info.mode === 'update' ? 'update' : 'save';
                        msg.textContent = /locked/i.test(String(err))
                            ? 'OC Vault is locked — unlock it (the popup is opening) to save this login.'
                            : 'could not save — try again.';
                    });
            });
            actions.append(dismiss, save);
            p.append(actions);
        }

        /** On a login submit, hand the typed values to the worker to judge. */
        function onSubmit(): void {
            if (!captureEnabled) return;
            for (const form of detectLoginForms()) {
                const pw = form.fields.find((f) => f.role === 'password')?.element;
                if (!pw || !pw.value) continue;
                const user = form.fields.find((f) => f.role === 'username')?.element;
                void send({
                    kind: 'capture-login',
                    url: location.href,
                    username: user?.value ?? '',
                    password: pw.value,
                })
                    .then((r) => {
                        if (r.decision !== 'none') {
                            showSavePrompt({
                                mode: r.decision,
                                host: r.host,
                                username: r.username,
                            });
                        }
                    })
                    .catch(() => undefined);
                return;
            }
        }

        /* ── scan + listeners ───────────────────────────────────────────── */

        function scan(): void {
            const next = new WeakMap<HTMLInputElement, LoginForm>();
            for (const form of detectLoginForms()) {
                for (const field of form.fields) next.set(field.element, form);
            }
            fieldForm = next;
        }

        let scanTimer: ReturnType<typeof setTimeout> | null = null;
        function scheduleScan(): void {
            if (scanTimer) clearTimeout(scanTimer);
            scanTimer = setTimeout(scan, 300);
        }

        // The affordance appears only when a recognised login field is
        // focused — keyboard, mouse or touch all fire `focusin`.
        document.addEventListener(
            'focusin',
            (e) => {
                const t = e.target;
                if (t instanceof HTMLInputElement && fieldForm.has(t)) showAffordance(t);
            },
            { capture: true }
        );
        document.addEventListener(
            'focusout',
            (e) => {
                const t = e.target;
                if (t instanceof HTMLInputElement && fieldForm.has(t)) hideAffordanceSoon();
            },
            { capture: true }
        );
        window.addEventListener('scroll', repositionAffordance, {
            capture: true,
            passive: true,
        });
        window.addEventListener('resize', repositionAffordance, { passive: true });
        window.addEventListener(
            'click',
            (e) => {
                if (picker && e.target !== picker) closePicker();
            },
            { capture: true }
        );
        window.addEventListener('submit', onSubmit, { capture: true });
        new MutationObserver(scheduleScan).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        scan();

        // A login submitted just before a navigation surfaces its prompt
        // here, on the page it landed on.
        if (window.top === window) {
            void send({ kind: 'get-pending-capture', pageUrl: location.href })
                .then((r) => {
                    if (r.pending) showSavePrompt(r.pending);
                })
                .catch(() => undefined);
        }
    },
});
