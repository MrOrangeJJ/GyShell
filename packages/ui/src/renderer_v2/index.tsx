import ReactDOM from 'react-dom/client'
import { App } from './App'
import { RendererErrorBoundary } from './components/Common/RendererErrorBoundary'
import './styles/global.scss'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

window.addEventListener('error', (event) => {
  console.error('[Renderer] uncaught error', event.error || event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Renderer] unhandled rejection', event.reason)
})

// NOTE: Keep StrictMode off to avoid double-invoking effects that initialize xterm/pty sessions.
root.render(
  <RendererErrorBoundary>
    <App />
  </RendererErrorBoundary>,
)


