/**
 * app.js — SvaraTherapy State Machine v4
 * - Duration selector: 1 / 2 / 3 / 5 minutes
 * - Three export formats:
 *     1. RR Intervals (emWave Pro compatible)
 *     2. Full HRV Feature Table (all computable features)
 *     3. Raw RGB Signal (for offline reanalysis)
 */

import { RPPGEngine }    from './rppg.js';
import { BreathPacer }   from './pacer.js';
import { Questionnaire } from './questionnaire.js';
import { saveSession }   from './api.js';

// ── Global session state ─────────────────────────────────────────────────────
const S = {
  email:            '',
  condition:        '',
  sessionNumber:    1,
  recordingDuration: 180,       // seconds — set from UI
  selectedDeviceId: null,
  baseline:         null,       // { hr_bpm, rmssd, lf_hf_ratio, quality_flag, rrIntervals, peakTimes }
  post:             null,
  pre:              null,
  postQ:            null,
  baselineRR:       [],         // RR intervals ms
  postRR:           [],
  baselinePeakTimes:[],         // absolute timestamps for RR
  postPeakTimes:    [],
  baselineRGB:      [],         // [{t, r, g, b}] raw signal
  postRGB:          []
};

// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 1 — CONSENT
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('consent-check').addEventListener('change', function() {
  document.getElementById('btn-consent').disabled = !this.checked;
});
document.getElementById('btn-consent').addEventListener('click', () => {
  showScreen('setup');
  initCameraSelector();
});

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 2 — SETUP
// ═══════════════════════════════════════════════════════════════════════════
let setupFaceMesh   = null;
let currentStream   = null;
let frameActive     = false;
let meshInitialized = false;

async function initCameraSelector() {
  const camBtns  = document.getElementById('cam-buttons');
  const camGroup = document.getElementById('cam-select-group');
  camBtns.innerHTML = '<span class="cam-detecting">Detecting cameras…</span>';
  camGroup.style.display = 'block';

  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach(t => t.stop());
  } catch(e) {
    camBtns.innerHTML = `<span class="cam-error">Camera access denied: ${e.message}</span>`;
    return;
  }

  const devices      = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  camBtns.innerHTML  = '';

  if (videoDevices.length === 0) {
    camBtns.innerHTML = '<span class="cam-error">No cameras found.</span>';
    return;
  }

  videoDevices.forEach((dev, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cam-btn';
    btn.dataset.deviceId = dev.deviceId;
    const raw   = dev.label || `Camera ${idx + 1}`;
    const lower = raw.toLowerCase();
    let icon, name;
    if (lower.includes('integrated') || lower.includes('facetime') ||
        lower.includes('built-in')   || lower.includes('internal') ||
        (lower.includes('hd') && idx === 0)) {
      icon = '💻'; name = 'Laptop Camera';
    } else if (lower.includes('usb') || lower.includes('logitech') ||
               lower.includes('brio') || lower.includes('c920') ||
               lower.includes('webcam') || lower.includes('external')) {
      icon = '🎥'; name = 'External Webcam';
    } else if (idx === 0) {
      icon = '💻'; name = 'Built-in Camera';
    } else {
      icon = '🎥'; name = `Camera ${idx + 1}`;
    }
    const shortLabel = raw.replace(/\(.*?\)/g, '').trim();
    if (shortLabel.length > 4 && shortLabel.toLowerCase() !== name.toLowerCase()) {
      name += `<small>${shortLabel.substring(0, 30)}</small>`;
    }
    btn.innerHTML = `<span class="cam-icon">${icon}</span><span class="cam-label">${name}</span>`;
    btn.addEventListener('click', () => selectCamera(dev.deviceId, btn));
    camBtns.appendChild(btn);
  });

  const firstBtn = camBtns.querySelector('.cam-btn');
  if (firstBtn) selectCamera(videoDevices[0].deviceId, firstBtn);
}

async function selectCamera(deviceId, clickedBtn) {
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('selected'));
  clickedBtn.classList.add('selected');
  S.selectedDeviceId = deviceId;
  frameActive = false; meshInitialized = false;
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
  if (setupFaceMesh) { try { setupFaceMesh.close(); } catch(e) {} setupFaceMesh = null; }

  const video  = document.getElementById('setup-video');
  const canvas = document.getElementById('setup-canvas');
  const badge  = document.getElementById('face-indicator');
  badge.className = 'face-badge face-no';
  badge.textContent = 'Loading…';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: 640, height: 480, frameRate: { ideal: 30 } },
      audio: false
    });
    currentStream = stream; video.srcObject = stream; await video.play();
  } catch(e) { badge.textContent = 'Camera Error: ' + e.message; return; }

  await startSetupFaceMesh(video, canvas);
  checkSetupReady();
}

async function startSetupFaceMesh(video, canvas) {
  const ctx   = canvas.getContext('2d');
  const badge = document.getElementById('face-indicator');
  setupFaceMesh = new FaceMesh({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
  });
  setupFaceMesh.setOptions({
    maxNumFaces: 1, refineLandmarks: false,
    minDetectionConfidence: 0.3, minTrackingConfidence: 0.3
  });
  setupFaceMesh.onResults(r => {
    if (!frameActive) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const found = r.multiFaceLandmarks && r.multiFaceLandmarks.length > 0;
    badge.className   = `face-badge ${found ? 'face-ok' : 'face-no'}`;
    badge.textContent = found ? '✓ Face OK' : 'No Face — move closer';
    if (found) {
      const lm = r.multiFaceLandmarks[0];
      ctx.fillStyle = 'rgba(255,153,51,0.5)';
      lm.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 1.2, 0, Math.PI*2);
        ctx.fill();
      });
    }
    checkSetupReady();
  });
  try {
    badge.textContent = 'Loading AI model…';
    await setupFaceMesh.initialize();
    badge.textContent = 'Model ready — detecting…';
    meshInitialized = true;
  } catch(e) { badge.textContent = 'Model load failed — refresh page'; return; }
  frameActive = true;
  const loop = async () => {
    if (!frameActive || !meshInitialized) return;
    if (!video.paused && video.readyState >= 2) {
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      try { await setupFaceMesh.send({ image: video }); } catch(e) {}
    }
    requestAnimationFrame(loop);
  };
  loop();
}

function checkSetupReady() {
  const email     = document.getElementById('setup-email').value.trim();
  const condition = document.getElementById('setup-condition').value;
  const session   = document.getElementById('setup-session').value;
  const duration  = document.getElementById('setup-duration').value;
  const badge     = document.getElementById('face-indicator');
  const formReady = email && condition && session && duration && S.selectedDeviceId;
  document.getElementById('btn-setup').disabled = !formReady;
  const warnEl = document.getElementById('face-warn');
  if (warnEl) warnEl.style.display = formReady && !badge.classList.contains('face-ok') ? 'block' : 'none';
}

['setup-email','setup-condition','setup-session','setup-duration'].forEach(id => {
  document.getElementById(id).addEventListener('input',  checkSetupReady);
  document.getElementById(id).addEventListener('change', checkSetupReady);
});

document.getElementById('btn-setup').addEventListener('click', () => {
  S.email             = document.getElementById('setup-email').value.trim();
  S.condition         = document.getElementById('setup-condition').value;
  S.sessionNumber     = parseInt(document.getElementById('setup-session').value);
  S.recordingDuration = parseInt(document.getElementById('setup-duration').value);
  frameActive = false; meshInitialized = false;
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
  if (setupFaceMesh) { try { setupFaceMesh.close(); } catch(e) {} setupFaceMesh = null; }
  showScreen('baseline');
  startRPPGRecording('baseline');
});

// ═══════════════════════════════════════════════════════════════════════════
// rPPG RECORDING
// ═══════════════════════════════════════════════════════════════════════════
let baselineEngine = null;
let postEngine     = null;
let recordingTimer = null;

function startRPPGRecording(phase) {
  const isBaseline = phase === 'baseline';
  const videoId    = isBaseline ? 'rppg-video'         : 'rppg-video-post';
  const overlayId  = isBaseline ? 'rppg-overlay'       : 'rppg-overlay-post';
  const countId    = isBaseline ? 'baseline-countdown' : 'post-countdown';
  const statusId   = isBaseline ? 'baseline-status'    : 'post-status';
  const hrId       = isBaseline ? 'live-hr'            : 'live-hr-post';
  const rmssdId    = isBaseline ? 'live-rmssd'         : 'live-rmssd-post';
  const lfhfId     = isBaseline ? 'live-lfhf'          : 'live-lfhf-post';
  const qualFillId = isBaseline ? 'quality-fill'       : 'quality-fill-post';
  const qualLblId  = isBaseline ? 'quality-label'      : 'quality-label-post';
  const pulseId    = isBaseline ? 'pulse-canvas'       : 'pulse-canvas-post';

  const video       = document.getElementById(videoId);
  const overlay     = document.getElementById(overlayId);
  const statusEl    = document.getElementById(statusId);
  const countEl     = document.getElementById(countId);
  const pulseCanvas = document.getElementById(pulseId);
  const pulseCtx    = pulseCanvas.getContext('2d');

  let elapsed = 0;
  const DURATION = S.recordingDuration;

  // Update screen title to show chosen duration
  const titleEl = document.querySelector(`#screen-${isBaseline ? 'baseline' : 'post'} .screen-title`);
  if (titleEl) {
    const mins = Math.floor(DURATION / 60);
    titleEl.textContent = isBaseline
      ? `Baseline Recording (${mins} min)`
      : `Post-Breathing Recording (${mins} min)`;
  }

  statusEl.textContent = 'Initializing…';

  const onMetrics = ({ hr, rmssd, lfhf }) => {
    if (elapsed < 30) return;
    document.getElementById(hrId).textContent    = hr    != null ? hr    : '—';
    document.getElementById(rmssdId).textContent = rmssd != null ? rmssd : '—';
    document.getElementById(lfhfId).textContent  = lfhf  != null ? lfhf  : '—';
  };

  const onPulse = (signal) => {
    if (!signal || signal.length < 2) return;
    const cw = pulseCanvas.width  = pulseCanvas.offsetWidth || 400;
    const ch = pulseCanvas.height = 80;
    pulseCtx.clearRect(0, 0, cw, ch);
    const show = Math.min(signal.length, 600);
    const seg  = signal.slice(signal.length - show);
    const maxV = Math.max(...seg.map(Math.abs)) || 1;
    pulseCtx.strokeStyle = '#FF9933';
    pulseCtx.lineWidth   = 1.5;
    pulseCtx.beginPath();
    seg.forEach((v, i) => {
      const x = (i / show) * cw, y = ch/2 - (v/maxV)*(ch/2-8);
      i === 0 ? pulseCtx.moveTo(x,y) : pulseCtx.lineTo(x,y);
    });
    pulseCtx.stroke();
  };

  const onQuality = (q) => {
    const pct = Math.round(q * 100);
    document.getElementById(qualFillId).style.width = `${pct}%`;
    document.getElementById(qualLblId).textContent  = `Quality: ${pct}%`;
    statusEl.textContent = q > 0.8
      ? (elapsed < 30 ? `Collecting (${elapsed}/30s before metrics)` : '● Recording live')
      : 'Keep face in view — face a light source';
  };

  const engine = new RPPGEngine(video, overlay, onMetrics, onPulse, onQuality, S.selectedDeviceId);
  if (isBaseline) baselineEngine = engine;
  else            postEngine     = engine;

  engine.start().then(() => {
    statusEl.textContent = 'Recording — sit still…';
    recordingTimer = setInterval(() => {
      elapsed++;
      const rem = DURATION - elapsed;
      countEl.textContent = `${Math.floor(rem/60)}:${(rem%60).toString().padStart(2,'0')}`;
      if (elapsed >= DURATION) {
        clearInterval(recordingTimer);
        statusEl.textContent = 'Complete ✓';
        engine.stop();
        const results = engine.getResults();
        if (isBaseline) {
          S.baseline          = results;
          S.baselineRR        = results.rrIntervals  || [];
          S.baselinePeakTimes = results.peakTimes    || [];
          S.baselineRGB       = engine.getRawRGB     ? engine.getRawRGB() : [];
          showScreen('preq'); initPreQ();
        } else {
          S.post          = results;
          S.postRR        = results.rrIntervals  || [];
          S.postPeakTimes = results.peakTimes    || [];
          S.postRGB       = engine.getRawRGB     ? engine.getRawRGB() : [];
          showScreen('postq'); initPostQ();
        }
      }
    }, 1000);
  }).catch(e => { statusEl.textContent = 'Camera error: ' + e.message; });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 4 — PRE-QUESTIONNAIRE
// ═══════════════════════════════════════════════════════════════════════════
let preQ = null;
function initPreQ() {
  preQ = new Questionnaire('questionnaire-form', 'btn-preq', 'pre');
  preQ.render();
}
document.getElementById('btn-preq').addEventListener('click', () => {
  S.pre = preQ.getScores();
  showScreen('breathing'); initBreathing();
});

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 5 — BREATHING
// ═══════════════════════════════════════════════════════════════════════════
let pacer = null;
function initBreathing() {
  pacer = new BreathPacer({
    onComplete: () => { showScreen('post'); startRPPGRecording('post'); }
  });
  pacer.init(S.condition);
  setTimeout(() => pacer.start(), 1500);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 7 — POST-QUESTIONNAIRE
// ═══════════════════════════════════════════════════════════════════════════
let postQ = null;
function initPostQ() {
  postQ = new Questionnaire('questionnaire-form-post', 'btn-postq', 'post');
  postQ.render();
  const slider = document.getElementById('calm-slider');
  const valEl  = document.getElementById('calm-val');
  slider.addEventListener('input', () => { valEl.textContent = slider.value; });
}
document.getElementById('btn-postq').addEventListener('click', () => {
  S.postQ = {
    gad2: postQ.getScores().gad2,
    phq2: postQ.getScores().phq2,
    calm: parseInt(document.getElementById('calm-slider').value)
  };
  showScreen('results'); renderResults();
});

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 8 — RESULTS
// ═══════════════════════════════════════════════════════════════════════════
function renderResults() {
  const tbody = document.getElementById('results-body');
  tbody.innerHTML = '';
  const rows = [
    { label:'Heart Rate (bpm)', bKey:'hr_bpm',      pKey:'hr_bpm',      higherBetter:false },
    { label:'RMSSD (ms)',        bKey:'rmssd',        pKey:'rmssd',        higherBetter:true  },
    { label:'LF/HF Ratio',       bKey:'lf_hf_ratio', pKey:'lf_hf_ratio', higherBetter:false },
    { label:'GAD-2 Score',        bKey:null,           pKey:null,           higherBetter:false, manual:true }
  ];
  rows.forEach(row => {
    let before, after, changeClass='change-nil', changeStr='—';
    if (row.manual) {
      before = S.pre?.gad2 ?? '—'; after = S.postQ?.gad2 ?? '—';
      if (typeof before==='number' && typeof after==='number') {
        const d = after-before;
        changeClass = d<0?'change-up':d>0?'change-down':'change-nil';
        changeStr = `${d>0?'+':''}${d}`;
      }
    } else {
      before = S.baseline?.[row.bKey] ?? null; after = S.post?.[row.pKey] ?? null;
      if (before!==null && after!==null) {
        const d = after-before;
        const good = row.higherBetter?(d>0):(d<0);
        changeClass = Math.abs(d)<0.1?'change-nil':good?'change-up':'change-down';
        changeStr = `${d>0?'+':''}${Math.round(d*10)/10}`;
      } else { before=before??'—'; after=after??'—'; }
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.label}</td>
      <td>${typeof before==='number'?Math.round(before*10)/10:before}</td>
      <td>${typeof after==='number'?Math.round(after*10)/10:after}</td>
      <td class="${changeClass}">${changeStr}</td>`;
    tbody.appendChild(tr);
  });
  const cond=S.condition, rd=(S.post?.rmssd??0)-(S.baseline?.rmssd??0), gd=(S.postQ?.gad2??0)-(S.pre?.gad2??0);
  let txt='';
  if(cond==='chandra') txt=rd>0?`<strong>Parasympathetic activation.</strong> RMSSD +${Math.round(rd*10)/10} ms — consistent with Ida Nadi upregulation.`:`RMSSD −${Math.abs(Math.round(rd*10)/10)} ms. Check lighting/movement quality.`;
  else if(cond==='surya') txt=rd<0?`<strong>Sympathetic activation.</strong> RMSSD −${Math.abs(Math.round(rd*10)/10)} ms — consistent with Pingala Nadi.`:`RMSSD +${Math.round(rd*10)/10} ms. Check LF/HF for sympathetic signal.`;
  else txt=Math.abs(rd)<5?'Control: minimal HRV change — consistent with resting baseline.':`Control: HRV change ${Math.round(rd*10)/10} ms.`;
  if(gd<0) txt+=` GAD-2 reduced by ${Math.abs(gd)} pt${Math.abs(gd)>1?'s':''}.`;
  document.getElementById('interpretation-card').innerHTML = txt;
}

// ═══════════════════════════════════════════════════════════════════════════
// SAVE TO SUPABASE
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveSession(S);
    showScreen('saved');
    document.getElementById('saved-msg').textContent = `Session ${S.sessionNumber} saved.`;
    document.getElementById('session-badge').textContent =
      `${new Date().toLocaleDateString()} · Session ${S.sessionNumber} · ${S.condition}`;
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Save to Supabase →';
    alert(`Save failed: ${e.message}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT 1 — RR INTERVALS  (emWave Pro compatible)
// Format: same as emWave Pro export — timestamp_ms, rr_ms, cumulative_time_s
// emWave Pro columns: Time(ms), IBI(ms)  — we match this exactly
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-export-rr').addEventListener('click', () => {
  const ts    = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const fname = `SvaraTherapy_RR_S${S.sessionNumber}_${S.condition}_${ts}.csv`;

  // emWave Pro format: Time(ms) = cumulative elapsed time, IBI(ms) = RR interval
  let rows = ['Phase,Time_ms,IBI_ms,HR_bpm,Notes'];
  let cumBaseline = 0, cumPost = 0;

  S.baselineRR.forEach((rr, i) => {
    cumBaseline += rr;
    const hr = Math.round(60000 / rr * 10) / 10;
    rows.push(`baseline,${Math.round(cumBaseline)},${Math.round(rr)},${hr},`);
  });

  S.postRR.forEach((rr, i) => {
    cumPost += rr;
    const hr = Math.round(60000 / rr * 10) / 10;
    rows.push(`post,${Math.round(cumPost)},${Math.round(rr)},${hr},`);
  });

  // Add metadata header block at top
  const meta = [
    `# SvaraTherapy rPPG Export — emWave Pro Compatible`,
    `# Participant: ${S.email}`,
    `# Condition: ${S.condition}`,
    `# Session: ${S.sessionNumber}`,
    `# Recording duration: ${S.recordingDuration}s`,
    `# Date: ${new Date().toLocaleString()}`,
    `# Baseline RR count: ${S.baselineRR.length}`,
    `# Post RR count: ${S.postRR.length}`,
    `# To import in emWave Pro: use IBI_ms column as Inter-Beat Interval`,
    `#`,
  ].join('\n');

  downloadCSV(meta + '\n' + rows.join('\n'), fname);
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT 2 — FULL HRV FEATURE TABLE
// All standard time-domain, frequency-domain and nonlinear HRV features
// Computed separately for baseline and post phases
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-export-hrv').addEventListener('click', () => {
  const ts    = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const fname = `SvaraTherapy_HRV_Features_S${S.sessionNumber}_${S.condition}_${ts}.csv`;

  const bFeatures = computeAllHRV(S.baselineRR, 'baseline');
  const pFeatures = computeAllHRV(S.postRR,     'post');

  // Build comparison table: Feature | Baseline | Post | Delta | Unit | Description
  const allKeys = Object.keys(bFeatures);
  const rows = ['Feature,Baseline,Post,Delta,Unit,Description'];

  allKeys.forEach(key => {
    const b   = bFeatures[key];
    const p   = pFeatures[key];
    const delta = (typeof b.val === 'number' && typeof p.val === 'number')
      ? Math.round((p.val - b.val) * 1000) / 1000
      : 'N/A';
    const bVal = typeof b.val === 'number' ? Math.round(b.val * 1000) / 1000 : b.val;
    const pVal = typeof p.val === 'number' ? Math.round(p.val * 1000) / 1000 : p.val;
    rows.push(`${key},${bVal},${pVal},${delta},${b.unit},"${b.desc}"`);
  });

  const meta = [
    `# SvaraTherapy HRV Feature Export`,
    `# Participant: ${S.email}`,
    `# Condition: ${S.condition} | Session: ${S.sessionNumber}`,
    `# Recording: ${S.recordingDuration}s | Date: ${new Date().toLocaleString()}`,
    `# Method: rPPG (van der Kooij & Naber 2019) + POS algorithm (Wang et al. 2017)`,
    `# Baseline quality: ${S.baseline?.quality_flag ? 'GOOD (>80% face detection)' : 'CHECK (face detection <80%)'}`,
    `# Post quality: ${S.post?.quality_flag ? 'GOOD' : 'CHECK'}`,
    `#`,
  ].join('\n');

  downloadCSV(meta + '\n' + rows.join('\n'), fname);
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT 3 — RAW RGB SIGNAL (for offline reanalysis in MATLAB/Python)
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-export-raw').addEventListener('click', () => {
  const ts    = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const fname = `SvaraTherapy_RGB_S${S.sessionNumber}_${S.condition}_${ts}.csv`;

  let rows = ['phase,frame,timestamp_s,R_mean,G_mean,B_mean'];

  // Get raw RGB from engines if available
  const bRGB = (baselineEngine && baselineEngine.getRawRGB) ? baselineEngine.getRawRGB() : S.baselineRGB;
  const pRGB = (postEngine     && postEngine.getRawRGB)     ? postEngine.getRawRGB()     : S.postRGB;

  bRGB.forEach((pt, i) => {
    rows.push(`baseline,${i},${pt.t.toFixed(4)},${pt.r.toFixed(2)},${pt.g.toFixed(2)},${pt.b.toFixed(2)}`);
  });
  pRGB.forEach((pt, i) => {
    rows.push(`post,${i},${pt.t.toFixed(4)},${pt.r.toFixed(2)},${pt.g.toFixed(2)},${pt.b.toFixed(2)}`);
  });

  const meta = [
    `# SvaraTherapy Raw RGB Signal Export`,
    `# Participant: ${S.email} | Condition: ${S.condition} | Session: ${S.sessionNumber}`,
    `# Use this file to re-run POS algorithm offline in MATLAB or Python`,
    `# Apply: van der Kooij & Naber (2019) pipeline | POS: Wang et al. (2017)`,
    `#`,
  ].join('\n');

  downloadCSV(meta + '\n' + rows.join('\n'), fname);
});

// ═══════════════════════════════════════════════════════════════════════════
// HRV FEATURE COMPUTATION
// Complete time-domain, frequency-domain, and nonlinear features
// ═══════════════════════════════════════════════════════════════════════════
function computeAllHRV(rr, phase) {
  const n   = rr.length;
  const inf = 'N/A (insufficient data)';

  if (n < 4) {
    return {
      'N_beats':   { val: n,  unit: 'beats', desc: 'Number of detected beats' },
      'Error':     { val: 'Insufficient RR intervals for HRV analysis (need ≥4)', unit: '', desc: '' }
    };
  }

  // ── Time domain ──────────────────────────────────────────────────────────
  const meanRR  = rr.reduce((a,b)=>a+b,0) / n;
  const meanHR  = 60000 / meanRR;
  const sdnn    = Math.sqrt(rr.reduce((s,v)=>s+(v-meanRR)**2, 0) / (n-1));
  const diffs   = rr.slice(1).map((v,i)=>v-rr[i]);
  const rmssd   = Math.sqrt(diffs.reduce((s,v)=>s+v**2,0) / diffs.length);
  const sdsd    = Math.sqrt(diffs.reduce((s,v)=>s+(v - diffs.reduce((a,b)=>a+b,0)/diffs.length)**2,0) / (diffs.length-1));
  const pnn50   = diffs.filter(d=>Math.abs(d)>50).length / diffs.length * 100;
  const pnn20   = diffs.filter(d=>Math.abs(d)>20).length / diffs.length * 100;
  const cvRR    = sdnn / meanRR * 100;
  const minRR   = Math.min(...rr);
  const maxRR   = Math.max(...rr);
  const rangeRR = maxRR - minRR;

  // ── Frequency domain (Welch PSD on RR tachogram) ────────────────────────
  const { ulf, vlf, lf, hf, lfnu, hfnu, lfhf, totalPow } = computePSD(rr);

  // ── Nonlinear (Poincaré plot) ─────────────────────────────────────────────
  const rr1 = rr.slice(0,-1), rr2 = rr.slice(1);
  const sd1  = Math.sqrt(0.5) * rmssd;
  const sd2  = Math.sqrt(2 * sdnn**2 - 0.5 * rmssd**2);
  const sd12 = sd2 > 0 ? sd1 / sd2 : 0;

  // Approximate entropy (simplified ApEn m=2, r=0.2*SDNN)
  const apen = approximateEntropy(rr, 2, 0.2 * sdnn);

  return {
    // ── Metadata
    'N_beats':         { val: n,              unit: 'beats',   desc: 'Total RR intervals analysed' },
    'Duration_s':      { val: Math.round(rr.reduce((a,b)=>a+b,0)/1000), unit: 's', desc: 'Total recording duration (RR sum)' },
    'Phase':           { val: phase,          unit: '',        desc: 'Recording phase' },

    // ── Time domain
    'Mean_RR_ms':      { val: meanRR,         unit: 'ms',      desc: 'Mean RR interval' },
    'Mean_HR_bpm':     { val: meanHR,         unit: 'bpm',     desc: 'Mean heart rate' },
    'SDNN_ms':         { val: sdnn,           unit: 'ms',      desc: 'Std dev of all RR intervals — overall HRV' },
    'RMSSD_ms':        { val: rmssd,          unit: 'ms',      desc: 'Root mean square of successive differences — parasympathetic index' },
    'SDSD_ms':         { val: sdsd,           unit: 'ms',      desc: 'Std dev of successive differences' },
    'pNN50_pct':       { val: pnn50,          unit: '%',       desc: 'Proportion of successive RR differences >50ms' },
    'pNN20_pct':       { val: pnn20,          unit: '%',       desc: 'Proportion of successive RR differences >20ms' },
    'CV_RR_pct':       { val: cvRR,           unit: '%',       desc: 'Coefficient of variation of RR intervals' },
    'Min_RR_ms':       { val: minRR,          unit: 'ms',      desc: 'Minimum RR interval (fastest beat)' },
    'Max_RR_ms':       { val: maxRR,          unit: 'ms',      desc: 'Maximum RR interval (slowest beat)' },
    'Range_RR_ms':     { val: rangeRR,        unit: 'ms',      desc: 'Range of RR intervals' },

    // ── Frequency domain
    'ULF_ms2':         { val: ulf,            unit: 'ms²',     desc: 'Ultra-low frequency power (≤0.003 Hz)' },
    'VLF_ms2':         { val: vlf,            unit: 'ms²',     desc: 'Very-low frequency power (0.003–0.04 Hz)' },
    'LF_ms2':          { val: lf,             unit: 'ms²',     desc: 'Low frequency power (0.04–0.15 Hz) — sympathetic + parasympathetic' },
    'HF_ms2':          { val: hf,             unit: 'ms²',     desc: 'High frequency power (0.15–0.40 Hz) — parasympathetic / respiratory' },
    'LF_nu':           { val: lfnu,           unit: 'n.u.',    desc: 'LF power in normalised units' },
    'HF_nu':           { val: hfnu,           unit: 'n.u.',    desc: 'HF power in normalised units' },
    'LF_HF_ratio':     { val: lfhf,           unit: 'ratio',   desc: 'Sympathovagal balance index' },
    'Total_Power_ms2': { val: totalPow,       unit: 'ms²',     desc: 'Total spectral power (≤0.40 Hz)' },

    // ── Nonlinear
    'SD1_ms':          { val: sd1,            unit: 'ms',      desc: 'Poincaré SD1 — short-term variability (≈RMSSD/√2)' },
    'SD2_ms':          { val: sd2,            unit: 'ms',      desc: 'Poincaré SD2 — long-term variability' },
    'SD1_SD2_ratio':   { val: sd12,           unit: 'ratio',   desc: 'SD1/SD2 — complexity of HRV' },
    'ApEn':            { val: apen,           unit: 'a.u.',    desc: 'Approximate Entropy (m=2, r=0.2×SDNN) — signal regularity' },
  };
}

function computePSD(rr) {
  if (rr.length < 8) return { ulf:0, vlf:0, lf:0, hf:0, lfnu:0, hfnu:0, lfhf:1, totalPow:0 };

  // Resample to 4 Hz
  const interpFs = 4;
  const cumT = [0];
  rr.forEach(v => cumT.push(cumT[cumT.length-1] + v/1000));
  const tEnd = cumT[cumT.length-1];
  const nPts = Math.floor(tEnd * interpFs);
  if (nPts < 8) return { ulf:0, vlf:0, lf:0, hf:0, lfnu:0, hfnu:0, lfhf:1, totalPow:0 };

  const tInterp = Array.from({length:nPts}, (_,i) => i/interpFs);
  const rrInterp = linInterp(cumT.slice(1), rr, tInterp);

  // Detrend
  const m = rrInterp.reduce((a,b)=>a+b,0)/rrInterp.length;
  const detrended = rrInterp.map(v=>v-m);

  // Welch segments
  const segLen  = Math.min(nPts, 256);
  const overlap = Math.floor(segLen / 2);
  const psd     = welchPSD(detrended, segLen, overlap, interpFs);
  const freqRes = interpFs / segLen;

  let ulf=0, vlf=0, lf=0, hf=0, total=0;
  psd.forEach((p, k) => {
    const f = k * freqRes;
    total += p;
    if (f <= 0.003)          ulf += p;
    if (f > 0.003 && f <= 0.04)  vlf += p;
    if (f > 0.04  && f <= 0.15)  lf  += p;
    if (f > 0.15  && f <= 0.40)  hf  += p;
  });

  const denom = lf + hf || 1;
  return {
    ulf:      Math.round(ulf*freqRes*1e6)/1e3,
    vlf:      Math.round(vlf*freqRes*1e6)/1e3,
    lf:       Math.round(lf *freqRes*1e6)/1e3,
    hf:       Math.round(hf *freqRes*1e6)/1e3,
    lfnu:     Math.round(lf/denom*1000)/10,
    hfnu:     Math.round(hf/denom*1000)/10,
    lfhf:     hf>0 ? Math.round(lf/hf*1000)/1000 : 999,
    totalPow: Math.round(total*freqRes*1e6)/1e3
  };
}

function welchPSD(signal, segLen, overlap, fs) {
  const step   = segLen - overlap;
  const nSegs  = Math.floor((signal.length - overlap) / step);
  const psd    = new Array(segLen).fill(0);
  const hann   = Array.from({length:segLen}, (_,i) => 0.5*(1-Math.cos(2*Math.PI*i/(segLen-1))));
  const hPow   = hann.reduce((s,v)=>s+v**2,0);

  for (let s = 0; s < nSegs; s++) {
    const start   = s * step;
    const seg     = signal.slice(start, start+segLen).map((v,i)=>v*hann[i]);
    const fftMag  = fftMagnitude(seg);
    fftMag.forEach((v,i) => psd[i] += v**2 / (hPow * fs));
  }
  return psd.map(v => v / nSegs).slice(0, Math.floor(segLen/2)+1);
}

function fftMagnitude(signal) {
  const N   = signal.length;
  const re  = [...signal];
  const im  = new Array(N).fill(0);
  // Cooley-Tukey in-place
  for (let size=2; size<=N; size*=2) {
    const half=size/2, step=-2*Math.PI/size;
    for (let i=0;i<N;i+=size) for (let j=0;j<half;j++) {
      const a=step*j, cos=Math.cos(a), sin=Math.sin(a);
      const tr=cos*re[i+j+half]-sin*im[i+j+half];
      const ti=sin*re[i+j+half]+cos*im[i+j+half];
      re[i+j+half]=re[i+j]-tr; im[i+j+half]=im[i+j]-ti;
      re[i+j]+=tr; im[i+j]+=ti;
    }
  }
  let j=0;
  for (let i=1;i<N;i++) {
    let bit=N>>1; for(;j&bit;bit>>=1)j^=bit; j^=bit;
    if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}
  }
  return re.map((r,i)=>Math.sqrt(r**2+im[i]**2));
}

function linInterp(xSrc, ySrc, xDst) {
  const out=[]; let j=0;
  for (const x of xDst) {
    while (j<xSrc.length-2 && xSrc[j+1]<x) j++;
    const t=(x-xSrc[j])/(xSrc[j+1]-xSrc[j]||1);
    out.push(ySrc[j]+t*(ySrc[j+1]-ySrc[j]));
  }
  return out;
}

function approximateEntropy(rr, m, r) {
  const n = rr.length;
  if (n < 2*m) return 0;
  function phi(m_) {
    let count=0, total=0;
    for (let i=0; i<=n-m_; i++) {
      let c=0;
      for (let j=0; j<=n-m_; j++) {
        if (i===j) continue;
        let maxDiff=0;
        for (let k=0;k<m_;k++) maxDiff=Math.max(maxDiff,Math.abs(rr[i+k]-rr[j+k]));
        if (maxDiff<=r) c++;
      }
      if (c>0) { count+=Math.log(c/(n-m_)); total++; }
    }
    return total>0 ? count/total : 0;
  }
  return Math.round((phi(m) - phi(m+1)) * 1000) / 1000;
}

// ── Download helper ──────────────────────────────────────────────────────────
function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: filename
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// Boot
showScreen('consent');
