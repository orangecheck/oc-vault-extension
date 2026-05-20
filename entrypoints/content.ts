/**
 * Content script — autofill + capture (PLAN.md §5–6, SECURITY.md §4–5).
 *
 * Runs in every frame. The UNTRUSTED-ADJACENT actor: it never holds the
 * vault key or the entry index. On focusing a login field it shows a
 * small OC mark and — when this site has matching credentials — drops the
 * suggestion list down automatically, the way a password manager should.
 * It fills on a user pick, and offers to save a submitted login.
 *
 * The iframe rule is structural — per-frame injection means every
 * `match-page` carries this frame's own origin (SECURITY.md §4).
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

        // Settings — fetched once. `showFieldIcon` is the master switch for
        // all on-field UI; `menuOnFocus` decides whether the dropdown opens
        // on focus or only on a click of the OC mark.
        let fieldUiEnabled = true;
        let menuOnFocus = true;
        let captureEnabled = true;
        void send({ kind: 'get-settings' })
            .then((s) => {
                fieldUiEnabled = s.showFieldIcon;
                menuOnFocus = s.autofillMenuOnFocus;
                captureEnabled = s.captureEnabled;
            })
            .catch(() => undefined);

        /** Detected login field → its form. Rebuilt on each scan. */
        let fieldForm = new WeakMap<HTMLInputElement, LoginForm>();
        let picker: HTMLElement | null = null;
        let pickerAnchor: HTMLInputElement | null = null;
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

        /* ── the OC keyhole mark (shared by every panel) ────────────────── */

        /**
         * Build the OC keyhole as a fresh SVG element via `createElementNS`.
         * Used by the panel header, the picker rows, and the field mark —
         * each call returns a new node so the caller can `append()` it.
         * (Avoids `innerHTML` so AMO's linter stays clean — every byte of
         * the SVG is fully under our control here.)
         */
        const SVG_NS = 'http://www.w3.org/2000/svg';
        function markIcon(size: number, color: string): SVGSVGElement {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('width', String(size));
            svg.setAttribute('height', String(size));
            svg.setAttribute('viewBox', '0 0 128 128');
            svg.setAttribute('fill', color);
            svg.setAttribute('aria-hidden', 'true');
            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('cx', '64');
            circle.setAttribute('cy', '51');
            circle.setAttribute('r', '22');
            svg.append(circle);
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', 'M55 58 H73 L80 100 H48 Z');
            svg.append(path);
            return svg;
        }

        /* ── shared shadow-DOM panel chrome ─────────────────────────────── */

        /** Build the panel chrome (style + header) inside a shadow root. */
        function panel(root: ShadowRoot): HTMLElement {
            root.replaceChildren();
            const style = document.createElement('style');
            style.textContent = `
                .panel { font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
                    background:#141414; color:#e5e5e5; border:1px solid #2a2a2a;
                    border-radius:8px; width:266px; overflow:hidden;
                    box-shadow:0 12px 34px rgba(0,0,0,.6); }
                .head { display:flex; align-items:center; gap:6px; padding:8px 11px;
                    border-bottom:1px solid #2a2a2a; color:#8a8a8a; font-size:9.5px;
                    letter-spacing:.16em; text-transform:uppercase; }
                .head svg { display:block; }
                .head strong { color:${ORANGE}; }
                .msg { padding:11px; color:#9a9a9a; line-height:1.55; }
                .who { padding:0 11px 10px; color:#e5e5e5; word-break:break-all; }
                .row { display:flex; align-items:center; gap:9px; width:100%;
                    text-align:left; cursor:pointer; background:none; border:none;
                    border-bottom:1px solid #2a2a2a; color:#e5e5e5; font:inherit;
                    padding:10px 11px; }
                .row:last-child { border-bottom:none; }
                .row:hover, .row:focus-visible { background:#1f1f1f; outline:none; }
                .row .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .row .t { margin-left:auto; color:#8a8a8a; font-size:9px;
                    letter-spacing:.12em; text-transform:uppercase; flex-shrink:0; }
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
            head.append(markIcon(13, ORANGE));
            const brand = document.createElement('span');
            brand.append('oc ');
            const strong = document.createElement('strong');
            strong.textContent = 'vault';
            brand.append(strong);
            head.append(brand);
            wrap.append(head);
            root.append(wrap);
            return wrap;
        }

        /** Append a message line; returns it so it can be removed later. */
        function panelMessage(p: HTMLElement, text: string): HTMLElement {
            const div = document.createElement('div');
            div.className = 'msg';
            div.textContent = text;
            p.append(div);
            return div;
        }

        /* ── the picker dropdown ────────────────────────────────────────── */

        function closePicker(): void {
            picker?.remove();
            picker = null;
            pickerAnchor = null;
        }

        function placePicker(host: HTMLElement, anchor: HTMLInputElement): void {
            const r = anchor.getBoundingClientRect();
            const left = Math.max(8, Math.min(r.left, window.innerWidth - 274));
            host.style.left = `${left}px`;
            host.style.top = `${r.bottom + 5}px`;
        }

        /**
         * Open the suggestion dropdown under `anchor`.
         *
         * `auto` = opened by focusing the field. In that mode a locked
         * vault / no-match result simply shows nothing (the page is not
         * disturbed). Opened by clicking the mark (`auto:false`), the
         * dropdown always renders and explains an empty result.
         */
        async function openPicker(
            form: LoginForm,
            anchor: HTMLInputElement,
            opts: { auto?: boolean } = {}
        ): Promise<void> {
            const auto = opts.auto === true;
            closePicker();
            const host = document.createElement('div');
            host.style.cssText = `position:fixed; z-index:${Z};`;
            const root = host.attachShadow({ mode: 'closed' });
            document.body.append(host);
            placePicker(host, anchor);
            picker = host;
            pickerAnchor = anchor;

            const p = panel(root);
            const loading = auto ? null : panelMessage(p, 'checking your vault…');
            const superseded = () => picker !== host;
            try {
                const state = await send({ kind: 'get-state' });
                if (superseded()) return;
                if (state.status !== 'unlocked') {
                    if (auto) return closePicker();
                    loading?.remove();
                    panelMessage(
                        p,
                        'OC Vault is locked — click the OC icon in your browser toolbar to unlock it.'
                    );
                    return;
                }
                if (state.entryCount === 0) {
                    if (auto) return closePicker();
                    loading?.remove();
                    panelMessage(
                        p,
                        'No entries synced yet — open the OC toolbar icon to check your vault.'
                    );
                    return;
                }
                const matches = await send({ kind: 'match-page', pageUrl: location.href });
                if (superseded()) return;
                if (matches.length === 0) {
                    if (auto) return closePicker();
                    loading?.remove();
                    panelMessage(p, 'No saved logins for this site.');
                    return;
                }
                // Auto-opened, but focus has since moved on — don't pop up.
                if (auto && affordanceField !== anchor) return closePicker();
                loading?.remove();
                renderMatches(p, matches, form);
            } catch {
                if (auto) return closePicker();
                loading?.remove();
                panelMessage(p, 'Could not reach the vault.');
            }
        }

        function renderMatches(
            p: HTMLElement,
            matches: VaultEntrySummary[],
            form: LoginForm
        ): void {
            for (const entry of matches) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'row';
                row.append(markIcon(13, ORANGE));
                const nm = document.createElement('span');
                nm.className = 'nm';
                nm.textContent = entry.name;
                const t = document.createElement('span');
                t.className = 't';
                t.textContent = entry.folder || entry.type;
                row.append(nm, t);
                row.addEventListener('click', () => void fillEntry(form, entry.id));
                p.append(row);
            }
        }

        /* ── the field mark — visible on focus, the dropdown's handle ───── */

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
                .mark { width:22px; height:22px; padding:0; border:none;
                    border-radius:5px; cursor:pointer; display:flex;
                    align-items:center; justify-content:center; color:${ORANGE};
                    background:rgba(234,88,12,.16);
                    box-shadow:0 1px 3px rgba(0,0,0,.28);
                    transition:background .12s, transform .12s; }
                .mark:hover, .mark:focus-visible { background:rgba(234,88,12,.32);
                    transform:scale(1.07); outline:none; }
            `;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mark';
            btn.title = 'OC Vault — fill a saved login';
            btn.setAttribute('aria-label', 'fill with OC Vault');
            btn.append(markIcon(13, 'currentColor'));
            // Keep the field focused (and the keyboard up, on touch) when the
            // mark is pressed.
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!affordanceField) return;
                const form = fieldForm.get(affordanceField);
                if (!form) return;
                // A second click on the mark toggles the dropdown shut.
                if (picker && pickerAnchor === affordanceField) closePicker();
                else void openPicker(form, affordanceField, { auto: false });
            });
            root.append(style, btn);
            document.body.append(host);
            affordance = host;
            return host;
        }

        const MARK = 22;

        /**
         * Find where, inside the field's right edge, the field is actually
         * clear. Sites (and some browsers) put their own control there — a
         * reveal-password eye, a clear-X. Walking inward with
         * `elementFromPoint` finds any such control so the OC mark is placed
         * just to its LEFT, never stacked on top of it.
         */
        function freeRightEdge(field: HTMLInputElement, r: DOMRect): number {
            const midY = r.top + r.height / 2;
            const limit = Math.min(r.width - 10, 132);
            for (let inset = 7; inset <= limit; inset += 4) {
                const el = document.elementFromPoint(r.right - inset, midY);
                // The field itself, our own mark, or nothing → clear here.
                if (!el || el === field || el === affordance || el === picker) {
                    return r.right - inset;
                }
            }
            return r.right - 7;
        }

        function placeAffordance(field: HTMLInputElement): void {
            const host = ensureAffordance();
            const r = field.getBoundingClientRect();
            if (r.width < 28 || r.height < 14) {
                host.style.display = 'none';
                return;
            }
            const rightEdge = freeRightEdge(field, r);
            host.style.display = '';
            host.style.left = `${Math.max(r.left + 4, rightEdge - MARK)}px`;
            host.style.top = `${r.top + (r.height - MARK) / 2}px`;
        }

        /** Focus landed on a recognised login field. */
        function onFieldFocus(field: HTMLInputElement, form: LoginForm): void {
            if (!fieldUiEnabled) return;
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            affordanceField = field;
            placeAffordance(field);
            // Drop the suggestion list automatically when this site has a
            // match — unless the user keeps their browser's own password
            // manager and chose click-to-open, so the two never collide.
            if (menuOnFocus) void openPicker(form, field, { auto: true });
        }

        function hideAffordanceSoon(): void {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (affordance) affordance.style.display = 'none';
                affordanceField = null;
            }, 220);
        }

        function reposition(): void {
            if (affordanceField && affordance && affordance.style.display !== 'none') {
                placeAffordance(affordanceField);
            }
            if (picker && pickerAnchor) placePicker(picker, pickerAnchor);
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
            dismiss.type = 'button';
            dismiss.className = 'act';
            dismiss.textContent = 'not now';
            dismiss.addEventListener('click', () => {
                void send({ kind: 'dismiss-capture' }).catch(() => undefined);
                closePrompt();
            });
            const save = document.createElement('button');
            save.type = 'button';
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
                            : 'Could not save — try again.';
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

        // The field UI appears only when a recognised login field is
        // focused — keyboard, mouse and touch all fire `focusin`. If the
        // field is not yet known (a form revealed after the last scan), a
        // fresh scan is run on the spot so timing never loses the field.
        document.addEventListener(
            'focusin',
            (e) => {
                const t = e.target;
                if (!(t instanceof HTMLInputElement)) return;
                let form = fieldForm.get(t);
                if (!form) {
                    const couldBeLogin =
                        (t.type || 'text').toLowerCase() !== 'hidden' && !t.disabled;
                    if (couldBeLogin) {
                        scan();
                        form = fieldForm.get(t);
                    }
                }
                if (form) onFieldFocus(t, form);
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
        window.addEventListener('scroll', reposition, { capture: true, passive: true });
        window.addEventListener('resize', reposition, { passive: true });
        window.addEventListener(
            'pointerdown',
            (e) => {
                // A click outside the dropdown (and not on the mark) closes it.
                if (picker && e.target !== picker && e.target !== affordance) closePicker();
            },
            { capture: true }
        );
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closePicker();
        });
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
