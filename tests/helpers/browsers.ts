import { chromium, firefox, webkit, type Browser } from "playwright";

// Bundled engines always run. CELERIS_BROWSER_CHANNELS additionally selects
// branded builds (comma-separated Playwright channels, e.g. "chrome,msedge")
// where they are installed — the PORT-01 evidence path.
export type BrowserTarget = {
  name: string;
  launch: () => Promise<Browser>;
};

const brandedEngines: Record<string, typeof chromium> = {
  chrome: chromium,
  "chrome-beta": chromium,
  msedge: chromium,
  "msedge-beta": chromium,
};

export function readBrowserTargets(): BrowserTarget[] {
  const targets: BrowserTarget[] = [
    { name: "chromium", launch: () => chromium.launch() },
    { name: "firefox", launch: () => firefox.launch() },
    { name: "webkit", launch: () => webkit.launch() },
  ];

  for (const entry of (process.env.CELERIS_BROWSER_CHANNELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const engine = brandedEngines[entry];
    if (!engine) throw new Error(`Unsupported browser channel: ${entry}`);

    targets.push({
      name: entry,
      launch: () => engine.launch({ channel: entry }),
    });
  }

  return targets;
}
