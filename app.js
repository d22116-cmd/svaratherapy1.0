/**
 * app.js — SvaraTherapy State Machine
 * Screens: CONSENT → SETUP → BASELINE_RPPG → PRE_Q → BREATHING → POST_RPPG → POST_Q → RESULTS → SAVED
 */

import { RPPGEngine }    from './rppg.js';
import { BreathPacer }   from './pacer.js';
import { Questionnaire } from './questionnaire.js';
import { saveSession }   from './api.js';

// ── Global session state ─────────────────────────────────────────────────────
const S = {
  email:         '',
  condition:     '',
  sessionNumber: 1,
  baseline:      null,
  post:          null,
  pre:           null,
  postQ:         null,
  baselineRR:    [],
  postRR:        []
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
const consentCheck = document.getElementById('consent-check');
const btnConsent   = document.getElementById('btn-consent');

consentCheck.addEventListener('change', () => {
  btnConsent.disabled = !consentCheck.checked;
});

btnConsent.addEventListener('click', () => {
  showScreen('setup');
  startSetupCamera();
});

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 2 — SETUP
// ═══════════════════════════════════════════════════════════════════════════
let setupFaceMesh = null;
let setupCamera   = null;

async function startSetupCamera() {
  const video   = document.getElementById('setup-video');
  const canvas  = document.getElementById('setup-canvas');
  const ctx     = canvas.getContext('2d');
  const badge   = document.getElementById('face-indicator');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width:640, height:480, frameRate:30 }, audio: false
    });
    video.srcObject = stream;
    await video.play();
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
  } catch(e) {
    badge.textContent = 'Camera Error';
    return;
  }

  setupFaceMesh = new FaceMesh({ locateFile: f =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  setupFaceMesh.setOptions({
    maxNumFaces:1, refineLandmarks:false,
    minDetectionConfidence:0.5, minTrackingConfidence:0.5
  });
  setupFaceMesh.onResults(r => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const found = r.multiFaceLandmarks && r.multiFaceLandmarks.length > 0;
    badge.className = `face-badge ${found ? 'face-ok' : 'face-no'}`;
    badge.textContent = found ? '✓ Face OK' : 'No Face';
    if (found) {
      const lm = r.multiFaceLandmarks[0];
      ctx.strokeStyle = 'rgba(255,153,51,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      lm.forEach((p,i) => {
        const x = p.x*canvas.width, y = p.y*canvas.height;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      });
    }
    checkSetupReady();
  });

  // Process frames
  const processFrame = async () => {
    if (!video.paused) {
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      await setupFaceMesh.send({ image: video });
    }
    requestAnimationFrame(processFrame);
  };
  video.addEventListener('loadeddata', processFrame);
}

function checkSetupReady() {
  const email     = document.getElementById('setup-email').value.trim();
  const condition = document.getElementById('setup-condition').value;
  const session   = document.getElementById('setup-session').value;
  const badge     = document.getElementById('face-indicator');
  document.getElementById('btn-setup').disabled =
    !email || !condition || !session || badge.classList.contains('face-no');
}

['setup-email','setup-condition','setup-session'].forEach(id => {
  document.getElementById(id).addEventListener('input', checkSetupReady);
  document.getElementById(id).addEventListener('change', checkSetupReady);
});

document.getElementById('btn-setup').addEventListener('click', () => {
  S.email         = document.getElementById('setup-email').value.trim();
  S.condition     = document.getElementById('setup-condition').value;
  S.sessionNumber = parseInt(document.getElementById('setup-session').value);

  // Stop setup camera
  const v = document.getElementById('setup-video');
  if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
  if (setupFaceMesh) setupFaceMesh.close();

  showScreen('baseline');
  startRPPGRecording('baseline');
});

// ═══════════════════════════════════════════════════════════════════════════
// rPPG RECORDING — shared logic for baseline and post
// ═══════════════════════════════════════════════════════════════════════════

let baselineEngine = null;
let postEngine     = null;
let recordingTimer = null;

function startRPPGRecording(phase) {
  const isBaseline = phase === 'baseline';
  const videoId    = isBaseline ? 'rppg-video'     : 'rppg-video-post';
  const overlayId  = isBaseline ? 'rppg-overlay'   : 'rppg-overlay-post';
  const countId    = isBaseline ? 'baseline-countdown' : 'post-countdown';
  const statusId   = isBaseline ? 'baseline-status'    : 'post-status';
  const hrId       = isBaseline ? 'live-hr'     : 'live-hr-post';
  const rmssdId    = isBaseline ? 'live-rmssd'  : 'live-rmssd-post';
  const lfhfId     = isBaseline ? 'live-lfhf'   : 'live-lfhf-post';
  const qualFillId = isBaseline ? 'quality-fill'  : 'quality-fill-post';
  const qualLblId  = isBaseline ? 'quality-label' : 'quality-label-post';
  const pulseId    = isBaseline ? 'pulse-canvas'  : 'pulse-canvas-post';

  const video   = document.getElementById(videoId);
  const overlay = document.getElementById(overlayId);
  const statusEl= document.getElementById(statusId);
  const countEl = document.getElementById(countId);
  const pulseCanvas = document.getElementById(pulseId);
  const pulseCtx    = pulseCanvas.getContext('2d');

  let elapsed = 0;
  const DURATION = 180; // 3 minutes

  statusEl.textContent = 'Initializing MediaPipe…';

  // Metrics callbacks
  const onMetrics = ({ hr, rmssd, lfhf }) => {
    if (elapsed < 30) return; // wait 30s
    document.getElementById(hrId).textContent    = hr    !== null ? hr    : '—';
    document.getElementById(rmssdId).textContent = rmssd !== null ? rmssd : '—';
    document.getElementById(lfhfId).textContent  = lfhf  !== null ? lfhf  : '—';
  };

  const onPulse = (signal) => {
    if (!signal || signal.length < 2) return;
    const cw = pulseCanvas.width  = pulseCanvas.offsetWidth || 400;
    const ch = pulseCanvas.height = 80;
    pulseCtx.clearRect(0, 0, cw, ch);

    // Show last 10s = 600 samples at 60Hz
    const show = Math.min(signal.length, 600);
    const seg  = signal.slice(signal.length - show);
    const maxV = Math.max(...seg.map(Math.abs)) || 1;

    pulseCtx.strokeStyle = '#FF9933';
    pulseCtx.lineWidth   = 1.5;
    pulseCtx.beginPath();
    seg.forEach((v, i) => {
      const x = (i / show) * cw;
      const y = ch/2 - (v / maxV) * (ch/2 - 8);
      if (i === 0) pulseCtx.moveTo(x, y);
      else         pulseCtx.lineTo(x, y);
    });
    pulseCtx.stroke();
  };

  const onQuality = (q) => {
    const pct = Math.round(q * 100);
    document.getElementById(qualFillId).style.width = `${pct}%`;
    document.getElementById(qualLblId).textContent  = `Quality: ${pct}%`;
    if (q > 0.8) statusEl.textContent = elapsed < 30
      ? `Collecting data (${elapsed}/30s)`
      : '● Recording';
    else statusEl.textContent = 'Keep face in view…';
  };

  const engine = new RPPGEngine(video, overlay, onMetrics, onPulse, onQuality);
  if (isBaseline) baselineEngine = engine;
  else            postEngine     = engine;

  engine.start().then(() => {
    statusEl.textContent = 'Face detected — recording…';

    // Countdown
    recordingTimer = setInterval(() => {
      elapsed++;
      const rem  = DURATION - elapsed;
      const mins = Math.floor(rem / 60);
      const secs = rem % 60;
      countEl.textContent = `${mins}:${secs.toString().padStart(2,'0')}`;

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
    onComplete: () => {
      showScreen('post');
      startRPPGRecording('post');
    }
  });
  pacer.init(S.condition);
  // Small delay before starting
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
  slider.addEventListener('input', () => {
    valEl.textContent = slider.value;
    checkPostQReady();
  });

  function checkPostQReady() {
    const scores = postQ.getScores();
    const allAnswered = ['gad2_0','gad2_1','phq2_0','phq2_1'].every(
      k => postQ.answers[k] !== undefined
    );
    document.getElementById('btn-postq').disabled = !allAnswered;
  }

  // Override questionnaire's internal check to include calm slider
  const origCheck = postQ._checkComplete.bind(postQ);
  postQ._checkComplete = () => { origCheck(); };
}

document.getElementById('btn-postq').addEventListener('click', () => {
  const scores = postQ.getScores();
  S.postQ = {
    gad2: scores.gad2,
    phq2: scores.phq2,
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
    let before, after, delta, changeClass, changeStr;

    if (row.manual) {
      before = S.pre?.gad2  ?? '—';
      after  = S.postQ?.gad2 ?? '—';
      if (typeof before === 'number' && typeof after === 'number') {
        delta = after - before;
        changeClass = delta < 0 ? 'change-up' : delta > 0 ? 'change-down' : 'change-nil';
        changeStr   = `${delta > 0 ? '+' : ''}${delta}`;
      } else { changeStr = '—'; changeClass = 'change-nil'; }
    } else {
      before = S.baseline?.[row.bKey] ?? null;
      after  = S.post?.[row.pKey]     ?? null;
      if (before !== null && after !== null) {
        delta = after - before;
        const sign = row.higherBetter ? (delta > 0) : (delta < 0);
        changeClass = Math.abs(delta) < 0.1 ? 'change-nil' : sign ? 'change-up' : 'change-down';
        changeStr   = `${delta > 0 ? '+' : ''}${Math.round(delta*10)/10}`;
      } else {
        before = before ?? '—'; after = after ?? '—';
        changeStr = '—'; changeClass = 'change-nil';
      }
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.label}</td>
      <td>${typeof before==='number' ? Math.round(before*10)/10 : before}</td>
      <td>${typeof after==='number'  ? Math.round(after*10)/10  : after}</td>
      <td class="${changeClass}">${changeStr}</td>
    `;
    tbody.appendChild(tr);
  });

  // Interpretation
  const interp = document.getElementById('interpretation-card');
  const cond = S.condition;
  const rmssdDelta = (S.post?.rmssd ?? 0) - (S.baseline?.rmssd ?? 0);
  const gad2Delta  = (S.postQ?.gad2 ?? 0) - (S.pre?.gad2 ?? 0);

  let text = '';
  if (cond === 'chandra') {
    text = rmssdDelta > 0
      ? `<strong>Parasympathetic activation detected.</strong> RMSSD increased by ${Math.round(rmssdDelta*10)/10} ms following Chandra Bhedana. This aligns with classical Svara Yoga predictions — left nostril breathing activates Ida Nadi, associated with cooling and parasympathetic dominance.`
      : `RMSSD showed a ${Math.abs(Math.round(rmssdDelta*10)/10)} ms decrease following Chandra Bhedana. Signal quality and movement artefacts can influence rPPG-derived HRV; review quality flags before interpreting.`;
  } else if (cond === 'surya') {
    text = rmssdDelta < 0
      ? `<strong>Sympathetic activation pattern detected.</strong> RMSSD decreased by ${Math.abs(Math.round(rmssdDelta*10)/10)} ms following Surya Bhedana. This aligns with classical Svara Yoga — right nostril activates Pingala Nadi, associated with warmth and sympathetic arousal.`
      : `RMSSD increased following Surya Bhedana (${Math.round(rmssdDelta*10)/10} ms). Individual variation is common; sympathetic effects may manifest more strongly in LF/HF ratio.`;
  } else {
    text = `Control condition completed. ${Math.abs(rmssdDelta) < 5 ? 'Minimal HRV change observed, consistent with resting baseline.' : 'Some HRV variation observed — this will be accounted for in group-level analysis.'}`;
  }

  if (gad2Delta < 0) text += ` GAD-2 anxiety score reduced by ${Math.abs(gad2Delta)} point${Math.abs(gad2Delta)>1?'s':''}.`;

  interp.innerHTML = text;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 8 — SAVE & EXPORT
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await saveSession(S);
    showScreen('saved');
    document.getElementById('saved-msg').textContent =
      `Session ${S.sessionNumber} data saved successfully.`;
    document.getElementById('session-badge').textContent =
      `${new Date().toLocaleDateString()} · Session ${S.sessionNumber} · ${S.condition}`;
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Save Session Data →';
    alert(`Save failed: ${e.message}\n\nCheck your Supabase connection.`);
  }
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const allRR = [
    ...S.baselineRR.map((v,i) => `baseline,${i},${Math.round(v)}`),
    ...S.postRR.map((v,i)     => `post,${i},${Math.round(v)}`)
  ];
  const csv = 'phase,index,rr_interval_ms\n' + allRR.join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `svaratherapy_rr_session${S.sessionNumber}_${S.condition}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Initial screen ────────────────────────────────────────────────────────────
showScreen('consent');
