import { describe, expect, it } from 'vitest'
import css from './App.css?raw'

describe('responsive history and road CSS', () => {
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

  it('prevents page-level horizontal overflow while keeping wide data regions internally scrollable', () => {
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*hidden/s)
    expect(css).toMatch(/\.report-panel\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toMatch(/\.scroll-list\s*\{[^}]*overflow-x:\s*auto/s)
  })

  it('keeps all five side predictions on one responsive row', () => {
    expect(css).toMatch(/\.side-prediction-row\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(/s)
    expect(css).not.toMatch(/\.side-prediction-row\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s)
  })

  it('uses the approved member-login artwork as the visual source of truth', () => {
    expect(css).toContain("url('/assets/ruiwen-member-login-approved.jpg')")
    expect(css).toMatch(/\.login-shell\s*\{[^}]*background:[^}]*100%\s+auto\s+no-repeat/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.login-shell\s*\{[^}]*background-position:\s*right\s+center\s*!important/s)
  })

  it('keeps the functional card locked to the approved artwork ratio on wide displays', () => {
    expect(css).toMatch(/\.login-shell\[data-ui-theme='navy-gold'\]\s+\.member-login-card\s*\{[^}]*width:\s*32\.8vw[^}]*min-height:\s*33\.85vw/s)
    expect(css).not.toMatch(/\.member-login-card\s*\{[^}]*width:\s*clamp\(/s)
  })

  it('uses the untouched pure background asset and approved command-deck geometry', () => {
    expect(css).toContain("url('/assets/ruiwen-login-bg-hq.png')")
    expect(css).toMatch(/\.app-shell\.member-dashboard\[data-ui-theme='navy-gold'\]\s*\{[^}]*url\('\/assets\/ruiwen-login-bg-hq\.png'\)/s)
    expect(css).not.toContain("url('/assets/ruiwen-member-dashboard-approved.jpg')")
    expect(css).toMatch(/\.member-dashboard\s+\.workspace\s*\{[^}]*grid-template-columns:\s*210px\s+minmax\(0,\s*1fr\)/s)
    expect(css).toMatch(/\.dashboard-middle-grid\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+310px[^}]*align-items:\s*stretch/s)
    expect(css).toMatch(/\.dashboard-middle-grid\s*>\s*\.prediction-card,[\s\S]*?\.dashboard-history-panel\s*\{[^}]*height:\s*310px/s)
    expect(css).toMatch(/\.dashboard-middle-grid\s+\.prediction-card\s*\{[^}]*padding-bottom:\s*12px[^}]*overflow:\s*visible/s)
    expect(css).toMatch(/\.member-dashboard\s+\.dashboard-sidebar\s+\.table-item\s*\{[^}]*height:\s*40px[^}]*min-height:\s*40px/s)
    expect(css).toMatch(/\.member-dashboard\s+\.table-casino-icon\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/s)
    expect(css).toMatch(/\.member-dashboard\s+\.dashboard-sidebar\s+\.table-item\.active\s*\{[^}]*box-shadow:[^}]*inset\s+0\s+0\s+0\s+1px/s)
    expect(css).toContain("url('/assets/ruiwen-dashboard-table-icon.png')")
    expect(css).toMatch(/\.dashboard-road-region\s+\.big-road\.classic-road\s*\{[^}]*grid-template-rows:\s*repeat\(6,\s*22px\)[^}]*height:\s*162px/s)
    expect(css).toMatch(/\.dashboard-road-region\s+\.big-cell\.Banker,[\s\S]*?\.big-cell\.Player\s*\{[^}]*background:\s*transparent/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.member-dashboard\s+\.dashboard-sidebar\s+\.table-list\s*\{[^}]*display:\s*flex[^}]*width:\s*max-content/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.dashboard-middle-grid\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.dashboard-history-panel\s*\{[^}]*display:\s*flex/s)
  })
})
