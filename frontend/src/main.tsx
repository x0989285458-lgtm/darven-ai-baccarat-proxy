import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installFrontendBuildMetadata } from './lib/buildVersion'
import { canonicalFrontendUrlForCloudflarePreview } from './lib/canonicalFrontendOrigin'
import './App.css'

const canonicalFrontendUrl = canonicalFrontendUrlForCloudflarePreview(window.location.href)

if (canonicalFrontendUrl) {
  window.location.replace(canonicalFrontendUrl)
} else {
  installFrontendBuildMetadata()

  createRoot(document.getElementById('root')!).render(
    <StrictMode><App /></StrictMode>,
  )
}
