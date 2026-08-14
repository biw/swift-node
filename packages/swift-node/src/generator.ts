/**
 * Stable public facade for swift-node code generation.
 *
 * Generator implementation modules are intentionally private so callers keep
 * importing this path while output families evolve independently.
 */

export { cppIdentifier } from './generator/shared.js'
export { generateBridgeH, generateStructsHeader } from './generator/bridge-header.js'
export { generateAddonCpp } from './generator/addon.js'
export { exportedToSwiftFunctions, generateWrappersSwift } from './generator/swift-wrapper.js'
export { generateDts, generateDtsCjs } from './generator/declarations.js'
export {
  generateEntryCjs,
  generateEntryMjs,
  generateSourceEntryTs,
} from './generator/entrypoints.js'
