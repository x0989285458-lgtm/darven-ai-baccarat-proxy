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

  it('uses the untouched formal background for the floating-portal member login only', () => {
    expect(css).toMatch(/\.member-login-shell\s*\{[^}]*url\('\/assets\/ruiwen-login-bg-hq\.png'\)[^}]*overflow-x:\s*hidden/s)
    expect(css).toMatch(/\.member-login-shell\s+\.member-login-card\s*\{[^}]*background:\s*linear-gradient\(150deg,[^}]*backdrop-filter:\s*blur\(14px\)/s)
  })

  it('keeps the member floating portal within 1440px and 390px viewports without horizontal overflow', () => {
    expect(css).toMatch(/\.login-shell\.member-login-shell\[data-ui-theme='navy-gold'\]\s+\.member-login-card\s*\{[^}]*width:\s*min\(460px,\s*calc\(100vw\s*-\s*32px\)\)[^}]*max-width:\s*100%[^}]*min-height:\s*0\s*!important[^}]*padding:\s*34px\s+34px\s+28px\s*!important/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.member-login-shell\s*\{[^}]*padding:\s*116px\s+16px\s+40px[^}]*background-position:\s*67%\s+center/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.login-shell\.member-login-shell\[data-ui-theme='navy-gold'\]\s+\.member-login-card\s*\{[^}]*width:\s*100%[^}]*margin:\s*0/s)
    expect(css).toMatch(/\.member-login-shell\s+\.login-intro\s*\{[^}]*text-wrap:\s*balance/s)
    expect(css).toMatch(/\.member-login-shell\s+\.member-login-card\s+\.system-status\s*\{[^}]*font-size:\s*12px/s)
    expect(css).toMatch(/\.member-login-shell\s+\.member-login-card\s+\.login-security\s*\{[^}]*color:\s*#9babbd[^}]*font-size:\s*12px/s)
    expect(css).toMatch(/\.member-login-shell\s+\.login-fields\s*\{[^}]*display:\s*grid[^}]*width:\s*100%[^}]*max-width:\s*none/s)
    expect(css).toMatch(/\.member-login-shell\s+\.member-login-card\s+\.login-field-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*padding:\s*0\s+18px/s)
    expect(css).toMatch(/\.member-login-shell\s+\.member-login-card\s+\.login-field-row\s+input\s*\{[^}]*text-align:\s*center[^}]*grid-column:\s*auto[^}]*grid-row:\s*auto[^}]*align-self:\s*center/s)
    expect(css).not.toMatch(/\.member-login-shell\s+\.login-field-(?:icon|label)/s)
    expect(css).not.toMatch(/\.login-field-(?:icon|label|trailing)|\.account-icon|\.lock-icon|\.login-card\.member-login-card\s+\.login-field-row/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.member-login-shell\s+\.member-login-card\s+\.login-field-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*padding:\s*0\s+16px/s)
  })

  it('uses the approved centered admin access gateway without the removed red-box elements', () => {
    expect(css).toMatch(/\.admin-login-shell\s*\{[^}]*url\('\/assets\/ruiwen-login-bg-hq\.png'\)[^}]*place-items:\s*center/s)
    expect(css).toMatch(/\.admin-login-shell\s+\.admin-login-card\s*\{[^}]*width:\s*min\(468px,\s*calc\(100vw\s*-\s*32px\)\)[^}]*text-align:\s*center/s)
    expect(css).toMatch(/\.admin-login-shell\s+\.admin-login-card\s+input\s*\{[^}]*height:\s*58px[^}]*text-align:\s*center/s)
    expect(css).toMatch(/\.admin-login-shell\s+\.admin-login-card\s+button\s*\{[^}]*height:\s*56px/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.admin-login-shell\s*\{[^}]*padding:\s*40px\s+16px[^}]*background-position:\s*67%\s+center/s)
    expect(css).not.toMatch(/\.admin-login-(?:gate|intro|corner)/s)
  })

  it('uses the approved original-parity layout for verification controls and weak-table cards', () => {
    expect(css).toMatch(/Approved original-parity admin dashboard[\s\S]*?\.admin-v015-shell\s+\.code-action-row\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s)
    expect(css).toMatch(/Approved original-parity admin dashboard[\s\S]*?\.admin-v015-shell\s+\.weak-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)\s*!important/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*520px\)[\s\S]*?\.admin-v015-shell\s+\.code-action-row\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*520px\)[\s\S]*?\.admin-v015-shell\s+\.code-list-head\s*\{[^}]*display:\s*none/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*520px\)[\s\S]*?\.admin-v015-shell\s+\.code-list\s+\.code-row:not\(\.code-list-head\)\s*\{[^}]*grid-template-columns:\s*28px\s+minmax\(0,\s*1fr\)/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*520px\)[\s\S]*?\.admin-v015-shell\s+\.weak-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/s)
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
    expect(css).toMatch(/\.dashboard-road-region\s+\.road-card\s*\{[^}]*min-height:\s*255px/s)
    expect(css).toMatch(/\.dashboard-road-region\s+\.big-road\.classic-road\s*\{[^}]*grid-template-rows:\s*repeat\(6,\s*28px\)[^}]*grid-auto-columns:\s*28px[^}]*gap:\s*6px[^}]*height:\s*210px[^}]*min-height:\s*210px/s)
    expect(css).toMatch(/\.dashboard-road-region\s+\.big-cell\s*\{[^}]*width:\s*28px[^}]*height:\s*28px[^}]*font-size:\s*12px/s)
    expect(css).toMatch(/\.dashboard-road-region\s+\.big-cell\.tie-mark::after\s*\{[^}]*width:\s*22px[^}]*height:\s*3px/s)
    expect(css).toMatch(/\.dashboard-road-region\s+\.big-cell\.Banker,[\s\S]*?\.big-cell\.Player\s*\{[^}]*background:\s*transparent/s)
    expect(css).toMatch(/Approved A command-deck[\s\S]*?\.member-dashboard\s+\.dashboard-side-brand\s*\{[^}]*white-space:\s*nowrap/s)
    expect(css).toMatch(/Approved A command-deck[\s\S]*?@media\s*\(max-width:\s*900px\)[\s\S]*?\.member-dashboard\s+\.dashboard-sidebar\s+\.table-list\s*\{[^}]*display:\s*flex[^}]*width:\s*max-content/s)
    expect(css).toMatch(/Approved A command-deck[\s\S]*?@media\s*\(max-width:\s*900px\)[\s\S]*?\.dashboard-middle-grid\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(css).toMatch(/Approved A command-deck[\s\S]*?@media\s*\(max-width:\s*900px\)[\s\S]*?\.dashboard-history-panel\s*\{[^}]*display:\s*flex/s)
  })
})
