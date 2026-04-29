/**
 * questionnaire.js — GAD-2 and PHQ-2 scales
 * Validated ultra-brief screening instruments
 */

const SCALE_OPTIONS = [
  { label: 'Not at all',             value: 0 },
  { label: 'Several days',           value: 1 },
  { label: 'More than half the days',value: 2 },
  { label: 'Nearly every day',       value: 3 }
];

const GAD2_ITEMS = [
  'Feeling nervous, anxious, or on edge',
  'Not being able to stop or control worrying'
];

const PHQ2_ITEMS = [
  'Little interest or pleasure in doing things',
  'Feeling down, depressed, or hopeless'
];

export class Questionnaire {
  constructor(containerId, submitBtnId, phase) {
    this.container = document.getElementById(containerId);
    this.submitBtn = document.getElementById(submitBtnId);
    this.phase     = phase; // 'pre' or 'post'
    this.answers   = {};    // itemId → value
  }

  render() {
    this.container.innerHTML = '';

    // GAD-2
    this._renderGroup('GAD-2 — Anxiety', 'gad2', GAD2_ITEMS);
    // PHQ-2
    this._renderGroup('PHQ-2 — Mood', 'phq2', PHQ2_ITEMS);

    this._checkComplete();
  }

  _renderGroup(title, prefix, items) {
    const group = document.createElement('div');
    group.className = 'q-group';
    group.innerHTML = `<div class="q-group-title">${title}</div>`;

    items.forEach((text, idx) => {
      const itemId = `${prefix}_${idx}`;
      const item = document.createElement('div');
      item.className = 'q-item';
      item.innerHTML = `<div class="q-text">${text}</div>`;

      const opts = document.createElement('div');
      opts.className = 'q-options';
      SCALE_OPTIONS.forEach(opt => {
        const btn = document.createElement('div');
        btn.className = 'q-opt';
        btn.textContent = opt.label;
        btn.dataset.value = opt.value;
        btn.dataset.item  = itemId;
        btn.addEventListener('click', () => {
          // Deselect siblings
          opts.querySelectorAll('.q-opt').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          this.answers[itemId] = opt.value;
          this._checkComplete();
        });
        opts.appendChild(btn);
      });

      item.appendChild(opts);
      group.appendChild(item);
    });

    this.container.appendChild(group);
  }

  _checkComplete() {
    const required = ['gad2_0','gad2_1','phq2_0','phq2_1'];
    const allDone = required.every(k => this.answers[k] !== undefined);
    if (this.submitBtn) this.submitBtn.disabled = !allDone;
  }

  getScores() {
    const gad2 = (this.answers['gad2_0']||0) + (this.answers['gad2_1']||0);
    const phq2 = (this.answers['phq2_0']||0) + (this.answers['phq2_1']||0);
    return { gad2, phq2 };
  }
}
