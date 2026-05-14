import { App, FileSystemAdapter, PluginManifest } from "obsidian";

interface AppWithPlugins extends App {
  plugins: { manifests: Record<string, PluginManifest> };
}

export function resolvePluginFromStack(
  stack: string,
  app: App
): string | null {
  const manifests = (app as AppWithPlugins).plugins?.manifests ?? {};

  let pluginsDir: string | null = null;
  if (app.vault.adapter instanceof FileSystemAdapter) {
    pluginsDir =
      app.vault.adapter.getBasePath() + "/.obsidian/plugins/";
  }
  void pluginsDir;

  const frames = stack.split("\n");

  for (const frame of frames) {
    if (frame.includes("rankigi-watcher")) continue;
    if (frame.includes("app://obsidian.md/app.js")) continue;

    const pathMatch = frame.match(
      /[/\\]\.obsidian[/\\]plugins[/\\]([^/\\]+)[/\\]/
    );
    if (pathMatch) {
      const id = pathMatch[1];
      if (manifests[id]) return id;
    }

    const pluginMatch = frame.match(/\bplugin:([a-z0-9_-]+)\b/);
    if (pluginMatch) {
      const id = pluginMatch[1];
      if (manifests[id]) return id;
    }
  }

  return null;
}

export function buildDomainAllowlist(app: App): Set<string> {
  const manifests = (app as AppWithPlugins).plugins?.manifests ?? {};
  const allowed = new Set<string>();
  for (const manifest of Object.values(manifests)) {
    const urls: string[] = [];
    if (manifest.authorUrl) urls.push(manifest.authorUrl);
    const funding = (manifest as PluginManifest & {
      fundingUrl?: string | Record<string, string>;
    }).fundingUrl;
    if (funding) {
      if (typeof funding === "string") {
        urls.push(funding);
      } else {
        urls.push(...Object.values(funding));
      }
    }
    for (const url of urls) {
      try {
        const normalized = url.startsWith("http")
          ? url
          : "https://" + url;
        allowed.add(new URL(normalized).host);
      } catch {
        // skip malformed URLs
      }
    }
  }
  return allowed;
}
