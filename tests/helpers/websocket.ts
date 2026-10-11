import { afterEach, beforeEach, vi } from "vitest";

export class TestWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = TestWebSocket.CONNECTING;
  readonly OPEN = TestWebSocket.OPEN;
  readonly CLOSING = TestWebSocket.CLOSING;
  readonly CLOSED = TestWebSocket.CLOSED;
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = TestWebSocket.CONNECTING;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  });

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  } // end constructor

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  } // end method open

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  } // end method receive

  fail(): void {
    this.dispatchEvent(new Event("error"));
  } // end method fail

  disconnect(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  } // end method disconnect

  // Every command sent, in order, with each `*N` frame split into its
  // commands.
  sentCommands(): string[] {
    return this.send.mock.calls.flatMap(([bytes]) =>
      splitFrame(bytes as Uint8Array).map((command) =>
        new TextDecoder().decode(command),
      ),
    );
  } // end method sentCommands
} // end class TestWebSocket

function splitFrame(frame: Uint8Array): Uint8Array[] {
  const lineFeed = "\n".charCodeAt(0);
  if (frame[0] !== "*".charCodeAt(0)) return [frame];

  const commands: Uint8Array[] = [];
  let offset = frame.indexOf(lineFeed) + 1;

  while (offset < frame.length) {
    const start = offset;
    offset = frame.indexOf(lineFeed, offset) + 1;

    // Fields follow the command name until the next command starts.
    while (offset < frame.length && frame[offset] !== "@".charCodeAt(0)) {
      const lineEnd = frame.indexOf(lineFeed, offset);
      const bulkLength =
        frame[offset] === "$".charCodeAt(0)
          ? Number(
              new TextDecoder().decode(frame.subarray(offset + 1, lineEnd)),
            )
          : -1;
      offset = lineEnd + 1 + (bulkLength >= 0 ? bulkLength + 1 : 0);
    }

    commands.push(frame.subarray(start, offset));
  }

  return commands;
} // end function splitFrame

export const sockets: TestWebSocket[] = [];

export function useTestWebSockets(): void {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", TestWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    sockets.length = 0;
  });
} // end function useTestWebSockets
