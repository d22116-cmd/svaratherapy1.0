/**
 * app.js — SvaraTherapy State Machine
 * FIXED: FaceMesh initialize() before sending frames, lower detection threshold,
 *        button no longer blocked by face detection (warning only)
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
  selectedDeviceId: null,
  baseline:         null,
  post:             null,
  pre:              null,
  postQ:            null,
  baselineRR:       [],
  postRR:           []
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
  const camBtns = document.getElementById('cam-buttons');
  const camGroup = document.getElementById('cam-select-group');
  camBtns.innerHTML = '<span class="cam-detecting">Detecting cameras…</span>';
  camGroup.style.display = 'block';

  // Need permission first so labels are populated
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach(t => t.stop());
  } catch(e) {
    camBtns.innerHTML = `<span class="cam-error">Camera access denied. Please allow camera in browser settings.</span>`;
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
    } else if (lower.includes('usb')      || lower.includes('logitech') ||
               lower.includes('brio')     || lower.includes('c920')     ||
               lower.includes('c922')     || lower.includes('razer')    ||
               lower.includes('webcam')   || lower.includes('external')) {
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

  // Auto-select first camera
  const firstBtn = camBtns.querySelector('.cam-btn');
  if (firstBtn) selectCamera(videoDevices[0].deviceId, firstBtn);
}

async function selectCamera(deviceId, clickedBtn) {
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('selected'));
  clickedBtn.classList.add('selected');
  S.selectedDeviceId = deviceId;

  // Tear down previous
  frameActive     = false;
  meshInitialized = false;
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
  if (setupFaceMesh) { try { setupFaceMesh.close(); } catch(e) {} setupFaceMesh = null; }

  const video  = document.getElementById('setup-video');
  const canvas = document.getElementById('setup-canvas');
  const badge  = document.getElementById('face-indicator');
  badge.className   = 'face-badge face-no';
  badge.textContent = 'Loading…';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: 640, height: 480, frameRate: { ideal: 30 } },
      audio: false
    });
    currentStream   = stream;
    video.srcObject = stream;
    await video.play();
  } catch(e) {
    badge.textContent = 'Camera Error: ' + e.message;
    return;
  }

  badge.textContent = 'Loading face detection…';
  await startSetupFaceMesh(video, canvas);
  checkSetupReady();
}

async function startSetupFaceMesh(video, canvas) {
  const ctx   = canvas.getContext('2d');
  const badge = document.getElementById('face-indicator');

  // Create FaceMesh
  setupFaceMesh = new FaceMesh({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
  });

  // LOW confidence thresholds for better detection at distance / with glasses
  setupFaceMesh.setOptions({
    maxNumFaces:            1,
    refineLandmarks:        false,
    minDetectionConfidence: 0.3,   // lowered from 0.5
    minTrackingConfidence:  0.3    // lowered from 0.5
  });

  setupFaceMesh.onResults(r => {
    if (!frameActive) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const found = r.multiFaceLandmarks && r.multiFaceLandmarks.length > 0;
    badge.className   = `face-badge ${found ? 'face-ok' : 'face-no'}`;
    badge.textContent = found ? '✓ Face OK' : 'No Face — move closer';

    if (found) {
      // Draw mesh dots
      const lm = r.multiFaceLandmarks[0];
      ctx.fillStyle = 'rgba(255,153,51,0.5)';
      lm.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 1.2, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    checkSetupReady();
  });

  // *** CRITICAL: initialize() loads the WASM model — must await before sending frames ***
  try {
    badge.textContent = 'Loading AI model…';
    await setupFaceMesh.initialize();
    badge.textContent = 'Model ready — detecting…';
    meshInitialized   = true;
  } catch(e) {
    badge.textContent = 'Model load failed — try refreshing';
    console.error('FaceMesh init error:', e);
    return;
  }

  // Start frame loop
  frameActive = true;
  const loop = async () => {
    if (!frameActive || !meshInitialized) return;
    if (!video.paused && video.readyState >= 2) {
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      try {
        await setupFaceMesh.send({ image: video });
      } catch(e) {
        // ignore single-frame errors
      }
    }
    requestAnimationFrame(loop);
  };

  loop();
}

function checkSetupReady() {
  const email     = document.getElementById('setup-email').value.trim();
  const condition = document.getElementById('setup-condition').value;
  const session   = document.getElementById('setup-session').value;
  const badge     = document.getElementById('face-indicator');
  const faceOK    = badge.classList.contains('face-ok');

  // Form fields must be filled + camera selected
  const formReady = email && condition && session && S.selectedDeviceId;
  document.getElementById('btn-setup').disabled = !formReady;

  // Show warning if face not detected but don't block
  const warnEl = document.getElementById('face-warn');
  if (warnEl) {
    warnEl.style.display = formReady && !faceOK ? 'block' : 'none';
  }
}

['setup-email', 'setup-condition', 'setup-session'].forEach(id => {
  document.getElementById(id).addEventListener('input',  checkSetupReady);
  document.getElementById(id).addEventListener('change', checkSetupReady);
});

document.getElementById('btn-setup').addEventListener('click', () => {
  S.email         = document.getElementById('setup-email').value.trim();
  S.condition     = document.getElementById('setup-condition').value;
  S.sessionNumber = parseInt(document.getElementById('setup-session').value);

  // Stop setup camera
  frameActive     = false;
  meshInitialized = false;
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
  if (setupFaceMesh) { try { setupFaceMesh.close(); } catch(e) {} setupFaceMesh = null; }

  showScreen('baseline');
  startRPPGRecording('baseline');
});

// ═══════════════════════════════════════════════════════════════════════════
// rPPG RECORDING — shared for baseline + post
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

  let elapsed  = 0;
  const DURATION = 180;

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
      const x = (i / show) * cw;
      const y = ch / 2 - (v / maxV) * (ch / 2 - 8);
      i === 0 ? pulseCtx.moveTo(x, y) : pulseCtx.lineTo(x, y);
    });
    pulseCtx.stroke();
  };

  const onQuality = (q) => {
    const pct = Math.round(q * 100);
    document.getElementById(qualFillId).style.width = `${pct}%`;
    document.getElementById(qualLblId).textContent  = `Quality: ${pct}%`;
    statusEl.textContent = q > 0.8
      ? (elapsed < 30 ? `Collecting (${elapsed}/30s before metrics show)` : '● Recording live')
      : 'Keep face fully in view — good lighting helps';
  };

  const engine = new RPPGEngine(video, overlay, onMetrics, onPulse, onQuality, S.selectedDeviceId);
  if (isBaseline) baselineEngine = engine;
  else            postEngine     = engine;

  engine.start().then(() => {
    statusEl.textContent = 'Recording — sit still…';
    recordingTimer = setInterval(() => {
      elapsed++;
      const rem = DURATION - elapsed;
      countEl.textContent = `${Math.floor(rem / 60)}:${(rem % 60).toString().padStart(2, '0')}`;
      if (elapsed >= DURATION) {
        clearInterval(recordingTimer);
        statusEl.textContent = 'Complete ✓';
        engine.stop();
        const results = engine.getResults();
        if (isBaseline) {
          S.baseline   = results;
          S.baselineRR = results.rrIntervals || [];
          showScreen('preq');
          initPreQ();
        } else {
          S.post    = results;
          S.postRR  = results.rrIntervals || [];
          showScreen('postq');
          initPostQ();
        }
      }
    }, 1000);
  }).catch(e => {
    statusEl.textContent = 'Camera error: ' + e.message;
  });
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
  showScreen('breathing');
  initBreathing();
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
  showScreen('results');
  renderResults();
});

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 8 — RESULTS
// ═══════════════════════════════════════════════════════════════════════════
function renderResults() {
  const tbody = document.getElementById('results-body');
  tbody.innerHTML = '';
  const rows = [
    { label: 'Heart Rate (bpm)', bKey: 'hr_bpm',      pKey: 'hr_bpm',      higherBetter: false },
    { label: 'RMSSD (ms)',        bKey: 'rmssd',        pKey: 'rmssd',        higherBetter: true  },
    { label: 'LF/HF Ratio',       bKey: 'lf_hf_ratio', pKey: 'lf_hf_ratio', higherBetter: false },
    { label: 'GAD-2 Score',        bKey: null,           pKey: null,           higherBetter: false, manual: true }
  ];
  rows.forEach(row => {
    let before, after, changeClass = 'change-nil', changeStr = '—';
    if (row.manual) {
      before = S.pre?.gad2 ?? '—'; after = S.postQ?.gad2 ?? '—';
      if (typeof before === 'number' && typeof after === 'number') {
        const d = after - before;
        changeClass = d < 0 ? 'change-up' : d > 0 ? 'change-down' : 'change-nil';
        changeStr = `${d > 0 ? '+' : ''}${d}`;
      }
    } else {
      before = S.baseline?.[row.bKey] ?? null;
      after  = S.post?.[row.pKey]     ?? null;
      if (before !== null && after !== null) {
        const d    = after - before;
        const good = row.higherBetter ? (d > 0) : (d < 0);
        changeClass = Math.abs(d) < 0.1 ? 'change-nil' : good ? 'change-up' : 'change-down';
        changeStr = `${d > 0 ? '+' : ''}${Math.round(d * 10) / 10}`;
      } else { before = before ?? '—'; after = after ?? '—'; }
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.label}</td>
      <td>${typeof before === 'number' ? Math.round(before * 10) / 10 : before}</td>
      <td>${typeof after  === 'number' ? Math.round(after  * 10) / 10 : after}</td>
      <td class="${changeClass}">${changeStr}</td>`;
    tbody.appendChild(tr);
  });

  const cond = S.condition;
  const rd   = (S.post?.rmssd ?? 0) - (S.baseline?.rmssd ?? 0);
  const gd   = (S.postQ?.gad2 ?? 0) - (S.pre?.gad2 ?? 0);
  let txt = '';
  if (cond === 'chandra') {
    txt = rd > 0
      ? `<strong>Parasympathetic activation detected.</strong> RMSSD +${Math.round(rd * 10) / 10} ms following Chandra Bhedana — consistent with Ida Nadi and parasympathetic upregulation (Svara Yoga).`
      : `RMSSD decreased ${Math.abs(Math.round(rd * 10) / 10)} ms. Check signal quality; backlit or low-light conditions affect rPPG accuracy.`;
  } else if (cond === 'surya') {
    txt = rd < 0
      ? `<strong>Sympathetic activation detected.</strong> RMSSD −${Math.abs(Math.round(rd * 10) / 10)} ms following Surya Bhedana — consistent with Pingala Nadi activation (Svara Yoga).`
      : `RMSSD increased +${Math.round(rd * 10) / 10} ms. Sympathetic effect may be more visible in LF/HF ratio.`;
  } else {
    txt = Math.abs(rd) < 5
      ? `Control completed. Minimal HRV change — consistent with resting baseline.`
      : `Control completed. HRV variation of ${Math.round(rd * 10) / 10} ms noted.`;
  }
  if (gd < 0) txt += ` GAD-2 reduced by ${Math.abs(gd)} point${Math.abs(gd) > 1 ? 's' : ''}.`;
  document.getElementById('interpretation-card').innerHTML = txt;
}

document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await saveSession(S);
    showScreen('saved');
    document.getElementById('saved-msg').textContent = `Session ${S.sessionNumber} saved successfully.`;
    document.getElementById('session-badge').textContent =
      `${new Date().toLocaleDateString()} · Session ${S.sessionNumber} · ${S.condition}`;
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Save Session Data →';
    alert(`Save failed: ${e.message}`);
  }
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const rows = [
    ...S.baselineRR.map((v, i) => `baseline,${i},${Math.round(v)}`),
    ...S.postRR.map((v, i)     => `post,${i},${Math.round(v)}`)
  ];
  const blob = new Blob(['phase,index,rr_interval_ms\n' + rows.join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `svaratherapy_rr_s${S.sessionNumber}_${S.condition}.csv`
  });
  a.click();
});

// Boot
showScreen('consent');
