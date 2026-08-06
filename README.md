# File Open Counter

Counts how many times each file in your vault is opened.

Obsidian records which files you opened recently, but not how often. This
plugin keeps a running total per file, so you can tell which notes you
actually return to.

## What it does

Every time a file is opened, its count goes up by one. The totals are stored
in `.obsidian/file-open-history.json`:

```json
{
  "diary/20260806.md": 3,
  "memo/継続するコツ.md": 12
}
```

Counts are not written into note frontmatter, so opening a note never modifies
the note itself.

The count for the file you are looking at appears in the status bar, next to
the word count and similar indicators. Obsidian on mobile has no status bar,
so counting still happens there but nothing is displayed.

## Renames and moves

Paths are used as identity, so renaming a file would normally lose its
history. The plugin listens for renames and carries the count over, including
when a whole folder is moved. If a file lands on a path that already has a
history, the two counts are added together.

Renames made outside Obsidian — with `git mv` or a sync client, for example —
cannot be observed, and those counts stay behind under the old path. The
command **Remove counts for files that no longer exist** clears them out.

## Reading the counts

With [Dataview](https://github.com/blacksmithgu/obsidian-dataview) installed,
the most opened files can be listed from any note:

````markdown
```dataviewjs
const path = `${app.vault.configDir}/file-open-history.json`;
const counts = JSON.parse(await app.vault.adapter.read(path));

dv.table(
  ["File", "Opens"],
  Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([file, count]) => [dv.fileLink(file), count]),
);
```
````

## Installing manually

1. Build the plugin, or download `main.js` and `manifest.json` from a release.
2. Put both files in `<vault>/.obsidian/plugins/file-open-counter/`.
3. Enable the plugin in **Settings → Community plugins**.

## Development

```bash
npm install
npm run dev      # rebuild on change
npm run build    # type-check and produce main.js
npm run deploy   # build, then copy into a vault for testing
```

`npm run deploy` needs a target vault. Set `OBSIDIAN_PLUGIN_DIR`, or create a
`.vault-path` file containing the plugin directory inside your vault. Both are
ignored by git.

## License

[MIT](LICENSE)
