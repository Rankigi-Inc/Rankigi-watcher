# Rankigi Watcher

Tamper-evident audit chain for your Obsidian plugins.

Every plugin action is hashed and chained locally. Nothing leaves your machine unless you connect to RANKIGI cloud.

## What it monitors

- Plugin installs, updates, and removals
- Network requests made by plugins (Phase 2)
- Vault file writes (Phase 2)
- Clipboard access, opt-in (Phase 4)
- Shell and filesystem escapes (Phase 4)

## Install

### Recommended: BRAT (one-click beta install)

1. Install BRAT from the Obsidian community plugins directory (search "BRAT")
2. Open BRAT settings
3. Click "Add Beta Plugin"
4. Paste: Rankigi-Inc/Rankigi-watcher
5. Click Add Plugin
6. Enable Rankigi Watcher in Settings > Community Plugins

### Manual install

1. Download main.js, manifest.json, styles.css from the latest release: github.com/Rankigi-Inc/Rankigi-watcher/releases
2. Create folder: {your-vault}/.obsidian/plugins/rankigi-watcher/
3. Copy the three files into that folder
4. Enable in Settings > Community Plugins

## Known limitations

Network monitoring does not capture requests made by plugins that imported requestUrl via destructuring at load time. There is no runtime signal to detect which of your installed plugins fall into this category. fetch and XMLHttpRequest calls are fully captured regardless.

Vault write attribution identifies the writing plugin when it is on the synchronous call stack at write time. Writes from async or timer-deferred plugin code record plugin_id as null. The chain event includes an attribution_method field so you can distinguish attributed from unattributed entries.

Writes to .obsidian/ (plugin data files, workspace config, app settings) are not recorded. The Obsidian vault API does not expose these writes to plugins.

## Connect to RANKIGI (optional, Phase 3)

Get a free account at rankigi.com. Paste your API key in Settings, Rankigi Watcher, RANKIGI Cloud.

## Local chain

Your audit chain lives at:

```
.obsidian/plugins/rankigi-watcher/chain.jsonl
```

Export it anytime from Settings, Local Chain. Verify integrity with the Verify chain button.

## Build

```
npm install
npm run build
```

## Test

```
npm run test
```

## License

MIT, Rankigi Inc 2026.
