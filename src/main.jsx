import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the service worker in production builds
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // Optional: handle updates
        reg.onupdatefound = () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available. You could show a toast and reload.
              console.info('[PWA] New version installed')
              // Example to activate immediately:
              // reg.waiting?.postMessage('skipWaiting')
            }
          })
        }
      })
      .catch((err) => console.error('[PWA] SW registration failed:', err))
  })
}