import { ux } from '@oclif/core'

const MIN_VERSION = 20
const MAX_VERSION = 23

export function checkNodeVersion(): boolean {
  const version = process.version
  const match = version.match(/^v(\d+)\./)
  
  if (!match) {
    return true
  }
  
  const major = parseInt(match[1], 10)
  
  if (major < MIN_VERSION || major > MAX_VERSION) {
    ux.error(`Node.js ${major}.x is not supported for file upload operations.
Required: Node.js ${MIN_VERSION}.x, ${MIN_VERSION + 1}.x, ${MIN_VERSION + 2}.x, or ${MAX_VERSION}.x
Current: ${version}
Workaround: Use Node.js ${MIN_VERSION}.x - ${MAX_VERSION}.x for file upload operations.`)
  }
  
  return true
}
