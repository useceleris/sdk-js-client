import { blockImportSideEffects } from "./import-guard";

blockImportSideEffects();
const client = await import("@useceleris/client");

const privatePath = "@useceleris/client/dist/index.js";
let privatePathBlocked = false;

try {
  await import(privatePath);
} catch {
  privatePathBlocked = true;
}

console.log(
  JSON.stringify({ exports: Object.keys(client).sort(), privatePathBlocked }),
);
