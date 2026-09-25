import { createRoot } from 'octane'
import BeastDevtools from './BeastDevtools.btsx'
import './devtools.css'

const HOST_ID = 'beast-devtools'

function mount(): void {
  if (document.getElementById(HOST_ID) !== null) return
  const host = document.createElement('div')
  host.id = HOST_ID
  document.body.append(host)
  createRoot(host).render(BeastDevtools, {})
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
else mount()
