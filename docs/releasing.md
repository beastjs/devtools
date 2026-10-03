# Releasing @beastjs/devtools

The `Release` workflow maintains a Release Please PR on `main`. Merging that
PR updates `package.json`, `.release-please-manifest.json`, and `CHANGELOG.md`,
creates a GitHub release and a matching tag such as `0.1.17`, then publishes the
checked package to npm. The private icons workspace is not published separately.

## One-time setup

1. Push the workflow and release configuration to `main`.
2. Add the repository Actions secret `RELEASE_PLEASE_TOKEN`: a fine-grained
   personal access token restricted to `beastjs/devtools`, with **Contents: Read
   and write** and **Pull requests: Read and write**. Authorize it for the
   organization if required, and renew it before it expires. Use
   `gh secret set RELEASE_PLEASE_TOKEN --repo beastjs/devtools` to enter it
   interactively; never put a token in a commit.
3. In the npm settings for `@beastjs/devtools`, add a **GitHub Actions trusted
   publisher** with exactly these values:

   | Field | Value |
   | --- | --- |
   | Organization or user | `beastjs` |
   | Repository | `devtools` |
   | Workflow filename | `release.yml` |
   | Environment | Leave empty |
   | Allowed actions | Enable direct `npm publish` |

   No `NPM_TOKEN` secret is needed. npm exchanges the workflow's OIDC identity
   for short-lived publishing credentials and generates provenance.

The repository's enterprise policy currently prevents the built-in
`GITHUB_TOKEN` from creating release PRs. The dedicated release token also lets
CI run automatically on those PRs; PRs created by `GITHUB_TOKEN` do not trigger
other Actions workflows. The publishing job uses OIDC and does not receive the
release token.

## Normal releases

Use conventional commit messages, or conventional PR titles when squash merging:

- `fix: replace existing style values` proposes a patch release.
- `feat: suggest removing empty styles` proposes a minor release.
- `feat!: change the inspector API` marks a breaking change. Before version
  `1.0.0`, breaking changes bump the minor version; after `1.0.0`, they bump major.
- `chore: ...`, `docs: ...`, and other maintenance-only commits do not trigger a
  release on their own.

Review the Release Please PR, including the version, changelog, and CI checks,
then merge it. Versions and changelog entries are generated from commits; do not
manually bump the manifest or run `npm version` for normal automated releases.
The first automated release starts after commit `c272824` (the current `0.1.16`
version commit). The full SHA is recorded in `release-please-config.json`.
Existing changelog history is retained.

CI and publishing both run `bun install --frozen-lockfile` and `bun run check`.
CI also previews the npm package contents. Publishing checks out the exact
release tag, verifies that it equals the package version, packs the checked root
package, and publishes that tarball. Publishing a tarball avoids repeating the
root `prepublishOnly` hook after the checks have already passed; local
`npm publish` still runs that hook.

## Retry a failed publish

A GitHub release can exist even if the npm step failed. After correcting the
problem, open **Actions → Release → Run workflow**, select `main`, and enter the
existing tag in `tag`. Alternatively:

```bash
gh workflow run release.yml --repo beastjs/devtools --ref main -f tag=0.1.17
```

The retry checks out that tag, verifies its version, and publishes only if npm
returns 404 for that exact package version. Already-published versions are
skipped; authentication errors, network failures, and other registry errors
stop the workflow. Leaving `tag` empty reruns Release Please instead.

Only releases containing this automation can be retried this way. The existing
`0.1.16` tag points to source declaring `0.1.15`; it is intentionally not moved
or republished. All new automated tags must match their package versions.

References: [Release Please](https://github.com/googleapis/release-please-action)
and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
