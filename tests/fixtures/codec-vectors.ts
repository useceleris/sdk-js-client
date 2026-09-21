import type { ClientCommand } from "../../src/commands";
import type { ServerMessage } from "../../src/messages";

// Vector revision 1: realtime@9b67cb6634a9c24754e75df25e2cbc2df1b26f26.
// Hand-authored from Rust layouts; no SDK encoder creates expectations.
export const utf8 = (text: string): Uint8Array =>
  new TextEncoder().encode(text);

export const encodingVectors: {
  name: string;
  command: ClientCommand;
  expected: Uint8Array;
}[] = [
  {
    name: "publish null ID",
    command: { command: "PUB", segmentId: "default", payload: utf8("hello") },
    expected: utf8("@PUB\n$7\ndefault\n$-1\n$5\nhello\n"),
  },
  {
    name: "publish binary and Unicode",
    command: {
      command: "PUB",
      segmentId: "c:é",
      messageId: "識",
      payload: new Uint8Array([0, 255, 13, 10, 64]),
    },
    expected: new Uint8Array([
      ...utf8("@PUB\n$4\nc:é\n$3\n識\n$5\n"),
      0,
      255,
      13,
      10,
      64,
      10,
    ]),
  },
  {
    name: "publish empty",
    command: { command: "PUB", segmentId: "a", payload: new Uint8Array() },
    expected: utf8("@PUB\n$1\na\n$-1\n$0\n\n"),
  },
  {
    name: "subscribe",
    command: { command: "SUB", segmentId: "chat" },
    expected: utf8("@SUB\n$4\nchat\n"),
  },
  {
    name: "unsubscribe",
    command: { command: "UNSUB", segmentId: "chat" },
    expected: utf8("@UNSUB\n$4\nchat\n"),
  },
  {
    name: "presence subscribe",
    command: { command: "PRES_SUB", segmentId: "chat" },
    expected: utf8("@PRES_SUB\n$4\nchat\n"),
  },
  {
    name: "presence unsubscribe",
    command: { command: "PRES_UNSUB", segmentId: "chat" },
    expected: utf8("@PRES_UNSUB\n$4\nchat\n"),
  },
  {
    name: "presence first page",
    command: { command: "PRES_LIST", segmentId: "chat", page: 1, perPage: 1 },
    expected: utf8("@PRES_LIST\n$4\nchat\n:1\n:1\n"),
  },
  {
    name: "presence last allowed page",
    command: {
      command: "PRES_LIST",
      segmentId: "chat",
      page: 2147483647,
      perPage: 100,
    },
    expected: utf8("@PRES_LIST\n$4\nchat\n:2147483647\n:100\n"),
  },
];

export const decodingVectors: {
  name: string;
  bytes: Uint8Array;
  expected: ServerMessage;
}[] = [
  {
    name: "peer null ID and zero timestamp",
    bytes: utf8("@MSG\n+user\n+chat\n$-1\n:0\n$0\n\n"),
    expected: {
      command: "MSG",
      tokenReference: "user",
      segmentId: "chat",
      messageId: null,
      timestamp: 0n,
      payload: new Uint8Array(),
    },
  },
  {
    name: "peer Unicode and max timestamp",
    bytes: new Uint8Array([
      ...utf8("@MSG\n+用戶\n+c:é\n+識\n:9223372036854775807\n$5\n"),
      0,
      255,
      13,
      10,
      64,
      10,
    ]),
    expected: {
      command: "MSG",
      tokenReference: "用戶",
      segmentId: "c:é",
      messageId: "識",
      timestamp: 9223372036854775807n,
      payload: new Uint8Array([0, 255, 13, 10, 64]),
    },
  },
  {
    name: "CRLF and min timestamp",
    bytes: utf8("@SERVER_MSG\r\n:-9223372036854775808\r\n$2\r\nok\r\n"),
    expected: {
      command: "SERVER_MSG",
      timestamp: -9223372036854775808n,
      payload: utf8("ok"),
    },
  },
  {
    name: "raw notice",
    bytes: utf8("@SERVER_MSG\n:1\n$6\njoined\n"),
    expected: { command: "SERVER_MSG", timestamp: 1n, payload: utf8("joined") },
  },
  {
    name: "simple payload and bulk identifiers",
    bytes: utf8("@MSG\n$1\nu\n$1\ns\n$1\nm\n:-1\n+data\n"),
    expected: {
      command: "MSG",
      tokenReference: "u",
      segmentId: "s",
      messageId: "m",
      timestamp: -1n,
      payload: utf8("data"),
    },
  },
  {
    name: "preserve BOM in text",
    bytes: utf8("@MSG\n+\uFEFFu\n+s\n$-1\n:1\n$0\n\n"),
    expected: {
      command: "MSG",
      tokenReference: "\uFEFFu",
      segmentId: "s",
      messageId: null,
      timestamp: 1n,
      payload: new Uint8Array(),
    },
  },
  {
    name: "empty array",
    bytes: utf8("*0\n"),
    expected: { command: "ARRAY", messages: [] },
  },
  {
    name: "nested arrays",
    bytes: utf8("*2\n*0\n*1\n@SERVER_MSG\n:1\n$0\n\n"),
    expected: {
      command: "ARRAY",
      messages: [
        { command: "ARRAY", messages: [] },
        {
          command: "ARRAY",
          messages: [
            { command: "SERVER_MSG", timestamp: 1n, payload: new Uint8Array() },
          ],
        },
      ],
    },
  },
  {
    name: "presence connections",
    bytes: utf8(
      "@PRES_LIST_RESPONSE\n+chat\n:1\n:25\n:1\n:1\n:1\n*1\n*3\n+user\n+connection\n:123\n",
    ),
    expected: {
      command: "PRES_LIST_RESPONSE",
      segmentId: "chat",
      total: 1n,
      perPage: 25n,
      currentPage: 1n,
      from: 1n,
      to: 1n,
      connections: [
        { tokenReference: "user", connectionId: "connection", timestamp: 123n },
      ],
    },
  },
  {
    name: "presence empty",
    bytes: utf8("@PRES_LIST_RESPONSE\n+chat\n:0\n:25\n:1\n:0\n:0\n*0\n"),
    expected: {
      command: "PRES_LIST_RESPONSE",
      segmentId: "chat",
      total: 0n,
      perPage: 25n,
      currentPage: 1n,
      from: 0n,
      to: 0n,
      connections: [],
    },
  },
  {
    name: "presence past last page",
    bytes: utf8("@PRES_LIST_RESPONSE\n+chat\n:1\n:25\n:2\n:26\n:1\n*0\n"),
    expected: {
      command: "PRES_LIST_RESPONSE",
      segmentId: "chat",
      total: 1n,
      perPage: 25n,
      currentPage: 2n,
      from: 26n,
      to: 1n,
      connections: [],
    },
  },
  {
    name: "whole-message error",
    bytes: utf8("-Err\nPermissionDeniedError\ntext\n-Err\nmore"),
    expected: {
      command: "ERROR",
      name: "PermissionDeniedError",
      message: utf8("text\n-Err\nmore"),
    },
  },
  {
    // The server's output batching wraps errors as the final array element
    // (C8 live observation); the tail position is boundary-unambiguous.
    name: "batched single error",
    bytes: utf8("*1\n-Err\nPermissionDeniedError\ndenied"),
    expected: {
      command: "ARRAY",
      messages: [
        {
          command: "ERROR",
          name: "PermissionDeniedError",
          message: utf8("denied"),
        },
      ],
    },
  },
  {
    name: "error as final batched element",
    bytes: utf8("*2\n@SERVER_MSG\n:1\n$2\nok\n-Err\nRateLimitError\nslow"),
    expected: {
      command: "ARRAY",
      messages: [
        { command: "SERVER_MSG", timestamp: 1n, payload: utf8("ok") },
        { command: "ERROR", name: "RateLimitError", message: utf8("slow") },
      ],
    },
  },
];

export const malformedVectors = [
  "",
  "*0\ntrailing",
  "*1\n",
  "*-1\n",
  "*4096\n",
  "*9223372036854775808\n",
  "@UNKNOWN\n",
  "@NODE_PUB\n",
  "@SUB\n+a\n",
  "+hello\n",
  ":1\n",
  "$-1\n",
  "@SERVER_MSG\n:+1\n$0\n\n",
  "@SERVER_MSG\n: 1\n$0\n\n",
  "@SERVER_MSG\n:1.0\n$0\n\n",
  "@SERVER_MSG\n:9223372036854775808\n$0\n\n",
  "@SERVER_MSG\n:-9223372036854775809\n$0\n\n",
  "@SERVER_MSG\n:1\n$-2\n",
  "@SERVER_MSG\n:1\n$-1\n",
  "@SERVER_MSG\n:1\n$9999999999999999999\n",
  "@SERVER_MSG\n:1\n$2\nx\n",
  "@SERVER_MSG\n:1\n$1\nx!",
  "@SERVER_MSG\n:1\n$0\n\r!",
  "@MSG\n+\n+s\n$-1\n:1\n$0\n\n",
  "@MSG\n+u\n+s\n+\n:1\n$0\n\n",
  "@MSG\n+u\rX\n+s\n$-1\n:1\n$0\n\n",
  "@MSG\n$3\nu\ns\n+s\n$-1\n:1\n$0\n\n",
  "*2\n-Err\nParserError\none-Err\nParserError\ntwo",
  "*2\n-Err\nParserError\nnot-last\n@SERVER_MSG\n:1\n$0\n\n",
  "*2\n*1\n-Err\nParserError\ninner-not-tail\n@SERVER_MSG\n:1\n$0\n\n",
  "-Other\nParserError\nmessage",
  "-Err\nBad\rName\nmessage",
  "@PRES_LIST_RESPONSE\n+s\n:0\n:1\n:1\n:0\n:0\n*1\n*2\n+u\n+c\n",
].map(utf8);
malformedVectors.push(
  new Uint8Array([...utf8("@MSG\n+"), 255, ...utf8("\n+s\n$-1\n:1\n$0\n\n")]),
);

// Invalid UTF-16 must not collapse onto the valid replacement character.
export const invalidIdentifierVectors = [
  "\ud800",
  "\udfff",
  "room-\ud800",
  "\udc00-room",
  "a\ud800b",
  "\udc00\ud800",
  "\ud800\ud800",
  "😀\udfff",
];

for (const [identifier, byteLength] of [
  ["😀", 4],
  ["\ud800\udc00", 4],
  ["\udbff\udfff", 4],
  ["\ufffd", 3],
  ["e\u0301", 3],
  ["é", 2],
  ["a\0b", 3],
] as const) {
  encodingVectors.push({
    name: `preserves Unicode identifier ${JSON.stringify(identifier)}`,
    command: { command: "SUB", segmentId: identifier },
    expected: utf8(`@SUB\n$${byteLength}\n${identifier}\n`),
  });
}

// Invalid text encodings remain valid opaque binary payloads.
export const invalidUtf8Vectors = [
  [0x80],
  [0xc0, 0xaf],
  [0xed, 0xa0, 0x80],
  [0xf0, 0x9f, 0x98],
  [0xf4, 0x90, 0x80, 0x80],
];
for (const bytes of invalidUtf8Vectors) {
  malformedVectors.push(
    new Uint8Array([
      ...utf8(`@MSG\n$${bytes.length}\n`),
      ...bytes,
      ...utf8("\n+s\n$-1\n:1\n$0\n\n"),
    ]),
  );
  decodingVectors.push({
    name: `opaque non-UTF8 payload ${bytes.join(",")}`,
    bytes: new Uint8Array([
      ...utf8(`@SERVER_MSG\n:1\n$${bytes.length}\n`),
      ...bytes,
      10,
    ]),
    expected: {
      command: "SERVER_MSG",
      timestamp: 1n,
      payload: new Uint8Array(bytes),
    },
  });
}
