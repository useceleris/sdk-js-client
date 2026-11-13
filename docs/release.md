# Releasing @useceleris/client

This package uses **manual semantic versioning**. A release version is chosen,
reviewed and committed before it reaches the protected `release` branch. The
release workflow then validates that exact commit, publishes the package to npm
and creates the matching GitHub tag and release.

## Required setup

The `release` branch is protected and accepts changes through reviewed pull
requests. It must contain [the release workflow](../.github/workflows/release.yml).
Merging a commit into this branch is the only event that starts a publish.

The repository Actions secrets must contain `NPM_TOKEN`: an npm granular token
that has publish access to `@useceleris/client`. The workflow uses GitHub's
temporary `GITHUB_TOKEN` automatically to create the git tag and GitHub
Release; it is not stored as a repository secret. GitHub Actions must allow the
workflow's `contents: write` permission.

## Choosing the version

Follow semantic versioning:

| Change                                                                | Bump  | Example           |
| --------------------------------------------------------------------- | ----- | ----------------- |
| Backward-compatible bug fix, documentation fix or internal correction | Patch | `1.1.1` → `1.1.2` |
| New backward-compatible public capability                             | Minor | `1.1.1` → `1.2.0` |
| Removed, renamed or incompatible public behavior                      | Major | `1.1.1` → `2.0.0` |

Never reuse a version. npm packages and git tags are immutable release records.

## Preparing a release

Create a release-preparation branch from `release`. For a chosen version, use
npm to update the manifest and lockfile without creating a local git tag:

```sh
npm version 1.1.2 --no-git-tag-version
```

On Windows PowerShell installations where `npm.ps1` is disabled, run:

```powershell
npm.cmd version 1.1.2 --no-git-tag-version
```

Then update the package-owned runtime version in `src/constants.ts`:

```ts
export const SDK_VERSION = "1.1.2";
```

All three values must be identical before merging:

```text
package.json                 1.1.2
package-lock.json            1.1.2
src/constants.ts             1.1.2
```

Open a pull request into `release`. The normal CI workflow validates the build,
typechecks, linting, formatting and tests. Review the selected semantic-version
bump and the version changes along with the product change. Merge only after CI
passes.

## What the release workflow does

The merge to `release` starts the release workflow. It:

1. Installs the committed dependency lockfile with `npm ci`.
2. Installs Bun, Deno and the Playwright browser engines required by the test
   matrix.
3. Runs `npm run check`, which builds, typechecks, lints, format-checks and
   tests the package.
4. Fails if tag `v<package.json version>` already exists.
5. Publishes that exact version to the public npm registry.
6. Creates tag `v<version>` at the merged commit and a GitHub Release with
   automatically generated notes.

For example, a successful `1.1.2` release produces:

```text
npm package:    @useceleris/client@1.1.2
git tag:        v1.1.2
GitHub Release: v1.1.2
```

## Failed releases

If validation fails before publishing, fix the release branch through another
pull request and let the workflow run again. Do not change the version merely
to retry a failed build.

If npm publication succeeds but the GitHub tag or release creation fails, do
not rerun the workflow: npm will reject publication of the already-published
version. Create the missing tag and GitHub Release for the same release commit,
then investigate the failed GitHub step. Never publish a second package version
solely to repair GitHub release metadata.
