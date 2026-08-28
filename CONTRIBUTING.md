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
pnpm run typecheck
pnpm run build
```

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

## Reporting security issues

Please do not disclose suspected vulnerabilities in a public issue. Contact
the repository maintainers privately through the project's GitHub security
features or a private maintainer channel.

## Code of conduct

Be respectful, constructive, and inclusive. Harassment and discriminatory
behavior are not welcome in this project.
