import { expectTypeOf, test } from "vitest";
import type {
  CredentialProvider,
  CredentialRequest,
  Credentials,
} from "../../src/credential-types";
import { openConnection, type ConnectionHandle } from "../../src/connection";

test("credential acquisition and connection results use portable async contracts", () => {
  expectTypeOf<Parameters<CredentialProvider>>().toEqualTypeOf<
    [CredentialRequest]
  >();
  expectTypeOf<ReturnType<CredentialProvider>>().toEqualTypeOf<
    Promise<Credentials>
  >();
  expectTypeOf<ReturnType<typeof openConnection>>().toEqualTypeOf<
    Promise<ConnectionHandle>
  >();
});
function verifyReadonlyCredentials(credentials: Credentials): void {
  // @ts-expect-error Validated credentials are readonly.
  credentials.payload = "changed";
}
void verifyReadonlyCredentials;
