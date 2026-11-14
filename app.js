(function(){
window.__appReady=true;
if(location.protocol==='file:') return;
let PoseLandmarker=null, mpState='読み込み前';
const $ = id => document.getElementById(id);
const video=$('video'), view=$('view'), ctx=view.getContext('2d'), chart=$('chart'), cctx=chart.getContext('2d'), chart2=$('chart2'), cctx2=chart2.getContext('2d');
const status=t=>$('status').textContent=t;

// 阿江ら(1992) 日本人アスリートの身体部分係数 [質量比, 近位端からの重心位置比]
// 頭部は耳の位置、手は人差し指・小指付け根の中点で近似
const AE={
  male:  {head:[.069,0],trunk:[.489,.493],uarm:[.027,.529],farm:[.016,.415],hand:[.006,0],thigh:[.110,.475],shank:[.051,.406],foot:[.011,.595]},
  female:{head:[.075,0],trunk:[.457,.506],uarm:[.026,.523],farm:[.015,.423],hand:[.006,0],thigh:[.123,.458],shank:[.053,.410],foot:[.012,.594]}
};
const VIS=0.5, CAL_N=15;

let landmarker=null, running=false, recording=false, rows=[], dir=1, lockedSide=null;
let curSide='L', lastTs=0, recStart=0, trail=[], frames=0, fpsT=performance.now(), stream=null;
let subj=null, scale=null, calLegs=[], origin=null;
let recs=[], result=null, curFrame=null, sync=null; // sync: 同期ライトの検出結果 // recs: 同時に録る動画（元の映像／骨格つき）

async function init(){
  try{
    status('解析エンジンを起動中…');
    const PC=self.PRECACHE;
    mpState='読み込み中';
    ({PoseLandmarker}=await import(PC.CDN+'vision_bundle.mjs'));
    const fileset={wasmLoaderPath:PC.CDN+'wasm/vision_wasm_internal.js',wasmBinaryPath:PC.CDN+'wasm/vision_wasm_internal.wasm'};
    const model={modelAssetPath:PC.MODEL};
    const opts=d=>({baseOptions:{...model,delegate:d},runningMode:"VIDEO",numPoses:1});
    try{ landmarker=await PoseLandmarker.createFromOptions(fileset,opts("GPU")); }
    catch(e){ landmarker=await PoseLandmarker.createFromOptions(fileset,opts("CPU")); }
    mpState='準備完了';
    status('準備完了');
    $('startBtn').disabled=false;
  }catch(e){
    mpState='失敗';
    status('解析エンジンを起動できません。'+(navigator.onLine?'':'初回はインターネットに接続して開いてください。')+'（'+e.message+'）');
  }
}
init();

// ---------- オフライン準備 ----------
const CAP=window.Capacitor, isNative=!!(CAP&&CAP.isNativePlatform&&CAP.isNativePlatform());
const PC=self.PRECACHE;
function offShow(state,title,msg,pct){
  const b=$('offlineBox'); b.classList.remove('ok','ng'); if(state) b.classList.add(state);
  $('offTitle').textContent=title; $('offMsg').textContent=msg||'';
  if(pct!=null) $('offBar').style.width=pct+'%';
}
async function cacheCount(){
  // 自分のキャッシュだけを数える（同じサイトの別アプリが保存したファイルは数えない）
  const c=await caches.open(PC.VERSION);
  let n=0; for(const f of PC.FILES){ if(await c.match(new URL(f,location.href).href,{ignoreSearch:true})) n++; }
  return n;
}
let offTimer=null, offStart=Date.now(), autoRecached=false;
async function checkCache(){
  const n=await cacheCount(), N=PC.FILES.length, pct=Math.round(n/N*100);
  if(n===N){
    offShow('ok','オフライン準備完了（機内モードで使えます）','この端末に全ファイルが保存されています。2回目以降の起動・計測・保存に通信は不要です。',100);
    $('recacheBtn').hidden=true; clearInterval(offTimer); offTimer=null;
    setTimeout(()=>$('offlineBox').classList.add('compact'),4000);
  }else{
    offShow('',`オフライン準備中… ${n}/${N} ファイル（${pct}%）`,
      `初回だけ通信が必要です（約${PC.TOTAL_MB}MB）。完了するまでこの画面を開いたまま、ネットにつないだ状態で待ってください。完了後は通信不要です。`,pct);
    // 一度保存したキャッシュが消えていた場合など、10秒たっても進まなければ自動で保存し直す
    if(navigator.onLine && !autoRecached && Date.now()-offStart>10000){
      autoRecached=true;
      navigator.serviceWorker.ready.then(r=>r.active&&r.active.postMessage('recache')).catch(()=>{});
    }
    if(!navigator.onLine){ offShow('ng',`オフライン準備が未完了です（${n}/${N}）`,'ネットにつないでから、もう一度このアプリを開いてください。',pct); $('recacheBtn').hidden=false; }
  }
  return n===N;
}
if(isNative){
  offShow('ok','アプリ版：全ファイル同梱済み','モデル・解析エンジンはアプリ内に入っています。通信は一切行いません。',100);
  setTimeout(()=>$('offlineBox').classList.add('compact'),4000);
}else if(!('serviceWorker' in navigator)||!window.caches){
  offShow('ng','このブラウザはオフライン保存に対応していません','iPhoneはSafari、AndroidはChromeで開いてください。',0);
}else{
  navigator.serviceWorker.register('sw.js').catch(e=>offShow('ng','オフライン準備を開始できません',e.message,0));
  navigator.serviceWorker.addEventListener('message',e=>{ if(e.data==='recached') checkCache(); });
  if(navigator.storage&&navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  checkCache().then(done=>{ if(!done) offTimer=setInterval(checkCache,700); });
  window.addEventListener('online',checkCache); window.addEventListener('offline',checkCache);
  $('recacheBtn').onclick=async()=>{
    const r=await navigator.serviceWorker.ready; r.active&&r.active.postMessage('recache');
    if(!offTimer) offTimer=setInterval(checkCache,700); checkCache();
  };
}

// ---------- 初期入力 ----------
try{ const p=JSON.parse(localStorage.getItem('com_subj')||'null'); if(p){$('pid').value=p.id||'';$('age').value=p.age||'';$('sex').value=p.sex||'';$('leg').value=p.leg||'';} }catch(e){}
$('startBtn').onclick=()=>{
  const age=+$('age').value, sex=$('sex').value, leg=+$('leg').value;
  const err=!(age>0&&age<=120)?'年齢を入れてください。':!sex?'性別を選んでください。':!(leg>=30&&leg<=130)?'下肢長を30〜130cmの範囲で入れてください。':'';
  $('setupErr').textContent=err; if(err) return;
  subj={id:$('pid').value.trim(),age,sex,leg};
  try{localStorage.setItem('com_subj',JSON.stringify(subj));}catch(e){}
  $('who').innerHTML='';
  $('who').append(`${subj.id?subj.id+'　':''}${age}歳　${sex==='male'?'男性':'女性'}　下肢長 ${leg} cm`);
  const b=document.createElement('button'); b.className='ghost'; b.textContent='変更'; b.onclick=backToSetup; $('who').append(b);
  $('who').classList.remove('hidden'); $('tabMeas').disabled=false; showTab('meas');
};
function backToSetup(){ showTab('info'); }
// ---------- タブ ----------
function busy(){ return recording||analyzing; }
function showTab(which){
  if(which==='info'&&busy()){ status('記録中・解析中はタブを切り替えられません。'); return; }
  const info=which==='info';
  if(info&&stream) toggleCam();
  $('setup').classList.toggle('hidden',!info); $('app').classList.toggle('hidden',info);
  $('tabInfo').setAttribute('aria-selected',info); $('tabMeas').setAttribute('aria-selected',!info);
  if(!info) setMode(curMode,true);
}
$('tabInfo').onclick=()=>showTab('info');
$('tabMeas').onclick=()=>{ if(subj) showTab('meas'); else $('startBtn').click(); };
// ---------- 計測モード（リアルタイム計測／撮影のみ／動画を解析） ----------
const MODE_HINT={
  rt:'カメラ映像をその場でAIが解析し、骨格・重心・関節角度を表示しながら記録します。カメラは被験者の真横、腰の高さに置いてください。',
  cap:'撮影中はAIの解析をせず、カメラのコマ数（30〜60 fps）のまま元の映像を保存します。記録停止後に「この動画を解析」で全コマを解析できます。',
  file:'保存してある動画（スロー撮影も可）を読み込み、全コマを解析します。'
};
let curMode='rt';
try{ const m=localStorage.getItem('com_mode'); if(m&&MODE_HINT[m]) curMode=m; }catch(e){}
function setMode(m,force){
  if(!force&&busy()){ status('記録中・解析中はモードを切り替えられません。'); return; }
  const changed=m!==curMode; curMode=m;
  try{localStorage.setItem('com_mode',m);}catch(e){}
  [['mRt','rt'],['mCap','cap'],['mFile','file']].forEach(([id,k])=>$(id).setAttribute('aria-pressed',k===m));
  $('modeHint').textContent=MODE_HINT[m];
  const wantFile=m==='file';
  if($('mode').value!==(wantFile?'file':'cam')||force){ $('mode').value=wantFile?'file':'cam'; $('mode').onchange(); }
  if(!wantFile){
    const off=m==='cap';
    if(($('rtMode').value==='off')!==off){ if(off) $('vidMode').dataset.prev=$('vidMode').value; $('rtMode').value=off?'off':'on'; applyRt(); }
  }
  if(changed&&!wantFile) status(m==='cap'?'撮影のみモードです。カメラを開始してください。':'リアルタイム計測モードです。カメラを開始してください。');
}
$('mRt').onclick=()=>setMode('rt'); $('mCap').onclick=()=>setMode('cap'); $('mFile').onclick=()=>setMode('file');

// ---------- 重心計算 ----------
function pickSide(lm){
  const sel=$('sideSel').value;
  if(sel!=='auto') return sel;
  if(lockedSide) return lockedSide;
  const v=o=>[11,13,15,23,25,27].reduce((a,i)=>a+(lm[i+o].visibility??0),0);
  const l=v(0), r=v(1);
  if(curSide==='L' && r>l+0.5) curSide='R'; else if(curSide==='R' && l>r+0.5) curSide='L';
  return curSide;
}
function sideJ(lm,W,H,o){
  const P=i=>{const p=lm[i+o];return {x:p.x*W,y:p.y*H,v:p.visibility??1}};
  return {ear:P(7),sh:P(11),el:P(13),wr:P(15),pk:P(17),ix:P(19),hp:P(23),kn:P(25),an:P(27),he:P(29),to:P(31)};
}
// 両側：左右それぞれの関節位置を使う（片側を2倍にしない）
function computeBoth(lm,W,H,sex){
  const A=sideJ(lm,W,H,0), B=sideJ(lm,W,H,1);
  const ok=J=>![J.sh,J.hp,J.kn,J.an].some(p=>p.v<VIS);
  if(!ok(A)&&!ok(B)) return null; // 少なくとも片側ははっきり見えていること
  const t=AE[sex], L=(a,b,r)=>({x:a.x+(b.x-a.x)*r,y:a.y+(b.y-a.y)*r}), M=(a,b)=>L(a,b,.5);
  const segs=[[t.head[0],M(A.ear,B.ear)],[t.trunk[0],L(M(A.sh,B.sh),M(A.hp,B.hp),t.trunk[1])]];
  for(const J of [A,B]) segs.push([t.uarm[0],L(J.sh,J.el,t.uarm[1])],[t.farm[0],L(J.el,J.wr,t.farm[1])],[t.hand[0],L(J.pk,J.ix,.5)],
    [t.thigh[0],L(J.hp,J.kn,t.thigh[1])],[t.shank[0],L(J.kn,J.an,t.shank[1])],[t.foot[0],L(J.he,J.to,t.foot[1])]);
  let m=0,x=0,y=0; for(const [w,p] of segs){m+=w;x+=w*p.x;y+=w*p.y;}
  const leg=J=>Math.hypot(J.hp.x-J.kn.x,J.hp.y-J.kn.y)+Math.hypot(J.kn.x-J.an.x,J.kn.y-J.an.y);
  const visOf=J=>[J.sh,J.hp,J.kn,J.an].reduce((s,p)=>s+p.v,0)/4;
  return {x:x/m,y:y/m,J:visOf(A)>=visOf(B)?A:B,JL:A,JR:B,visL:visOf(A),visR:visOf(B),legPx:(leg(A)+leg(B))/2,
    face:((A.to.x-A.he.x)+(B.to.x-B.he.x)>0)?1:-1};
}
function computeCOM(lm,W,H,side,sex){
  if(side==='B') return computeBoth(lm,W,H,sex);
  const o=side==='L'?0:1;
  const P=i=>{const p=lm[i+o];return {x:p.x*W,y:p.y*H,v:p.visibility??1}};
  const J={ear:P(7),sh:P(11),el:P(13),wr:P(15),pk:P(17),ix:P(19),hp:P(23),kn:P(25),an:P(27),he:P(29),to:P(31)};
  if([J.sh,J.hp,J.kn,J.an].some(p=>p.v<VIS)) return null;
  const t=AE[sex], L=(a,b,r)=>({x:a.x+(b.x-a.x)*r,y:a.y+(b.y-a.y)*r});
  const segs=[ // 見えている側の四肢を左右対称と仮定して2倍
    [t.head[0],J.ear],[t.trunk[0],L(J.sh,J.hp,t.trunk[1])],
    [2*t.uarm[0],L(J.sh,J.el,t.uarm[1])],[2*t.farm[0],L(J.el,J.wr,t.farm[1])],[2*t.hand[0],L(J.pk,J.ix,.5)],
    [2*t.thigh[0],L(J.hp,J.kn,t.thigh[1])],[2*t.shank[0],L(J.kn,J.an,t.shank[1])],[2*t.foot[0],L(J.he,J.to,t.foot[1])]
  ];
  let m=0,x=0,y=0; for(const [w,p] of segs){m+=w;x+=w*p.x;y+=w*p.y;}
  const legPx=Math.hypot(J.hp.x-J.kn.x,J.hp.y-J.kn.y)+Math.hypot(J.kn.x-J.an.x,J.kn.y-J.an.y);
  return {x:x/m,y:y/m,J,legPx,face:(J.to.x>J.he.x)?1:-1};
}
// 矢状面の関節角度（度）。face=+1で右向き、-1で左向き
// 股関節屈曲：体幹（肩→股）の延長線に対する大腿（股→膝）の角度。前方が＋（伸展は－）
// 膝関節屈曲：大腿の延長線に対する下腿（膝→足関節）の角度。後方が＋（完全伸展で0）
function sang(a,b){return Math.atan2(a.x*b.y-a.y*b.x,a.x*b.x+a.y*b.y)*180/Math.PI;}
function jointAngles(J,face){
  const v=(p,q)=>({x:q.x-p.x,y:q.y-p.y});
  const trunk=v(J.sh,J.hp), thigh=v(J.hp,J.kn), shank=v(J.kn,J.an);
  return {hip:-face*sang(trunk,thigh), knee:face*sang(thigh,shank)};
}
const median=a=>{const s=[...a].sort((p,q)=>p-q);const n=s.length;return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2;};

// ---------- 1フレーム処理 ----------
function processFrame(ts,tSec){
  const W=view.width,H=view.height;
  ctx.drawImage(video,0,0,W,H);
  if(ts<=lastTs) ts=lastTs+1;
  const res=landmarker.detectForVideo(video,ts); lastTs=ts;
  lastPose=!!(res.landmarks&&res.landmarks[0]);
  if(!res.landmarks||!res.landmarks[0]) return;
  const lm=res.landmarks[0], side=pickSide(lm), c=computeCOM(lm,W,H,side,subj.sex);
  if(!c) return;
  const angOf=f=>{ if(!c.JL) return jointAngles(c.J,f);
    const l=jointAngles(c.JL,f), r=jointAngles(c.JR,f); return {hip:(l.hip+r.hip)/2,knee:(l.knee+r.knee)/2,l,r}; }; // 両側のときは左右の平均を代表値にする
  const ang=angOf(recording&&rows.length?dir:c.face);
  $('vHip').textContent=ang.hip.toFixed(0); $('vKnee').textContent=ang.knee.toFixed(0);
  drawBody(c,W);
  if(curFrame!=null) frameDraw[curFrame]=c; // あとで骨格つき動画を作るために取っておく
  trail.push({x:c.x,y:c.y}); if(trail.length>90) trail.shift();
  if(!recording) return;
  if(rows.length===0){ dir=c.face; lockedSide=side; }
  const an=angOf(dir);
  rows.push({t:tSec,frame:curFrame,side,cx:c.x,cy:c.y,legPx:c.legPx,hip:an.hip,knee:an.knee,hipL:an.l?.hip,kneeL:an.l?.knee,hipR:an.r?.hip,kneeR:an.r?.knee,visL:c.visL,visR:c.visR,dx:null,dy:null,lm:lm.map(p=>[p.x*W,p.y*H,p.visibility??0])});
  if(!scale){
    calLegs.push(c.legPx);
    if(calLegs.length>=CAL_N){
      scale=subj.leg/median(calLegs);
      const first=rows.slice(0,CAL_N);
      origin={x:median(first.map(r=>r.cx)),y:median(first.map(r=>r.cy))};
      rows.forEach(setDisp);
      $('scaleTxt').textContent=`換算 ${scale.toFixed(4)} cm/px`;
    }else{ $('vY').textContent='…'; $('vX').textContent='…'; return; }
  }else setDisp(rows[rows.length-1]);
  const r=rows[rows.length-1];
  $('vY').textContent=r.dy.toFixed(1); $('vX').textContent=r.dx.toFixed(1);
  drawChart(); drawChart2();
}
function setDisp(r){ r.dx=dir*(r.cx-origin.x)*scale; r.dy=-(r.cy-origin.y)*scale; }

// ---------- 描画 ----------
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function drawBody(c,W){
  const lw=Math.max(2,W/400);
  ctx.strokeStyle=css('--bone'); ctx.lineWidth=lw; ctx.beginPath();
  (c.JL?[c.JL,c.JR]:[c.J]).forEach(J=>[[J.ear,J.sh],[J.sh,J.el],[J.el,J.wr],[J.sh,J.hp],[J.hp,J.kn],[J.kn,J.an],[J.an,J.he],[J.he,J.to]].forEach(([a,b])=>{ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}));
  if(c.JL){ [[c.JL.sh,c.JR.sh],[c.JL.hp,c.JR.hp]].forEach(([a,b])=>{ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}); }
  ctx.stroke();
  ctx.strokeStyle='rgba(255,255,255,.7)'; ctx.beginPath();
  trail.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke();
  ctx.fillStyle=css('--com'); ctx.beginPath(); ctx.arc(c.x,c.y,lw*4,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#fff'; ctx.stroke();
  if((recording||rendering)&&origin){ ctx.setLineDash([lw*3,lw*3]); ctx.strokeStyle='rgba(255,255,255,.6)';
    ctx.beginPath(); ctx.moveTo(0,origin.y); ctx.lineTo(W,origin.y); ctx.stroke(); ctx.setLineDash([]); }
}
function drawChart(){
  const dpr=window.devicePixelRatio||1, w=chart.clientWidth, h=chart.clientHeight;
  if(chart.width!==Math.round(w*dpr)){chart.width=Math.round(w*dpr);chart.height=Math.round(h*dpr);}
  cctx.setTransform(dpr,0,0,dpr,0,0); cctx.clearRect(0,0,w,h);
  const data=rows.filter(r=>r.dy!==null); if(!data.length) return;
  const span=6, tEnd=data[data.length-1].t, t0=Math.max(data[0].t,tEnd-span);
  const vis=data.filter(r=>r.t>=t0);
  let lo=0,hi=0; vis.forEach(r=>{lo=Math.min(lo,r.dx,r.dy);hi=Math.max(hi,r.dx,r.dy);});
  const pad=(hi-lo)*0.1||1; lo-=pad; hi+=pad;
  const X=t=>(t-t0)/span*w, Y=v=>h-(v-lo)/(hi-lo)*h;
  cctx.strokeStyle=css('--line'); cctx.lineWidth=1; cctx.beginPath(); cctx.moveTo(0,Y(0)); cctx.lineTo(w,Y(0)); cctx.stroke();
  cctx.fillStyle=css('--sub'); cctx.font='11px system-ui'; cctx.fillText(hi.toFixed(0)+' cm',4,12); cctx.fillText(lo.toFixed(0),4,h-4);
  [['dy','--com'],['dx','--fwd']].forEach(([k,col])=>{
    cctx.strokeStyle=css(col); cctx.lineWidth=2; cctx.beginPath();
    vis.forEach((r,i)=>i?cctx.lineTo(X(r.t),Y(r[k])):cctx.moveTo(X(r.t),Y(r[k]))); cctx.stroke();
  });
}

function drawChart2(){
  const dpr=window.devicePixelRatio||1, w=chart2.clientWidth, h=chart2.clientHeight;
  if(chart2.width!==Math.round(w*dpr)){chart2.width=Math.round(w*dpr);chart2.height=Math.round(h*dpr);}
  cctx2.setTransform(dpr,0,0,dpr,0,0); cctx2.clearRect(0,0,w,h);
  const data=rows.filter(r=>r.dy!==null); if(!data.length) return;
  const span=6, tEnd=data[data.length-1].t, t0=Math.max(data[0].t,tEnd-span);
  const vis=data.filter(r=>r.t>=t0);
  let lo=0,hi=90; vis.forEach(r=>{lo=Math.min(lo,r.hip,r.knee);hi=Math.max(hi,r.hip,r.knee);});
  lo-=5; hi+=5;
  const X=t=>(t-t0)/span*w, Y=v=>h-(v-lo)/(hi-lo)*h;
  cctx2.strokeStyle=css('--line'); cctx2.lineWidth=1; cctx2.beginPath(); cctx2.moveTo(0,Y(0)); cctx2.lineTo(w,Y(0)); cctx2.stroke();
  cctx2.fillStyle=css('--sub'); cctx2.font='11px system-ui'; cctx2.fillText(hi.toFixed(0)+'°',4,12); cctx2.fillText(lo.toFixed(0)+'°',4,h-4);
  [['hip','--hip'],['knee','--knee']].forEach(([k,col])=>{
    cctx2.strokeStyle=css(col); cctx2.lineWidth=2; cctx2.beginPath();
    vis.forEach((r,i)=>i?cctx2.lineTo(X(r.t),Y(r[k])):cctx2.moveTo(X(r.t),Y(r[k]))); cctx2.stroke();
  });
}

// ---------- 動画の同時保存 ----------
function pickMime(){
  const c=['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  if(!window.MediaRecorder) return null;
  for(const m of c){ try{ if(MediaRecorder.isTypeSupported(m)) return m; }catch(e){} }
  return '';
}
const rtOff=()=>$('rtMode').value==='off';
function applyRt(){
  const off=rtOff();
  const vm=$('vidMode');
  [...vm.options].forEach(o=>{ o.disabled=off&&(o.value==='both'||o.value==='overlay'||o.value==='off'); });
  if(off) vm.value='raw'; else if(vm.value==='raw'&&vm.dataset.prev) vm.value=vm.dataset.prev;
  if(!off) vm.dataset.prev='';
  if(off){ $('vY').textContent='–'; $('vX').textContent='–'; $('vHip').textContent='–'; $('vKnee').textContent='–'; trail=[]; }
}
$('rtMode').onchange=()=>{ if(recording){ $('rtMode').value=rtOff()?'on':'off'; status('記録中は切り替えられません。'); return; } if(rtOff()) $('vidMode').dataset.prev=$('vidMode').value; applyRt(); };
function startOne(kind,src,mime){
  let rec;
  try{ rec=new MediaRecorder(src,mime?{mimeType:mime,videoBitsPerSecond:8e6}:undefined); }catch(e){ return null; }
  const type=rec.mimeType||mime||'video/webm';
  const r={kind,rec,chunks:[],blob:null,ext:type.includes('mp4')?'mp4':'webm',type:type.split(';')[0]};
  rec.ondataavailable=e=>{ if(e.data&&e.data.size) r.chunks.push(e.data); };
  rec.start(1000);
  return r;
}
function startVideo(){
  recs=[];
  const mode=$('vidMode').value; if(mode==='off'||!stream) return;
  const mime=pickMime(); if(mime===null){ $('recTxt').textContent='この端末は動画保存に未対応'; return; }
  if(mode==='raw'||mode==='both'){ const r=startOne('raw',stream,mime); if(r) recs.push(r); }
  if((mode==='overlay'||mode==='both')&&view.captureStream){ const r=startOne('overlay',view.captureStream(30),mime); if(r) recs.push(r); }
  $('recTxt').textContent=recs.length?'● 動画録画中（'+recs.map(r=>r.kind==='raw'?'元の映像':'骨格つき').join('・')+'）':'動画保存を開始できません';
}
function stopVideo(){
  return Promise.all(recs.map(r=>new Promise(res=>{
    const fin=()=>{ r.blob=new Blob(r.chunks,{type:r.type}); r.chunks=[]; res(); };
    if(r.rec.state==='inactive'){ fin(); return; }
    r.rec.onstop=fin; r.rec.stop();
  }))).then(()=>{
    const ok=recs.filter(r=>r.blob&&r.blob.size);
    $('recTxt').textContent=ok.length?ok.map(r=>`${r.kind==='raw'?'元の映像':'骨格つき'} ${(r.blob.size/1e6).toFixed(1)} MB`).join('　'):'';
  });
}

// ---------- カメラ ----------
// ---------- カメラの選択 ----------
const BAD_CAM=/scanner|mouse|virtual|obs|snap|manycam|droidcam/i;
let camList=[], camIdx=-1, wakeLock=null;
async function listCams(){
  try{ camList=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput'); }catch(e){ camList=[]; }
  const sel=$('camSel'); sel.innerHTML='';
  camList.forEach((d,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=(BAD_CAM.test(d.label)?'⚠ ':'')+(d.label||('カメラ'+(i+1))); sel.append(o); });
  if(camIdx>=0) sel.value=camIdx;
  $('camPick').hidden=camList.length<2;
}
async function openStream(){
  const base={width:{ideal:1280},height:{ideal:720},frameRate:{ideal:60}};
  const v=camIdx>=0&&camList[camIdx]?{...base,deviceId:{exact:camList[camIdx].deviceId}}:{...base,facingMode:$('facing').value};
  return navigator.mediaDevices.getUserMedia({audio:false,video:v});
}
async function keepAwake(on){
  try{
    if(on&&'wakeLock' in navigator&&!wakeLock){ wakeLock=await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release',()=>wakeLock=null); }
    if(!on&&wakeLock){ await wakeLock.release(); wakeLock=null; }
  }catch(e){}
}
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&stream) keepAwake(true); });
async function switchCam(i){
  camIdx=i; if(!stream) return;
  if(recording){ status('記録中はカメラを切り替えられません。'); return; }
  stream.getTracks().forEach(t=>t.stop()); stream=null; running=false;
  await toggleCam();
}

async function toggleCam(){
  if(stream){ if(recording) $('recBtn').click(); stream.getTracks().forEach(t=>t.stop()); stream=null; running=false; keepAwake(false); $('camBtn').textContent='カメラ開始'; $('recBtn').disabled=true; return; }
  if(!window.isSecureContext||!navigator.mediaDevices){ status('カメラは https のページでしか使えません。公開したURL（https://〜）から開いてください。'); return; }
  try{
    stream=await openStream();
  }catch(e){
    status(e.name==='NotAllowedError'?'カメラの使用が許可されていません。ブラウザやスマホの設定でカメラを許可してください。':'カメラを開けません：'+e.message); return;
  }
  await listCams();
  const label=stream.getVideoTracks()[0].label;
  if(camIdx<0){
    camIdx=camList.findIndex(d=>d.label===label);
    if(BAD_CAM.test(label)){ const good=camList.findIndex(d=>!BAD_CAM.test(d.label)); if(good>=0){ stream.getTracks().forEach(t=>t.stop()); camIdx=good; stream=await openStream(); } }
    $('camSel').value=camIdx;
  }
  keepAwake(true);
  video.srcObject=stream; await video.play();
  view.width=video.videoWidth; view.height=video.videoHeight;
  running=true; $('camBtn').textContent='カメラ停止'; $('recBtn').disabled=false;
  const fr=stream.getVideoTracks()[0].getSettings().frameRate;
  status('カメラ動作中'+(fr?`（${Math.round(fr)}fps）`:''));
  const loop=()=>{
    if(!running) return;
    const n=performance.now();
    if(rtOff()) ctx.drawImage(video,0,0,view.width,view.height); else processFrame(n,(n-recStart)/1000);
    frames++; if(n-fpsT>1000){$('fpsTxt').textContent=`${rtOff()?'表示':'処理'} ${frames} fps`;frames=0;fpsT=n;}
    if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
  };
  loop();
}
$('camBtn').onclick=()=>{ if(landmarker) toggleCam(); };
$('camSel').onchange=e=>switchCam(+e.target.value);
$('camNext').onclick=()=>{ if(camList.length) { const i=(camIdx+1)%camList.length; $('camSel').value=i; switchCam(i); } };

// ---------- 診断情報 ----------
let lastPose=false;
async function diag(){
  const rows=[];
  const ok=(k,v,good)=>rows.push(`<li class="${good?'g':'b'}"><span>${k}</span><b>${v}</b></li>`);
  ok('https',window.isSecureContext?'OK':'NG（カメラ不可）',window.isSecureContext);
  let perm='不明';
  try{ perm=(await navigator.permissions.query({name:'camera'})).state; }catch(e){}
  ok('カメラ権限',{granted:'許可',denied:'拒否',prompt:'未確認',不明:'不明'}[perm]||perm,perm!=='denied');
  ok('カメラ台数',camList.length?camList.length+'台':'—',camList.length>0||!stream);
  const tr=stream&&stream.getVideoTracks()[0];
  ok('使用中のカメラ',tr?tr.label||'（名前なし）':'停止中',!!tr&&!BAD_CAM.test(tr.label));
  ok('解像度',video.videoWidth?video.videoWidth+'×'+video.videoHeight:'—',!stream||video.videoWidth>0);
  ok('解析エンジン',mpState,mpState==='準備完了');
  ok('骨格の検出',stream?(lastPose?'できている':'できていない'):'—',!stream||lastPose);
  $('diagList').innerHTML=rows.join('');
}
setInterval(()=>{ if($('diag').open) diag(); },1000);
$('diag').addEventListener('toggle',diag);

// ---------- インストール案内 ----------
let installEv=null;
const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); installEv=e; if(!standalone){ $('installBox').hidden=false; $('installBtn').hidden=false; } });
$('installBtn').onclick=async()=>{ if(!installEv) return; installEv.prompt(); await installEv.userChoice; installEv=null; $('installBox').hidden=true; };
if(!standalone && /iP(hone|ad|od)/.test(navigator.userAgent)){ $('installBox').hidden=false; $('iosHelp').hidden=false; }

// ---------- 記録 ----------
function resetRec(){ sync=null; rows=[]; origin=null; lockedSide=null; trail=[]; scale=null; calLegs=[]; result=null; recs=[]; $('scaleTxt').textContent=''; $('recTxt').textContent=''; $('vY').textContent='–'; $('vX').textContent='–'; }
$('recBtn').onclick=()=>{
  if(!recording){ resetRec(); startVideo(); recStart=performance.now(); recording=true; $('recBtn').textContent='記録停止'; $('recBtn').classList.add('on'); $('csvBtn').disabled=true; $('who').querySelector('button').disabled=true; }
  else{ recording=false; $('recBtn').textContent='記録開始'; $('recBtn').classList.remove('on'); $('who').querySelector('button').disabled=false; stopVideo().then(finish); }
};
function finish(){
  const data=rows.filter(r=>r.dy!==null);
  $('csvBtn').disabled=!data.length&&!recs.some(r=>r.blob&&r.blob.size)&&!sync; // 数値が取れなくても動画だけは保存できる
  const raw=recs.find(r=>r.kind==='raw'&&r.blob&&r.blob.size);
  $('anaNowBtn').hidden=!raw;
  if($('mode').value!=='file'&&rtOff()){ $('summary').textContent=raw?'撮影だけ行いました。「CSV・動画を保存」で元の映像を保存できます。「この動画を解析」で、撮った動画の全コマを解析します。':'動画を保存できませんでした。'; return; }
  if(!data.length){ $('summary').textContent='スケールを決められませんでした。最初に全身が映った状態で静止立位をとってから記録してください。'; return; }
  let mx=data[0],fmin=Infinity,fmax=-Infinity;
  data.forEach(r=>{ if(r.dy>mx.dy)mx=r; fmin=Math.min(fmin,r.dx); fmax=Math.max(fmax,r.dx); });
  const after=data.filter(r=>r.t>mx.t); let low=after[0]; after.forEach(r=>{if(r.dy<low.dy)low=r;});
  const dur=data[data.length-1].t-data[0].t;
  const ext=k=>{let mx=data[0],mn=data[0];data.forEach(r=>{if(r[k]>mx[k])mx=r;if(r[k]<mn[k])mn=r;});return {flex:mx,ext:mn};};
  const H=ext('hip'), K=ext('knee');
  const both=data[0].side==='B';
  result={peak:mx,low,H,K,both};
  if(both){ result.HL=ext('hipL'); result.HR=ext('hipR'); result.KL=ext('kneeL'); result.KR=ext('kneeR'); }
  const fm=(r,k)=>`${r[k].toFixed(1)}°（${r.t.toFixed(2)}秒）`;
  $('summary').textContent=
`フレーム数 ${data.length}（${dur.toFixed(2)}秒、平均 ${(data.length/Math.max(dur,1e-6)).toFixed(0)}fps）
最高点 ${mx.dy.toFixed(1)} cm（${mx.t.toFixed(2)}秒）
着地後の最下点 ${low?low.dy.toFixed(1)+' cm（'+low.t.toFixed(2)+'秒、そのときの前後 '+low.dx.toFixed(1)+' cm）':'—'}
前後の移動範囲 ${fmin.toFixed(1)} 〜 ${fmax.toFixed(1)} cm

股関節屈曲　最大屈曲 ${fm(H.flex,'hip')}　最大伸展 ${fm(H.ext,'hip')}
膝関節屈曲　最大屈曲 ${fm(K.flex,'knee')}　最大伸展 ${fm(K.ext,'knee')}

計測側 ${both?'両側':data[0].side==='L'?'左':'右'}　換算 ${scale.toFixed(4)} cm/px`
  +(both?`\n\n左右別の最大屈曲（上の股・膝は左右の平均）
左　股 ${fm(result.HL.flex,'hipL')}　膝 ${fm(result.KL.flex,'kneeL')}
右　股 ${fm(result.HR.flex,'hipR')}　膝 ${fm(result.KR.flex,'kneeR')}
見えやすさ（0〜1）　左 ${(data.reduce((s,r)=>s+r.visL,0)/data.length).toFixed(2)}　右 ${(data.reduce((s,r)=>s+r.visR,0)/data.length).toFixed(2)}`:'');
  drawChart(); drawChart2();
}

// ---------- CSV ----------
$('csvBtn').onclick=()=>{
  const names=['nose','l_eye_in','l_eye','l_eye_out','r_eye_in','r_eye','r_eye_out','l_ear','r_ear','mouth_l','mouth_r','l_shoulder','r_shoulder','l_elbow','r_elbow','l_wrist','r_wrist','l_pinky','r_pinky','l_index','r_index','l_thumb','r_thumb','l_hip','r_hip','l_knee','r_knee','l_ankle','r_ankle','l_heel','r_heel','l_foot','r_foot'];
  const head=['time_s','side','com_up_cm','com_fwd_cm','hip_flex_deg','knee_flex_deg','com_x_px','com_y_px','leg_px',...names.flatMap(n=>[n+'_x',n+'_y',n+'_vis']),'frame','hip_flex_l_deg','knee_flex_l_deg','hip_flex_r_deg','knee_flex_r_deg'];
  const q=s=>'"'+String(s).replace(/"/g,'""')+'"';
  const d=new Date(), pad=n=>String(n).padStart(2,'0');
  const base=`com_${subj.id?subj.id.replace(/[^\w-]/g,'_')+'_':''}${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const vids=recs.filter(r=>r.blob&&r.blob.size).map(r=>({name:`${base}_${r.kind==='raw'?'raw':'skeleton'}.${r.ext}`,blob:r.blob,kind:r.kind}));
  const vname=vids.map(v=>v.name).join(' / ')||($('mode').value==='file'&&$('fileIn').files[0]?$('fileIn').files[0].name:'');
  const syncFile=sync?{name:`${base}_sync.csv`,blob:new Blob(['\ufeff'+syncCSV(vname).join('\n')],{type:'text/csv'})}:null;
  if(!result){ const l=vids.map(v=>({name:v.name,blob:v.blob})); if(syncFile) l.unshift(syncFile); if(l.length) saveFiles(l); return; }
  const R=result, s=(r,k)=>`${r[k].toFixed(2)},${r.t.toFixed(4)}`;
  // 書き出す座標の原点（解析は画像の左上を原点にしたまま行い、書き出すときだけ変換する）
  const og=$('orgSel').value, IW=view.width, IH=view.height;
  const tx=x=>og==='br'?IW-x:x, ty=y=>og==='tl'?y:IH-y;
  const ogName={br:'bottom_right',bl:'bottom_left',tl:'top_left'}[og];
  const lines=[`# id,${q(subj.id)}`,`# age,${subj.age}`,`# sex,${subj.sex}`,`# leg_length_cm,${subj.leg}`,`# scale_cm_per_px,${scale}`,`# coord_origin,${ogName},x_positive,${og==='br'?'left':'right'},y_positive,${og==='tl'?'down':'up'}`,`# image_size_px,${IW},${IH}`,`# origin_px,${tx(origin.x).toFixed(2)},${ty(origin.y).toFixed(2)}`,
    `# video_file,${vname}`,`# source,${$('mode').value==='file'?'file':'camera'}`,`# fps_video,${$('mode').value==='file'?$('fps').value:''}`,`# fps_capture,${$('mode').value==='file'?$('capFps').value:''}`,
    `# app_version,${PC.VERSION}`,`# analysis_range_frames,${$('mode').value==='file'&&anaRange?anaRange.a+','+anaRange.b:''}`,
    ...syncHead(),
    `# summary,value,time_s`,
    `# com_up_max_cm,${s(R.peak,'dy')}`,
    `# hip_flex_max_deg,${s(R.H.flex,'hip')}`,`# hip_ext_max_deg,${s(R.H.ext,'hip')}`,
    `# knee_flex_max_deg,${s(R.K.flex,'knee')}`,`# knee_ext_max_deg,${s(R.K.ext,'knee')}`,
    ...(R.both?[`# hip_flex_l_max_deg,${s(R.HL.flex,'hipL')}`,`# knee_flex_l_max_deg,${s(R.KL.flex,'kneeL')}`,`# hip_flex_r_max_deg,${s(R.HR.flex,'hipR')}`,`# knee_flex_r_max_deg,${s(R.KR.flex,'kneeR')}`]:[]),
    head.join(',')];
  rows.filter(r=>r.dy!==null).forEach(r=>lines.push([r.t.toFixed(4),r.side,r.dy.toFixed(3),r.dx.toFixed(3),r.hip.toFixed(2),r.knee.toFixed(2),tx(r.cx).toFixed(2),ty(r.cy).toFixed(2),r.legPx.toFixed(2),...r.lm.flatMap(p=>[tx(p[0]).toFixed(2),ty(p[1]).toFixed(2),p[2].toFixed(3)]),r.frame??'',...['hipL','kneeL','hipR','kneeR'].map(k=>r[k]==null?'':r[k].toFixed(2))].join(',')));
  const files=[{name:`${base}.csv`,blob:new Blob(['\ufeff'+lines.join('\n')],{type:'text/csv'})}];
  if(syncFile) files.push(syncFile);
  vids.forEach(v=>files.push({name:v.name,blob:v.blob}));
  saveFiles(files);
};
const isIOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function blobToB64Chunks(blob,size=3*1024*1024){ // 3の倍数で区切るとBase64をそのまま連結できる
  const out=[]; for(let i=0;i<blob.size;i+=size) out.push(blob.slice(i,i+size));
  return out.map(part=>()=>new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result).split(',')[1]||'');fr.onerror=rej;fr.readAsDataURL(part);}));
}
async function writeNative(FS,f,target){
  if(f.blob.type.startsWith('text/')){
    await FS.writeFile({...target,data:await f.blob.text(),encoding:'utf8',recursive:true});
  }else{
    const parts=blobToB64Chunks(f.blob);
    for(let i=0;i<parts.length;i++){
      const data=await parts[i]();
      if(i===0) await FS.writeFile({...target,data,recursive:true}); else await FS.appendFile({...target,data});
    }
  }
}
async function saveNative(list){
  const FS=CAP.Plugins.Filesystem;
  try{ await FS.requestPermissions(); }catch(e){}
  // Android 11以降は、アプリが作るファイルなら共有の Download フォルダに直接書ける
  let dl=null;
  try{ const u=(await FS.getUri({directory:'DOCUMENTS',path:''})).uri; dl=u.replace(/\/?$/,'').replace(/Documents$/,'Download'); }catch(e){}
  const done=[];
  for(const f of list){
    status(`${f.name} を保存中…`);
    try{ if(!dl) throw 0; await writeNative(FS,f,{path:dl+'/'+f.name}); done.push('ダウンロード/'+f.name); }
    catch(e){
      try{ await writeNative(FS,f,{path:f.name,directory:'DOCUMENTS'}); done.push('Documents/'+f.name); }
      catch(e2){ status('保存できませんでした：'+(e2.message||e2)); return; }
    }
  }
  status(done.join('、')+' に保存しました。');
}
async function saveFiles(list){
  if(isNative&&CAP.Plugins&&CAP.Plugins.Filesystem) return saveNative(list);
  if(isIOS){
    const fs=list.map(f=>new File([f.blob],f.name,{type:f.blob.type}));
    if(navigator.canShare&&navigator.canShare({files:fs})){
      status('共有メニューで「ファイルに保存」→「ダウンロード」を選んでください。');
      try{ await navigator.share({files:fs}); status(list.map(f=>f.name).join('、')+' を保存しました。'); return; }
      catch(e){ if(e.name==='AbortError') return; }
    }
  }
  for(const f of list){
    const a=document.createElement('a'); a.href=URL.createObjectURL(f.blob); a.download=f.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),60000);
    await new Promise(r=>setTimeout(r,400));
  }
  status(list.map(f=>f.name).join('、')+' をダウンロードフォルダに保存しました。');
}

// ---------- 動画ファイル（全コマ解析） ----------
$('mode').onchange=()=>{
  const f=$('mode').value==='file';
  $('camRow').style.display=f?'none':'flex'; $('fileBox').style.display=f?'block':'none';
  $('recBtn').style.display=f?'none':''; $('vidRow').style.display=f?'none':'flex'; $('anaNowBtn').hidden=true;
  if(f){ $('camPick').hidden=true; if(stream) toggleCam(); }
};
// 動画を少し再生して、コマの間隔から動画のfpsを推定する
const STD_FPS=[24,25,30,48,50,60,90,100,120,240,480];
function detectFps(){
  return new Promise(res=>{
    if(!video.requestVideoFrameCallback){ res(null); return; }
    const ts=[]; let done=false;
    const end=()=>{ if(done) return; done=true; video.pause();
      const d=[]; for(let i=1;i<ts.length;i++){ const x=ts[i]-ts[i-1]; if(x>1e-5) d.push(x); }
      if(d.length<5){ res(null); return; }
      d.sort((a,b)=>a-b); const f=1/d[Math.floor(d.length*0.2)]; // 取りこぼしで間隔が広がる分を避けて短い側を使う
      const near=STD_FPS.find(s=>Math.abs(s-f)/s<0.04); res(near||Math.round(f));
    };
    const cb=(now,md)=>{ ts.push(md.mediaTime); if(ts.length>=40||video.ended) end(); else video.requestVideoFrameCallback(cb); };
    video.muted=true; video.playbackRate=1; video.requestVideoFrameCallback(cb);
    video.play().catch(end); setTimeout(end,4000);
  });
}
async function loadVideo(src,label){
  if(stream) toggleCam();
  video.srcObject=null; video.src=URL.createObjectURL(src); video.muted=true; video.playsInline=true;
  await new Promise(r=>{ video.onloadeddata=r; video.load(); });
  view.width=video.videoWidth; view.height=video.videoHeight;
  status('動画のfpsを調べています…');
  const f=await detectFps();
  await seek(0); showFrame();
  setupScrub(f||+$('fps').value||30);
  if(f){ $('fps').value=f; $('capFps').value=f; }
  $('anaBtn').disabled=!landmarker; $('roiBtn').disabled=false;
  status(`${label||'動画'}を読み込みました（${video.duration.toFixed(1)}秒${f?`、${f} fps`:''}）。`+(f?'':'動画のfpsを入れてください。')+'スロー撮影なら撮影時のfpsを確認して、解析開始を押してください。');
  return f;
}
$('fileIn').onchange=async e=>{ const file=e.target.files[0]; if(file){ recs=[]; await loadVideo(file); } };
// 撮影だけモードで撮った動画を、そのまま全コマ解析に回す
$('anaNowBtn').onclick=async()=>{
  const raw=recs.find(r=>r.kind==='raw'&&r.blob&&r.blob.size); if(!raw) return;
  const keep=recs; setMode('file'); recs=keep;
  await loadVideo(raw.blob,'撮った動画');
  if(landmarker) $('anaBtn').click();
};
const seek=t=>new Promise(r=>{ let ok=false; const h=()=>{ if(ok) return; ok=true; video.onseeked=null; r(); }; video.onseeked=h; video.currentTime=t; setTimeout(h,3000); });
let analyzing=false, rng={a:null,b:null}, anaRange=null, frameDraw={}, rendering=false;
$('anaBtn').onclick=async()=>{
  if(analyzing){ analyzing=false; return; }
  const vf=+$('fps').value, cf=+$('capFps').value||vf;
  if(!(vf>0)){ status('動画のfpsを入れてください。'); return; }
  video.pause();
  analyzing=true; $('anaBtn').textContent='中止'; $('fileIn').disabled=true; const keepRecs=recs; resetRec(); recs=keepRecs; recording=true;
  const N=Math.floor(video.duration*vf+1e-6), base=lastTs+1000, t0=performance.now();
  const ka=Math.max(0,Math.min(N-1,rng.a??0)), kb=Math.max(ka,Math.min(N-1,rng.b??N-1)), n=kb-ka+1; // 解析する区間（コマ番号）
  anaRange={a:ka,b:kb,all:ka===0&&kb===N-1};
  const syncRows=($('syncOn').checked&&roi)?[]:null; frameDraw={};
  for(let k=ka,i=0;k<=kb && analyzing;k++,i++){
    const tv=Math.min((k+0.5)/vf, video.duration-1e-3); // コマの真ん中に移動して、確実にそのコマを表示させる
    const tr=k/cf;                                      // 実際の時間（スロー撮影なら撮影時のfpsで換算）
    await seek(tv); curFrame=k;
    if(syncRows) syncRows.push({k,tv:k/vf,tr,lum:roiLum()});
    processFrame(base+tr*1000,tr); if(syncRows) drawROI();
    if(k%5===0){
      const el=(performance.now()-t0)/1000, rest=el/(i+1)*(n-i-1);
      status(`解析中 ${i+1}/${n}コマ（${Math.round((i+1)/n*100)}%、残り約${Math.ceil(rest)}秒）`);
    }
  }
  const stopped=!analyzing;
  recording=false; curFrame=null;
  if(!stopped&&$('ovOn').checked&&Object.keys(frameDraw).length) await renderOverlay(ka,kb,vf);
  analyzing=false; $('anaBtn').textContent='解析開始'; $('fileIn').disabled=false;
  sync=syncRows&&syncRows.length?detectSync(syncRows,vf,cf):null;
  status(stopped?'解析を中止しました。':`解析が終わりました（${n}コマ、${cf} fps換算）。CSVを保存できます。`); finish();
  if(result) $('summary').textContent=`入力：動画ファイル（動画 ${vf} fps／撮影 ${cf} fps）`+(anaRange.all?'':`　解析区間 ${ka}〜${kb}コマ（${(ka/cf).toFixed(2)}〜${(kb/cf).toFixed(2)}秒）`)+`\n`+$('summary').textContent;
  if(sync) $('summary').textContent=syncText()+'\n'+$('summary').textContent;
  if(sync&&!result) $('csvBtn').disabled=false;
};
// ---------- 解析した動画から骨格つき動画を作る ----------
// 解析はコマ送りで行うので、そのままでは録画できない。解析後に動画を等速で再生し、取っておいた骨格を重ねて録画する
async function renderOverlay(ka,kb,vf){
  const mime=pickMime();
  if(mime===null||!view.captureStream||!window.MediaRecorder){ status('この端末は骨格つき動画の作成に未対応です。'); return; }
  const W=view.width,H=view.height, tEnd=Math.min((kb+1)/vf,video.duration), len=Math.max(0.1,tEnd-ka/vf);
  let last=-1; trail=[];
  const drawAt=t=>{
    const k=Math.max(ka,Math.min(kb,Math.floor(t*vf+1e-6)));
    ctx.drawImage(video,0,0,W,H);
    const c=frameDraw[k];
    if(c){ if(k!==last){ trail.push({x:c.x,y:c.y}); if(trail.length>90) trail.shift(); last=k; } drawBody(c,W); }
    drawROI();
  };
  await seek(Math.min((ka+0.5)/vf,video.duration-1e-3)); rendering=true; drawAt(ka/vf);
  const r=startOne('overlay',view.captureStream(30),mime);
  if(!r){ rendering=false; status('骨格つき動画を作成できませんでした。'); return; }
  await new Promise(res=>{
    let done=false; const end=()=>{ if(done) return; done=true; video.onended=null; res(); };
    const step=(now,md)=>{
      if(done) return; if(!analyzing){ end(); return; }
      const t=md?md.mediaTime:video.currentTime; drawAt(t);
      status(`骨格つき動画を作成中 ${Math.min(100,Math.round((t-ka/vf)/len*100))}%`);
      if(video.ended||t>=tEnd-0.5/vf){ end(); return; }
      next();
    };
    const next=()=>video.requestVideoFrameCallback?video.requestVideoFrameCallback(step):requestAnimationFrame(()=>step());
    video.onended=end; video.muted=true; video.playbackRate=1; next();
    video.play().catch(end); setTimeout(end,(len+10)*1000);
  });
  video.pause(); await new Promise(r=>setTimeout(r,300)); // 最後のコマが録画に入るのを待つ
  await new Promise(res=>{ const fin=()=>{ r.blob=new Blob(r.chunks,{type:r.type}); r.chunks=[]; res(); }; if(r.rec.state==='inactive') fin(); else{ r.rec.onstop=fin; r.rec.stop(); } });
  rendering=false;
  if(r.blob.size){ recs=recs.filter(x=>x.kind!=='overlay'); recs.push(r); }
  const ok=recs.filter(x=>x.blob&&x.blob.size);
  $('recTxt').textContent=ok.map(x=>`${x.kind==='raw'?'元の映像':'骨格つき'} ${(x.blob.size/1e6).toFixed(1)} MB`).join('　');
}
try{ const o=localStorage.getItem('com_ov'); if(o) $('ovOn').checked=o==='1'; }catch(e){}
$('ovOn').onchange=()=>{ try{localStorage.setItem('com_ov',$('ovOn').checked?'1':'0');}catch(e){} };

// ---------- 同期ライトの検出 ----------
// roi は動画の画素で持ち、保存は 0〜1 の割合で持つ（解像度が違う動画でも同じ場所になる）
let roi=null, roiN=null, selecting=false, dragStart=null;
try{ roiN=JSON.parse(localStorage.getItem('com_roi')||'null'); }catch(e){}
try{ $('syncOn').checked=localStorage.getItem('com_sync')==='1'; }catch(e){}
function syncUi(){ const on=$('syncOn').checked; $('syncHint').hidden=!on; $('roiBtn').hidden=!on; $('roiTxt').hidden=!on; }
$('syncOn').onchange=()=>{ try{localStorage.setItem('com_sync',$('syncOn').checked?'1':'0');}catch(e){} syncUi(); showFrame(); };
function roiFromN(){ if(!roiN||!view.width){ roi=null; return; } roi={x:roiN.x*view.width,y:roiN.y*view.height,w:roiN.w*view.width,h:roiN.h*view.height}; }
function roiInfo(){ $('roiTxt').textContent=roi?`範囲 ${Math.round(roi.w)}×${Math.round(roi.h)} px　明るさ ${roiLum().toFixed(0)}`:'範囲が未指定です'; }
function drawROI(r){ r=r||roi; if(!r||!$('syncOn').checked) return; ctx.save(); ctx.lineWidth=Math.max(2,view.width/320); ctx.strokeStyle='#ffd400'; ctx.setLineDash([8,6]); ctx.strokeRect(r.x,r.y,r.w,r.h); ctx.restore(); }
function showFrame(r){ if(!video.videoWidth) return; ctx.drawImage(video,0,0,view.width,view.height); roiFromN(); drawROI(r); if($('syncOn').checked) roiInfo(); }
const oc=document.createElement('canvas'), octx=oc.getContext('2d',{willReadFrequently:true});
function roiLum(){
  if(!roi||!video.videoWidth) return NaN;
  const sx=video.videoWidth/view.width, sy=video.videoHeight/view.height;
  const w=Math.max(1,Math.min(64,Math.round(roi.w))), h=Math.max(1,Math.min(64,Math.round(roi.h)));
  oc.width=w; oc.height=h; octx.drawImage(video,roi.x*sx,roi.y*sy,roi.w*sx,roi.h*sy,0,0,w,h);
  const d=octx.getImageData(0,0,w,h).data; let s=0;
  for(let i=0;i<d.length;i+=4) s+=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
  return s/(d.length/4);
}
// 画面上の位置 → 動画の画素（object-fit:contain の余白も考える）
function toPx(e){
  const b=view.getBoundingClientRect(), k=Math.min(b.width/view.width,b.height/view.height);
  const ox=(b.width-view.width*k)/2, oy=(b.height-view.height*k)/2;
  return {x:Math.max(0,Math.min(view.width,(e.clientX-b.left-ox)/k)),y:Math.max(0,Math.min(view.height,(e.clientY-b.top-oy)/k))};
}
$('roiBtn').onclick=()=>{
  if(analyzing) return;
  selecting=!selecting; view.style.touchAction=selecting?'none':''; view.style.cursor=selecting?'crosshair':'';
  $('roiBtn').textContent=selecting?'囲み終わったら押す':'光る範囲を指定';
  status(selecting?'映像の上をなぞって、ライトの場所を四角で囲んでください。':'範囲を決めました。');
  if(selecting) view.scrollIntoView({block:'center'});
};
view.addEventListener('pointerdown',e=>{ if(!selecting) return; e.preventDefault(); view.setPointerCapture(e.pointerId); dragStart=toPx(e); });
view.addEventListener('pointermove',e=>{ if(!selecting||!dragStart) return; const p=toPx(e); showFrame({x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),w:Math.abs(p.x-dragStart.x),h:Math.abs(p.y-dragStart.y)}); });
view.addEventListener('pointerup',e=>{
  if(!selecting||!dragStart) return; const p=toPx(e), s=dragStart; dragStart=null;
  const r={x:Math.min(p.x,s.x),y:Math.min(p.y,s.y),w:Math.abs(p.x-s.x),h:Math.abs(p.y-s.y)};
  if(r.w<3||r.h<3){ status('範囲が小さすぎます。もう一度なぞってください。'); showFrame(); return; }
  roiN={x:r.x/view.width,y:r.y/view.height,w:r.w/view.width,h:r.h/view.height};
  try{localStorage.setItem('com_roi',JSON.stringify(roiN));}catch(e){}
  showFrame(); $('roiBtn').click();
});
let scrubFps=30;
function rngShow(){
  const n=+$('scrub').max, a=rng.a??0, b=rng.b??n, cf=+$('capFps').value||scrubFps;
  $('rngTxt').textContent=(rng.a==null&&rng.b==null)?`解析区間：全体（0〜${n}コマ）`:`解析区間：${a}〜${b}コマ（${(a/cf).toFixed(2)}〜${(b/cf).toFixed(2)}秒、${b-a+1}コマ）`;
}
function setupScrub(f){ scrubFps=f; rng={a:null,b:null}; const n=Math.max(0,Math.floor(video.duration*f+1e-6)-1); $('scrub').max=n; $('scrub').value=0; $('scrubTxt').textContent=`0 / ${n}コマ`; $('rangeBox').hidden=false; rngShow(); syncUi(); }
async function scrubTo(k){ await seek(Math.min((k+0.5)/scrubFps,video.duration-1e-3)); showFrame(); $('scrubTxt').textContent=`${k} / ${$('scrub').max}コマ`; }
$('scrub').oninput=()=>{ if(!analyzing) scrubTo(+$('scrub').value); };
$('rngA').onclick=()=>{ if(analyzing) return; rng.a=+$('scrub').value; if(rng.b!=null&&rng.b<rng.a) rng.b=null; rngShow(); };
$('rngB').onclick=()=>{ if(analyzing) return; rng.b=+$('scrub').value; if(rng.a!=null&&rng.a>rng.b) rng.a=null; rngShow(); };
$('rngAll').onclick=()=>{ if(analyzing) return; rng={a:null,b:null}; rngShow(); };
// 動画のfpsを手で直したら、コマ番号が変わるので区間を決め直す
$('fps').onchange=()=>{ const f=+$('fps').value; if(f>0&&video.duration&&$('mode').value==='file'&&!analyzing){ setupScrub(f); scrubTo(0); } };
$('capFps').onchange=()=>{ if(video.duration) rngShow(); };
$('ver').textContent=PC.VERSION;
try{ const o=localStorage.getItem('com_org'); if(o) $('orgSel').value=o; }catch(e){}
$('orgSel').onchange=()=>{ try{localStorage.setItem('com_org',$('orgSel').value);}catch(e){} };
$('sideSel').addEventListener('change',()=>{ $('sideHint').hidden=$('sideSel').value!=='B'; });
// 明るさが「暗いとき」と「最も明るいとき」の中間を超えたコマを、点灯したコマとする
function detectSync(rs,vf,cf){
  const v=rs.map(r=>r.lum).filter(Number.isFinite).sort((a,b)=>a-b); if(!v.length) return null;
  const lo=v[Math.floor(v.length*0.05)], hi=v[v.length-1], range=hi-lo;
  const res={rows:rs,vf,cf,lo,hi,thr:null,events:[],roi:{...roi}};
  if(range<15) return res; // ほとんど明るさが変わっていない
  const on=lo+range*0.5, off=lo+range*0.3; res.thr=on; let st=false;
  rs.forEach((r,i)=>{
    if(!st&&r.lum>=on){ st=true; res.events.push({k:r.k,tv:r.tv,tr:r.tr,lum:r.lum,atStart:i===0}); }
    else if(st&&r.lum<off) st=false;
    r.on=st?1:0;
  });
  return res;
}
function syncText(){
  if(!sync.events.length) return '同期ライト：明るさの変化が見つかりませんでした（範囲の位置を確認してください）';
  const e=sync.events[0];
  return `同期ライト：${e.k}コマ目（${e.tr.toFixed(4)}秒）で点灯`+(e.atStart?'（最初から点灯）':'')+(sync.events.length>1?`、ほか${sync.events.length-1}回`:'');
}
function syncHead(){
  if(!sync) return [];
  const r=sync.roi, L=[`# sync_roi_px_topleft,${r.x.toFixed(0)},${r.y.toFixed(0)},${r.w.toFixed(0)},${r.h.toFixed(0)}`,`# sync_threshold_lum,${sync.thr==null?'':sync.thr.toFixed(1)}`,`# sync_events,${sync.events.length}`];
  if(sync.events[0]) L.push(`# sync_first_frame,${sync.events[0].k}`,`# sync_first_time_s,${sync.events[0].tr.toFixed(4)}`,`# sync_first_video_time_s,${sync.events[0].tv.toFixed(4)}`);
  sync.events.forEach((e,i)=>L.push(`# sync_on_${i+1},frame,${e.k},time_s,${e.tr.toFixed(4)},video_time_s,${e.tv.toFixed(4)}${e.atStart?',on_at_start':''}`));
  return L;
}
function syncCSV(vname){
  const L=[`# video_file,${vname||$('fileIn').files[0]?.name||''}`,`# fps_video,${sync.vf}`,`# fps_capture,${sync.cf}`,...syncHead(),
    '# frame: 0から数えたコマ番号 / video_time_s: 動画ファイル上の時間 / time_s: 実際の時間（スロー撮影は撮影時のfpsで換算）',
    'frame,video_time_s,time_s,roi_lum,light_on'];
  sync.rows.forEach(r=>L.push([r.k,r.tv.toFixed(4),r.tr.toFixed(4),Number.isFinite(r.lum)?r.lum.toFixed(2):'',r.on??''].join(',')));
  return L;
}
syncUi();
window.addEventListener('resize',()=>{drawChart();drawChart2();});
})();
