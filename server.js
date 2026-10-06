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
const SESSION_TTL_MS = 5 * 60 * 1000;
// Render Free is memory constrained. This tool is personal-use, so keeping one
// live Pacdora tab is much safer than allowing several Chromium contexts.
const MAX_SESSIONS = 1;

function nowMs() { return Date.now(); }
function elapsed(start) { return Date.now() - start; }

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-webgl',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run'
      ]
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

async function closeAllSessions() {
  for (const id of [...sessions.keys()]) await closeSession(id);
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) await closeSession(id);
  }
}, 45_000).unref();

async function installFastRouting(context) {
  await context.route('**/*', async route => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url().toLowerCase();
    const heavyExt = /\.(?:png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|glb|gltf|hdr)(?:\?|$)/i.test(url);
    const tracker = /google-analytics|googletagmanager|doubleclick|hotjar|clarity\.ms|segment\.io|sentry\.io|facebook\.com\/tr|connect\.facebook|amplitude|mixpanel/.test(url);
    if (['image', 'media', 'font'].includes(type) || heavyExt || tracker) return route.abort();
    return route.continue();
  });
}

async function stripHeavyWatermarkDom(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('svg image').forEach(n => {
        const href = `${n.getAttribute('href') || ''} ${n.getAttribute('xlink:href') || ''} ${n.getAttribute('clip-path') || ''}`.toLowerCase();
        if (href.includes('data:image') || href.includes('watermark')) n.remove();
      });
      document.querySelectorAll('[id*="watermark" i],[class*="watermark" i]').forEach(n => {
        if (n.tagName?.toLowerCase() !== 'body') n.remove();
      });
    });
  } catch {}
}

async function newPacdoraSession(url) {
  // Hard cap at one session to avoid Render Free OOM/restarts.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];
    if (!oldest) break;
    await closeSession(oldest[0]);
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    locale: 'en-US',
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
  });
  await installFastRouting(context);
  const page = await context.newPage();
  page.setDefaultTimeout(6_000);

  // "commit" returns as soon as the response starts; we then wait specifically
  // for the controls we need instead of waiting for Pacdora's whole app/3D UI.
  await page.goto(url, { waitUntil: 'commit', timeout: 20_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});

  for (const label of ['Accept', 'Accept all', 'Agree', 'Got it']) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
      if (await btn.isVisible({ timeout: 120 })) { await btn.click(); break; }
    } catch {}
  }

  const id = crypto.randomUUID();
  const s = { id, context, page, url, lastUsed: Date.now(), controls: [] };
  sessions.set(id, s);
  return s;
}

async function ensureMillimeters(page) {
  try {
    const clicked = await page.evaluate(() => {
      const visible = el => {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
      };
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const nodes = [...document.querySelectorAll('button,[role="button"],label,span')].filter(visible);
      for (const mm of nodes.filter(el => norm(el.textContent) === 'mm')) {
        let p = mm.parentElement;
        for (let depth = 0; p && depth < 3; depth++, p = p.parentElement) {
          const hasIn = [...p.querySelectorAll('button,[role="button"],label,span')].some(el => visible(el) && norm(el.textContent) === 'in');
          if (hasIn) { mm.click(); return true; }
        }
      }
      return false;
    });
    if (clicked) await page.waitForTimeout(80);
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

    const candidateText = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,label,span,p,div')].filter(el => {
      if (!visible(el)) return false;
      const own = norm([...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' '));
      return own.length > 0;
    });
    const customHeads = candidateText.filter(el => /^custom\s*size$/i.test(norm(el.textContent)));
    const heading = customHeads.sort((a,b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0] || null;

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
      let best = null, bestScore = Infinity;
      for (const el of candidateText) {
        if (el === input || el.contains(input)) continue;
        const er = el.getBoundingClientRect();
        if (er.bottom > r.top + 18) continue;
        const dy = r.top - er.bottom;
        const xOverlap = Math.max(0, Math.min(r.right, er.right) - Math.max(r.left, er.left));
        const centerDx = Math.abs((er.left + er.right)/2 - (r.left + r.right)/2);
        if (dy > 72 || (xOverlap <= 0 && centerDx > 120)) continue;
        const score = dy + centerDx * .15;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) return norm(best.textContent);
      return norm(input.getAttribute('placeholder')) || norm(input.getAttribute('name')) || 'Dimension';
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
      const stops = candidateText.filter(el => {
        const t = norm(el.textContent);
        return stopWords.some(re => re.test(t)) && el.getBoundingClientRect().top > hr.bottom;
      }).map(el => el.getBoundingClientRect().top);
      const bottom = stops.length ? Math.min(...stops) : hr.bottom + 360;
      candidates = allInputs.filter(input => {
        const r = input.getBoundingClientRect();
        return r.top >= hr.bottom - 6 && r.bottom <= bottom + 6;
      });
    }

    if (!candidates.length) {
      const dimensionWords = /(length|width|height|depth|diameter|radius|side|size|inner|outer|long|short|top|bottom|major|minor|\bl\b|\bw\b|\bh\b)/i;
      candidates = allInputs.filter(input => dimensionWords.test(guessLabel(input)));
    }

    const seen = new Set();
    const rows = [];
    let seq = 0;
    for (const input of candidates) {
      const r = input.getBoundingClientRect();
      const key = `${Math.round(r.left)}:${Math.round(r.top)}:${norm(input.value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = guessLabel(input).replace(/\bmm\b|\bin\b/ig, '').trim() || `Dimension ${seq + 1}`;
      if (/thickness|material/i.test(label)) continue;
      const exportId = `pd-dim-${seq}`;
      input.setAttribute('data-pd-exporter-id', exportId);
      const nearby = norm(input.parentElement?.textContent || '');
      const unit = /\bin\b/i.test(nearby) && !/\bmm\b/i.test(nearby) ? 'in' : 'mm';
      rows.push({
        id: exportId,
        index: seq,
        label,
        value: norm(input.value),
        type: (input.type || 'text').toLowerCase(),
        min: input.min || null,
        max: input.max || null,
        step: input.step || null,
        unit
      });
      seq++;
    }

    return { title: norm(document.title), controls: rows, foundCustomSizeHeading: Boolean(heading) };
  });
}

async function waitForCustomSizeControls(page, timeoutMs = 8_000) {
  // Cheap readiness test first; avoid repeatedly scanning the entire DOM.
  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText || '';
    const inputs = [...document.querySelectorAll('input')].filter(el => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && !el.disabled;
    });
    return inputs.length > 0 && (/custom\s*size/i.test(bodyText) || inputs.length >= 3);
  }, { timeout: timeoutMs, polling: 250 }).catch(() => {});

  await ensureMillimeters(page);
  let info = await extractCustomSizeControls(page).catch(() => null);
  if (info?.controls?.length) return info;

  await page.waitForTimeout(650);
  await ensureMillimeters(page);
  info = await extractCustomSizeControls(page).catch(() => null);
  return info || { title: '', controls: [], foundCustomSizeHeading: false };
}

function normalizeNumberString(v) {
  const n = Number(String(v ?? '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

async function applyDimensions(page, fields) {
  // Re-tag current inputs because Pacdora/Vue may replace input DOM nodes after
  // any edit. This is the main fix for Generate failing after a successful Import.
  let current = await extractCustomSizeControls(page);
  if (!current.controls.length) throw new Error('Không còn tìm thấy các ô Custom size. Hãy Import link lại.');

  const assignments = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const parsed = /^pd-dim-(\d+)$/.exec(String(f.id || ''));
    const idx = parsed ? Number(parsed[1]) : i;
    const target = current.controls[idx] || current.controls.find(c => c.label.toLowerCase() === String(f.label || '').toLowerCase());
    if (!target) throw new Error(`Không còn tìm thấy ô ${f.label || `#${i+1}`}.`);
    assignments.push({ id: target.id, label: target.label, value: String(f.value ?? '').trim(), index: idx });
  }

  const beforeValues = new Map(current.controls.map(c => [c.index, normalizeNumberString(c.value)]));
  const changedAny = assignments.some(a => {
    const before = beforeValues.get(a.index);
    const next = normalizeNumberString(a.value);
    return before === null || next === null || Math.abs(before - next) > 1e-9;
  });

  // First attempt: set every dimension in one browser task. Vue usually queues
  // its re-render until this JS task ends, so no input disappears midway.
  await page.evaluate(assigns => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    for (const a of assigns) {
      const el = document.querySelector(`[data-pd-exporter-id="${CSS.escape(a.id)}"]`);
      if (!(el instanceof HTMLInputElement)) continue;
      el.focus();
      if (nativeSetter) nativeSetter.call(el, a.value); else el.value = a.value;
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: a.value })); }
      catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
  }, assignments);

  await page.waitForTimeout(180);

  // Validate what Pacdora accepted. If a controlled input reverted, retry that
  // field individually, re-discovering inputs after every edit.
  let after = await extractCustomSizeControls(page);
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];
    const wanted = normalizeNumberString(a.value);
    let c = after.controls[a.index] || after.controls.find(x => x.label.toLowerCase() === a.label.toLowerCase());
    const got = c ? normalizeNumberString(c.value) : null;
    if (wanted !== null && got !== null && Math.abs(wanted - got) <= 1e-6) continue;

    current = await extractCustomSizeControls(page);
    c = current.controls[a.index] || current.controls.find(x => x.label.toLowerCase() === a.label.toLowerCase());
    if (!c) throw new Error(`Pacdora đã render lại UI và không còn tìm thấy ô ${a.label}.`);
    const loc = page.locator(`[data-pd-exporter-id="${c.id}"]`).first();
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.fill(a.value).catch(async () => {
      await loc.evaluate((el, v) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (set) set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, a.value);
    });
    await loc.press('Tab').catch(() => {});
    await page.waitForTimeout(120);
    after = await extractCustomSizeControls(page);
  }

  return { changedAny, controls: after.controls };
}

async function getDielineSignature(page) {
  return await page.evaluate(() => {
    const colors = new Set(['#46ba00','#2028b0','#fa0000']);
    const isBad = el => {
      let n = el;
      while (n && n.nodeType === 1) {
        const s = `${n.id || ''} ${n.getAttribute?.('class') || ''} ${n.getAttribute?.('clip-path') || ''} ${n.getAttribute?.('href') || ''}`.toLowerCase();
        if (s.includes('watermark') || s.includes('data:image')) return true;
        n = n.parentElement;
      }
      return false;
    };
    const nodes = [...document.querySelectorAll('svg path[stroke],svg line[stroke],svg polyline[stroke],svg polygon[stroke]')]
      .filter(n => colors.has(String(n.getAttribute('stroke') || '').toLowerCase()) && !isBad(n));
    return nodes.slice(0, 90).map(n => [n.getAttribute('stroke'), n.getAttribute('d'), n.getAttribute('x1'), n.getAttribute('y1'), n.getAttribute('x2'), n.getAttribute('y2')].join('|')).join('||');
  });
}

async function waitForDielineReady(page, oldSignature = '', changedAny = true) {
  if (!changedAny) {
    await page.waitForTimeout(80);
    return await getDielineSignature(page);
  }
  let stable = 0, last = '';
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(110);
    const sig = await getDielineSignature(page);
    const changed = Boolean(sig && sig !== oldSignature);
    if (changed && sig === last) stable++; else stable = 0;
    last = sig;
    if (changed && stable >= 1) return sig;
  }
  // Don't silently export the old dieline after the user changed dimensions.
  const finalSig = await getDielineSignature(page);
  if (oldSignature && finalSig === oldSignature) {
    throw new Error('Pacdora chưa cập nhật dieline sau khi đổi kích thước. Hãy thử Generate lại hoặc Import lại link.');
  }
  return finalSig;
}

async function extractCleanSvg(page, options = {}) {
  return await page.evaluate(({ includeBleed, normalizeLines, paddingMm }) => {
    const NS = 'http://www.w3.org/2000/svg';
    const COLORS = { bleed:'#46ba00', cut:'#2028b0', fold:'#fa0000' };
    const kindOf = n => {
      const s = String(n.getAttribute('stroke') || '').trim().toLowerCase();
      if (s === COLORS.bleed) return 'bleed';
      if (s === COLORS.cut) return 'cut';
      if (s === COLORS.fold) return 'fold';
      return null;
    };
    const isWatermark = node => {
      let n = node;
      while (n && n.nodeType === 1) {
        const marker = [n.id, n.getAttribute?.('class'), n.getAttribute?.('clip-path'), n.getAttribute?.('href'), n.getAttribute?.('xlink:href')].join(' ').toLowerCase();
        if (marker.includes('watermark') || marker.includes('data:image')) return true;
        n = n.parentElement;
      }
      return false;
    };

    // Efficient candidate detection: group only known dieline-colored shapes by
    // their nearest SVG. Avoid walking every descendant of every SVG, which was
    // expensive enough to make Chromium unstable on Render Free.
    const allColored = [...document.querySelectorAll('svg path[stroke],svg line[stroke],svg polyline[stroke],svg polygon[stroke],svg rect[stroke],svg circle[stroke],svg ellipse[stroke]')]
      .filter(n => kindOf(n) && !isWatermark(n));
    if (!allColored.length) throw new Error('Không tìm thấy linework dieline trên trang Pacdora.');

    const bySvg = new Map();
    for (const n of allColored) {
      const svg = n.closest('svg');
      if (!svg || isWatermark(svg)) continue;
      if (!bySvg.has(svg)) bySvg.set(svg, []);
      bySvg.get(svg).push(n);
    }

    const scored = [...bySvg.entries()].map(([svg, shapes]) => {
      let bleed=0, cut=0, fold=0;
      for (const n of shapes) {
        const k = kindOf(n);
        if (k === 'bleed') bleed++; else if (k === 'cut') cut++; else if (k === 'fold') fold++;
      }
      let score = cut*8 + fold*6 + bleed*4;
      if (svg.getAttribute('width') === '1px' || svg.getAttribute('width') === '1') score += 12;
      if (svg.getAttribute('height') === '1px' || svg.getAttribute('height') === '1') score += 12;
      if (svg.querySelector('image,foreignObject')) score -= 60;
      return { svg, shapes, bleed, cut, fold, score };
    }).sort((a,b) => b.score - a.score);

    const candidate = scored.find(x => x.cut > 0 && x.fold > 0 && !x.svg.querySelector('image,foreignObject')) || scored[0];
    if (!candidate) throw new Error('Không xác định được SVG dieline.');

    // Pacdora's dieline geometry is stored in millimetre user units in the DOM.
    // The 3.77953 transform seen in its wrapper is only mm -> CSS px for display.
    // Verify opportunistically from one or more dimension labels, but default to 1.
    let unitsPerMm = 1;
    try {
      const ratios = [];
      const texts = [...document.querySelectorAll('text')].slice(0, 120);
      const re = /[ML]\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*,?\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)/ig;
      for (const t of texts) {
        const m = (t.textContent || '').trim().match(/^(\d+(?:\.\d+)?)\s*mm$/i);
        if (!m || isWatermark(t)) continue;
        const mm = Number(m[1]);
        const p = [...(t.parentElement?.children || [])].find(n => n.tagName?.toLowerCase() === 'path');
        if (!p || !(mm > 0)) continue;
        const pts=[]; let q; re.lastIndex=0;
        while ((q = re.exec(p.getAttribute('d') || '')) && pts.length < 40) pts.push([Number(q[1]),Number(q[2])]);
        if (pts.length < 2) continue;
        const xs=pts.map(x=>x[0]), ys=pts.map(x=>x[1]);
        const span=Math.max(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys));
        const r=span/mm;
        if (Number.isFinite(r) && r > .5 && r < 2) ratios.push(r);
        if (ratios.length >= 8) break;
      }
      if (ratios.length) {
        ratios.sort((a,b)=>a-b);
        unitsPerMm = ratios[Math.floor(ratios.length/2)];
      }
    } catch {}

    const chosen=[];
    for (const n of candidate.shapes) {
      const kind=kindOf(n);
      if (!kind || isWatermark(n)) continue;
      if (kind === 'bleed' && !includeBleed) continue;
      const c=n.cloneNode(true);
      [...c.attributes].forEach(a => { if (a.name.startsWith('data-v-')) c.removeAttribute(a.name); });
      c.removeAttribute('class'); c.removeAttribute('style'); c.setAttribute('fill','none');
      if (normalizeLines) {
        c.setAttribute('stroke-width', String(.2 * unitsPerMm));
        c.setAttribute('stroke-linecap','round');
        c.setAttribute('stroke-linejoin','round');
        if (kind === 'fold') c.setAttribute('stroke-dasharray', `${2*unitsPerMm} ${1*unitsPerMm}`);
        else c.removeAttribute('stroke-dasharray');
      }
      chosen.push({kind,node:c});
    }
    if (!chosen.length) throw new Error('Dieline không có linework hợp lệ để xuất.');

    const stage=document.createElementNS(NS,'svg');
    stage.setAttribute('width','1'); stage.setAttribute('height','1');
    stage.style.cssText='position:fixed;left:-10000px;top:-10000px;overflow:visible;visibility:hidden';
    const g=document.createElementNS(NS,'g');
    chosen.forEach(x => g.appendChild(x.node.cloneNode(true)));
    stage.appendChild(g); document.body.appendChild(stage);
    let b;
    try { const bb=g.getBBox(); b={x:bb.x,y:bb.y,width:bb.width,height:bb.height}; }
    finally { stage.remove(); }
    if (!(b.width > 0 && b.height > 0)) throw new Error('Không đo được kích thước dieline.');

    const pad=Math.max(0,Number(paddingMm)||0)*unitsPerMm;
    b={x:b.x-pad,y:b.y-pad,width:b.width+2*pad,height:b.height+2*pad};
    const mmW=b.width/unitsPerMm, mmH=b.height/unitsPerMm;
    const fmt=n => String(Number(Number(n).toFixed(4)));

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

    root.querySelectorAll('image,foreignObject,script,style').forEach(n=>n.remove());
    root.querySelectorAll('*').forEach(n => {
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

app.get('/api/health', (req,res) => res.json({ ok:true, sessions:sessions.size }));

app.post('/api/import', async (req,res) => {
  const start=nowMs();
  let s;
  try {
    const url=validatePacdoraUrl(req.body?.url);
    // Frontend close is fire-and-forget. Enforce one session server-side as well.
    await closeAllSessions();
    s=await newPacdoraSession(url);
    const info=await waitForCustomSizeControls(s.page);
    if(!info.controls.length) {
      await closeSession(s.id);
      return res.status(422).json({ok:false,error:'Không tìm thấy các ô Custom size. Pacdora có thể đã đổi UI hoặc template này dùng kiểu control khác.'});
    }
    s.controls=info.controls;
    s.lastUsed=Date.now();
    await stripHeavyWatermarkDom(s.page);
    res.json({ok:true,sessionId:s.id,url,...info,timingMs:elapsed(start)});
  } catch(err) {
    if(s) await closeSession(s.id);
    console.error('IMPORT ERROR',err);
    res.status(500).json({ok:false,error:err?.message||'Không mở được Pacdora.'});
  }
});

app.post('/api/generate', async (req,res) => {
  const start=nowMs();
  try {
    const {sessionId,fields=[],options={}}=req.body||{};
    const s=sessions.get(sessionId);
    if(!s) return res.status(410).json({ok:false,error:'Phiên Pacdora đã hết hạn. Hãy Import link lại.'});
    s.lastUsed=Date.now();

    await ensureMillimeters(s.page);
    const before=await getDielineSignature(s.page);
    const applied=await applyDimensions(s.page,fields);
    await waitForDielineReady(s.page,before,applied.changedAny);
    await stripHeavyWatermarkDom(s.page);
    const result=await extractCleanSvg(s.page,options);
    s.lastUsed=Date.now();
    res.json({ok:true,...result,timingMs:elapsed(start)});
  } catch(err) {
    console.error('GENERATE ERROR',err);
    res.status(500).json({ok:false,error:err?.message||'Không tạo được SVG.'});
  }
});

app.post('/api/close', async (req,res) => {
  try { await closeSession(req.body?.sessionId); } catch {}
  res.json({ok:true});
});

app.listen(PORT,'0.0.0.0',() => {
  console.log(`Pacdora Link → SVG v2.2 running on port ${PORT}`);
  getBrowser().then(()=>console.log('Chromium warmed')).catch(err=>console.error('Chromium warmup failed:',err?.message||err));
});

process.on('SIGTERM',async()=>{
  await closeAllSessions();
  try { if(browserPromise) (await browserPromise).close(); } catch {}
  process.exit(0);
});
