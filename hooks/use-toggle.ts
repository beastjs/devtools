import { useState } from 'octane'

export const useToggle = (initialValue = false): [boolean, VoidFunction] => {
  const [value, setValue] = useState(initialValue)
  const toggle = () => {
    void setValue(!value)
  }
  return [value, toggle]
}
