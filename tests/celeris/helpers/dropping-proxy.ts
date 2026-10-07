import { connect, createServer, type Server, type Socket } from "node:net";

// A TCP proxy in front of the realtime endpoint that a test can break:
// - refusing: new connections close at once
// - dropAll: every open connection closes
// - blackhole: new connections stay open but carry no bytes
// - stallUpstream: the proxy stops reading what clients send, so their
//   socket buffers fill
export type DroppingProxy = {
  readonly url: string;
  setRefusing(refusing: boolean): void;
  setBlackhole(blackhole: boolean): void;
  stallUpstream(stalled: boolean): void;
  dropAll(): void;
  close(): Promise<void>;
};

export async function startDroppingProxy(
  targetUrl: string,
): Promise<DroppingProxy> {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port) || 80;
  const links = new Set<Socket>();
  const upstreams = new Map<Socket, Socket>();
  let refusing = false;
  let blackhole = false;
  let stalled = false;

  const server: Server = createServer((client) => {
    if (refusing) {
      client.destroy();
      return;
    }

    links.add(client);
    client.on("error", () => client.destroy());
    client.on("close", () => links.delete(client));

    if (blackhole) {
      client.resume();
      return;
    }

    const upstream = connect(targetPort, target.hostname);
    links.add(upstream);
    upstreams.set(client, upstream);
    const unlink = () => {
      links.delete(client);
      links.delete(upstream);
      upstreams.delete(client);
      client.destroy();
      upstream.destroy();
    };

    client.on("error", unlink).on("close", unlink);
    upstream.on("error", unlink).on("close", unlink);
    upstream.pipe(client);
    if (!stalled) client.pipe(upstream);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("The proxy has no TCP address.");
  }

  return {
    url: `ws://127.0.0.1:${address.port}${target.pathname.replace(/\/$/, "")}`,
    setRefusing: (value) => {
      refusing = value;
    },
    setBlackhole: (value) => {
      blackhole = value;
    },
    stallUpstream: (value) => {
      stalled = value;
      for (const [client, upstream] of upstreams) {
        if (value) {
          client.unpipe(upstream);
          client.pause();
        } else {
          client.pipe(upstream);
        }
      }
    },
    dropAll: () => {
      for (const link of links) link.destroy();
      links.clear();
      upstreams.clear();
    },
    close: async () => {
      for (const link of links) link.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
} // end function startDroppingProxy
