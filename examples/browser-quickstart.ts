// @useceleris/client quickstart for browsers.
//
// The browser NEVER holds a signing secret: it fetches short-lived opaque
// credentials from the application's authenticated endpoint. The endpoint
// URL arrives via a page global here so the verification test can point it
// at a local signer; in an application it is simply your own API route.
import { createClient, readText } from "@useceleris/client";

declare global {
  // Provided by the hosting page: base URL + credential endpoint.
  var celerisWsUrl: string;
  var celerisCredentialEndpoint: string;
  var exampleResult: { ok: boolean; delivered: number } | undefined;
}

const client = createClient({
  baseUrl: globalThis.celerisWsUrl,
  allowInsecureLoopback: true, // local qualification stack; production uses wss://
  credentialProvider: async (request) => {
    const response = await fetch(globalThis.celerisCredentialEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: request.reason }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error("credential request failed");

    return response.json(); // { payload, signature }
  },
});

async function main(): Promise<void> {
  const channel = client.channel(`browser-quickstart-${Date.now()}`);
  const chat = channel.segment("chat");
  const delivered: string[] = [];
  chat.onMessage((payload) => {
    delivered.push(readText(payload));
  });
  chat.subscribe();

  await channel.connect();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await chat.publish({ payload: new TextEncoder().encode("from-the-browser") });

  for (
    let waited = 0;
    delivered.length === 0 && waited < 15_000;
    waited += 250
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await channel.close();

  globalThis.exampleResult = {
    ok: delivered.length > 0,
    delivered: delivered.length,
  };
} // end function main

void main();
