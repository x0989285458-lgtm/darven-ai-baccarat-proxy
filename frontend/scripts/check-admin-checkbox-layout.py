"""Run with browser harness helpers; isolated synthetic DOM, no backend requests.
exec(compile(path.read_text(encoding='utf-8'), str(path), 'exec'),
     dict(globals(), __file__=str(path)))
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
css = (root / 'src/App.css').read_text(encoding='utf-8')
account = 'E2E_LAYOUT_ACCOUNT_12345678901234567890'
html = '''<!doctype html><meta charset="UTF-8"><style>''' + css + '''</style>
<main class="admin-v015-shell"><section class="v015-management-grid">
<section class="admin-panel list-panel">代理列表</section>
<section class="admin-panel list-panel"><h2>已建立驗證碼</h2>
<div class="scroll-list code-list">
<div class="list-head code-row code-list-head"><span>選取</span><span>會員帳號</span><span>驗證碼</span><span>狀態／期限</span><span>延長天數</span></div>
<div class="list-row code-row"><input type="checkbox" aria-label="測試選取">
<span>''' + account + '''</span><b>SYNTHETIC_ONLY_NOT_A_CREDENTIAL</b><em>已到期｜0 天</em>
<input placeholder="延長1-30天"></div></div></section></section></main>'''
new_tab('about:blank')
js('window.__layoutHtml=""')
for offset in range(0, len(html), 12000):
    js('window.__layoutHtml+=' + json.dumps(html[offset:offset + 12000]))
js('document.open();document.write(window.__layoutHtml);document.close()')
results = []
for width in [1912, 1366, 768, 390]:
    cdp('Emulation.setDeviceMetricsOverride', width=width, height=867, deviceScaleFactor=1, mobile=False)
    result = js('''(()=>{const x=document.querySelector('input[type=checkbox]');x.checked=false;
const r=x.getBoundingClientRect();const s=x.nextElementSibling;const b=s.getBoundingClientRect();
return {width:innerWidth,x:r.x+r.width/2,y:r.y+r.height/2,
 hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===x,
 overlap:b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top,
 account:s.textContent,scrollOverflow:document.documentElement.scrollWidth>innerWidth}})()''')
    click_at_xy(result['x'], result['y'])
    result['checkedAfterClick'] = js('document.querySelector("input[type=checkbox]").checked')
    if result['checkedAfterClick']:
        click_at_xy(result['x'], result['y'])
    result['uncheckedAfterSecondClick'] = not js('document.querySelector("input[type=checkbox]").checked')
    result['pass'] = (result['hit'] and not result['overlap'] and result['checkedAfterClick']
                      and result['uncheckedAfterSecondClick'] and result['account'] == account
                      and not result['scrollOverflow'])
    results.append(result)
cdp('Emulation.clearDeviceMetricsOverride')
print(json.dumps({'cases':results,'passed':sum(r['pass'] for r in results),'total':len(results)},ensure_ascii=False))
assert all(r['pass'] for r in results), 'Long account must not cover checkbox; physical click must toggle both ways'
