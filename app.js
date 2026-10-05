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
let recorder=null, vidChunks=[], vidBlob=null, vidExt='', vidName='', result=null;

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
  let n=0; for(const f of PC.FILES){ if(await caches.match(new URL(f,location.href).href,{ignoreSearch:true})) n++; }
  return n;
}
let offTimer=null;
async function checkCache(){
  const n=await cacheCount(), N=PC.FILES.length, pct=Math.round(n/N*100);
  if(n===N){
    offShow('ok','オフライン準備完了（機内モードで使えます）','この端末に全ファイルが保存されています。2回目以降の起動・計測・保存に通信は不要です。',100);
    $('recacheBtn').hidden=true; clearInterval(offTimer); offTimer=null;
    setTimeout(()=>$('offlineBox').classList.add('compact'),4000);
  }else{
    offShow('',`オフライン準備中… ${n}/${N} ファイル（${pct}%）`,
      `初回だけ通信が必要です（約${PC.TOTAL_MB}MB）。完了するまでこの画面を開いたまま、ネットにつないだ状態で待ってください。完了後は通信不要です。`,pct);
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
  $('setup').classList.add('hidden'); $('app').classList.remove('hidden'); $('who').classList.remove('hidden');
  status('カメラを被験者の真横、腰の高さに置いてください。');
};
function backToSetup(){
  if(recording) return;
  if(stream) toggleCam();
  $('app').classList.add('hidden'); $('who').classList.add('hidden'); $('setup').classList.remove('hidden');
}

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
function computeCOM(lm,W,H,side,sex){
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
  const ang=jointAngles(c.J,recording&&rows.length?dir:c.face);
  $('vHip').textContent=ang.hip.toFixed(0); $('vKnee').textContent=ang.knee.toFixed(0);
  drawBody(c,W);
  trail.push({x:c.x,y:c.y}); if(trail.length>90) trail.shift();
  if(!recording) return;
  if(rows.length===0){ dir=c.face; lockedSide=side; }
  const an=jointAngles(c.J,dir);
  rows.push({t:tSec,side,cx:c.x,cy:c.y,legPx:c.legPx,hip:an.hip,knee:an.knee,dx:null,dy:null,lm:lm.map(p=>[p.x*W,p.y*H,p.visibility??0])});
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
  const J=c.J, lw=Math.max(2,W/400);
  ctx.strokeStyle=css('--bone'); ctx.lineWidth=lw; ctx.beginPath();
  [[J.ear,J.sh],[J.sh,J.el],[J.el,J.wr],[J.sh,J.hp],[J.hp,J.kn],[J.kn,J.an],[J.an,J.he],[J.he,J.to]].forEach(([a,b])=>{ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);});
  ctx.stroke();
  ctx.strokeStyle='rgba(255,255,255,.7)'; ctx.beginPath();
  trail.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke();
  ctx.fillStyle=css('--com'); ctx.beginPath(); ctx.arc(c.x,c.y,lw*4,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#fff'; ctx.stroke();
  if(recording&&origin){ ctx.setLineDash([lw*3,lw*3]); ctx.strokeStyle='rgba(255,255,255,.6)';
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
function startVideo(){
  vidBlob=null; vidChunks=[]; recorder=null;
  const mode=$('vidMode').value; if(mode==='off'||!stream) return;
  const mime=pickMime(); if(mime===null){ $('recTxt').textContent='この端末は動画保存に未対応'; return; }
  const src=mode==='overlay'&&view.captureStream?view.captureStream(30):stream;
  try{ recorder=new MediaRecorder(src,mime?{mimeType:mime,videoBitsPerSecond:8e6}:undefined); }
  catch(e){ recorder=null; $('recTxt').textContent='動画保存を開始できません'; return; }
  const type=recorder.mimeType||mime||'video/webm';
  vidExt=type.includes('mp4')?'mp4':'webm';
  recorder.ondataavailable=e=>{ if(e.data&&e.data.size) vidChunks.push(e.data); };
  recorder.onstop=()=>{ vidBlob=new Blob(vidChunks,{type:type.split(';')[0]}); vidChunks=[]; $('recTxt').textContent=`動画 ${(vidBlob.size/1e6).toFixed(1)} MB`; };
  recorder.start(1000);
  $('recTxt').textContent='● 動画録画中';
}
function stopVideo(){ return new Promise(r=>{ if(!recorder||recorder.state==='inactive'){r();return;} const f=recorder.onstop; recorder.onstop=e=>{f(e);r();}; recorder.stop(); }); }

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
    processFrame(n,(n-recStart)/1000);
    frames++; if(n-fpsT>1000){$('fpsTxt').textContent=`処理 ${frames} fps`;frames=0;fpsT=n;}
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
function resetRec(){ rows=[]; origin=null; lockedSide=null; trail=[]; scale=null; calLegs=[]; result=null; vidBlob=null; $('scaleTxt').textContent=''; $('recTxt').textContent=''; $('vY').textContent='–'; $('vX').textContent='–'; }
$('recBtn').onclick=()=>{
  if(!recording){ resetRec(); startVideo(); recStart=performance.now(); recording=true; $('recBtn').textContent='記録停止'; $('recBtn').classList.add('on'); $('csvBtn').disabled=true; $('who').querySelector('button').disabled=true; }
  else{ recording=false; $('recBtn').textContent='記録開始'; $('recBtn').classList.remove('on'); $('who').querySelector('button').disabled=false; stopVideo().then(finish); }
};
function finish(){
  const data=rows.filter(r=>r.dy!==null);
  $('csvBtn').disabled=!data.length;
  if(!data.length){ $('summary').textContent='スケールを決められませんでした。最初に全身が映った状態で静止立位をとってから記録してください。'; return; }
  let mx=data[0],fmin=Infinity,fmax=-Infinity;
  data.forEach(r=>{ if(r.dy>mx.dy)mx=r; fmin=Math.min(fmin,r.dx); fmax=Math.max(fmax,r.dx); });
  const after=data.filter(r=>r.t>mx.t); let low=after[0]; after.forEach(r=>{if(r.dy<low.dy)low=r;});
  const dur=data[data.length-1].t-data[0].t;
  const ext=k=>{let mx=data[0],mn=data[0];data.forEach(r=>{if(r[k]>mx[k])mx=r;if(r[k]<mn[k])mn=r;});return {flex:mx,ext:mn};};
  const H=ext('hip'), K=ext('knee');
  result={peak:mx,low,H,K};
  const fm=(r,k)=>`${r[k].toFixed(1)}°（${r.t.toFixed(2)}秒）`;
  $('summary').textContent=
`フレーム数 ${data.length}（${dur.toFixed(2)}秒、平均 ${(data.length/Math.max(dur,1e-6)).toFixed(0)}fps）
最高点 ${mx.dy.toFixed(1)} cm（${mx.t.toFixed(2)}秒）
着地後の最下点 ${low?low.dy.toFixed(1)+' cm（'+low.t.toFixed(2)+'秒、そのときの前後 '+low.dx.toFixed(1)+' cm）':'—'}
前後の移動範囲 ${fmin.toFixed(1)} 〜 ${fmax.toFixed(1)} cm

股関節屈曲　最大屈曲 ${fm(H.flex,'hip')}　最大伸展 ${fm(H.ext,'hip')}
膝関節屈曲　最大屈曲 ${fm(K.flex,'knee')}　最大伸展 ${fm(K.ext,'knee')}

計測側 ${data[0].side==='L'?'左':'右'}　換算 ${scale.toFixed(4)} cm/px`;
  drawChart(); drawChart2();
}

// ---------- CSV ----------
$('csvBtn').onclick=()=>{
  const names=['nose','l_eye_in','l_eye','l_eye_out','r_eye_in','r_eye','r_eye_out','l_ear','r_ear','mouth_l','mouth_r','l_shoulder','r_shoulder','l_elbow','r_elbow','l_wrist','r_wrist','l_pinky','r_pinky','l_index','r_index','l_thumb','r_thumb','l_hip','r_hip','l_knee','r_knee','l_ankle','r_ankle','l_heel','r_heel','l_foot','r_foot'];
  const head=['time_s','side','com_up_cm','com_fwd_cm','hip_flex_deg','knee_flex_deg','com_x_px','com_y_px','leg_px',...names.flatMap(n=>[n+'_x',n+'_y',n+'_vis'])];
  const q=s=>'"'+String(s).replace(/"/g,'""')+'"';
  const d=new Date(), pad=n=>String(n).padStart(2,'0');
  const base=`com_${subj.id?subj.id.replace(/[^\w-]/g,'_')+'_':''}${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const vname=vidBlob?`${base}.${vidExt}`:'';
  const R=result, s=(r,k)=>`${r[k].toFixed(2)},${r.t.toFixed(4)}`;
  const lines=[`# id,${q(subj.id)}`,`# age,${subj.age}`,`# sex,${subj.sex}`,`# leg_length_cm,${subj.leg}`,`# scale_cm_per_px,${scale}`,`# origin_px,${origin.x.toFixed(2)},${origin.y.toFixed(2)}`,
    `# video_file,${vname}`,
    `# summary,value,time_s`,
    `# com_up_max_cm,${s(R.peak,'dy')}`,
    `# hip_flex_max_deg,${s(R.H.flex,'hip')}`,`# hip_ext_max_deg,${s(R.H.ext,'hip')}`,
    `# knee_flex_max_deg,${s(R.K.flex,'knee')}`,`# knee_ext_max_deg,${s(R.K.ext,'knee')}`,
    head.join(',')];
  rows.filter(r=>r.dy!==null).forEach(r=>lines.push([r.t.toFixed(4),r.side,r.dy.toFixed(3),r.dx.toFixed(3),r.hip.toFixed(2),r.knee.toFixed(2),r.cx.toFixed(2),r.cy.toFixed(2),r.legPx.toFixed(2),...r.lm.flatMap(p=>[p[0].toFixed(2),p[1].toFixed(2),p[2].toFixed(3)])].join(',')));
  const files=[{name:`${base}.csv`,blob:new Blob(['\ufeff'+lines.join('\n')],{type:'text/csv'})}];
  if(vidBlob) files.push({name:vname,blob:vidBlob});
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

// ---------- 動画ファイル ----------
$('mode').onchange=()=>{
  const f=$('mode').value==='file';
  $('camRow').style.display=f?'none':'flex'; $('fileRow').style.display=f?'flex':'none';
  $('recBtn').style.display=f?'none':''; $('vidRow').style.display=f?'none':'flex';
  if(f && stream) toggleCam();
};
$('fileIn').onchange=async e=>{
  const file=e.target.files[0]; if(!file) return;
  video.srcObject=null; video.src=URL.createObjectURL(file);
  await new Promise(r=>video.onloadeddata=r);
  view.width=video.videoWidth; view.height=video.videoHeight; ctx.drawImage(video,0,0);
  $('anaBtn').disabled=!landmarker;
  status(`動画を読み込みました（${video.duration.toFixed(1)}秒）。撮影時のfpsを入れて解析してください。`);
};
const seek=t=>new Promise(r=>{video.onseeked=()=>{video.onseeked=null;r();};video.currentTime=t;});
let analyzing=false;
$('anaBtn').onclick=async()=>{
  if(analyzing){ analyzing=false; return; }
  analyzing=true; $('anaBtn').textContent='中止'; resetRec(); recording=true;
  const dt=1/(+$('fps').value||60), base=lastTs+1000; let k=0;
  for(let t=0;t<video.duration && analyzing;t+=dt,k++){
    await seek(t); processFrame(base+t*1000,t);
    if(k%10===0) status(`解析中 ${(t/video.duration*100).toFixed(0)}%`);
  }
  recording=false; analyzing=false; $('anaBtn').textContent='解析開始';
  status('解析が終わりました。'); finish();
};
window.addEventListener('resize',()=>{drawChart();drawChart2();});
})();
