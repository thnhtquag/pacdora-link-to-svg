import express from 'express';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let browserPromise = null;
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 3;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }).catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function validatePacdoraUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch { throw new Error('Link không hợp lệ.'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Chỉ hỗ trợ link http/https.');
  const host = u.hostname.toLowerCase();
  if (!(host === 'pacdora.com' || host.endsWith('.pacdora.com'))) {
    throw new Error('Hiện tại tool chỉ nhận link pacdora.com.');
  }
  return u.toString();
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.context.close(); } catch {}
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) await closeSession(id);
  }
}, 60_000).unref();

async function newPacdoraSession(url) {
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];
    if (!oldest) break;
    await closeSession(oldest[0]);
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
  try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}
  await page.waitForTimeout(1800);

  // Best-effort cookie/privacy dismissal. It is intentionally generic.
  for (const label of ['Accept', 'Accept all', 'Agree', 'Got it']) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
      if (await btn.isVisible({ timeout: 300 })) { await btn.click(); break; }
    } catch {}
  }

  await ensureMillimeters(page);

  const id = crypto.randomUUID();
  const s = { id, context, page, url, lastUsed: Date.now() };
  sessions.set(id, s);
  return s;
}

async function ensureMillimeters(page) {
  try {
    await page.evaluate(() => {
      const visible = el => {
        if (!el || !(el instanceof Element)) return false;
        const r=el.getBoundingClientRect(), st=getComputedStyle(el);
        return r.width>0 && r.height>0 && st.display!=='none' && st.visibility!=='hidden';
      };
      const norm = s => String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
      const els=[...document.querySelectorAll('button,[role="button"],label,span,div')].filter(visible);
      const mms=els.filter(el=>norm(el.textContent)==='mm');
      for(const mm of mms) {
        let p=mm.parentElement;
        for(let depth=0;p && depth<3;depth++,p=p.parentElement) {
          const hasIn=[...p.querySelectorAll('button,[role="button"],label,span,div')].some(el=>visible(el)&&norm(el.textContent)==='in');
          if(hasIn) { mm.click(); return true; }
        }
      }
      return false;
    });
    await page.waitForTimeout(250);
  } catch {}
}

async function extractCustomSizeControls(page) {
  return await page.evaluate(() => {
    const visible = el => {
      if (!el || !(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || 1) !== 0;
    };
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const textEls = [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el)) return false;
      const own = norm([...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' '));
      return own.length > 0;
    });

    const customHeads = textEls.filter(el => /^custom\s*size$/i.test(norm(el.textContent)));
    let heading = customHeads.sort((a,b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0] || null;

    const guessLabel = input => {
      const aria = norm(input.getAttribute('aria-label'));
      if (aria) return aria;
      const id = input.id;
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab && visible(lab)) return norm(lab.textContent);
      }
      const parentLabel = input.closest('label');
      if (parentLabel) {
        const t = norm(parentLabel.textContent).replace(norm(input.value), '').trim();
        if (t) return t;
      }
      const r = input.getBoundingClientRect();
      let best = null;
      let bestScore = Infinity;
      for (const el of textEls) {
        if (el === input || el.contains(input)) continue;
        const er = el.getBoundingClientRect();
        if (er.bottom > r.top + 16) continue;
        const dy = r.top - er.bottom;
        const xOverlap = Math.max(0, Math.min(r.right, er.right) - Math.max(r.left, er.left));
        const centerDx = Math.abs((er.left+er.right)/2 - (r.left+r.right)/2);
        if (dy > 80 || (xOverlap <= 0 && centerDx > 120)) continue;
        const score = dy + centerDx * 0.15;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) return norm(best.textContent);
      const ph = norm(input.getAttribute('placeholder'));
      if (ph) return ph;
      return norm(input.getAttribute('name')) || 'Dimension';
    };

    const allInputs = [...document.querySelectorAll('input')].filter(input => {
      if (!visible(input) || input.disabled) return false;
      const t = (input.type || 'text').toLowerCase();
      return !['hidden','checkbox','radio','file','submit','button','range','color'].includes(t);
    });

    let candidates = [];
    if (heading) {
      const hr = heading.getBoundingClientRect();
      const stopWords = [/^choose\s+material$/i, /^custom\s+thickness$/i, /^size\s+mode$/i, /^advanced$/i, /^more$/i];
      const stops = textEls.filter(el => {
        const t = norm(el.textContent);
        if (!stopWords.some(re => re.test(t))) return false;
        return el.getBoundingClientRect().top > hr.bottom;
      }).map(el => el.getBoundingClientRect().top);
      const bottom = stops.length ? Math.min(...stops) : hr.bottom + 420;
      candidates = allInputs.filter(input => {
        const r = input.getBoundingClientRect();
        return r.top >= hr.bottom - 6 && r.bottom <= bottom + 6;
      });
    }

    // Fallback for templates where the heading text/layout differs.
    if (!candidates.length) {
      const dimensionWords = /(length|width|height|depth|diameter|radius|side|size|inner|outer|long|short|top|bottom|major|minor|l\b|w\b|h\b)/i;
      candidates = allInputs.filter(input => dimensionWords.test(guessLabel(input)));
    }

    // Deduplicate stacked/hidden clone inputs by visual position + value.
    const seen = new Set();
    const rows = [];
    let seq = 0;
    for (const input of candidates) {
      const r = input.getBoundingClientRect();
      const key = `${Math.round(r.left)}:${Math.round(r.top)}:${norm(input.value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = guessLabel(input).replace(/\bmm\b|\bin\b/ig,'').trim() || `Dimension ${seq+1}`;
      if (/thickness|material/i.test(label)) continue;
      const exportId = `pd-dim-${seq++}`;
      input.setAttribute('data-pd-exporter-id', exportId);
      const nearby = norm(input.parentElement?.textContent || '');
      const unit = /\bin\b/i.test(nearby) && !/\bmm\b/i.test(nearby) ? 'in' : 'mm';
      rows.push({
        id: exportId,
        label,
        value: norm(input.value),
        type: (input.type || 'text').toLowerCase(),
        min: input.min || null,
        max: input.max || null,
        step: input.step || null,
        unit
      });
    }

    return {
      title: norm(document.title),
      controls: rows,
      foundCustomSizeHeading: Boolean(heading)
    };
  });
}

async function waitForDielineReady(page, oldSignature = '') {
  const getSig = () => page.evaluate(() => {
    const bad = el => {
      let n = el;
      while (n && n.nodeType === 1) {
        const s = `${n.id || ''} ${n.getAttribute?.('class') || ''} ${n.getAttribute?.('clip-path') || ''}`.toLowerCase();
        if (s.includes('watermark')) return true;
        n = n.parentElement;
      }
      return false;
    };
    const nodes = [...document.querySelectorAll('svg path[stroke],svg line[stroke]')].filter(n => !bad(n));
    return nodes.slice(0,100).map(n => [n.getAttribute('stroke'),n.getAttribute('d'),n.getAttribute('x1'),n.getAttribute('y1'),n.getAttribute('x2'),n.getAttribute('y2')].join('|')).join('||');
  });

  let stable = 0;
  let last = '';
  for (let i=0;i<20;i++) {
    await page.waitForTimeout(250);
    const sig = await getSig();
    const changed = !oldSignature || sig !== oldSignature;
    if (changed && sig && sig === last) stable++; else stable = 0;
    last = sig;
    if (changed && stable >= 2) return sig;
  }
  return await getSig();
}

async function setDimension(page, field) {
  const selector = `[data-pd-exporter-id="${String(field.id).replace(/"/g,'\\"')}"]`;
  const loc = page.locator(selector).first();
  if (!(await loc.count())) throw new Error(`Không còn tìm thấy ô ${field.label || field.id}.`);
  await loc.scrollIntoViewIfNeeded();
  const value = String(field.value ?? '').trim();
  try {
    await loc.fill(value);
  } catch {
    await loc.evaluate((el, v) => {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  try { await loc.press('Tab'); } catch {}
  try { await loc.dispatchEvent('change'); } catch {}
  await page.waitForTimeout(180);
}

async function extractCleanSvg(page, options = {}) {
  return await page.evaluate(({ includeBleed, normalizeLines, paddingMm }) => {
    const NS = 'http://www.w3.org/2000/svg';
    const COLORS = {
      bleed: ['#46ba00','rgb(70, 186, 0)','rgb(70,186,0)'],
      cut: ['#2028b0','rgb(32, 40, 176)','rgb(32,40,176)'],
      fold: ['#fa0000','rgb(250, 0, 0)','rgb(250,0,0)']
    };
    const cleanColor = s => String(s || '').trim().toLowerCase();
    const isWatermark = node => {
      let n=node;
      while(n && n.nodeType===1) {
        const marker = [n.id, n.getAttribute?.('class'), n.getAttribute?.('clip-path'), n.getAttribute?.('href'), n.getAttribute?.('xlink:href')].join(' ').toLowerCase();
        if (marker.includes('watermark') || marker.includes('data:image')) return true;
        n=n.parentElement;
      }
      return false;
    };
    const kindOf = n => {
      const raw = cleanColor(n.getAttribute('stroke') || getComputedStyle(n).stroke);
      if (COLORS.bleed.includes(raw)) return 'bleed';
      if (COLORS.cut.includes(raw)) return 'cut';
      if (COLORS.fold.includes(raw)) return 'fold';
      return null;
    };
    const svgs = [...document.querySelectorAll('svg')].filter(s => !isWatermark(s));
    const scored = svgs.map(svg => {
      const shapes = [...svg.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')].filter(n => !isWatermark(n));
      let bleed=0,cut=0,fold=0;
      for (const n of shapes) {
        const k = kindOf(n); if (k) ({bleed:()=>bleed++,cut:()=>cut++,fold:()=>fold++}[k])();
      }
      let score = cut*8 + fold*6 + bleed*4;
      if (svg.getAttribute('width') === '1px') score += 12;
      if (svg.getAttribute('height') === '1px') score += 12;
      if (svg.querySelector('image,foreignObject')) score -= 80;
      return { svg, score, bleed, cut, fold, shapes };
    }).filter(x => x.cut + x.fold + x.bleed > 0).sort((a,b)=>b.score-a.score);
    const candidate = scored.find(x => x.svg.getAttribute('width')==='1px' && x.cut>0 && x.fold>0 && !x.svg.querySelector('image,foreignObject')) || scored[0];
    if (!candidate) throw new Error('Không tìm thấy dieline SVG trên trang Pacdora.');

    // Infer how many SVG user units correspond to 1 mm using Pacdora measurement labels.
    const parseML = d => {
      const pts=[]; const re=/[ML]\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*,?\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)/ig; let m;
      while((m=re.exec(d||''))) pts.push([Number(m[1]),Number(m[2])]);
      return pts;
    };
    const ratios=[];
    for (const t of document.querySelectorAll('text')) {
      if (isWatermark(t)) continue;
      const mm = Number((t.textContent||'').trim().match(/^(\d+(?:\.\d+)?)\s*mm$/i)?.[1]);
      if (!Number.isFinite(mm) || mm<=0) continue;
      const p=[...t.parentElement?.children||[]].find(n=>n.tagName?.toLowerCase()==='path');
      if(!p) continue;
      const pts=parseML(p.getAttribute('d'));
      if(pts.length<2) continue;
      const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
      const span=Math.max(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys));
      const r=span/mm; if(Number.isFinite(r)&&r>.001&&r<1000) ratios.push(r);
    }
    const median = a => { if(!a.length)return null; const s=[...a].sort((a,b)=>a-b),m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
    const med=median(ratios); const clean=med?ratios.filter(v=>Math.abs(v-med)/med<.02):[];
    const unitsPerMm=median(clean.length?clean:ratios)||1;

    const chosen=[];
    for (const n of candidate.shapes) {
      if (isWatermark(n)) continue;
      const kind=kindOf(n); if(!kind) continue;
      if(kind==='bleed' && !includeBleed) continue;
      const c=n.cloneNode(true);
      [...c.attributes].forEach(a=>{ if(a.name.startsWith('data-v-')) c.removeAttribute(a.name); });
      c.removeAttribute('class'); c.removeAttribute('style'); c.setAttribute('fill','none');
      if(normalizeLines) {
        c.setAttribute('stroke-width', String(.2*unitsPerMm));
        c.setAttribute('stroke-linecap','round');
        c.setAttribute('stroke-linejoin','round');
        if(kind==='fold') c.setAttribute('stroke-dasharray', `${2*unitsPerMm} ${1*unitsPerMm}`);
        else c.removeAttribute('stroke-dasharray');
      }
      chosen.push({kind,node:c});
    }
    if(!chosen.length) throw new Error('Dieline không có linework hợp lệ để xuất.');

    const stage=document.createElementNS(NS,'svg');
    stage.setAttribute('width','1'); stage.setAttribute('height','1');
    stage.style.cssText='position:fixed;left:-10000px;top:-10000px;overflow:visible;visibility:hidden';
    const g=document.createElementNS(NS,'g');
    chosen.forEach(x=>g.appendChild(x.node.cloneNode(true))); stage.appendChild(g); document.body.appendChild(stage);
    let b;
    try { const bb=g.getBBox(); b={x:bb.x,y:bb.y,width:bb.width,height:bb.height}; }
    finally { stage.remove(); }
    if(!(b.width>0&&b.height>0)) throw new Error('Không đo được kích thước dieline.');

    const pad=Math.max(0,Number(paddingMm)||0)*unitsPerMm;
    b={x:b.x-pad,y:b.y-pad,width:b.width+2*pad,height:b.height+2*pad};
    const mmW=b.width/unitsPerMm, mmH=b.height/unitsPerMm;
    const fmt=n=>String(Number(Number(n).toFixed(4)));
    const root=document.createElementNS(NS,'svg');
    root.setAttribute('xmlns',NS); root.setAttribute('version','1.1');
    root.setAttribute('width',`${fmt(mmW)}mm`); root.setAttribute('height',`${fmt(mmH)}mm`);
    root.setAttribute('viewBox',[fmt(b.x),fmt(b.y),fmt(b.width),fmt(b.height)].join(' '));
    root.setAttribute('preserveAspectRatio','xMinYMin meet');

    for (const kind of ['bleed','cut','fold']) {
      const arr=chosen.filter(x=>x.kind===kind); if(!arr.length) continue;
      const gg=document.createElementNS(NS,'g'); gg.setAttribute('id',kind.toUpperCase());
      arr.forEach(x=>gg.appendChild(x.node)); root.appendChild(gg);
    }

    // Last-line sanitizer: exported SVG is vector-only and contains no Pacdora raster watermark/UI.
    root.querySelectorAll('image,foreignObject,script,style').forEach(n=>n.remove());
    root.querySelectorAll('*').forEach(n=>{
      const marker=[n.id,n.getAttribute('class'),n.getAttribute('clip-path'),n.getAttribute('href'),n.getAttribute('xlink:href')].join(' ').toLowerCase();
      if(marker.includes('watermark') || marker.includes('data:image')) n.remove();
    });
    const xml='<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(root);
    if(/watermark|data:image|<image\b|foreignObject/i.test(xml)) throw new Error('Watermark sanitizer failed; export đã bị chặn.');
    return {
      svg: xml,
      widthMm: mmW,
      heightMm: mmH,
      unitsPerMm,
      counts: {
        bleed: chosen.filter(x=>x.kind==='bleed').length,
        cut: chosen.filter(x=>x.kind==='cut').length,
        fold: chosen.filter(x=>x.kind==='fold').length
      }
    };
  }, {
    includeBleed: options.includeBleed !== false,
    normalizeLines: options.normalizeLines !== false,
    paddingMm: Number(options.paddingMm || 0)
  });
}

app.get('/api/health', (req,res)=>res.json({ ok:true }));

app.post('/api/import', async (req,res) => {
  let s;
  try {
    const url = validatePacdoraUrl(req.body?.url);
    s = await newPacdoraSession(url);
    const info = await extractCustomSizeControls(s.page);
    if (!info.controls.length) {
      await closeSession(s.id);
      return res.status(422).json({ ok:false, error:'Không tìm thấy các ô Custom size. Pacdora có thể đã đổi UI hoặc template này dùng kiểu control khác.' });
    }
    s.lastUsed = Date.now();
    res.json({ ok:true, sessionId:s.id, url, ...info });
  } catch (err) {
    if (s) await closeSession(s.id);
    console.error(err);
    res.status(500).json({ ok:false, error: err?.message || 'Không mở được Pacdora.' });
  }
});

app.post('/api/generate', async (req,res) => {
  try {
    const { sessionId, fields = [], options = {} } = req.body || {};
    const s = sessions.get(sessionId);
    if (!s) return res.status(410).json({ ok:false, error:'Phiên Pacdora đã hết hạn. Hãy Import link lại.' });
    s.lastUsed = Date.now();

    await ensureMillimeters(s.page);
    const before = await waitForDielineReady(s.page);
    for (const f of fields) await setDimension(s.page, f);
    await waitForDielineReady(s.page, before);
    const result = await extractCleanSvg(s.page, options);
    s.lastUsed = Date.now();
    res.json({ ok:true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: err?.message || 'Không tạo được SVG.' });
  }
});

app.post('/api/close', async (req,res) => {
  try { await closeSession(req.body?.sessionId); } catch {}
  res.json({ ok:true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Pacdora Link → SVG running on port ${PORT}`));

process.on('SIGTERM', async () => {
  for (const id of [...sessions.keys()]) await closeSession(id);
  try { if (browserPromise) (await browserPromise).close(); } catch {}
  process.exit(0);
});
