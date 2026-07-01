/**
 * smile-html — render a Chain into a standalone Chart.js dashboard page. This is the
 * local/preview analogue of the interactive artifact the MCP tool asks the model to build; it
 * lets `scripts/smoke-smile-live.ts --html` produce something viewable in a browser/preview
 * pane without a model round-trip. Pure string builder (no I/O), so it's unit-testable.
 */
import type { Chain } from './chain.js';

/** Embed a value as JSON that is safe inside a <script> block (no </script> breakout). */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const pct = (x: number | null): string => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Escape a string for interpolation into HTML text/attribute context. */
const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderSmileHtml(chain: Chain): string {
  const data = safeJson(chain);
  const sym = escHtml(chain.symbol);
  const exp = escHtml(chain.expiration);
  const asof = escHtml(chain.asOf ?? 'n/a');
  const skew = chain.skew25 == null ? 'n/a' : `${(chain.skew25 * 100).toFixed(1)}pt`;
  const metrics: [string, string][] = [
    ['Forward', chain.spot.toFixed(2)],
    ['ATM IV', pct(chain.atmIV)],
    ['25Δ skew', skew],
    ['PCR (OI)', chain.pcrOI == null ? 'n/a' : chain.pcrOI.toFixed(2)],
    ['Max pain', `${chain.maxPain}`],
    ['DTE', `${chain.dte}`],
  ];
  const cards = metrics
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${sym} volatility smile — ${exp}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#141413; --mut:#6b6a66; --line:#e1e0d9; --card:#f1efe8; --call:#2a78d6; --put:#eb6834; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#191817; --fg:#f4f3ee; --mut:#a3a29b; --line:#2c2c2a; --card:#232220; } }
  body{ margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap{ max-width:900px; margin:0 auto; padding:24px 20px 40px; }
  h1{ font-size:19px; font-weight:600; margin:0 0 2px; }
  .sub{ color:var(--mut); font-size:13px; margin-bottom:18px; }
  .cards{ display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:22px; }
  .card{ background:var(--card); border-radius:8px; padding:10px 12px; }
  .card .k{ font-size:12px; color:var(--mut); } .card .v{ font-size:22px; font-weight:600; margin-top:2px; }
  .legend{ display:flex; flex-wrap:wrap; gap:16px; font-size:12px; color:var(--mut); margin:0 0 6px; }
  .legend span{ display:flex; align-items:center; gap:5px; }
  .sw{ width:14px; height:2px; display:inline-block; } .box{ width:10px; height:10px; border-radius:2px; display:inline-block; }
  .panel{ position:relative; width:100%; height:300px; margin-bottom:24px; }
  .oi{ height:220px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${sym} options · ${exp} · ${chain.dte} DTE</h1>
  <div class="sub">Black-76 implied vol from live GLBX.MDP3 quotes · forward from the underlying future · as of ${asof}</div>
  <div class="cards">${cards}</div>

  <div class="legend">
    <span><span class="sw" style="background:var(--call)"></span>Call IV</span>
    <span><span class="sw" style="border-top:2px dashed var(--put);height:0"></span>Put IV</span>
    <span><span class="sw" style="border-top:1px solid var(--mut);height:0"></span>ATM ${chain.atmStrike}</span>
  </div>
  <div class="panel"><canvas id="smile"></canvas></div>

  <div class="legend">
    <span><span class="box" style="background:var(--call)"></span>Call OI ${chain.callOItotal.toLocaleString()}</span>
    <span><span class="box" style="background:var(--put)"></span>Put OI ${chain.putOItotal.toLocaleString()}</span>
    <span><span class="sw" style="border-top:1px dashed var(--mut);height:0"></span>Max pain ${chain.maxPain}</span>
  </div>
  <div class="panel oi"><canvas id="oi"></canvas></div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
(function(){
  var C = ${data};
  var css = getComputedStyle(document.documentElement);
  var mut = css.getPropertyValue('--mut').trim() || '#888';
  var line = css.getPropertyValue('--line').trim() || '#ddd';
  var call = css.getPropertyValue('--call').trim() || '#2a78d6';
  var put = css.getPropertyValue('--put').trim() || '#eb6834';
  var pctv = function(v){ return v==null ? null : Math.round(v*1000)/10; };
  var idx = function(v){ return C.strikes.indexOf(v); };
  function vline(chart,val,color,dash,label){
    var x=chart.scales.x.getPixelForValue(idx(val)); if(x==null||isNaN(x))return;
    var cx=chart.ctx; cx.save(); cx.beginPath(); cx.setLineDash(dash||[]); cx.strokeStyle=color; cx.lineWidth=1;
    cx.moveTo(x,chart.chartArea.top); cx.lineTo(x,chart.chartArea.bottom); cx.stroke();
    if(label){ cx.setLineDash([]); cx.fillStyle=color; cx.font='11px sans-serif'; cx.textAlign='center'; cx.fillText(label,x,chart.chartArea.top-3); }
    cx.restore();
  }
  new Chart(document.getElementById('smile'),{ type:'line',
    data:{ labels:C.strikes, datasets:[
      { label:'Call IV', data:C.callIV.map(pctv), borderColor:call, borderWidth:2, pointRadius:0, tension:.35, spanGaps:true },
      { label:'Put IV', data:C.putIV.map(pctv), borderColor:put, borderWidth:2, borderDash:[5,4], pointRadius:0, tension:.35, spanGaps:true } ] },
    options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:function(t){return 'Strike '+C.strikes[t[0].dataIndex];}, label:function(c){return c.dataset.label+': '+c.parsed.y+'%';} } } },
      scales:{ x:{ title:{display:true,text:'Strike',color:mut}, ticks:{color:mut,autoSkip:true,maxTicksLimit:11}, grid:{display:false} },
               y:{ title:{display:true,text:'Implied vol (%)',color:mut}, ticks:{color:mut,callback:function(v){return v+'%';}}, grid:{color:line} } } },
    plugins:[{ afterDraw:function(c){ vline(c,C.atmStrike,mut,[],'ATM '+C.atmStrike); if(C.put25Strike)vline(c,C.put25Strike,put,[3,3],'25Δ put'); if(C.call25Strike)vline(c,C.call25Strike,call,[3,3],'25Δ call'); } }] });
  new Chart(document.getElementById('oi'),{ type:'bar',
    data:{ labels:C.strikes, datasets:[
      { label:'Call OI', data:C.callOI.map(function(x){return x||0;}), backgroundColor:call },
      { label:'Put OI', data:C.putOI.map(function(x){return x||0;}), backgroundColor:put } ] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:function(t){return 'Strike '+C.strikes[t[0].dataIndex];}, label:function(c){return c.dataset.label+': '+c.parsed.y.toLocaleString();} } } },
      scales:{ x:{ ticks:{color:mut,autoSkip:true,maxTicksLimit:11}, grid:{display:false} },
               y:{ title:{display:true,text:'Open interest',color:mut}, ticks:{color:mut,callback:function(v){return v>=1000?(v/1000)+'k':v;}}, grid:{color:line} } } },
    plugins:[{ afterDraw:function(c){ vline(c,C.maxPain,mut,[4,3],'max pain'); } }] });
})();
</script>
</body>
</html>`;
}
