# Release validation

Gears requires Node **22.14.0 or newer**. The CI workflow tests the exact minimum,
latest Node 22, Node 24, and Node 26 on Ubuntu. This is the maintained CI matrix;
other operating systems and intermediate Node releases are not qualified by that
workflow. Local checks have also been run on macOS.

The previous minimum, 22.0.0, was not reliable with the current native SQLite
dependency. During validation, SQLite initialization crashed on macOS under Node
22.0.0 and 22.12.0. The dependency targets Node-API 10, and the isolated package
consumer passed on 22.14.0. Do not lower the engine requirement without testing
the native runtime and the complete installed artifact.

## Checks

```sh
npm ci
npm run build
npm run typecheck:tests
npm test
npm run test:package:built
```

`typecheck:tests` checks source, tests, fixtures, standalone verification scripts,
and Vitest configuration without emitting files. Assertions must use the actual
service contracts; do not suppress errors simply to make this check pass.

`test:package` builds and then runs the same smoke test as `test:package:built`.
Use the latter only after building, as CI does.

## Installed-package test

The smoke test runs in an isolated OS temporary directory outside the checkout:

1. Packs the build into an npm tarball.
2. Checks that examples and validation scripts are not included in the artifact.
3. Installs the tarball with runtime dependencies only.
4. Imports the root, testing, and database exports and exercises SQLite-backed
   queue persistence, the database provider, and the testing container.
5. Runs the installed `gears --version` executable and checks successful exit.
6. Installs consumer-owned TypeScript and Node declarations, then type-checks the
   consumer with strict checking and without `skipLibCheck`.
7. Removes the temporary consumer and tarball, including on failure.

The test needs registry access and allows normal native dependency installation.
It does not publish a package. SQLite declarations referenced by Gears' public
`.d.ts` files are package dependencies, so consumers need not discover and add
those declarations themselves.

The published file allowlist is `dist/src`; build output for examples and release
scripts stays out of the package. Public testing helpers remain intentionally
included through the testing export.

## What these checks do not establish

A green run validates that commit and its installed dependency resolution on the
selected runtime. It does not certify every newer dependency release, platform,
filesystem, upgrade path, or long-running workload. Database migration fixtures,
backup/restore drills, and release-candidate observation remain separate gates in
[the stability roadmap](ALPHA_TO_STABLE.md).
