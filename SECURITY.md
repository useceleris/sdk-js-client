# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [Security Advisories](https://github.com/useceleris/sdk-js-client/security/advisories/new) on this repository. That channel is private between you and the maintainer, and it lets us prepare a fix before anything is disclosed.

Include what you need to make the problem reproducible: affected version, the runtime you saw it on, and the smallest example that shows it. If you have a suggested fix, that is welcome but not required.

You should get an acknowledgement within a few days. We will tell you what we found, what we intend to do, and when we expect a fix to land — and we will credit you when it is published, unless you would rather we did not.

## Supported versions

Fixes land on the latest release. There is no long-term support branch.

## Scope

In scope: anything in this package that lets one connection read, write or impersonate beyond what its credentials grant, any leak of a signing secret or credential into a place it should not reach, and any input from the network that can crash or corrupt a consuming application.

Out of scope: the Celeris service itself, which is reported through the same channel on its own repository, and findings that require an attacker who already holds the signing secret — that secret is the trust boundary, and its compromise is total by design.

## What this package promises

This is the client package. It **never signs anything** and contains no signing facility, no secret-taking constructor and no dependency path that reaches one. A build of this package is safe to ship to a browser. If you find a way that it is not, that is exactly the kind of report we want.

Bytes arriving from the network are treated as untrusted: the decoder is bounded on size, depth and fragment count, identifiers are validated, and no server-supplied text is ever placed into an error message, a log or a thrown value.
