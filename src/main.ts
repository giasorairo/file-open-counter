import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";

type OpenCounts = Record<string, number>;

interface Settings {
	/** When true, a file adds at most one to its count per calendar day. */
	oncePerDay: boolean;
	/** How many files the ranking shows. */
	rankingLimit: number;
}

/**
 * Which files have already been counted today. Kept apart from the counts so
 * that the history file stays a plain map of path to number.
 */
interface Bookkeeping {
	day: string;
	countedToday: string[];
}

const DEFAULT_SETTINGS: Settings = { oncePerDay: true, rankingLimit: 100 };

/** Writes are debounced so that rapid tab switching does not hit the disk. */
const SAVE_DELAY_MS = 2000;

export default class FileOpenCounterPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };

	private counts: OpenCounts = {};
	private saveTimer: number | null = null;
	private statusBar: HTMLElement | null = null;
	private day = today();
	private countedToday = new Set<string>();

	async onload(): Promise<void> {
		this.counts = await this.readCounts();
		await this.loadState();
		this.addSettingTab(new FileOpenCounterSettingTab(this.app, this));

		// Mobile has no status bar; the element is simply never shown there.
		this.statusBar = this.addStatusBarItem();
		this.app.workspace.onLayoutReady(() => this.refreshStatusBar());

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.recordOpen(file);
				this.refreshStatusBar();
			}),
		);

		// Paths are the identity here, so a rename would otherwise orphan the
		// count and start the file over from zero.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.transferCounts(file, oldPath);
				this.refreshStatusBar();
			}),
		);

		this.addCommand({
			id: "prune-missing",
			name: "Remove counts for files that no longer exist",
			callback: () => this.prune(),
		});

		// A ```file-open-counter``` block anywhere renders the ranking.
		this.registerMarkdownCodeBlockProcessor("file-open-counter", (_, el) =>
			this.renderRanking(el),
		);
	}

	async onunload(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			await this.writeCounts();
		}
	}

	/** Location of the history file, next to Obsidian's own config. */
	private get dataPath(): string {
		return `${this.app.vault.configDir}/file-open-history.json`;
	}

	private recordOpen(file: TFile): void {
		if (this.settings.oncePerDay) {
			this.rolloverDay();
			if (this.countedToday.has(file.path)) return;
			this.countedToday.add(file.path);
			void this.saveState();
		}

		this.counts[file.path] = (this.counts[file.path] ?? 0) + 1;
		this.scheduleSave();
	}

	/** Draws the most opened files, highest first. */
	private renderRanking(container: HTMLElement): void {
		container.empty();

		const entries = Object.entries(this.counts)
			.sort(([pathA, a], [pathB, b]) => b - a || pathA.localeCompare(pathB))
			.slice(0, Math.max(1, this.settings.rankingLimit));

		if (entries.length === 0) {
			container.createEl("p", { text: "No files have been opened yet." });
			return;
		}

		const table = container.createEl("table");
		const header = table.createEl("thead").createEl("tr");
		header.createEl("th", { text: "File" });
		header.createEl("th", { text: "Path" });
		header.createEl("th", { text: "Count" });

		const body = table.createEl("tbody");
		for (const [path, count] of entries) {
			const row = body.createEl("tr");
			const link = row.createEl("td").createEl("a", {
				cls: "internal-link",
				text: basename(path),
				href: path,
			});
			link.dataset.href = path;

			// The folder alone, since the name is already in the first column.
			row.createEl("td", { text: path.split("/").slice(0, -1).join("/") });
			row.createEl("td", { text: String(count) });
		}
	}

	/** Clears the per-day record once the date has moved on. */
	private rolloverDay(): void {
		const current = today();
		if (current === this.day) return;
		this.day = current;
		this.countedToday.clear();
	}

	/** Shows the count for the file currently in focus. */
	private refreshStatusBar(): void {
		if (!this.statusBar) return;

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.statusBar.setText("");
			this.statusBar.removeAttribute("aria-label");
			return;
		}

		this.statusBar.setText(`count ${this.counts[file.path] ?? 0}`);
		// The number is already on screen, so this says how it is counted.
		this.statusBar.setAttribute(
			"aria-label",
			this.settings.oncePerDay
				? `${file.path} — counted once per day`
				: `${file.path} — counted on every open`,
		);
	}

	/**
	 * Moves counts from the old path to the new one. Renaming a folder shifts
	 * every descendant, so those keys are re-pointed by prefix.
	 */
	private transferCounts(file: TAbstractFile, oldPath: string): void {
		const moves: Array<[string, string]> =
			file instanceof TFolder
				? [...Object.keys(this.counts), ...this.countedToday]
						.filter((path) => path.startsWith(`${oldPath}/`))
						.map((path) => [
							path,
							`${file.path}/${path.slice(oldPath.length + 1)}`,
						])
				: [[oldPath, file.path]];

		let moved = false;
		let markedMoved = false;
		for (const [from, to] of moves) {
			if (from === to) continue;

			if (from in this.counts) {
				// A file can land on a path that already has a history, so keep both.
				this.counts[to] = (this.counts[to] ?? 0) + this.counts[from];
				delete this.counts[from];
				moved = true;
			}

			// Otherwise the file would be counted a second time today.
			if (this.countedToday.delete(from)) {
				this.countedToday.add(to);
				markedMoved = true;
			}
		}

		if (moved) this.scheduleSave();
		if (markedMoved) void this.saveState();
	}

	private prune(): void {
		const before = Object.keys(this.counts).length;
		for (const path of Object.keys(this.counts)) {
			if (!this.app.vault.getAbstractFileByPath(path)) {
				delete this.counts[path];
			}
		}

		const removed = before - Object.keys(this.counts).length;
		if (removed > 0) {
			this.scheduleSave();
			this.refreshStatusBar();
		}
		new Notice(
			removed > 0
				? `Removed ${removed} missing ${removed === 1 ? "entry" : "entries"}.`
				: "No missing entries found.",
		);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.writeCounts();
		}, SAVE_DELAY_MS);
	}

	private async readCounts(): Promise<OpenCounts> {
		const { adapter } = this.app.vault;
		if (!(await adapter.exists(this.dataPath))) return {};

		try {
			const parsed: unknown = JSON.parse(await adapter.read(this.dataPath));
			if (typeof parsed !== "object" || parsed === null) return {};

			// Drop anything that is not a plain path/count pair, so a corrupted
			// file cannot poison later writes.
			return Object.fromEntries(
				Object.entries(parsed as Record<string, unknown>).filter(
					([, count]) => typeof count === "number" && Number.isFinite(count),
				) as Array<[string, number]>,
			);
		} catch (error) {
			console.error("file-open-counter: could not read history", error);
			return {};
		}
	}

	private async writeCounts(): Promise<void> {
		// Sorted by path so the file stays diff-friendly between writes.
		const sorted = Object.entries(this.counts).sort(([a], [b]) =>
			a.localeCompare(b),
		);

		try {
			await this.app.vault.adapter.write(
				this.dataPath,
				`${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`,
			);
		} catch (error) {
			console.error("file-open-counter: could not write history", error);
		}
	}

	/** Settings and per-day bookkeeping share the plugin's own data file. */
	private async loadState(): Promise<void> {
		const stored = (await this.loadData()) as
			| (Partial<Settings> & Partial<Bookkeeping>)
			| null;

		this.settings = { ...DEFAULT_SETTINGS, ...stored };

		if (stored?.day === today() && Array.isArray(stored.countedToday)) {
			this.day = stored.day;
			this.countedToday = new Set(stored.countedToday);
		}
	}

	async saveState(): Promise<void> {
		await this.saveData({
			...this.settings,
			day: this.day,
			countedToday: [...this.countedToday],
		});
	}
}

/** File name without its folders or the markdown extension. */
function basename(path: string): string {
	return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

/** Local calendar day, so the reset lines up with the user's midnight. */
function today(): string {
	const now = new Date();
	const month = `${now.getMonth() + 1}`.padStart(2, "0");
	const date = `${now.getDate()}`.padStart(2, "0");
	return `${now.getFullYear()}-${month}-${date}`;
}

class FileOpenCounterSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: FileOpenCounterPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();

		new Setting(this.containerEl)
			.setName("Count once per day")
			.setDesc(
				"Add at most one to a file's count each day, so the number reflects " +
					"how many days you have opened it rather than how many times. " +
					"Turn this off to count every open.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.oncePerDay)
					.onChange(async (value) => {
						this.plugin.settings.oncePerDay = value;
						await this.plugin.saveState();
					}),
			);

		new Setting(this.containerEl)
			.setName("Files shown in the ranking")
			.setDesc(
				"How many files a file-open-counter code block lists. " +
					`Defaults to ${DEFAULT_SETTINGS.rankingLimit}.`,
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.rankingLimit))
					.setValue(String(this.plugin.settings.rankingLimit))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed) || parsed < 1) return;
						this.plugin.settings.rankingLimit = parsed;
						await this.plugin.saveState();
					}),
			);
	}
}
