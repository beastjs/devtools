/** Shared descriptor renderers used by Octane, rather than authored components. */
const IMPLEMENTATION_SCOPES = new Set(['hostElementBody', 'hostStringTagBody', 'deoptItemBody', 'mappedDeoptItemBody'])

export function isRuntimeImplementation(name: string): boolean {
  return IMPLEMENTATION_SCOPES.has(name)
}
