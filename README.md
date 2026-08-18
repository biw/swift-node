# swift-node

[![CI](https://badgen.net/github/checks/biw/swift-node)](https://github.com/biw/swift-node/actions)
[![npm version](https://badgen.net/npm/v/swift-node)](https://www.npmjs.com/package/swift-node)
[![npm downloads](https://badgen.net/npm/dt/swift-node)](https://www.npmjs.com/package/swift-node)

Write the native part of a Node module in Swift. Add an annotation, build, and import typed named exports—without maintaining C++ glue or shipping a runtime loader.

`swift-node` turns annotated Swift functions into a Node-API addon and generates TypeScript declarations. It keeps its generated runtime and target-qualified native binaries in `dist_swift-node/`.

```swift
// @swift-node:export
func helloWorld() -> String {
    "Hello, World!"
}
```

```js
import { helloWorld } from './dist_swift-node/index.mjs'

console.log(helloWorld())
```

`// @swift-node:export` marks a Swift function as part of your module's public Node API. Every annotated function becomes a named JavaScript export; there is no default export.

## Quick start

### 1. Create a project

```bash
npx swift-node init my-addon
cd my-addon
```

### 2. Install and build

Install dependencies and build with your package manager. For example, with npm:

```bash
npm install
npm run build
```

The generated `build` script runs the project-local `swift-node` dev dependency. It compiles `src/native.swift` and writes the generated runtime and binary to `dist_swift-node/`.

### 3. Import it from Node

Create `demo.mjs`:

```js
import { helloWorld } from './dist_swift-node/index.mjs'

console.log(helloWorld())
```

```bash
node demo.mjs
# Hello, World!
```

Edit `src/native.swift`, then repeat your package manager's build command. The generated ESM, CommonJS, TypeScript, and native implementation stays in `dist_swift-node/`.

## Exporting Swift functions

Put `// @swift-node:export` immediately above each Swift function you want to import from Node. Its Swift signature determines the JavaScript API.

Only functions become module exports. You cannot directly export a Swift class, struct, enum, stored variable, or constant. Instead, expose operations with functions. Classes, structs, and enums can still be used as function parameters and return values when their data fits one of the bridges below; JavaScript receives values, not Swift instances with methods or identity.

```swift
import Foundation

// @swift-node:export
func divide(_ a: Double, _ b: Double) throws -> Double {
    guard b != 0 else { throw NSError(domain: "swift-node", code: 1) }
    return a / b
}

// @swift-node:export
func uppercase(_ input: String) async -> String {
    input.uppercased()
}

// @swift-node:export
func reverse(_ input: Data) -> Data {
    Data(input.reversed())
}
```

## Passing custom types with `Codable`

`Codable` is Swift's way to turn a custom type into JSON-shaped data. Use `// @swift-node:codable` when an exported function needs a struct, enum, or class with nested fields, optional values, or another shape that is not one of the simple built-in bridges. It is not an export annotation: `respond` is the JavaScript export below, while `Request` and `Response` travel across the boundary as ordinary JavaScript objects. The generated bridge uses Foundation JSON encoding and decoding instead of requiring a C-compatible memory layout.

```swift
// @swift-node:codable
struct Request: Codable {
    let prompt: String
    let tags: [String]
}

// @swift-node:codable
struct Response: Codable {
    let text: String
}

// @swift-node:export
func respond(_ request: Request) async throws -> Response {
    Response(text: request.prompt)
}
```

If JavaScript supplies a value that Swift cannot decode as the expected model, the call fails: a synchronous export throws and an asynchronous export rejects its Promise. Generated declarations use `unknown` for custom Codable models, so a public package should provide its own TypeScript request and response interfaces around the generated functions.

## Supported types

These are the values that an exported function can accept or return. They are not additional module exports.

| Swift value                                                         | JavaScript value        | Notes                                                                                                 |
| ------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `String`                                                            | `string`                |                                                                                                       |
| `String?`, `Int?`, `Int32?`, `Int64?`, `Double?`, `Float?`, `Bool?` | nullable value          | Swift `nil` becomes JavaScript `null`                                                                 |
| `Int`, `Int32`, `Int64`, `Double`, `Float`                          | `number`                | `Int` and `Int64` must be JavaScript-safe integers                                                    |
| `Bool`                                                              | `boolean`               |                                                                                                       |
| `Data`, `[UInt8]`                                                   | `Uint8Array` / `Buffer` | Top-level binary values use a binary-safe bridge                                                      |
| `[T]`, `Array<T>`, `[String: T]`, `Dictionary<String, T>`           | arrays and objects      | `T` must be JSON-safe; nested `Data` values become base64 strings                                     |
| `// @swift-node:codable` `Codable` type                             | JSON-like object        | Works for structs, enums, and classes; concrete generic instances such as `Box<String>` are supported |
| Public struct with scalar or `String` stored fields                 | plain object            | A lightweight ABI bridge; optional or unsupported fields need `Codable` instead                       |

### Function behavior

| Swift function feature                          | JavaScript behavior                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `throws`                                        | throws a JavaScript exception                                                                         |
| `async`, `async throws`                         | returns `Promise<T>`; an error rejects the Promise                                                    |
| `@MainActor`                                    | returns directly on Node's main thread                                                                |
| other global actors                             | uses the Promise bridge                                                                               |
| `@escaping (String, Int, Bool, Double) -> Void` | accepts a one-shot JavaScript callback; `String?` is also supported for an optional callback argument |

## Unsupported types and signatures

| Swift feature                                                             | Why                                                                                            | What to use instead                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Classes, structs, enums, variables, or constants as direct module exports | The Node module surface is generated from callable functions                                   | Expose functions; pass structured data through function parameters and returns          |
| Unconstrained generic functions                                           | JavaScript has no runtime type argument with which to choose a Swift specialization            | Use a concrete specialization, such as `func echo(_ value: Box<String>) -> Box<String>` |
| Overloaded exported functions                                             | JavaScript exports have one name, but Swift overloads use the same name for several signatures | Give each exported function a distinct name                                             |
| Raw ABI structs in `async` functions                                      | Their synchronous in-memory representation cannot cross the asynchronous boundary safely       | Mark the model `Codable`                                                                |
| `AsyncSequence` as a stream return                                        | It is a broad protocol, not one concrete runtime representation with a stable C ABI            | Return `AsyncStream<Element>` or `AsyncThrowingStream<Element, Error>`                  |
| Arbitrary callback shapes                                                 | Callbacks must be one-shot `@escaping (...) -> Void` functions with supported argument types   | Use a supported callback or a stream                                                    |

## Commands

### `swift-node init [package-name|.]`

Creates a project. Pass a name to create a directory, or `.` to initialize the current directory. Non-interactive use writes the starter and tells you to install dependencies and build it.

In an interactive terminal, it can also:

- Choose a package manager.
- Set up tsdown to package TypeScript with `swift-node-unplugin`.
- Select target binaries.
- Choose whether Linux and Windows target packages include the Swift runtime (default: yes).
- Generate a CI workflow and an optional CI-gated npm publish workflow.
- Build the starter addon.

### `swift-node build`

Parses annotated functions, generates the bridge, and builds macOS binaries at `dist_swift-node/{moduleName}.darwin-{arch}.node`. Linux and Windows binaries stay in `dist_swift-node/{platform}-{arch}/{moduleName}.{platform}-{arch}.node` with their Swift runtime sidecars.

### tsdown (optional)

Interactive `init` can add tsdown and `swift-node-unplugin`. The generated `build` script then runs `tsdown`; the Unplugin adapter runs the project-local `swift-node build` first, lets tsdown bundle the generated JavaScript, and emits the target-qualified `.node` binary plus any Swift runtime sidecars beside the final `dist/index.*` files. It never uses `npx`.

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'
import swiftNodeNativeAssets from 'swift-node-unplugin/rolldown'

export default defineConfig({
  plugins: [swiftNodeNativeAssets()],
})
```

See [the tsdown example](./examples/hello-world-tsdown), including ESM and CommonJS consumers.

### `swift-node doctor`

Checks whether the local machine can build a Swift Node addon. It reports the host platform, `swiftc`, `clang++`, Node-API headers, and on macOS the selected Xcode or Command Line Tools path. It does not install or build anything. On Windows, missing Node headers are expected on a fresh machine: `swift-node build` downloads the matching headers and `node.lib` when needed.

## Streams

Streams are supported for functions marked with both `// @swift-node:export` and `// @swift-node:stream` that return `AsyncStream<Element>` or `AsyncThrowingStream<Element, Error>`. The generated binding takes `onValue`, with optional `onError` and `onComplete` callbacks, and returns a handle for that subscription. `cancel()` and `[Symbol.dispose]()` cancel the generated Swift consumer task; completion and errors clean up the callback references automatically.

`AsyncSequence` is not supported as a stream return type. It is a broad protocol rather than one concrete runtime representation, so there is no stable C ABI that the generated bridge can call. Use one of the two concrete `AsyncStream` types above.

```swift
// @swift-node:export
// @swift-node:stream
func tokens(_ prompt: String) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            // Wrap a Foundation Models stream here and yield text rather than
            // exposing a model-specific partial-response payload directly.
            continuation.yield(prompt)
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
```

```ts
const subscription = tokens(
  'Summarize this',
  (value) => console.log(value),
  (error) => console.error(error),
  () => console.log('done'),
)

// Stops only this subscription. It is safe to call more than once.
subscription.cancel()
// `using subscription = tokens(...)` also calls [Symbol.dispose]().
```

The stream bridge supports scalar, `String`, and JSON-safe collection or explicitly annotated Codable elements. Foundation encodes nested `Data` in structured stream events as base64 strings. Attach `AsyncStream.Continuation.onTermination` to the producer task or resource it needs to stop.

## Generated project files

This describes a project created by `swift-node init`, not this repository. You edit `src/native.swift`; `src/index.ts` re-exports the generated runtime. `swift-node build` writes JavaScript, declarations, and the native binary to `dist_swift-node/`. When you opt into tsdown, it bundles the JavaScript into `dist/` and `swift-node-unplugin` emits the native binary and any Swift runtime sidecars there. Both generated directories are gitignored.

## Set up CI and publishing (optional)

`swift-node init` can scaffold a complete GitHub Actions pipeline for a native package. During interactive `init`, choose the targets to build and whether to generate the CI-gated npm publish workflow.

The generated `CI` workflow runs the package's normal `build` script for every selected target in parallel. The optional publish workflow runs only after CI succeeds on the current `main`; it builds every target, collects the binaries and runtime files, packs one npm tarball, and publishes it. There is no separate `swift-node prebuild` command.

Prebuilt binaries make installation faster and more reproducible, and avoid requiring a local Swift toolchain.

By default, Linux packages include the Swift `.so` runtime libraries and Windows packages include the Swift `.dll` runtime libraries beside their target-qualified `.node` binary. This lets consumers load the package without separately installing Swift. Set `"swiftNode": { "shipSwiftRuntime": false }` only when your deployment supplies a compatible Swift runtime. Linux prebuilds use a glibc baseline; Alpine and other musl systems build locally into a distinct `{platform}-{arch}-musl` target directory.

Publish macOS binaries as `dist_swift-node/{moduleName}.darwin-{arch}.node`, or `dist/{moduleName}.darwin-{arch}.node` when using tsdown. Linux and Windows retain `/{platform}-{arch}/` so their Swift runtime sidecars remain beside the addon. The generated manifest and workflow already include the required runtime sidecars. Start with the [prebuild workflow template](./packages/swift-node/templates/prebuild.yml) when adding this to an existing package; when building Windows targets, also copy its [Windows toolchain action](./packages/swift-node/templates/setup-windows-toolchain.yml) to `.github/actions/setup-windows-toolchain/action.yml`.

## Requirements

- Node.js 24 or newer
- `swiftc` and `clang++` available on `PATH`
- macOS 14 or newer with Xcode or Command Line Tools; Linux with Swift and clang++; or Windows with the Swift toolchain and clang++ (the first Windows build downloads matching Node headers and `node.lib`)
- A package manager for your project; interactive `init` detects npm, pnpm, Bun, and modern Yarn via Corepack
- `import Foundation` only in Swift source that uses Foundation APIs such as `Data`, `NSError`, `DispatchQueue`, or Foundation JSON APIs; the starter does not need it

## License

MIT
