// オフライン用に保存するファイルの一覧（Service Worker と画面の両方で使う）
// アプリを更新したら VERSION を変えてください（例：jump-m2）
self.PRECACHE={
  VERSION:'jump-m1',
  // アプリ本体（このフォルダのファイル）
  LOCAL:['./','./index.html','./app.js','./precache.js','./manifest.webmanifest',
    './icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'],
  // 解析エンジンとモデル（初回だけインターネットから取得し、以後は端末内のものを使う）
  REMOTE:['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm',
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'],
  CDN:'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/',
  MODEL:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  TOTAL_MB:19
};
self.PRECACHE.FILES=self.PRECACHE.LOCAL.concat(self.PRECACHE.REMOTE);
