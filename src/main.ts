import { Editor, MarkdownView, Plugin, TFile } from 'obsidian';
import { BetterTableSettingTab, DEFAULT_SETTINGS } from './settings';
import { ChoiceRegistry } from './choiceRegistry';
import { TableBlock } from './tableBlock';
import type { BetterTableSettings } from './model';
import { planRichTableBlockInsertion } from './insertRichTableBlock';
import { planMarkdownTableConversion, type MarkdownTableConversionPlan } from './convertMarkdownTable';
import { t } from './i18n';
export default class BetterTablePlugin extends Plugin {
	settings!: BetterTableSettings;
	choiceRegistry!: ChoiceRegistry;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.choiceRegistry = new ChoiceRegistry(this.settings.customChoices);

		this.registerMarkdownCodeBlockProcessor('rich-table', (source, el, ctx) => {
			const info = ctx.getSectionInfo(el);
			const cacheKey = info ? `${ctx.sourcePath}:${info.lineStart}` : ctx.sourcePath;
			const block = new TableBlock(el, source, this, ctx.sourcePath, ctx, cacheKey);
			ctx.addChild(block);
		});

		this.addSettingTab(new BetterTableSettingTab(this.app, this));

		// "Defaults to preview mode" (user request): notes that contain a rich
		// table open in reading (preview) mode instead of source mode, so the
		// rendered table is what you see. Source mode is the only mode switched
		// — live preview already renders the block inline, and forcing a
		// reading view on top of it would change an experience the user chose.
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (!this.settings.openInPreview) return;
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			void this.openRichTableInPreview(file);
		}));

		// Three entry points for the one action, per user request — a command
		// (which is also how a user assigns their own hotkey, via Settings →
		// Hotkeys, so that request needs no separate mechanism here), a ribbon
		// icon for a click-to-insert workflow, and an editor context-menu entry
		// for reaching it without leaving the keyboard/mouse flow of writing.
		this.addCommand({
			id: 'insert-block',
			name: t('insertRichTableBlock'),
			editorCallback: (editor) => this.insertRichTableBlock(editor),
		});
		this.addRibbonIcon('table', t('insertRichTableBlock'), () => {
			const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
			if (editor) this.insertRichTableBlock(editor);
		});
		// Command-palette entry point (also assignable a hotkey under Settings →
		// Hotkeys) is the reliable way to reach this: Obsidian's own Live Preview
		// renders a plain Markdown table as an interactive widget with its OWN
		// right-click menu (cut/copy/paste, align, clear/delete cell), which
		// consumes the event before it ever reaches the 'editor-menu' workspace
		// hook — the editor-menu item below is added too, for Source Mode and
		// any other case where that widget isn't in the way, but it can't be
		// the only entry point. editorCheckCallback greys the command out
		// (rather than acting as a no-op) when the cursor isn't on a table.
		this.addCommand({
			id: 'convert-markdown-table',
			name: t('convertToRichTable'),
			editorCheckCallback: (checking, editor) => {
				const plan = this.planMarkdownTableConversionAt(editor);
				if (checking) return plan !== null;
				if (plan) this.applyMarkdownTableConversion(editor, plan);
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
			menu.addItem(item => item
				.setTitle(t('insertRichTableBlock'))
				.setIcon('table')
				.onClick(() => this.insertRichTableBlock(editor)));

			// Only offered when the cursor is actually on a plain Markdown table —
			// unlike "Insert rich-table block" above, this action has nothing to
			// do when there's no table there, so it stays out of the menu instead
			// of appearing as a no-op (see "Evaluating feature requests" in
			// CLAUDE.md: match how comparable tools only show contextual actions
			// when they apply).
			const plan = this.planMarkdownTableConversionAt(editor);
			if (plan) {
				menu.addItem(item => item
					.setTitle(t('convertToRichTable'))
					.setIcon('table')
					.onClick(() => this.applyMarkdownTableConversion(editor, plan)));
			}
		}));
	}

	/**
	 * Switch every open source-mode view of `file` to reading (preview) mode if
	 * the note contains a rich-table block. Deferred one frame so Obsidian has
	 * finished settling on the file's default view before we look at it; the
	 * content check is an in-memory cached read (no disk access) and the whole
	 * thing is a no-op for notes without a ```rich-table block.
	 */
	private openRichTableInPreview(file: TFile): void {
		window.requestAnimationFrame(() => {
			void this.app.vault.cachedRead(file).then(content => {
				if (!content.includes('```rich-table')) return;
				for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
					const view = leaf.view;
					if (!(view instanceof MarkdownView) || view.file !== file) continue;
					if (view.getMode() !== 'source') continue;
					// setMode is the same stable runtime method the view's own
					// mode-toggle button calls, but the public type definitions
					// only declare getMode — narrow it here.
					(view as MarkdownView & {
						setMode(mode: 'source' | 'live-preview' | 'preview'): void;
					}).setMode('preview');
				}
			}).catch(() => { /* unreadable file — leave the view as-is */ });
		});
	}

	/** Inserts an empty rich-table block at the cursor — the existing empty-block
	 *  template-picker banner (tableBlock.ts's isEmpty path) takes it from there. */
	insertRichTableBlock(editor: Editor): void {
		const cursor = editor.getCursor();
		const plan = planRichTableBlockInsertion(cursor, editor.getLine(cursor.line));
		editor.replaceRange(plan.text, cursor);
		editor.setCursor(plan.cursorAfter);
		editor.focus();
	}

	private planMarkdownTableConversionAt(editor: Editor): MarkdownTableConversionPlan | null {
		const cursor = editor.getCursor();
		const lines = Array.from({ length: editor.lineCount() }, (_, i) => editor.getLine(i));
		return planMarkdownTableConversion(lines, cursor.line);
	}

	private applyMarkdownTableConversion(editor: Editor, plan: MarkdownTableConversionPlan): void {
		editor.replaceRange(
			plan.blockText,
			{ line: plan.startLine, ch: 0 },
			{ line: plan.endLine, ch: editor.getLine(plan.endLine).length },
		);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<BetterTableSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.choiceRegistry = new ChoiceRegistry(this.settings.customChoices);
		// Re-render all open reading views so allowReadingViewEdit takes effect
		// immediately without requiring the user to close and reopen the note.
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === 'preview') {
				view.previewMode.rerender(true);
			}
		});
	}
}
