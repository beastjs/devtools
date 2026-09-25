// `octane/compiler/bundler` ships without typings; this covers the subset the
// devtools use to validate refactored sources.
declare module 'octane/compiler/bundler' {
  export interface OctaneTransformOptions {
    environment?: 'client' | 'server'
    hmr?: false | 'vite'
    dev?: boolean
    profile?: boolean
    strong?: boolean
  }

  export interface OctaneBundlerCompiler {
    transform(code: string, id: string, options?: OctaneTransformOptions): { code: string; map: unknown } | null
  }

  export function createOctaneCompiler(options?: OctaneTransformOptions & { root?: string }): OctaneBundlerCompiler
}
