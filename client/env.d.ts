/// <reference types="vite/client" />

// The overlay's `.btsx` components compile to Octane component bodies.
declare module '*.btsx' {
  import type { ComponentBody } from 'octane'

  const component: ComponentBody
  export default component
}
