import { encodeClientCommand } from "../../src/encode";
import { decodeServerMessage } from "../../src/decode";
import {
  encodingVectors,
  invalidIdentifierVectors,
  decodingVectors,
  malformedVectors,
} from "./codec-vectors";

const observations = {
  encoded: encodingVectors.map(({ command }) =>
    Array.from(encodeClientCommand(command)),
  ),
  invalidIdentifiers: invalidIdentifierVectors.map((segmentId) => {
    try {
      encodeClientCommand({ command: "SUB", segmentId });
      return "accepted";
    } catch (error) {
      return error instanceof Error && "code" in error
        ? error.code
        : "unexpected error";
    }
  }),
  decoded: decodingVectors.map(({ bytes }) => decodeServerMessage(bytes)),
  malformed: malformedVectors.map((bytes) => {
    try {
      decodeServerMessage(bytes);
      return "accepted";
    } catch (error) {
      return error instanceof Error && "code" in error
        ? error.code
        : "unexpected error";
    }
  }),
};
// JSON carries bigint/byte observations across process and browser boundaries.
const serialized = JSON.stringify(observations, (_key, value: unknown) =>
  typeof value === "bigint"
    ? value.toString()
    : value instanceof Uint8Array
      ? Array.from(value)
      : value,
);
Object.assign(globalThis, { codecObservations: JSON.parse(serialized) });
console.log(serialized);
