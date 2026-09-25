import { ConfigurationError } from "./errors";
import { STRICT_TEXT_DECODER, TEXT_ENCODER } from "./constants";

// Payloads are opaque bytes on the wire. These helpers cover the two
// encodings applications reach for first; every other format goes through
// createPayloadCodec, which keeps serializer libraries out of this package.

export function textPayload(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
} // end function textPayload

export function jsonPayload(value: unknown): Uint8Array {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch {
    // Circular structures and bigint values throw; undefined, functions and
    // symbols serialize to nothing at all. Both are the same refusal, and
    // neither may surface the input.
  }

  if (serialized === undefined)
    throw new ConfigurationError("Value is not JSON-serializable.");

  return TEXT_ENCODER.encode(serialized);
} // end function jsonPayload

export function readText(payload: Uint8Array): string {
  try {
    return STRICT_TEXT_DECODER.decode(payload);
  } catch {
    throw new ConfigurationError("Payload is not valid UTF-8.");
  }
} // end function readText

// The generic is an assertion, not a validation: schema-check payloads that
// come from peers you do not control.
export function readJson<T>(payload: Uint8Array): T {
  const text = readText(payload);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConfigurationError("Payload is not valid JSON.");
  }
} // end function readJson

export type PayloadCodec<T> = {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
};

export type BoundPayloadCodec<T> = {
  encodePayload(value: T): Uint8Array;
  readPayload(payload: Uint8Array): T;
};

// Bring your own serializer — protobuf, MessagePack, CBOR, Avro, anything.
// Failures from the supplied functions propagate unchanged: they are the
// caller's errors, not this package's.
export function createPayloadCodec<T>(
  codec: PayloadCodec<T>,
): BoundPayloadCodec<T> {
  if (
    typeof codec?.encode !== "function" ||
    typeof codec.decode !== "function"
  ) {
    throw new ConfigurationError(
      "Codec must provide encode and decode functions.",
    );
  }

  return {
    encodePayload: (value) => codec.encode(value),
    readPayload: (payload) => codec.decode(payload),
  };
} // end function createPayloadCodec
