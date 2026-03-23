export function maybeParseJSON(value: unknown): unknown {
  if (typeof value !== 'string') return value
  
  const trimmed = value.trim()
  
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  
  return value
}

export function transformReferences<T>(
  obj: T, 
  mappings: Map<string, string>[],
  parseJSON = true
): T {
  if (obj === null || obj === undefined) return obj
  
  if (Array.isArray(obj)) {
    return obj.map(item => transformReferences(item, mappings, parseJSON)) as T
  }
  
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    
    for (const [key, value] of Object.entries(obj)) {
      let transformedValue = value
      
      if (typeof value === 'string') {
        for (const mapping of mappings) {
          if (mapping.has(value)) {
            transformedValue = mapping.get(value)
            break
          }
        }
        
        if (parseJSON && typeof transformedValue === 'string') {
          transformedValue = maybeParseJSON(transformedValue)
        }
      } else if (typeof value === 'object') {
        transformedValue = transformReferences(value, mappings, parseJSON)
      }
      
      result[key] = transformedValue
    }
    
    return result as T
  }
  
  return obj
}
