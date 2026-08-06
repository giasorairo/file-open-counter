import { Plugin, TAbstractFile, TFile, TFolder, Notice } from "obsidian";

type OpenCounts = Record<string, number>;

/** Writes are debounced so that rapid tab switching does not hit the disk. */
const SAVE_DELAY_MS = 2000;

export default class FileOpenCounterPlugin extends Plugin {
	private counts: OpenCounts = {};
	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		this.counts = await this.readCounts();

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.recordOpen(file);
			}),
		);

		// Paths are the identity here, so a rename would otherwise orphan the
		// count and start the file over from zero.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.transferCounts(file, oldPath);
			}),
		);

		this.addCommand({
			id: "prune-missing",
			name: "Remove counts for files that no longer exist",
			callback: () => this.prune(),
		});
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
		this.counts[file.path] = (this.counts[file.path] ?? 0) + 1;
		this.scheduleSave();
	}

	/**
	 * Moves counts from the old path to the new one. Renaming a folder shifts
	 * every descendant, so those keys are re-pointed by prefix.
	 */
	private transferCounts(file: TAbstractFile, oldPath: string): void {
		const moves: Array<[string, string]> =
			file instanceof TFolder
				? Object.keys(this.counts)
						.filter((path) => path.startsWith(`${oldPath}/`))
						.map((path) => [
							path,
							`${file.path}/${path.slice(oldPath.length + 1)}`,
						])
				: [[oldPath, file.path]];

		let moved = false;
		for (const [from, to] of moves) {
			if (!(from in this.counts) || from === to) continue;
			// A file can land on a path that already has a history, so keep both.
			this.counts[to] = (this.counts[to] ?? 0) + this.counts[from];
			delete this.counts[from];
			moved = true;
		}

		if (moved) this.scheduleSave();
	}

	private prune(): void {
		const before = Object.keys(this.counts).length;
		for (const path of Object.keys(this.counts)) {
			if (!this.app.vault.getAbstractFileByPath(path)) {
				delete this.counts[path];
			}
		}

		const removed = before - Object.keys(this.counts).length;
		if (removed > 0) this.scheduleSave();
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
}
