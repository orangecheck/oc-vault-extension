/**
 * Content script — autofill (PLAN.md §5, SECURITY.md §4–5).
 *
 * Runs in every frame of every page. It is the UNTRUSTED-ADJACENT actor:
 * it never holds the vault key or the entry index. It detects login forms,
 * draws a non-spoofable affordance, and — only after the user clicks it —
 * asks the worker which entries match THIS frame's origin and, on a pick,
 * for that one entry's field values to fill.
 *
 * The iframe rule is structural: this script runs per-frame, so every
 * `match-page` carries the frame's own `location`, never the parent's.
 */

import type { VaultEntrySummary } from '@/lib/crypto';
import { detectLoginForms, type LoginForm } from '@/lib/forms';
import { send } from '@/lib/messaging';

export default defineContentScript({
    matches: ['<all_urls>'],
    allFrames: true,
    runAt: 'document_idle',
    main() {
        if (typeof document === 'undefined') return;

        /** Affordance host elements, keyed by the field they sit on. */
        const affordances = new WeakMap<HTMLInputElement, HTMLElement>();
        let picker: HTMLElement | null = null;
        let savePrompt: HTMLElement | null = null;

        const ORANGE = '#ea580c';

        /* ── filling ────────────────────────────────────────────────────── */

        /** Set an input's value so framework-controlled inputs notice. */
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
                // resolution failed (re-locked, etc.) — leave the form be
            }
            closePicker();
        }

        /* ── the picker ─────────────────────────────────────────────────── */

        function closePicker(): void {
            picker?.remove();
            picker = null;
        }

        function pickerPanel(root: ShadowRoot): HTMLElement {
            root.innerHTML = '';
            const style = document.createElement('style');
            style.textContent = `
                .panel { font: 12px ui-monospace,SFMono-Regular,Menlo,monospace;
                    background:#141414; color:#e5e5e5; border:1px solid #2a2a2a;
                    border-radius:6px; width:240px; overflow:hidden;
                    box-shadow:0 8px 28px rgba(0,0,0,.55); }
                .head { padding:7px 10px; border-bottom:1px solid #2a2a2a;
                    color:#8a8a8a; font-size:9.5px; letter-spacing:.14em;
                    text-transform:uppercase; }
                .head strong { color:${ORANGE}; }
                .msg { padding:12px 10px; color:#8a8a8a; line-height:1.5; }
                .row { display:block; width:100%; text-align:left; cursor:pointer;
                    background:none; border:none; border-bottom:1px solid #2a2a2a;
                    color:#e5e5e5; font:inherit; padding:9px 10px; }
                .row:last-child { border-bottom:none; }
                .row:hover { background:#1f1f1f; }
                .row .t { color:#8a8a8a; font-size:9px; letter-spacing:.12em;
                    text-transform:uppercase; margin-left:6px; }
                .who { padding:0 10px 10px; color:#e5e5e5; word-break:break-all; }
                .actions { display:flex; gap:6px; padding:8px 10px;
                    border-top:1px solid #2a2a2a; }
                .act { flex:1; cursor:pointer; font:inherit; font-size:11px;
                    padding:7px; border-radius:4px; border:1px solid #2a2a2a;
                    background:none; color:#e5e5e5; }
                .act:hover { border-color:${ORANGE}; }
                .act-primary { background:${ORANGE}; color:#fff; border-color:${ORANGE}; }
            `;
            root.append(style);
            const panel = document.createElement('div');
            panel.className = 'panel';
            const head = document.createElement('div');
            head.className = 'head';
            head.innerHTML = 'oc <strong>vault</strong>';
            panel.append(head);
            root.append(panel);
            return panel;
        }

        function message(panel: HTMLElement, text: string): void {
            const div = document.createElement('div');
            div.className = 'msg';
            div.textContent = text;
            panel.append(div);
        }

        async function openPicker(form: LoginForm, anchor: HTMLInputElement): Promise<void> {
            closePicker();
            const host = document.createElement('div');
            const rect = anchor.getBoundingClientRect();
            host.style.cssText = `position:fixed; z-index:2147483647; left:${rect.left}px; top:${
                rect.bottom + 4
            }px;`;
            const root = host.attachShadow({ mode: 'closed' });
            document.body.append(host);
            picker = host;

            const panel = pickerPanel(root);
            message(panel, 'checking your vault…');

            try {
                const state = await send({ kind: 'get-state' });
                if (state.status !== 'unlocked') {
                    panel.lastElementChild?.remove();
                    message(panel, 'OC Vault is locked — open the OC toolbar icon to unlock it.');
                    return;
                }
                const matches = await send({ kind: 'match-page', pageUrl: location.href });
                panel.lastElementChild?.remove();
                renderMatches(panel, matches, form);
            } catch {
                panel.lastElementChild?.remove();
                message(panel, 'could not reach the vault.');
            }
        }

        function renderMatches(
            panel: HTMLElement,
            matches: VaultEntrySummary[],
            form: LoginForm
        ): void {
            if (matches.length === 0) {
                message(panel, 'no saved logins for this site.');
                return;
            }
            for (const entry of matches) {
                const row = document.createElement('button');
                row.className = 'row';
                row.textContent = entry.name;
                const tag = document.createElement('span');
                tag.className = 't';
                tag.textContent = entry.type;
                row.append(tag);
                row.addEventListener('click', () => void fillEntry(form, entry.id));
                panel.append(row);
            }
        }

        /* ── save prompt (capture, PLAN.md §6) ──────────────────────────── */

        function closePrompt(): void {
            savePrompt?.remove();
            savePrompt = null;
        }

        function showSavePrompt(info: {
            mode: 'new' | 'update';
            host: string;
            username: string;
        }): void {
            // After a navigation the prompt has no anchor field — show it
            // toast-style, and only in the top frame.
            if (window.top !== window) return;
            closePrompt();
            const host = document.createElement('div');
            host.style.cssText = 'position:fixed; z-index:2147483647; right:16px; bottom:16px;';
            const root = host.attachShadow({ mode: 'closed' });
            document.body.append(host);
            savePrompt = host;

            const panel = pickerPanel(root);
            const msg = document.createElement('div');
            msg.className = 'msg';
            msg.textContent =
                info.mode === 'update'
                    ? `Update the saved login for ${info.host}?`
                    : `Save this login for ${info.host} to OC Vault?`;
            panel.append(msg);
            if (info.username) {
                const who = document.createElement('div');
                who.className = 'who';
                who.textContent = info.username;
                panel.append(who);
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
                    .catch(() => {
                        msg.textContent = 'could not save — open the OC popup and retry.';
                    });
            });
            actions.append(dismiss, save);
            panel.append(actions);
        }

        /** On a login submit, hand the typed values to the worker to judge. */
        function onSubmit(): void {
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

        /* ── the field affordance ───────────────────────────────────────── */

        function attachAffordance(field: HTMLInputElement, form: LoginForm): void {
            if (affordances.has(field)) return;
            const host = document.createElement('div');
            host.style.cssText =
                'position:fixed; z-index:2147483646; width:18px; height:18px; pointer-events:auto;';
            const root = host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = `
                .mark { width:18px; height:18px; border-radius:4px; cursor:pointer;
                    background:${ORANGE}; display:flex; align-items:center;
                    justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,.4); }
                .mark span { width:7px; height:7px; border:2px solid #fff;
                    border-radius:50%; }
            `;
            const mark = document.createElement('div');
            mark.className = 'mark';
            mark.title = 'fill with OC Vault';
            mark.append(document.createElement('span'));
            mark.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                void openPicker(form, field);
            });
            root.append(style, mark);
            document.body.append(host);

            affordances.set(field, host);
            positionHost(host, field);
        }

        function positionHost(host: HTMLElement, field: HTMLInputElement): void {
            const rect = field.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || !field.isConnected) {
                host.style.display = 'none';
                return;
            }
            host.style.display = '';
            host.style.left = `${rect.right - 22}px`;
            host.style.top = `${rect.top + (rect.height - 18) / 2}px`;
        }

        /** Re-place every affordance over its (re-detected) field. */
        function repositionAll(): void {
            for (const form of detectLoginForms()) {
                for (const field of form.fields) {
                    const host = affordances.get(field.element);
                    if (host) positionHost(host, field.element);
                }
            }
        }

        /* ── scan + observe ─────────────────────────────────────────────── */

        function scan(): void {
            for (const form of detectLoginForms()) {
                for (const field of form.fields) attachAffordance(field.element, form);
            }
            repositionAll();
        }

        let scanTimer: ReturnType<typeof setTimeout> | null = null;
        function scheduleScan(): void {
            if (scanTimer) clearTimeout(scanTimer);
            scanTimer = setTimeout(scan, 300);
        }

        window.addEventListener('scroll', repositionAll, { capture: true, passive: true });
        window.addEventListener('resize', repositionAll, { passive: true });
        // Dismiss the picker on an outside click.
        window.addEventListener(
            'click',
            (e) => {
                if (picker && e.target !== picker) closePicker();
            },
            { capture: true }
        );
        // Capture a login on submit — fires even when the page's own handler
        // calls preventDefault (SPA logins), and before a real navigation.
        window.addEventListener('submit', onSubmit, { capture: true });
        new MutationObserver(scheduleScan).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        scan();

        // A login submitted just before a navigation surfaces its save
        // prompt here, on the page it landed on.
        if (window.top === window) {
            void send({ kind: 'get-pending-capture', pageUrl: location.href })
                .then((r) => {
                    if (r.pending) showSavePrompt(r.pending);
                })
                .catch(() => undefined);
        }
    },
});
