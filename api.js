/**
 * api.js — Supabase backend integration
 *
 * SCHEMA (already created in Supabase SQL editor):
 * ─────────────────────────────────────────────────
 * CREATE TABLE sessions (
 *   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *   created_at TIMESTAMPTZ DEFAULT NOW(),
 *   participant_email TEXT,
 *   session_number INTEGER,
 *   condition TEXT CHECK (condition IN ('chandra','surya','control')),
 *   baseline_hr NUMERIC, baseline_rmssd NUMERIC, baseline_lf_hf NUMERIC, baseline_quality BOOLEAN,
 *   post_hr NUMERIC, post_rmssd NUMERIC, post_lf_hf NUMERIC, post_quality BOOLEAN,
 *   pre_gad2 INTEGER, pre_phq2 INTEGER, post_gad2 INTEGER, post_phq2 INTEGER,
 *   calm_rating INTEGER,
 *   delta_rmssd NUMERIC GENERATED ALWAYS AS (post_rmssd - baseline_rmssd) STORED,
 *   delta_gad2 INTEGER GENERATED ALWAYS AS (post_gad2 - pre_gad2) STORED
 * );
 * ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
 * CREATE POLICY "Allow insert" ON sessions FOR INSERT WITH CHECK (true);
 * CREATE POLICY "Allow select" ON sessions FOR SELECT USING (true);
 */

const SUPABASE_URL      = 'https://tpvhslqrwciofblomelw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vRU4FzLNia0gTY43UUz1rw_cCvcrs8z';

let _client = null;

function getClient() {
  if (!_client) {
    _client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _client;
}

export async function saveSession(sessionState) {
  const db = getClient();

  const row = {
    participant_email: sessionState.email,
    session_number:    sessionState.sessionNumber,
    condition:         sessionState.condition,

    baseline_hr:      sessionState.baseline?.hr_bpm      ?? null,
    baseline_rmssd:   sessionState.baseline?.rmssd        ?? null,
    baseline_lf_hf:   sessionState.baseline?.lf_hf_ratio  ?? null,
    baseline_quality: sessionState.baseline?.quality_flag ?? null,

    post_hr:           sessionState.post?.hr_bpm      ?? null,
    post_rmssd:        sessionState.post?.rmssd        ?? null,
    post_lf_hf:        sessionState.post?.lf_hf_ratio  ?? null,
    post_quality:      sessionState.post?.quality_flag ?? null,

    pre_gad2:  sessionState.pre?.gad2  ?? null,
    pre_phq2:  sessionState.pre?.phq2  ?? null,
    post_gad2: sessionState.postQ?.gad2 ?? null,
    post_phq2: sessionState.postQ?.phq2 ?? null,

    calm_rating: sessionState.postQ?.calm ?? null
  };

  const { data, error } = await db.from('sessions').insert([row]).select();
  if (error) throw error;
  return data;
}
