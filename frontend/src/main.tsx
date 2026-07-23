import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installFrontendBuildMetadata } from './lib/buildVersion'
import './App.css'

installFrontendBuildMetadata()

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
