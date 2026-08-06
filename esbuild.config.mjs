import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "node:process";

const production = process.argv.includes("--production");

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Everything below is provided by Obsidian at runtime, never bundled.
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
