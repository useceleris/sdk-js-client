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
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  fail(): void {
    this.dispatchEvent(new Event("error"));
  }

  disconnect(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

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
}
