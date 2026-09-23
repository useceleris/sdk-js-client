import { describe, expect, it } from "vitest";
import {
  connectedChannel,
  nextMessage,
  uniqueChannelReference,
} from "./helpers/environment";

// Payloads are opaque bytes to the SDK and the server: whatever a caller
// encodes is what the peer decodes. These vectors are hand-encoded so the
// suite needs no serializer dependency, and each is decoded on arrival so
// the vector proves itself rather than merely matching a copy of itself.
const settle = (ms = 1_500) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// protobuf wire format:
//   field 1 (varint)          = 150
//   field 2 (length-delimited) = "안녕 celeris"
//   field 3 (embedded message) = { field 1 (varint) = 1 }
const protobufVector = new Uint8Array([
  8, 150, 1, 18, 14, 236, 149, 136, 235, 133, 149, 32, 99, 101, 108, 101, 114,
  105, 115, 26, 2, 8, 1,
]);

// MessagePack: fixmap(3) { "id": 7, "bin": bin8 <00 ff 10>, "txt": "héllo" }
const messagePackVector = new Uint8Array([
  131, 162, 105, 100, 7, 163, 98, 105, 110, 196, 3, 0, 255, 16, 163, 116, 120,
  116, 166, 104, 195, 169, 108, 108, 111,
]);

const jsonVector = new TextEncoder().encode(
  JSON.stringify({ id: 7, txt: "héllo 안녕", nested: { ok: true } }),
);

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    const byte = bytes[index++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, index];
    shift += 7;
  }
}

describe("celeris payload formats", () => {
  it.each([
    ["json", jsonVector],
    ["messagepack", messagePackVector],
    ["protobuf", protobufVector],
  ])("round-trips a %s payload byte-identically", async (label, vector) => {
    const reference = uniqueChannelReference(`fmt-${label}`);
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    receiver.segment("formats").subscribe();
    await settle();

    await publisher.segment("formats").publish({ payload: vector });
    const message = await nextMessage(
      receiver.segment("formats"),
      () => true,
      `the ${label} delivery`,
      20_000,
    );

    expect(Array.from(message.payload)).toEqual(Array.from(vector));
    expect(message.messageId).toMatch(/^msg_/);

    await publisher.close();
    await receiver.close();
  });

  it("delivers payloads that decode to their intended values", async () => {
    const reference = uniqueChannelReference("fmt-decode");
    const publisher = await connectedChannel(reference);
    const receiver = await connectedChannel(reference);
    const received = new Map<number, Uint8Array>();
    receiver.segment("formats").onMessage((message) => {
      received.set(message.payload.length, message.payload);
    });
    receiver.segment("formats").subscribe();
    await settle();

    for (const vector of [jsonVector, messagePackVector, protobufVector]) {
      await publisher.segment("formats").publish({ payload: vector });
    }
    await nextMessage(
      receiver.segment("formats"),
      () => received.size >= 3,
      "all three format deliveries",
      20_000,
    );

    const json = received.get(jsonVector.length)!;
    expect(JSON.parse(new TextDecoder().decode(json))).toEqual({
      id: 7,
      txt: "héllo 안녕",
      nested: { ok: true },
    });

    // MessagePack: fixmap header, then the bin8 field's exact bytes.
    const messagePack = received.get(messagePackVector.length)!;
    expect(messagePack[0]! & 0xf0).toBe(0x80);
    const binaryStart = messagePack.indexOf(0xc4);
    expect(Array.from(messagePack.slice(binaryStart, binaryStart + 5))).toEqual(
      [0xc4, 0x03, 0x00, 0xff, 0x10],
    );

    // protobuf: field 1 is a varint carrying 150, field 2 is the string.
    const protobuf = received.get(protobufVector.length)!;
    expect(protobuf[0]).toBe(0x08);
    const [fieldOne, afterFieldOne] = readVarint(protobuf, 1);
    expect(fieldOne).toBe(150);
    expect(protobuf[afterFieldOne]).toBe(0x12);
    const [length, afterLength] = readVarint(protobuf, afterFieldOne + 1);
    expect(
      new TextDecoder().decode(
        protobuf.slice(afterLength, afterLength + length),
      ),
    ).toBe("안녕 celeris");

    await publisher.close();
    await receiver.close();
  });
});
