# Contributing

Thanks for helping harden `swift-node`.

Before sending changes:

```bash
vp install
vp check
vp test
```

For a focused native or release-style check, run the matching first-class test file:

```bash
vp test test/workspace.test.mjs
vp test test/packaged-hello-world.test.mjs
vp test test/production-bridge.test.mjs
```

Keep changes focused. If a Swift signature is not fully supported across parser,
validator, generator, generated TypeScript, native compilation, and runtime
execution, reject it in validation instead of accepting a broken partial path.
