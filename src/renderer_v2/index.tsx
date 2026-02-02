import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/global.scss'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

// NOTE: Keep StrictMode off to avoid double-invoking effects that initialize xterm/pty sessions.
root.render(<App />)


