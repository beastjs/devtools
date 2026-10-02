import type { ClassValue } from 'octane'
import type { IconName } from './icons'

export interface IconProps {
  name: IconName
  /** Width and height in pixels. A size class such as `size-5` overrides it. */
  size?: number
  className?: ClassValue
  /** Any CSS color. Without it the icon takes the surrounding text color. */
  color?: string
  /** Names an icon that means something on its own. Without it the icon is hidden from screen readers. */
  label?: string
}
