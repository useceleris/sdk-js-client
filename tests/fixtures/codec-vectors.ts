import type { ClientCommand } from "../../src/commands";
import type { ServerMessage } from "../../src/messages";

// Vector revision 2: realtime@cfa901fa73b2bd26abcc46c2f5ce47879dd4dc75 plus the
// uncommitted C14 error frame and presence request ids.
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
    command: {
      command: "PRES_LIST",
      segmentId: "chat",
      page: 1,
      perPage: 1,
      requestId: "1",
    },
    expected: utf8("@PRES_LIST\n$4\nchat\n;1\n;1\n$1\n1\n"),
  },
  {
    name: "presence last allowed page",
    command: {
      command: "PRES_LIST",
      segmentId: "chat",
      page: 2147483647,
      perPage: 100,
      requestId: "識-9",
    },
    expected: utf8("@PRES_LIST\n$4\nchat\n;2147483647\n;100\n$5\n識-9\n"),
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
      "@PRES_LIST_RESPONSE\n+chat\n$1\n7\n;1\n;25\n;1\n;1\n;1\n*1\n*3\n+user\n+connection\n:123\n",
    ),
    expected: {
      command: "PRES_LIST_RESPONSE",
      segmentId: "chat",
      requestId: "7",
      total: 1,
      perPage: 25,
      currentPage: 1,
      from: 1,
      to: 1,
      connections: [
        { tokenReference: "user", connectionId: "connection", timestamp: 123n },
      ],
    },
  },
  {
    name: "presence empty",
    bytes: utf8("@PRES_LIST_RESPONSE\n+chat\n$1\n8\n;0\n;25\n;1\n;0\n;0\n*0\n"),
    expected: {
      command: "PRES_LIST_RESPONSE",
      segmentId: "chat",
      requestId: "8",
      total: 0,
      perPage: 25,
      currentPage: 1,
      from: 0,
      to: 0,
      connections: [],
    },
  },
  {
    name: "presence notification join",
    bytes: utf8("@PRES_NOTIFY\n+chat\n+user\n+connection\n;1\n:123\n"),
    expected: {
      command: "PRES_NOTIFY",
      segmentId: "chat",
      tokenReference: "user",
      connectionId: "connection",
      joined: true,
      timestamp: 123n,
    },
  },
  {
    name: "presence notification leave",
    bytes: utf8("@PRES_NOTIFY\n+chat\n+user\n+connection\n;0\n:124\n"),
    expected: {
      command: "PRES_NOTIFY",
      segmentId: "chat",
      tokenReference: "user",
      connectionId: "connection",
      joined: false,
      timestamp: 124n,
    },
  },
  {
    // DECODE-01: a command this version does not know is skipped, not
    // rejected, so a newer server cannot break a deployed client.
    name: "unknown command ignored",
    bytes: utf8("@FUTURE_COMMAND\n+a\n:1\n"),
    expected: { command: "IGNORED" },
  },
  {
    name: "unknown command ignored in tail position",
    bytes: utf8("*2\n@SERVER_MSG\n:1\n$0\n\n@FUTURE_COMMAND\n+a\n"),
    expected: {
      command: "ARRAY",
      messages: [
        { command: "SERVER_MSG", timestamp: 1n, payload: new Uint8Array() },
        { command: "IGNORED" },
      ],
    },
  },
  {
    // NODE_* commands are internal between server nodes. The SDK does not
    // recognise any of them, so one that arrives is skipped like any other
    // unknown command.
    name: "internal node command ignored",
    bytes: utf8("@NODE_PUB\n+node-1\n$4\nbody\n"),
    expected: { command: "IGNORED" },
  },
  {
    name: "internal node command ignored in tail position",
    bytes: utf8("*2\n@SERVER_MSG\n:1\n$0\n\n@NODE_PUB\n+node-1\n"),
    expected: {
      command: "ARRAY",
      messages: [
        { command: "SERVER_MSG", timestamp: 1n, payload: new Uint8Array() },
        { command: "IGNORED" },
      ],
    },
  },
  {
    name: "any NODE_ command ignored",
    bytes: utf8("@NODE_FUTURE\n+a\n"),
    expected: { command: "IGNORED" },
  },
  {
    name: "presence past last page",
    bytes: utf8(
      "@PRES_LIST_RESPONSE\n+chat\n$1\n9\n;1\n;25\n;2\n;26\n;1\n*0\n",
    ),
    expected: {
      command: "PRES_LIST_RESPONSE",
      segmentId: "chat",
      requestId: "9",
      total: 1,
      perPage: 25,
      currentPage: 2,
      from: 26,
      to: 1,
      connections: [],
    },
  },
  {
    name: "error without sub type or resource",
    bytes: utf8("-Err\n+RateLimitError\n$-1\n$4\nslow\n$-1\n"),
    expected: {
      command: "ERROR",
      type: "RateLimitError",
      subType: null,
      message: utf8("slow"),
      resource: null,
    },
  },
  {
    // The message is length-prefixed, so it may contain anything, including
    // text that looks like another error.
    name: "error message containing frame text",
    bytes: utf8(
      "-Err\n+PermissionDeniedError\n+SUB\n$14\ntext\n-Err\nmore\n$4\nroom\n",
    ),
    expected: {
      command: "ERROR",
      type: "PermissionDeniedError",
      subType: "SUB",
      message: utf8("text\n-Err\nmore"),
      resource: "room",
    },
  },
  {
    name: "presence query error carrying its request id",
    bytes: utf8(
      "-Err\n+InternalError\n+PRES_LIST\n$27\nError getting presence data\n$1\n3\n",
    ),
    expected: {
      command: "ERROR",
      type: "InternalError",
      subType: "PRES_LIST",
      message: utf8("Error getting presence data"),
      resource: "3",
    },
  },
  {
    name: "error resource of every shape",
    bytes: utf8(
      "-Err\n+FutureError\n+PUB\n$1\nx\n*5\n+a\n:-5\n;7\n$-1\n*1\n$1\nb\n",
    ),
    expected: {
      command: "ERROR",
      type: "FutureError",
      subType: "PUB",
      message: utf8("x"),
      resource: ["a", -5n, 7, null, ["b"]],
    },
  },
  {
    // Errors are self-delimiting, so they may sit anywhere in a batch, and two
    // batched errors decode as two.
    name: "batched errors before other messages",
    bytes: utf8(
      "*3\n-Err\n+PermissionDeniedError\n+PRES_SUB\n$2\nno\n$4\nroom\n-Err\n+PermissionDeniedError\n+PRES_LIST\n$2\nno\n$1\n4\n@SERVER_MSG\n:1\n$2\nok\n",
    ),
    expected: {
      command: "ARRAY",
      messages: [
        {
          command: "ERROR",
          type: "PermissionDeniedError",
          subType: "PRES_SUB",
          message: utf8("no"),
          resource: "room",
        },
        {
          command: "ERROR",
          type: "PermissionDeniedError",
          subType: "PRES_LIST",
          message: utf8("no"),
          resource: "4",
        },
        { command: "SERVER_MSG", timestamp: 1n, payload: utf8("ok") },
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
  // An unknown command is skippable only when it runs to the end of the
  // transport message; anywhere else its boundary is unknowable (DECODE-01).
  "*2\n@FUTURE_COMMAND\n+a\n@SERVER_MSG\n:1\n$0\n\n",
  "*2\n*1\n@FUTURE_COMMAND\n+a\n@SERVER_MSG\n:1\n$0\n\n",
  "*2\n@NODE_PUB\n+node-1\n@SERVER_MSG\n:1\n$0\n\n",
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
  // A line-based layout without field markers.
  "-Err\nParserError\nmessage",
  "-Other\n+ParserError\n$-1\n$1\nm\n$-1\n",
  // Missing fields.
  "-Err\n+ParserError\n$-1\n$1\nm\n",
  "-Err\n+ParserError\n$-1\n",
  // The type must be a simple-string name.
  "-Err\n$11\nParserError\n$-1\n$1\nm\n$-1\n",
  "-Err\n+Bad\rName\n$-1\n$1\nm\n$-1\n",
  "-Err\n+Bad-Name\n$-1\n$1\nm\n$-1\n",
  "-Err\n+ParserErrorParserErrorParserErrorParserErrorParserErrorParserError\n$-1\n$1\nm\n$-1\n",
  // The sub type must be a name or null.
  "-Err\n+ParserError\n+PRES LIST\n$1\nm\n$-1\n",
  "-Err\n+ParserError\n$3\nSUB\n$1\nm\n$-1\n",
  "-Err\n+ParserError\n:1\n$1\nm\n$-1\n",
  // The message cannot be null.
  "-Err\n+ParserError\n$-1\n$-1\n$-1\n",
  // The resource must be a known fragment, within the depth limit.
  "-Err\n+ParserError\n$-1\n$1\nm\n@SERVER_MSG\n",
  "-Err\n+ParserError\n$-1\n$1\nm\n" + "*1\n".repeat(40) + "$-1\n",
  "@PRES_LIST_RESPONSE\n+s\n$1\n1\n;0\n;1\n;1\n;0\n;0\n*1\n*2\n+u\n+c\n",
  // Presence figures and the join/leave flag are Integer32: signed 32-bit,
  // decimal digits only, with the `;` marker.
  ...[
    ";2147483648\n",
    ";-2147483649\n",
    ";000000000001\n",
    ";+1\n",
    "; 1\n",
    ";1.0\n",
    ":1\n",
  ].map(
    (total) => `@PRES_LIST_RESPONSE\n+s\n$1\n1\n${total};1\n;1\n;0\n;0\n*0\n`,
  ),
  "@PRES_NOTIFY\n+s\n+u\n+c\n:1\n:123\n",
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
