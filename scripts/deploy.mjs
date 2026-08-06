/**
 * Copies the built plugin into a local vault for testing.
 *
 * The target is read from the OBSIDIAN_PLUGIN_DIR environment variable, or
 * from a `.vault-path` file in the repository root. Both are kept out of git
 * so the path stays personal to each machine.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FILES = ["main.js", "manifest.json"];

async function resolveTarget() {
	if (process.env.OBSIDIAN_PLUGIN_DIR) return process.env.OBSIDIAN_PLUGIN_DIR;

	try {
		const configured = await readFile(".vault-path", "utf8");
		if (configured.trim()) return configured.trim();
	} catch {
		// Falls through to the error below.
	}

	throw new Error(
		"No target vault. Set OBSIDIAN_PLUGIN_DIR or create a .vault-path file.",
	);
}

const target = await resolveTarget();
await mkdir(target, { recursive: true });

for (const file of FILES) {
	await copyFile(file, path.join(target, file));
}

console.log(`Deployed ${FILES.join(", ")} to ${target}`);
