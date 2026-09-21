# Contributing

Thank you for helping improve `dsh-gentle-engram`. Contributions, bug
reports, documentation updates, and focused feature proposals are welcome.

## Before you start

- Check the existing [issues](https://github.com/eehcx/dsh-gentle-engram/issues)
and pull requests to avoid duplicate work.
- For larger changes, open an issue first so the approach can be discussed.
- Never include secrets, personal Engram data, local database files, or
machine-specific configuration in a commit.

## Development setup

Requirements:

- Node.js compatible with the project's TypeScript and build tooling.
- `pnpm`.
- DeepSeek Harness and Engram are useful for integration testing, but are not
required for typechecking and building the package.

Clone the repository and install dependencies:

```bash
git clone https://github.com/eehcx/dsh-gentle-engram.git
cd dsh-gentle-engram
pnpm install
```

## Making changes

1. Create a focused branch from the default branch:

   ```bash
   git switch -c fix/short-description
   ```

2. Keep changes small and focused. Preserve the existing TypeScript and Cordis
patterns, and update documentation when behavior or configuration changes.
3. Do not edit generated output in `dist/`; regenerate it with the build script.
4. Avoid unrelated formatting or dependency changes.

## Validation

Run the checks before committing:

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

Tests are colocated at `src/**/*.test.ts`, use only the Node standard library (`node:test` / `node:assert`), add no dependencies, and remain erasable TypeScript — no `enum`, `namespace`, or constructor parameter properties.

If your change affects runtime behavior, test it with a local DSH profile when
possible and describe the test environment in the pull request.

## Commits and pull requests

- Use a clear, imperative commit message, such as `Fix session cleanup`.
- Explain what changed, why it changed, and how it was validated.
- Link related issues where applicable.
- Keep pull requests focused and update the documentation or examples when
needed.
- Be prepared to respond to review feedback; maintainers may request changes
before merging.

## Releases

Releases are managed with [Release Please](https://github.com/googleapis/release-please) and published by GitHub Actions.

1. Use [Conventional Commits](https://www.conventionalcommits.org/), such as `fix:` or `feat:`.
2. Push changes to `main`; Release Please opens or updates a release PR.
3. Merge the release PR. It creates a GitHub Release and tag.
4. The publish workflow validates, builds, and publishes that tag to npm.

The npm package must have GitHub Actions configured as a trusted publisher for this repository and the workflow `.github/workflows/publish.yml`. Do not add an npm token to the repository.

## Reporting security issues

Please do not disclose suspected vulnerabilities in a public issue. Contact
the repository maintainers privately through the project's GitHub security
features or a private maintainer channel.

## Code of conduct

Be respectful, constructive, and inclusive. Harassment and discriminatory
behavior are not welcome in this project.
