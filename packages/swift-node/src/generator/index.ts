/**
 * Stable public facade for swift-node code generation.
 *
 * Generator implementation modules are intentionally private so callers keep
 * importing this path while output families evolve independently.
 */

export { cppIdentifier } from './shared.js'
export { generateBridgeH, generateStructsHeader } from './bridge-header.js'
export { generateAddonCpp } from './addon.js'
export { exportedToSwiftFunctions, generateWrappersSwift } from './swift-wrapper.js'
export { generateDts, generateDtsCjs } from './declarations.js'
export {
  generateEntryCjs,
  generateEntryMjs,
  generateSourceEntryTs,
} from './entrypoints.js'
