const $ = id => document.getElementById(id);
const state = { sessionId:null, fields:[], svgText:'', url:'' };

const els = {
  url:$('url'), importBtn:$('importBtn'), importStatus:$('importStatus'), fields:$('fields'), fieldsEmpty:$('fieldsEmpty'),
  includeBleed:$('includeBleed'), normalizeLines:$('normalizeLines'), paddingMm:$('paddingMm'), generateBtn:$('generateBtn'),
  generateStatus:$('generateStatus'), previewHost:$('previewHost'), previewEmpty:$('previewEmpty'), sizeBadge:$('sizeBadge'), downloadBtn:$('downloadBtn')
};

function status(el,msg,type=''){ el.className='status'+(type?' '+type:''); el.textContent=msg; }
function busy(btn,on,label){ if(on){ btn.dataset.old=btn.textContent; btn.textContent=label; btn.disabled=true; } else { btn.textContent=btn.dataset.old||btn.textContent; btn.disabled=false; } }

async function api(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({ok:false,error:'Server trả dữ liệu không hợp lệ.'}));
  if(!r.ok||!j.ok) throw new Error(j.error||`HTTP ${r.status}`);
  return j;
}

function renderFields(fields){
  els.fields.innerHTML='';
  els.fieldsEmpty.style.display=fields.length?'none':'';
  fields.forEach((f,i)=>{
    const row=document.createElement('div'); row.className='field';
    const left=document.createElement('div');
    left.innerHTML=`<div class="label"></div><div class="unit">Custom size parameter</div>`;
    left.querySelector('.label').textContent=f.label||`Dimension ${i+1}`;
    const wrap=document.createElement('div'); wrap.className='input-wrap';
    const input=document.createElement('input'); input.type='number'; input.step=f.step&&f.step!=='any'?f.step:'any'; input.value=f.value||'';
    if(f.min) input.min=f.min; if(f.max) input.max=f.max;
    input.dataset.id=f.id; input.dataset.label=f.label;
    const suffix=document.createElement('span'); suffix.className='suffix'; suffix.textContent=f.unit||'mm';
    wrap.append(input,suffix); row.append(left,wrap); els.fields.appendChild(row);
  });
}

async function doImport(){
  const url=els.url.value.trim();
  if(!url) return status(els.importStatus,'Hãy dán link Pacdora.','err');
  if(state.sessionId) api('/api/close',{sessionId:state.sessionId}).catch(()=>{});
  busy(els.importBtn,true,'Opening…'); status(els.importStatus,'Đang mở Pacdora bằng browser ẩn…');
  els.generateBtn.disabled=true; els.downloadBtn.disabled=true; state.svgText='';
  try{
    const j=await api('/api/import',{url});
    state.sessionId=j.sessionId; state.url=j.url; state.fields=j.controls;
    renderFields(j.controls); els.generateBtn.disabled=false;
    status(els.importStatus,`Đã tìm thấy ${j.controls.length} thông số Custom size${j.foundCustomSizeHeading?'':' (fallback detection)'}.`,'ok');
  }catch(e){ status(els.importStatus,e.message,'err'); state.sessionId=null; }
  finally{ busy(els.importBtn,false); }
}

async function doGenerate(){
  if(!state.sessionId) return;
  const inputs=[...els.fields.querySelectorAll('input[data-id]')];
  const fields=inputs.map(inp=>({id:inp.dataset.id,label:inp.dataset.label,value:inp.value}));
  busy(els.generateBtn,true,'Generating…'); status(els.generateStatus,'Đang cập nhật kích thước trên Pacdora và lấy dieline…'); els.downloadBtn.disabled=true;
  try{
    const j=await api('/api/generate',{sessionId:state.sessionId,fields,options:{includeBleed:els.includeBleed.checked,normalizeLines:els.normalizeLines.checked,paddingMm:Number(els.paddingMm.value||0)}});
    state.svgText=j.svg;
    els.previewHost.innerHTML=j.svg; els.previewEmpty.style.display='none';
    els.sizeBadge.textContent=`${j.widthMm.toFixed(2)} × ${j.heightMm.toFixed(2)} mm`;
    els.downloadBtn.disabled=false;
    status(els.generateStatus,`Xong · ${j.counts.cut} cut · ${j.counts.fold} fold · ${j.counts.bleed} bleed · ${j.unitsPerMm.toFixed(4)} unit/mm`,'ok');
  }catch(e){ status(els.generateStatus,e.message,'err'); }
  finally{ busy(els.generateBtn,false); if(state.sessionId) els.generateBtn.disabled=false; }
}

function download(){
  if(!state.svgText) return;
  const blob=new Blob([state.svgText],{type:'image/svg+xml;charset=utf-8'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='pacdora-dieline-mm.svg'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

els.importBtn.addEventListener('click',doImport);
els.url.addEventListener('keydown',e=>{if(e.key==='Enter')doImport()});
els.generateBtn.addEventListener('click',doGenerate);
els.downloadBtn.addEventListener('click',download);
window.addEventListener('beforeunload',()=>{ if(state.sessionId) navigator.sendBeacon('/api/close',new Blob([JSON.stringify({sessionId:state.sessionId})],{type:'application/json'})); });
