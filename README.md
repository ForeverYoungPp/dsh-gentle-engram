# dsh-gentle-engram

Host Cordis plugin written in TypeScript that adds reliable [Engram](https://github.com/Gentleman-Programming/engram) lifecycle behavior to DeepSeek Harness.

This integration requires [Engram](https://github.com/Gentleman-Programming/engram) to be installed and available on your system; the bridge cannot work without it.

## Design

- Uses the existing `@deepseek-ai/dsh-mcp-client` row for official [Engram](https://github.com/Gentleman-Programming/engram) MCP stdio tools.
- Hooks DSH session start, inbound prompts, tool results, turn stopping, and agent disposal.
- Seeds relevant [Engram](https://github.com/Gentleman-Programming/engram) context into the next model step.
- Saves prompts and filtered passive tool learnings asynchronously.
- Serializes per-session writes and waits for pending writes at turn boundaries.
- Closes [Engram](https://github.com/Gentleman-Programming/engram) sessions and records a structured summary when an agent is disposed.
- Never accesses [Engram](https://github.com/Gentleman-Programming/engram) SQLite directly and avoids forwarding likely secrets.

## Installation from npm

Requirements:

- DeepSeek Harness with the `dsh plugin` command.
- [Engram](https://github.com/Gentleman-Programming/engram) installed and available as `engram` in `PATH`.
- A configured DSH profile, such as `web`.

Install the alpha channel with:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-gentle-engram@alpha
```

For the stable channel:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-gentle-engram
```

Restart DSH after installation. The package is a Host bundle: its `cordis.patch.yml` owns both the MCP bridge and lifecycle plugin. Do not edit shipped presets or add a second manual [Engram](https://github.com/Gentleman-Programming/engram) MCP row.

Check that [Engram](https://github.com/Gentleman-Programming/engram) is available before starting DSH:

```bash
engram --version
```

## Local development

```bash
pnpm install
pnpm run typecheck
pnpm run build
```

## Contributing

Contributions, bug reports, documentation updates, and focused feature
proposals are welcome. For the complete workflow, coding expectations, and pull
request checklist, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

Before starting:

- Check existing [issues](https://github.com/eehcx/dsh-gentle-engram/issues) and
  pull requests to avoid duplicate work.
- Open an issue first for larger changes so the approach can be discussed.
- Do not include secrets, personal Engram data, local database files, or
  machine-specific configuration in commits.

For a typical change:

1. Fork the repository and create a focused branch.
2. Install dependencies with `pnpm install`.
3. Make the smallest change that solves the problem, preserving existing
   TypeScript and Cordis patterns.
4. Run `pnpm run typecheck` and `pnpm run build`.
5. Open a pull request explaining what changed, why, and how it was validated.

Keep pull requests focused, avoid editing generated `dist/` output directly,
and do not include unrelated formatting or dependency changes. Please report
suspected security vulnerabilities privately rather than in a public issue.

## License

This project is released under the MIT License. See [`LICENSE`](LICENSE) for
the complete license text.

