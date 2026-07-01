/**
 * smile-html — render a Chain into a Chart.js dashboard page. Two modes:
 *  - snapshot (default): a static, standalone page (the preview/artifact analogue).
 *  - live: `opts.live` adds a UI interval selector + a poll loop that re-fetches the snapshot
 *    JSON and updates the EXISTING chart points (Chart.js animates them — no full redraw) plus
 *    a LIVE badge. This is "level 2" (polled snapshot + per-point update), not a push stream.
 * Pure string builder (no I/O), so it's unit-testable.
 */
import type { Chain } from './chain.js';

/** Embed a value as JSON that is safe inside a <script> block (no </script> breakout). */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const pct = (x: number | null): string => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Escape a string for interpolation into HTML text/attribute context. */
const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SmileHtmlOpts {
  /** Turn the page into a live-polling view of `jsonUrl` (a get_futures_options_smile snapshot). */
  live?: { jsonUrl: string; interval?: number };
}

const INTERVALS = [5, 10, 30, 60];

export function renderSmileHtml(chain: Chain, opts: SmileHtmlOpts = {}): string {
  const data = safeJson(chain);
  const sym = escHtml(chain.symbol);
  const exp = escHtml(chain.expiration);
  const asof = escHtml(chain.asOf ?? 'n/a');
  const selLabel = chain.selection ? escHtml(chain.selection) : '';
  const live = opts.live;
  const ivDefault = live?.interval ?? 10;

  const skew = chain.skew25 == null ? 'n/a' : `${(chain.skew25 * 100).toFixed(1)}pt`;
  const metrics: [string, string, string][] = [
    ['Forward', 'm-fwd', chain.spot.toFixed(2)],
    ['ATM IV', 'm-atmiv', pct(chain.atmIV)],
    ['25Δ skew', 'm-skew', skew],
    ['PCR (OI)', 'm-pcr', chain.pcrOI == null ? 'n/a' : chain.pcrOI.toFixed(2)],
    ['Max pain', 'm-mp', `${chain.maxPain}`],
    ['DTE', 'm-dte', `${chain.dte}`],
  ];
  const cards = metrics
    .map(([k, id, v]) => `<div class="card"><div class="k">${k}</div><div class="v" id="${id}">${v}</div></div>`)
    .join('');

  const selChip = selLabel ? `<span class="chip sel">${selLabel} series</span>` : '';
  const ivOptions = INTERVALS.map((s) => `<option value="${s}"${s === ivDefault ? ' selected' : ''}>${s}s</option>`).join('');
  const chips = live
    ? `<span class="chip sel" id="h-sel"${selLabel ? '' : ' style="display:none"'}>${selLabel ? `${selLabel} series` : ''}</span>
    <span class="chip live" id="livebadge">LIVE · connecting…</span>
    <label class="ivsel">interval <select id="iv">${ivOptions}</select></label>`
    : `${selChip}<span class="chip snap">snapshot · as of ${asof}</span>`;
  const subNote = live
    ? 'Black-76 implied vol from the latest GLBX.MDP3 quotes · polled snapshot, points update in place.'
    : 'Black-76 implied vol from the latest GLBX.MDP3 quotes · forward from the underlying future. Static snapshot — not a live stream.';

  // The live poll loop is EMITTED only in live mode (so a static page carries no timers).
  const liveJs = live
    ? `
  if (LIVE) {
    var badge = document.getElementById('livebadge');
    var ivSel = document.getElementById('iv');
    var last = 0, err = null, timer = null, period = LIVE.interval, busy = false;
    function paint(){
      if (!badge) return;
      if (err){ badge.className='chip live stale'; badge.textContent='LIVE · '+err; return; }
      if (!last){ badge.className='chip live'; badge.textContent='LIVE · connecting…'; return; }
      badge.className='chip live';
      badge.textContent='LIVE · updated '+Math.round((Date.now()-last)/1000)+'s ago · every '+period+'s';
    }
    function poll(){
      if (busy) return; // don't pile up when the snapshot is slower than the interval
      busy = true;
      fetch(LIVE.url, {cache:'no-store'}).then(function(r){
        if(!r.ok) return r.json().then(function(j){ throw new Error(j && j.error ? j.error : ('HTTP '+r.status)); });
        return r.json();
      }).then(function(d){ applyChain(d.chain || d); last=Date.now(); err=null; paint(); })
        .catch(function(e){ err=(''+e.message).slice(0,80); paint(); })
        .finally(function(){ busy=false; });
    }
    function arm(sec){ if(timer)clearInterval(timer); period=sec; timer=setInterval(poll, sec*1000); }
    if (ivSel) ivSel.addEventListener('change', function(){ arm(+this.value); poll(); });
    paint(); poll(); arm(period); // page loads a placeholder shell instantly; first poll fills it
    setInterval(paint, 1000);
  }`
    : '';

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
  .chips{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:6px 0 14px; }
  .chip{ font-size:12px; padding:3px 9px; border-radius:12px; background:var(--card); color:var(--fg); }
  .chip.sel{ background:rgba(42,120,214,.15); color:#3987e5; }
  .chip.snap{ color:var(--mut); }
  .chip.live{ background:rgba(29,158,117,.16); color:#199e70; }
  .chip.live.stale{ background:rgba(186,117,23,.16); color:#c98500; }
  .ivsel{ font-size:12px; color:var(--mut); display:inline-flex; align-items:center; gap:5px; }
  .ivsel select{ font:inherit; color:var(--fg); background:var(--card); border:0.5px solid var(--line); border-radius:8px; padding:2px 6px; }
  .legend{ display:flex; flex-wrap:wrap; gap:16px; font-size:12px; color:var(--mut); margin:0 0 6px; }
  .legend span{ display:flex; align-items:center; gap:5px; }
  .sw{ width:14px; height:2px; display:inline-block; } .box{ width:10px; height:10px; border-radius:2px; display:inline-block; }
  .panel{ position:relative; width:100%; height:300px; margin-bottom:24px; }
  .oi{ height:220px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${sym} options · <span id="h-exp">${exp}</span> · <span id="h-dte">${chain.dte}</span> DTE</h1>
  <div class="chips">${chips}</div>
  <div class="sub">${subNote}</div>
  <div class="cards">${cards}</div>

  <div class="legend">
    <span><span class="sw" style="background:var(--put)"></span>Put IV (OTM, K ≤ ATM)</span>
    <span><span class="sw" style="background:var(--call)"></span>Call IV (OTM, K ≥ ATM)</span>
    <span><span class="sw" style="border-top:1px solid var(--mut);height:0"></span>ATM <span id="h-atm">${chain.atmStrike}</span></span>
  </div>
  <div class="panel"><canvas id="smile"></canvas></div>

  <div class="legend">
    <span><span class="box" style="background:var(--call)"></span>Call OI <span id="oi-c">${chain.callOItotal.toLocaleString()}</span></span>
    <span><span class="box" style="background:var(--put)"></span>Put OI <span id="oi-p">${chain.putOItotal.toLocaleString()}</span></span>
    <span><span class="sw" style="border-top:1px dashed var(--mut);height:0"></span>Max pain <span id="oi-mp">${chain.maxPain}</span></span>
  </div>
  <div class="panel oi"><canvas id="oi"></canvas></div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
(function(){
  var cur = ${data};
  var LIVE = ${live ? safeJson({ url: live.jsonUrl, interval: ivDefault }) : 'null'};
  var css = getComputedStyle(document.documentElement);
  var mut = css.getPropertyValue('--mut').trim() || '#888';
  var line = css.getPropertyValue('--line').trim() || '#ddd';
  var call = css.getPropertyValue('--call').trim() || '#2a78d6';
  var put = css.getPropertyValue('--put').trim() || '#eb6834';
  var pctv = function(v){ return v==null ? null : Math.round(v*1000)/10; };
  var fmtPct = function(x){ return x==null ? 'n/a' : (x*100).toFixed(1)+'%'; };
  var setTxt = function(id,v){ var e=document.getElementById(id); if(e) e.textContent=v; };
  var idx = function(v){ return cur.strikes.indexOf(v); };
  function vline(chart,val,color,dash,label){
    var x=chart.scales.x.getPixelForValue(idx(val)); if(x==null||isNaN(x))return;
    var c=chart.ctx; c.save(); c.beginPath(); c.setLineDash(dash||[]); c.strokeStyle=color; c.lineWidth=1;
    c.moveTo(x,chart.chartArea.top); c.lineTo(x,chart.chartArea.bottom); c.stroke();
    if(label){ c.setLineDash([]); c.fillStyle=color; c.font='11px sans-serif'; c.textAlign='center'; c.fillText(label,x,chart.chartArea.top-3); }
    c.restore();
  }
  function putSide(C){ return C.strikes.map(function(k,i){ return k<=C.atmStrike ? pctv(C.putIV[i]) : null; }); }
  function callSide(C){ return C.strikes.map(function(k,i){ return k>=C.atmStrike ? pctv(C.callIV[i]) : null; }); }

  var smile = new Chart(document.getElementById('smile'),{ type:'line',
    data:{ labels:cur.strikes, datasets:[
      { label:'Put IV (OTM)', data:putSide(cur), borderColor:put, borderWidth:2, pointRadius:0, tension:.35, spanGaps:false },
      { label:'Call IV (OTM)', data:callSide(cur), borderColor:call, borderWidth:2, pointRadius:0, tension:.35, spanGaps:false } ] },
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:400}, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:function(t){return 'Strike '+cur.strikes[t[0].dataIndex];}, label:function(c){return c.dataset.label+': '+c.parsed.y+'%';} } } },
      scales:{ x:{ title:{display:true,text:'Strike',color:mut}, ticks:{color:mut,autoSkip:true,maxTicksLimit:11}, grid:{display:false} },
               y:{ title:{display:true,text:'Implied vol (%)',color:mut}, ticks:{color:mut,callback:function(v){return v+'%';}}, grid:{color:line} } } },
    plugins:[{ afterDraw:function(c){ vline(c,cur.atmStrike,mut,[],'ATM '+cur.atmStrike); if(cur.put25Strike)vline(c,cur.put25Strike,put,[3,3],'25Δ put'); if(cur.call25Strike)vline(c,cur.call25Strike,call,[3,3],'25Δ call'); } }] });
  var oi = new Chart(document.getElementById('oi'),{ type:'bar',
    data:{ labels:cur.strikes, datasets:[
      { label:'Call OI', data:cur.callOI.map(function(x){return x||0;}), backgroundColor:call },
      { label:'Put OI', data:cur.putOI.map(function(x){return x||0;}), backgroundColor:put } ] },
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:400},
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title:function(t){return 'Strike '+cur.strikes[t[0].dataIndex];}, label:function(c){return c.dataset.label+': '+c.parsed.y.toLocaleString();} } } },
      scales:{ x:{ ticks:{color:mut,autoSkip:true,maxTicksLimit:11}, grid:{display:false} },
               y:{ title:{display:true,text:'Open interest',color:mut}, ticks:{color:mut,callback:function(v){return v>=1000?(v/1000)+'k':v;}}, grid:{color:line} } } },
    plugins:[{ afterDraw:function(c){ vline(c,cur.maxPain,mut,[4,3],'max pain'); } }] });

  function applyChain(C){
    cur = C;
    smile.data.labels = C.strikes;
    smile.data.datasets[0].data = putSide(C);
    smile.data.datasets[1].data = callSide(C);
    smile.update();
    oi.data.labels = C.strikes;
    oi.data.datasets[0].data = C.callOI.map(function(x){return x||0;});
    oi.data.datasets[1].data = C.putOI.map(function(x){return x||0;});
    oi.update();
    setTxt('m-fwd', C.spot.toFixed(2));
    setTxt('m-atmiv', fmtPct(C.atmIV));
    setTxt('m-skew', C.skew25==null ? 'n/a' : (C.skew25*100).toFixed(1)+'pt');
    setTxt('m-pcr', C.pcrOI==null ? 'n/a' : C.pcrOI.toFixed(2));
    setTxt('m-mp', String(C.maxPain));
    setTxt('m-dte', String(C.dte));
    setTxt('oi-c', (C.callOItotal||0).toLocaleString());
    setTxt('oi-p', (C.putOItotal||0).toLocaleString());
    setTxt('oi-mp', String(C.maxPain));
    setTxt('h-exp', C.expiration);
    setTxt('h-dte', String(C.dte));
    setTxt('h-atm', String(C.atmStrike));
    var sel = document.getElementById('h-sel');
    if (sel){ if (C.selection){ sel.textContent = C.selection + ' series'; sel.style.display=''; } else { sel.style.display='none'; } }
  }

${liveJs}
})();
</script>
</body>
</html>`;
}
