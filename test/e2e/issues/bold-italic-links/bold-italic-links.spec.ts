import { test, expect } from '../../common/test-base';
import type { Page } from '@playwright/test';

// Regression: a column formatted bold/italic LOST that formatting on any
// link text inside it — the letters of a `[word](url)` rendered at the
// normal weight/style while the rest of the cell stayed bold/italic ("it
// forgets the boldness or italic and the letters reset to their normal look
// while still embedded with the url").
//
// Mechanism, and why this fixture is shaped the way it is:
//   * The real applyStyleRulesV2 (via buildTableDom) puts the bt-bold /
//     bt-italic class on the CELL element; the emphasis then reached the
//     text by plain CSS inheritance.
//   * Obsidian's own stylesheet sets explicit font properties on rendered
//     markdown links — obsidian-vars.css models that here (see the
//     "OBSIDIAN'S LINK FONT RESET" rule), which beats inheritance for the
//     <a>'s text. That is the whole bug.
//   * The fix (styles.css) is a descendant rule under .bt-bold / .bt-italic
//     that forces the cell's emphasis through to every child, so the <a>
//     can no longer reset it.
//
// buildTableDom renders cell content as plain text in a <p> (no real
// MarkdownRenderer), so each test seeds the cell with an <a> the way
// MarkdownRenderer's real link output would sit there, then asserts on the
// computed style of the <a> itself.
const SOURCE = `---
version: 2
columns:
  - id: c_a
    name: Bold
    width: 200
  - id: c_b
    name: Italic
    width: 200
  - id: c_c
    name: Both
    width: 200
  - id: c_d
    name: Plain
    width: 200
rows:
  - id: r_1
    cells:
      c_a: before after
      c_b: before after
      c_c: before after
      c_d: before after
styles:
  - target: c_a
    bold: true
  - target: c_b
    italic: true
  - target: c_c
    bold: true
    italic: true
---
`;

/** Replace the cell's <p> content with "before <a>LINK</a> after", the DOM
 *  shape MarkdownRenderer produces for `before [LINK](url) after`. */
async function seedLink(page: Page, cellSel: string): Promise<void> {
	await page.evaluate((sel: string) => {
		const p = document.querySelector(sel)!.querySelector('p')!;
		const a = document.createElement('a');
		a.href = 'https://example.com';
		a.textContent = 'LINK';
		p.replaceChildren(document.createTextNode('before '), a, document.createTextNode(' after'));
	}, cellSel);
}

interface LinkStyle { fontWeight: string; fontStyle: string }

async function linkStyle(page: Page, cellSel: string): Promise<LinkStyle> {
	return await page.evaluate((sel: string): LinkStyle => {
		const a = document.querySelector(sel + ' p a') as HTMLElement;
		const cs = getComputedStyle(a);
		return { fontWeight: cs.fontWeight, fontStyle: cs.fontStyle };
	}, cellSel);
}

test.describe('bold-italic-links', () => {
	test('an unstyled cell\'s link sits at the normal weight/style (baseline)', async ({ page, renderReal }) => {
		await renderReal(SOURCE);
		await seedLink(page, '#table td[data-row="1"][data-col="3"]'); // c_d — no style on it
		const s = await linkStyle(page, '#table td[data-row="1"][data-col="3"]');
		expect(s.fontWeight).toBe('400');
		expect(s.fontStyle).toBe('normal');
	});

	test('the pre-fix mechanism really reproduces in this harness (non-vacuity)', async ({ page, renderReal }) => {
		// The fix is a DESCENDANT rule under .bt-bold. The pre-fix code only
		// put the weight on the cell itself (td-level bold), which Obsidian's
		// own link rule beats for the <a>'s text — that cascade loss IS the
		// bug. Prove the harness can actually lose that cascade: a fresh cell
		// with td-level bold (the pre-fix state, via inline style — the real
		// descendant rule can't match this element, since the class isn't
		// there) must render its link at 400. If this assertion failed, the
		// fix tests below would pass even with the descendant rule removed,
		// i.e. they'd be measuring nothing — the same class of vacuity the
		// freeze-merge specs guard against with their "would NOT satisfy"
		// test.
		await renderReal(SOURCE); // loads styles.css + the shim's link rule
		const preFixWeight = await page.evaluate(() => {
			const host = document.createElement('div');
			// Inside .markdown-rendered, so the shim's `a` rule applies —
			// exactly where Obsidian's own rule would.
			(document.querySelector('.markdown-rendered') as HTMLElement).appendChild(host);
			host.innerHTML = '<table class="bt-table"><tr><td style="font-weight: bold"><p><a href="x">x</a></p></td></tr></table>';
			const a = host.querySelector('a') as HTMLAnchorElement;
			const weight = getComputedStyle(a).fontWeight;
			host.remove();
			return weight;
		});
		expect(preFixWeight).toBe('400');
	});

	test('a bold column keeps its bold on link text', async ({ page, renderReal }) => {
		await renderReal(SOURCE);
		await seedLink(page, '#table td[data-row="1"][data-col="0"]'); // c_a
		const s = await linkStyle(page, '#table td[data-row="1"][data-col="0"]');
		expect(s.fontWeight).toBe('700');
		expect(s.fontStyle).toBe('normal');
		// The cell's own (non-link) text is still bold too.
		const pWeight = await page.evaluate(() =>
			getComputedStyle(document.querySelector('#table td[data-row="1"][data-col="0"] p') as HTMLElement).fontWeight);
		expect(pWeight).toBe('700');
	});

	test('an italic column keeps its italic on link text', async ({ page, renderReal }) => {
		await renderReal(SOURCE);
		await seedLink(page, '#table td[data-row="1"][data-col="1"]'); // c_b
		const s = await linkStyle(page, '#table td[data-row="1"][data-col="1"]');
		expect(s.fontStyle).toBe('italic');
		expect(s.fontWeight).toBe('400');
	});

	test('a bold+italic column keeps both on link text', async ({ page, renderReal }) => {
		await renderReal(SOURCE);
		await seedLink(page, '#table td[data-row="1"][data-col="2"]'); // c_c
		const s = await linkStyle(page, '#table td[data-row="1"][data-col="2"]');
		expect(s.fontWeight).toBe('700');
		expect(s.fontStyle).toBe('italic');
	});

	test('the <a> is still a link — href survives the styling', async ({ page, renderReal }) => {
		// The user's words: the letters "reset to their normal look WHILE
		// still embedded with the url" — the bug report's complaint is the
		// look, not the link, but a fix that drops the href would be a
		// regression in the other direction, so pin it explicitly.
		await renderReal(SOURCE);
		await seedLink(page, '#table td[data-row="1"][data-col="0"]');
		const href = await page.evaluate(() =>
			(document.querySelector('#table td[data-row="1"][data-col="0"] p a') as HTMLAnchorElement).href);
		expect(href).toBe('https://example.com/');
	});
});
