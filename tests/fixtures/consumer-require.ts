import { blockImportSideEffects } from "./import-guard";

blockImportSideEffects();
const client = require("@useceleris/client");

let privatePathBlocked = false;
try {
  require("@useceleris/client/dist/index.cjs");
} catch {
  privatePathBlocked = true;
}

console.log(
  JSON.stringify({ exports: Object.keys(client).sort(), privatePathBlocked }),
);
