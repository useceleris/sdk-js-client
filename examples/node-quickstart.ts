// @useceleris/client quickstart for server runtimes (Node.js, Bun, Deno).
//
// One Channel is one WebSocket connection; every segment of the channel is
// multiplexed over it. Connecting joins the "default" segment automatically.
// Segment handlers are lightweight proxies over the channel connection.
//
// Credentials: a trusted server signs short-lived opaque credentials. The
// inline signer below stands in for YOUR application's credential endpoint —
// in production keep the signing secret server-side and fetch from there.
import { createHmac } from "node:crypto";
import {
  createClient,
  jsonPayload,
  readText,
  type Credentials,
} from "@useceleris/client";

function signCredentials(): Credentials {
  const payload = Buffer.from(
    JSON.stringify({
      timestamp: Date.now(),
      allow_echo: true, // let this single connection see its own publishes
    }),
  ).toString("base64");
  const digestHex = createHmac("sha512", process.env.CELERIS_SIGNING_SECRET!)
    .update(payload, "ascii")
    .digest("hex");
  const signature = Buffer.from(
    `${process.env.CELERIS_CLIENT_ID}:${digestHex}`,
  ).toString("base64");

  return { payload, signature };
} // end function signCredentials

const client = createClient({
  baseUrl: process.env.CELERIS_WS_URL!,
  allowInsecureLoopback: true, // local ws:// stack; production uses wss://
  credentialProvider: async () => signCredentials(), // fresh per attempt
});

const channel = client.channel(`quickstart-${Date.now()}`);
channel.events().onStateChange((state) => console.log("state:", state));
channel.events().onError((error) => console.log("error:", error.code));

await channel.connect();

// Subscribe, publish, receive — on one connection thanks to allow_echo.
const chat = channel.segment("chat");
const delivered: string[] = [];
const membership = chat.subscribe();
chat.onMessage((payload, metadata) => {
  // Payload first; metadata carries the sender, server id and timestamp.
  void metadata.messageId;
  delivered.push(readText(payload));
});
await new Promise((resolve) => setTimeout(resolve, 1_000));

await chat.publish({ payload: jsonPayload({ hello: "world" }) });
// Resolution means the local socket accepted the bytes — never a receipt.

for (let waited = 0; delivered.length === 0 && waited < 15_000; waited += 250) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// Presence: who is in the segment right now (one query in flight per channel).
const page = await chat.presenceList({ page: 1, perPage: 10 });

membership.cancel();
await channel.close();

console.log(`example: ok delivered=${delivered.length} present=${page.total}`);
