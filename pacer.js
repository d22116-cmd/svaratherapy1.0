/**
 * pacer.js — Breathing Pacer with Solfeggio Audio Cues
 * 3-4-7 ratio: Inhale 3s, Hold 4s, Exhale 7s = 14s/cycle
 * 6 minutes = 360 seconds / 14 ≈ 25.7 → 26 cycles
 * Audio: Web Audio API, Solfeggio frequencies (528, 396, 285, 639 Hz)
 */

const CYCLE_SEC   = 14;   // 3+4+7
const INHALE_SEC  = 3;
const HOLD_SEC    = 4;
const EXHALE_SEC  = 7;
const TOTAL_SEC   = 360;  // 6 minutes
const TOTAL_CYCLES = Math.ceil(TOTAL_SEC / CYCLE_SEC); // 26

const PHASE_INHALE = 'inhale';
const PHASE_HOLD   = 'hold';
const PHASE_EXHALE = 'exhale';

// Solfeggio frequencies
const FREQ_INHALE  = 528;  // MI — transformation
const FREQ_HOLD    = 396;  // UT — liberation
const FREQ_EXHALE  = 285;  // UT low — consciousness
const FREQ_DONE    = 639;  // FA — connection

const CONDITION_TEXT = {
  chandra: {
    icon: '🌙',
    label: 'Chandra Bhedana',
    text: 'Close your right nostril with your right thumb. Inhale slowly through your <strong>LEFT nostril</strong> only.'
  },
  surya: {
    icon: '☀️',
    label: 'Surya Bhedana',
    text: 'Close your left nostril with your right ring finger. Inhale slowly through your <strong>RIGHT nostril</strong> only.'
  },
  control: {
    icon: '🌬️',
    label: 'Control',
    text: 'Breathe naturally and comfortably through <strong>both nostrils</strong>.'
  }
};

const PHASE_COLORS = {
  inhale: { bg: '#4caf82', glow: 'rgba(76,175,130,0.5)', ring: 'rgba(76,175,130,0.3)' },
  hold:   { bg: '#f5c842', glow: 'rgba(245,200,66,0.5)',  ring: 'rgba(245,200,66,0.3)' },
  exhale: { bg: '#5c9eff', glow: 'rgba(92,158,255,0.5)', ring: 'rgba(92,158,255,0.3)' }
};

export class BreathPacer {
  constructor({ onComplete }) {
    this.onComplete = onComplete;
    this.muted      = false;
    this.audioCtx   = null;
    this.running    = false;
    this.timer      = null;
    this.elapsed    = 0;
    this.cycle      = 0;
    this.phase      = null;
    this.phaseElapsed = 0;

    // DOM refs
    this.circleEl   = document.getElementById('pacer-circle');
    this.ringEl     = document.getElementById('pacer-ring');
    this.phaseLabel = document.getElementById('pacer-phase');
    this.innerText  = document.getElementById('pacer-inner-text');
    this.countdown  = document.getElementById('breathing-countdown');
    this.cycleLabel = document.getElementById('cycle-label');
    this.progress   = document.getElementById('breath-progress');
    this.muteBtn    = document.getElementById('mute-btn');
    this.condCard   = document.getElementById('condition-card');
  }

  init(condition) {
    const info = CONDITION_TEXT[condition] || CONDITION_TEXT.control;
    this.condCard.innerHTML = `
      <strong>${info.icon} ${info.label}</strong>
      ${info.text}
    `;
    this.muteBtn.classList.add('visible');
    this.muteBtn.addEventListener('click', () => this._toggleMute());
  }

  start() {
    this.running = true;
    this.elapsed = 0;
    this.cycle   = 0;
    this._initAudio();
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.muteBtn.classList.remove('visible');
  }

  _toggleMute() {
    this.muted = !this.muted;
    this.muteBtn.textContent = this.muted ? '🔇' : '🔊';
  }

  _initAudio() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) {
      console.warn('Web Audio API not available:', e);
    }
  }

  _playTone(freq, duration, fadeIn=0.3, fadeOut=0.3) {
    if (this.muted || !this.audioCtx) return;
    try {
      const osc  = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
      const now = this.audioCtx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + fadeIn);
      gain.gain.setValueAtTime(0.18, now + duration - fadeOut);
      gain.gain.linearRampToValueAtTime(0, now + duration);
      osc.start(now);
      osc.stop(now + duration);
    } catch(e) {}
  }

  _tick() {
    if (!this.running) return;

    const remaining = TOTAL_SEC - this.elapsed;
    const mins = Math.floor(remaining / 60);
    const secs = Math.floor(remaining % 60);
    this.countdown.textContent = `${mins}:${secs.toString().padStart(2,'0')}`;

    const progress = (this.elapsed / TOTAL_SEC) * 100;
    this.progress.style.width = `${progress}%`;

    if (this.elapsed >= TOTAL_SEC) {
      this._complete();
      return;
    }

    // Determine current phase within cycle
    const cyclePos = this.elapsed % CYCLE_SEC;
    this.cycle = Math.floor(this.elapsed / CYCLE_SEC) + 1;
    this.cycleLabel.textContent = `Cycle ${Math.min(this.cycle, TOTAL_CYCLES)} of ${TOTAL_CYCLES}`;

    let newPhase;
    if (cyclePos < INHALE_SEC) {
      newPhase = PHASE_INHALE;
    } else if (cyclePos < INHALE_SEC + HOLD_SEC) {
      newPhase = PHASE_HOLD;
    } else {
      newPhase = PHASE_EXHALE;
    }

    if (newPhase !== this.phase) {
      this.phase = newPhase;
      this._transitionPhase(newPhase);
    }

    this.elapsed++;
    this.timer = setTimeout(() => this._tick(), 1000);
  }

  _transitionPhase(phase) {
    const colors = PHASE_COLORS[phase];

    // Update label
    const labels = { inhale: 'Inhale…', hold: 'Hold…', exhale: 'Exhale…' };
    this.phaseLabel.textContent = labels[phase];
    this.phaseLabel.style.color = colors.bg;

    // Remove old phase classes
    this.circleEl.classList.remove('phase-inhale', 'phase-hold', 'phase-exhale');

    // Update ring color
    this.ringEl.style.borderColor = colors.ring;
    this.ringEl.style.boxShadow   = `0 0 40px ${colors.ring}`;

    if (phase === PHASE_INHALE) {
      // Expand circle over 3 seconds
      this.circleEl.classList.add('phase-inhale');
      this.circleEl.style.width  = '200px';
      this.circleEl.style.height = '200px';
      this.circleEl.style.background = `radial-gradient(circle at 35% 35%, ${colors.bg}, ${darken(colors.bg)})`;
      this.circleEl.style.boxShadow  = `0 0 50px ${colors.glow}`;
      this.innerText.textContent = `${INHALE_SEC}`;
      this._playTone(FREQ_INHALE, INHALE_SEC - 0.3, 0.3, 0.3);

    } else if (phase === PHASE_HOLD) {
      this.circleEl.classList.add('phase-hold');
      this.circleEl.style.background = `radial-gradient(circle at 35% 35%, ${colors.bg}, ${darken(colors.bg)})`;
      this.circleEl.style.boxShadow  = `0 0 60px ${colors.glow}`;
      this.innerText.textContent = `${HOLD_SEC}`;
      this._playTone(FREQ_HOLD, 0.8, 0.1, 0.2);

    } else if (phase === PHASE_EXHALE) {
      // Contract circle over 7 seconds
      this.circleEl.classList.add('phase-exhale');
      this.circleEl.style.width  = '80px';
      this.circleEl.style.height = '80px';
      this.circleEl.style.background = `radial-gradient(circle at 35% 35%, ${colors.bg}, ${darken(colors.bg)})`;
      this.circleEl.style.boxShadow  = `0 0 30px ${colors.glow}`;
      this.innerText.textContent = `${EXHALE_SEC}`;
      this._playTone(FREQ_EXHALE, EXHALE_SEC - 0.3, 0.3, 0.3);
    }
  }

  _complete() {
    this.running = false;
    this.phaseLabel.textContent = 'Complete 🙏';
    this.circleEl.classList.remove('phase-inhale','phase-hold','phase-exhale');
    this.circleEl.style.width  = '120px';
    this.circleEl.style.height = '120px';
    this.circleEl.style.background = 'radial-gradient(circle at 35% 35%, #FF9933, #c06000)';
    this.circleEl.style.boxShadow  = '0 0 60px rgba(255,153,51,0.6)';
    this.progress.style.width = '100%';
    this.countdown.textContent = '0:00';
    this._playTone(FREQ_DONE, 1.5, 0.3, 0.5);
    setTimeout(() => {
      this.muteBtn.classList.remove('visible');
      this.onComplete();
    }, 2500);
  }
}

function darken(hex) {
  // Simple darkener for gradient stops
  const map = {
    '#4caf82': '#1e7a4c',
    '#f5c842': '#c49a00',
    '#5c9eff': '#1a5fcc',
    '#FF9933': '#c06000'
  };
  return map[hex] || '#333';
}
