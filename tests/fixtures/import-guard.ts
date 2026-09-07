export function blockImportSideEffects(): void {
  // Each consumer runs in a disposable process; these guards need no restoration.
  for (const capability of [
    "crypto",
    "fetch",
    "WebSocket",
    "setTimeout",
    "setInterval",
  ]) {
    Object.defineProperty(globalThis, capability, {
      configurable: true,
      get() {
        throw new Error(`Import accessed forbidden capability: ${capability}`);
      },
    });
  }
}
