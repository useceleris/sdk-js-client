import { openConnection } from "../../src/connection";
import type { ServerMessage } from "../../src/messages";

const configuration = Reflect.get(globalThis, "transportConfiguration") as {
  baseUrl: string;
  rejectTls: boolean;
};

async function exerciseTransport(): Promise<unknown> {
  let receive!: (message: ServerMessage) => void;
  const received = new Promise<ServerMessage>((resolve) => {
    receive = resolve;
  });
  try {
    const transport = await openConnection(
      {
        baseUrl: configuration.baseUrl,
        channelReference: "room-1",
        allowInsecureLoopback: true,
      },
      {
        credentialProvider: async () => ({
          payload: "a+/=&%識",
          signature: "signature+/=",
        }),
        onMessage: receive,
      },
    );
    transport.send(new TextEncoder().encode("@SUB\n$4\nchat\n"));
    const message = await received;
    transport.close();
    return {
      command: message.command,
      payload:
        message.command === "SERVER_MSG" ? Array.from(message.payload) : null,
    };
  } catch (error) {
    if (configuration.rejectTls && error instanceof Error && "code" in error)
      return { code: error.code };
    throw error;
  }
}
Object.assign(globalThis, { transportResult: exerciseTransport() });
