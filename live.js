/* Qadam Live — углы бедра и колена по камере.
   Трекинг сделан участником команды на MediaPipe (Google). Оригинал: live_source/original.html.
   Логика MediaPipe (модели, расчёт углов, сглаживание, рисование) сохранена; изменён только интерфейс и тексты.
   Видео никуда не отправляется: модели скачиваются один раз, кадры обрабатываются в браузере. */
import { FilesetResolver, PoseLandmarker, HandLandmarker, FaceLandmarker, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";

const K = window.Kadam;
const t = K.t;

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const MODELS = {
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

const $ = id => document.getElementById(id);
const v = $("v"), c = $("c"), ctx = c.getContext("2d"), stage = $("stage"), msg = $("msg");
let pose, hand, face, running = false, last = -1, ema = { hip: null, knee: null }, frames = 0, t0 = performance.now();
let side = "LEFT";

/* ——— сообщения храним ключом, чтобы переводить при смене языка ——— */
let msgState = { key: "msgLoading", arg: "" }, warnKey = "";
function setMsg(key, arg = "") { msgState = { key, arg }; msg.textContent = t(key).replace("{e}", arg); }
function setWarn(key) { if (key === warnKey) return; warnKey = key; $("warn").textContent = key ? t(key) : ""; }
function camLabel() {
  const b = $("cam");
  if (!pose) { b.textContent = t(failed ? "camUnavailable" : "camLoading"); b.disabled = true; return; }
  b.disabled = false;
  b.textContent = running && v.srcObject ? t("camOff") : t("camOn");
}
let failed = false;

async function make(kind, vision) {
  const base = d => ({ modelAssetPath: MODELS[kind], delegate: d });
  const opts = d => kind === "pose" ? { baseOptions: base(d), runningMode: "VIDEO", numPoses: 1 }
                  : kind === "hand" ? { baseOptions: base(d), runningMode: "VIDEO", numHands: 2 }
                  : { baseOptions: base(d), runningMode: "VIDEO", numFaces: 1 };
  const cls = { pose: PoseLandmarker, hand: HandLandmarker, face: FaceLandmarker }[kind];
  try { return await cls.createFromOptions(vision, opts("GPU")); }
  catch { return await cls.createFromOptions(vision, opts("CPU")); }
}

(async () => {
  setMsg("msgLoading");
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM);
    [pose, hand, face] = await Promise.all([make("pose", vision), make("hand", vision), make("face", vision)]);
    setMsg("msgReady");
    document.body.dataset.models = "ready";
    camLabel();
  } catch (e) {
    failed = true;
    setMsg("msgFail", e.message);
    document.body.dataset.models = "failed";
    camLabel();
  }
})();

// ---- источники ----
$("cam").onclick = async () => {
  if (!pose) { msg.style.display = ""; setMsg(failed ? "msgFail" : "msgWait", ""); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.style.display = ""; setMsg("camInsecure"); return; }
  if (running && v.srcObject) { stop(); return; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" }, audio: false });
    v.srcObject = s; v.loop = false; await v.play();
    stage.classList.toggle("mirror", $("oMirror").checked);
    start(); camLabel(); $("cam").classList.add("is-on");
  } catch (e) {
    msg.style.display = "";
    // понятная причина вместо технического текста
    const why = e && e.name === "NotAllowedError" ? "camDenied"
              : e && (e.name === "NotFoundError" || e.name === "OverconstrainedError") ? "camNotFound"
              : e && e.name === "NotReadableError" ? "camBusy"
              : !navigator.mediaDevices || !window.isSecureContext ? "camInsecure" : null;
    if (why) setMsg(why); else setMsg("msgNoCam", e && e.message ? e.message : String(e));
  }
};
$("file").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (!pose) { msg.style.display = ""; setMsg(failed ? "msgFail" : "msgWait", ""); e.target.value = ""; return; }
  stop(); v.src = URL.createObjectURL(f); v.loop = true; await v.play();
  stage.classList.remove("mirror"); $("oMirror").checked = false; start();
  e.target.value = "";
};
$("oMirror").onchange = () => stage.classList.toggle("mirror", $("oMirror").checked);
document.querySelectorAll("#side [data-side]").forEach(b => b.addEventListener("click", () => {
  side = b.dataset.side;
  document.querySelectorAll("#side [data-side]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  ema = { hip: null, knee: null };
}));
function start() {
  running = true; msg.style.display = "none"; last = -1;
  frames = 0; t0 = performance.now();   // счётчик кадров — с момента включения, а не с открытия страницы
  requestAnimationFrame(loop);
}
function stop() {
  running = false;
  if (v.srcObject) { v.srcObject.getTracks().forEach(tr => tr.stop()); v.srcObject = null; }
  v.removeAttribute("src"); v.load(); ctx.clearRect(0, 0, c.width, c.height);
  camLabel(); $("cam").classList.remove("is-on");
  msg.style.display = ""; setMsg("msgStopped"); setWarn("");
}

// ---- углы (та же математика, что в video_gait.py) ----
function angles(lm, w, h, side) {
  const I = side === "LEFT" ? [11, 23, 25, 27] : [12, 24, 26, 28];
  const [s, hp, k, a] = I.map(i => ({ x: lm[i].x * w, y: lm[i].y * h, vis: lm[i].visibility ?? 1 }));
  const facing = Math.sign(lm[0].x * w - hp.x) || 1;
  const ax = hp.x - s.x, ay = hp.y - s.y, bx = k.x - hp.x, by = k.y - hp.y;
  const hip = -Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180 / Math.PI * facing;
  const ux = hp.x - k.x, uy = hp.y - k.y, vx = a.x - k.x, vy = a.y - k.y;
  const cs = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9);
  const knee = 180 - Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI;
  return { hip, knee, vis: Math.min(s.vis, hp.vis, k.vis, a.vis) };
}
const smooth = (key, x) => (ema[key] = ema[key] == null ? x : 0.7 * ema[key] + 0.3 * x);

// ---- рисование со свечением (цвета — фирменные: цитрус, белый, чернила) ----
const BODY = PoseLandmarker.POSE_CONNECTIONS.filter(p => p.start >= 11 && p.end >= 11);
const COL = { body: "#C7D93B", bodyGlow: "#E2EDA6", hand: "#FFFFFF", handGlow: "#C7D93B", face: "#E9EEF5", faceGlow: "#9AA0AC", dot: "#FFFFFF", bg: "#14213A" };
function drawNeon(glowColor, blur, fn) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}

function loop() {
  if (!running) return;
  if (v.readyState >= 2 && v.currentTime !== last && v.videoWidth) {
    last = v.currentTime;
    const w = v.videoWidth, h = v.videoHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; stage.style.aspectRatio = w + " / " + h; }
    const ts = performance.now();
    ctx.clearRect(0, 0, w, h);
    if ($("oBlack").checked) { ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h); }
    const du = new DrawingUtils(ctx), lw = Math.max(2, w / 400);

    if ($("oFace").checked) {
      const fr = face.detectForVideo(v, ts);
      drawNeon(COL.faceGlow, 8, () => {
        for (const lm of fr.faceLandmarks) {
          for (const set of [FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
                             FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, FaceLandmarker.FACE_LANDMARKS_LIPS])
            du.drawConnectors(lm, set, { color: COL.face, lineWidth: lw * 0.65 });
        }
      });
    }
    if ($("oHand").checked) {
      const hr = hand.detectForVideo(v, ts);
      for (const lm of hr.landmarks) {
        drawNeon(COL.handGlow, 12, () => {
          du.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: COL.hand, lineWidth: lw });
        });
        drawNeon(COL.handGlow, 10, () => {
          du.drawLandmarks(lm, { color: COL.dot, fillColor: COL.dot, radius: lw * 0.9 });
        });
      }
    }
    const pr = pose.detectForVideo(v, ts);
    if (pr.landmarks.length) {
      const lm = pr.landmarks[0];
      if ($("oPose").checked) {
        drawNeon(COL.bodyGlow, 14, () => {
          du.drawConnectors(lm, BODY, { color: COL.body, lineWidth: lw * 1.3 });
        });
        drawNeon(COL.bodyGlow, 12, () => {
          du.drawLandmarks(lm.filter((_, i) => i >= 11), { color: COL.dot, fillColor: COL.dot, radius: lw });
        });
      }
      const a = angles(lm, w, h, side);
      $("aHip").textContent = smooth("hip", a.hip).toFixed(0) + "°";
      $("aKnee").textContent = smooth("knee", a.knee).toFixed(0) + "°";
      setWarn(a.vis < 0.5 ? "warnVis" : "");
    } else {
      $("aHip").textContent = $("aKnee").textContent = "—";
      setWarn("warnNoPerson");
    }
    frames++;
    const dt = performance.now() - t0;
    if (dt > 1000) { $("fps").textContent = (frames * 1000 / dt).toFixed(0); frames = 0; t0 = performance.now(); }
  }
  requestAnimationFrame(loop);
}

/* ——— язык и дорожка следов в шапке ——— */
function drawTrail() {
  const trail = $("trail");
  trail.innerHTML = "";
  const w = trail.clientWidth || window.innerWidth, stride = 62, count = Math.ceil(w / stride) + 1;
  for (let i = 0; i < count; i++) {
    const left = i % 2 === 0;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#foot"); svg.append(use);
    svg.style.left = `${i * stride + 8}px`; svg.style.top = left ? "-2px" : "22px";
    svg.style.transform = `rotate(90deg)${left ? " scaleX(-1)" : ""}`;
    svg.style.opacity = String(Math.min(0.85, 0.1 + (i / count) * 0.75));
    if (i === count - 2) { svg.classList.add("is-now"); svg.style.opacity = "1"; }
    trail.append(svg);
  }
}
function relabel() {
  K.applyI18n();
  setMsg(msgState.key, msgState.arg);
  const k = warnKey; warnKey = null; setWarn(k);
  camLabel();
}
document.querySelectorAll("[data-lang]").forEach(b => b.addEventListener("click", () => K.setLang(b.dataset.lang)));
document.addEventListener("kadam:lang", relabel);
window.addEventListener("resize", () => { clearTimeout(drawTrail.tm); drawTrail.tm = setTimeout(drawTrail, 150); });
relabel();
drawTrail();
