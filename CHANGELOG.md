# Changelog

## [0.3.1](https://github.com/ForeverYoungPp/dsh-gentle-engram/compare/v0.3.0...v0.3.1) (2026-09-21)


### Bug Fixes

* **changelog:** correct the 0.3.0 entry, which repeated commits 0.2.0 already shipped ([c27199d](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/c27199d616cc71ab7a986a14815e5c5bcf5fb47c))

## [0.3.0](https://github.com/ForeverYoungPp/dsh-gentle-engram/compare/v0.2.0...v0.3.0) (2026-09-21)

**Tagged and released, but never published to npm**: 0.3.1 is the first release that reached the
registry.

release-please measured this release from v0.1.1, because 0.2.0 was published to npm from a local
token and never tagged in this repository. The entries marked _already in 0.2.0_ are therefore not
new here; only the injection fix is.

### Features

* talk to Engram over HTTP instead of bridging its MCP server ([08c8ab3](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/08c8ab34eedd0cf16f2b706ea992adfbfa753ae2)) — _already in 0.2.0_

### Bug Fixes

* close this plugin's own Engram session when its agent is disposed ([f45a690](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/f45a6907584846730b1a9941b65a8a4e24712326)) — _already in 0.2.0_
* handle Engram project resolution failures ([cfa5752](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/cfa5752f2d1521c211b88b4ceb2b147b7e936dae)) — _already in 0.2.0_
* **injection:** stop re-injecting memory after a compaction, and fit the block ([58aea5f](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/58aea5ff7039186124b3b1b6a4bfc674c9f405f7))
