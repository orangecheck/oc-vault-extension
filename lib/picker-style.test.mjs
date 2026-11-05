// node --test: the in-page picker carries app-design's tokens by value; each one must equal the
// package's own, light and dark, so a token change in the package fails here first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { test } from 'node:test';

register('./ts-alias-loader.mjs', import.meta.url);
const { PICKER_TOKENS, PANEL_CSS, MARK_CSS } = await import('./picker-style.ts');

const require = createRequire(import.meta.url);
const tokensCss = readFileSync(
    require.resolve('@orangecheck/app-design/styles/tokens.css'),
    'utf8'
);

/** The declarations inside the rule whose selector list ends with `selector {`. */
function block(css, selector) {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `tokens.css has no ${selector} block`);
    const body = css.slice(start, css.indexOf('\n}', start));
    const out = {};
    for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) out[m[1]] = m[2].trim();
    return out;
}

const light = block(tokensCss, "\n[data-oc-app='ochk']");
// The dark block restates what changes; anything it leaves out is the light value.
const dark = { ...light, ...block(tokensCss, ".dark [data-oc-app='ochk']") };

for (const [mode, theirs] of [
    ['light', light],
    ['dark', dark],
]) {
    test(`picker tokens match app-design's ${mode} tokens`, () => {
        for (const [name, value] of Object.entries(PICKER_TOKENS[mode])) {
            assert.ok(name in theirs, `${name} is not an app-design token`);
            assert.equal(value.toLowerCase(), theirs[name].toLowerCase(), `${mode} ${name}`);
        }
    });
}

test('the panel and the field mark read colour only from those tokens', () => {
    for (const css of [PANEL_CSS, MARK_CSS]) {
        const rules = css.replace(/:host \{[^}]*\}/g, '');
        assert.deepEqual(
            rules.match(/#[0-9a-f]{3,8}\b/gi) ?? [],
            [],
            'no hex colour outside the tokens'
        );
        for (const [, name] of rules.matchAll(/var\((--[\w-]+)\)/g)) {
            assert.ok(name in PICKER_TOKENS.light, `${name} is used but not carried`);
        }
    }
});
