import { describe, expect, it } from 'vitest'
import { canonicalFrontendUrlForCloudflarePreview } from './canonicalFrontendOrigin'

describe('canonicalFrontendUrlForCloudflarePreview', () => {
  it('redirects a project preview origin to the canonical frontend while preserving route and query', () => {
    expect(canonicalFrontendUrlForCloudflarePreview('https://9b4df77a.darven-ai-baccarat.pages.dev/login?next=%2Fadmin#form'))
      .toBe('https://darven-ai-baccarat.pages.dev/login?next=%2Fadmin#form')
  })

  it('does not redirect the canonical frontend or unrelated Pages projects', () => {
    expect(canonicalFrontendUrlForCloudflarePreview('https://darven-ai-baccarat.pages.dev/login')).toBeNull()
    expect(canonicalFrontendUrlForCloudflarePreview('https://other-project.pages.dev/login')).toBeNull()
  })
})
