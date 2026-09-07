import * as client from "@useceleris/client";

Object.assign(globalThis, { clientExports: Object.keys(client) });
