import { describe, expect, it } from 'vitest'
import css from './App.css?raw'

describe('v098.18 responsive history and road CSS', () => {
  it('keeps the four-row B table horizontally scrollable on mobile', () => {
    expect(css).toMatch(/\.prediction-history-scroll\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toMatch(/\.prediction-history\s*\{[^}]*min-width:\s*\d+px/s)
  })

  it('contains intrinsic table width so only the history scroller can overflow horizontally', () => {
    expect(css).toMatch(/\.prediction-card\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s)
    expect(css).toMatch(/\.prediction-history-block\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s)
    expect(css).toMatch(/\.prediction-history-scroll\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s)
  })

  it('wraps road counts and keeps the tie slash behind the winning point', () => {
    expect(css).toMatch(/\.road-counts\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s)
    expect(css).toMatch(/\.big-cell\s*>\s*span\s*\{[^}]*z-index:\s*2/s)
    expect(css).toMatch(/\.big-cell\.tie-mark::after\s*\{[^}]*z-index:\s*1/s)
  })
})
