# Changelog

## [0.5.0](https://github.com/ForeverYoungPp/dsh-gentle-engram/compare/v0.4.1...v0.5.0) (2026-09-23)


### Features

* **tools:** expose mem_delete and send the Engram bearer token ([730212b](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/730212b5bfe7a7fec6ecfdd6ee7b0307b51f9d09))

## [0.4.1](https://github.com/ForeverYoungPp/dsh-gentle-engram/compare/v0.4.0...v0.4.1) (2026-09-22)


### Bug Fixes

* **json:** normalize negative zero so tool output is always lossless JSON ([d9ae1a6](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/d9ae1a625fee2952575313ca17e106db0a685bc7))
* **json:** normalize negative zero so tool output is always lossless JSON ([3662a2b](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/3662a2bd055c4e69cae9622e8e5dc4b69cbc62d9))

## [0.4.0](https://github.com/ForeverYoungPp/dsh-gentle-engram/compare/v0.3.1...v0.4.0) (2026-09-22)


### Features

* **memory:** scope recall to the session project, drop ambient injection, add stats/timeline ([71b8e09](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/71b8e09006ecec51daa6fdafd9e11738f2dd362e))
* **transport:** verify the server instance and report write timeouts honestly ([6ec734c](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/6ec734cebe0a5e2fd1a4d37b325721d09f33fa38))


### Bug Fixes

* **memory:** project-exact recall, on-demand context, and reference-aligned transport ([7a076d8](https://github.com/ForeverYoungPp/dsh-gentle-engram/commit/7a076d8c589bd3d16cf085288913e3e80c44f55d))

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
