/**
 * risk-engine.js — CANONICAL RISK ENGINE
 * ============================================================================
 * Single source of truth for THI / zone / risk-score calculation across the
 * whole Hemita Farm-Tech product line: paid BroilerOS tenants AND DWP-99
 * trial/lead usage both call this SAME code path.
 *
 * PROVENANCE: v2.0.0 recovers the CLINICAL 5-category risk model from
 * DWP-99 v3.0's `calcRisks()` (Heat Stress, SMS/SDS, Ascites/PHS, Wet
 * Litter, Mortality Forecast) — v1.0.0 of this file had ported v3.5.0's
 * `cRisk()` instead, which turned out to be a simplified/regressed version
 * that dropped 3 of those 5 named categories to generic proxies while still
 * showing the original 5 names on-screen. v3.0's reference-table-relative
 * WIR/FIR (actual vs age-appropriate target, not raw water:feed ratio) and
 * BW-deviation logic are recovered too — see calcRisksClinical() below for
 * the full history and the two deliberate adaptations made. `cTHI()`/
 * `gTZ()`/`clsTHI()` (age-dependent zones) are UNCHANGED from v3.5.0 —
 * that part was a genuine improvement over v3.0's fixed thresholds and is
 * kept.
 *
 * RULE GOING FORWARD (mirrors the rule DWP-99 already enforces around its
 * DataStore): no other file in either BroilerOS or DWP-99 should reimplement
 * THI/zone/risk math. If the formula needs to change, it changes HERE, and
 * both the DWP-99 frontend (offline fallback copy) and BroilerOS backend
 * (this file) get bumped together — see VERSION below.
 *
 * ---------------------------------------------------------------------------
 * INTEGRATION (BroilerOS backend index.js — confirmed against your actual
 * file, not a generic guess):
 *
 * Your file defines `pool`, `auth`, `requireSuperAdmin` around lines 40-363,
 * BEFORE the first route (`app.get('/', ...)` at line 368). Add these two
 * lines right after `requireClientAdmin` is defined (~line 363) and before
 * that first route:
 *
 *   const { createRiskRouter } = require('./risk-engine');
 *   app.use('/api', createRiskRouter({ pool, auth, requireSuperAdmin }));
 *
 * Do NOT wrap this app.use() call in `auth` itself (e.g. don't write
 * `app.use('/api', auth, createRiskRouter(...))`) — that would force auth on
 * EVERY route this router defines, including the public DWP-99 trial
 * endpoint below, which must stay unauthenticated. Each route inside this
 * file applies its own middleware individually instead, exactly like the
 * rest of your index.js does (e.g. `app.post('/api/water/predict', auth,
 * ...)`), not like a blanket `app.use(prefix, middleware, router)`.
 *
 * This adds three endpoints:
 *   POST /api/risk/calculate        — auth required (any logged-in tenant
 *                                      user). Stateless calculation, no
 *                                      floorId, so no ownership check needed.
 *   POST /api/dwp99/trial/telemetry — public, no auth (DWP-99 field installs
 *                                      have no JWT). Rate-limited instead,
 *                                      same pattern as your enumerationLimiter.
 *                                      Writes into the isolated dwp99_trial
 *                                      schema (see neon-dwp99-trial-schema.sql)
 *                                      — never the tenant tables.
 *   GET  /api/dwp99/trial/leads     — auth + requireSuperAdmin, same gate as
 *                                      your existing /api/admin/clients.
 * ---------------------------------------------------------------------------
 */

'use strict';

const VERSION = '2.0.0'; // v2.0.0: clinical 5-category model recovered from DWP-99 v3.0 — see below

// ----------------------------------------------------------------------------
// TEMPERATURE-HUMIDITY ZONES (age-dependent)
// Source: DWP-99 v3.5.0 `TZ` constant, KEPT — this age-dependent approach
// (Lara & Rostagno 2013 / Aviagen 2022) is physiologically correct (DOC
// needs heat, finisher needs cool) and already live in production, so v2.0.0
// does NOT revert to v3.0's fixed non-age-dependent thresholds (72/79/84/88).
// Only the risk-SCORING layer below changes, not the zone/THI layer.
// ----------------------------------------------------------------------------
const TZ = [
  { phase: 'Starter Awal',   min: 0,  max: 7,  comfort: 92, alert: 95, suhu: '30–33°C' },
  { phase: 'Starter Akhir',  min: 8,  max: 14, comfort: 89, alert: 93, suhu: '28–30°C' },
  { phase: 'Grower Awal',    min: 15, max: 21, comfort: 86, alert: 90, suhu: '26–28°C' },
  { phase: 'Grower Akhir',   min: 22, max: 28, comfort: 84, alert: 88, suhu: '24–26°C' },
  { phase: 'Finisher Awal',  min: 29, max: 35, comfort: 81, alert: 85, suhu: '22–24°C' },
  { phase: 'Finisher Akhir', min: 36, max: 60, comfort: 79, alert: 83, suhu: '≤22°C' },
];

/** Temperature-Humidity Index. Unchanged from v3.5.0's `cTHI()`. */
function cTHI(t, rh) {
  const tf = 1.8 * t + 32;
  return +(tf - (0.55 - 0.0055 * rh) * (tf - 58)).toFixed(1);
}

/** Age-appropriate comfort/alert zone. Unchanged from v3.5.0's `gTZ()`. */
function gTZ(age) {
  return TZ.find((z) => age >= z.min && age <= z.max) || TZ[TZ.length - 1];
}

/** THI classification within a zone. Unchanged from v3.5.0's `clsTHI()`. */
function clsTHI(thi, z) {
  if (thi <= z.comfort) return 'comfort';
  if (thi <= z.alert) return 'alert';
  return 'danger';
}

// ============================================================================
// DEFAULT REFERENCE TABLES — recovered from DWP-99 v3.0
// Source: CP Pokphand Indonesia SOP + Cobb500 2022 + Ross308 2022
// Water: Cobb500 thermoneutral mL/bird/day × 1.22 (koreksi tropis +22%)
// Feed:  standar CP Pokphand Indonesia g/bird/day
// BW:    target CP Pokphand gram (mixed sex)
// These are the DEFAULTS. A DWP-99 device may run with its own Manager-edited
// local override (see DWP99-RiskEngine-v3_6_0.html's getRef()/saveRef()) —
// this backend does NOT yet know about per-tenant overrides (no storage for
// that exists here), so BroilerOS tenants always score against these
// defaults for now. Flagged as a known gap, not silently glossed over: if a
// tenant's real farm runs a different breed standard, their BroilerOS risk
// score and their own DWP-99 device's locally-overridden score can diverge
// until per-tenant reference storage is built.
// ============================================================================
const DEF_WATER = {1:27,2:33,3:42,4:54,5:66,6:78,7:92,8:108,9:124,10:140,11:157,12:178,13:200,14:219,15:240,16:261,17:280,18:302,19:325,20:342,21:363,22:384,23:404,24:427,25:448,26:469,27:490,28:507,29:528,30:546,31:561,32:577,33:593,34:607,35:621,36:636,37:650,38:661,39:671,40:679,41:686,42:692};
const DEF_FEED = {1:15,2:17,3:20,4:24,5:28,6:32,7:37,8:43,9:49,10:55,11:62,12:70,13:78,14:85,15:93,16:102,17:111,18:120,19:130,20:140,21:150,22:160,23:171,24:182,25:193,26:204,27:215,28:224,29:234,30:244,31:253,32:263,33:271,34:279,35:286,36:293,37:300,38:305,39:310,40:314,41:317,42:320};
const DEF_BW = {1:50,2:68,3:89,4:115,5:143,6:175,7:205,8:243,9:285,10:328,11:375,12:424,13:476,14:525,15:580,16:638,17:698,18:760,19:824,20:890,21:960,22:1030,23:1105,24:1178,25:1252,26:1330,27:1408,28:1488,29:1568,30:1648,31:1728,32:1808,33:1882,34:1956,35:2025,36:2096,37:2163,38:2226,39:2284,40:2338,41:2387,42:2430};

function getRef() { return { water: DEF_WATER, feed: DEF_FEED, bw: DEF_BW }; }

/** Population-level daily targets from the reference table. Identical to DWP-99 v3.0 `getTargets()`. */
function getTargets(age, pop, ref) {
  const a = Math.min(Math.max(age, 1), 42);
  const wRef = ref.water[a] || 692;
  const fRef = ref.feed[a] || 320;
  return {
    wTarget: Math.round((wRef * pop) / 1000), // Liter, total populasi
    fTarget: Math.round((fRef * pop) / 1000), // Kg, total populasi
  };
}

function riskColor(v) { return v <= 25 ? 'safe' : v <= 50 ? 'warn' : v <= 75 ? 'warn' : 'danger'; }

/**
 * CLINICAL 5-CATEGORY RISK MODEL — recovered verbatim (formula-for-formula)
 * from DWP-99 v3.0 `calcRisks()`, which computed real named clinical
 * categories (Heat Stress, SMS/SDS, Ascites/PHS, Wet Litter, Mortality
 * Forecast) rather than v3.5.0's generic proxies (which is what v1.0.0 of
 * this file mistakenly ported as "canonical" — v3.0 turned out to be the
 * more physiologically rigorous version; see chat history for the full
 * comparison). Two deliberate adaptations from the original v3.0 source:
 *
 * 1. Heat Stress's THI sub-score now uses the age-dependent zone (z.comfort/
 *    z.alert) instead of v3.0's fixed thresholds (72/79/84/88) — v3.0's
 *    thresholds were calibrated for its OWN (different) THI formula, and
 *    plugging v3.5's age-dependent THI into those fixed numbers would be
 *    miscalibrated. The zone-relative shape (0–25 in comfort tapering in,
 *    25–60 in alert, 60–90 beyond) mirrors v3.0's proportions.
 * 2. wir/fir here mean ACTUAL-vs-TARGET compliance ratios (from the
 *    reference table), NOT the water:feed internal ratio v1.0.0 of this
 *    file used under the same names — see evaluate() below.
 *
 * @returns {{heatRisk,smsRisk,ascitesRisk,litterRisk,mortForecast,bwDev}}
 */
function calcRisksClinical({ age, thi, z, rh, wir, fir, mortRate, bw, ref }) {
  // ── Heat Stress Risk ─────────────────────────────────────────────
  const thiScore = thi <= z.comfort
    ? Math.max(0, 25 - ((z.comfort - thi) / Math.max(1, z.comfort - (z.comfort - 15))) * 25)
    : thi <= z.alert
      ? 25 + ((thi - z.comfort) / Math.max(1, z.alert - z.comfort)) * 35
      : Math.min(100, 60 + ((thi - z.alert) / 5) * 30);
  const wirScore = wir < 1.1 ? 0 : wir > 1.45 ? 100 : ((wir - 1.1) / 0.35) * 100;
  const firScore = fir >= 0.95 ? 0 : fir < 0.80 ? 100 : ((0.95 - fir) / 0.15) * 100;
  const mScore = mortRate < 0.05 ? 0 : mortRate > 0.5 ? 100 : (mortRate / 0.5) * 100;
  const heatRisk = Math.min(100, thiScore * 0.45 + wirScore * 0.30 + firScore * 0.15 + mScore * 0.10);

  // ── SMS / SDS Risk (Sudden Death Syndrome) ───────────────────────
  // Peak D20-D35, dipicu BW overshoot + pertumbuhan cepat + FIR tinggi
  const bwRef = ref.bw[Math.min(age, 42)] || 2430;
  const bwDev = bwRef > 0 ? ((bw - bwRef) / bwRef) * 100 : 0;
  const ageSMS = age < 18 || age > 40 ? 0 : age <= 35 ? (age - 18) / 17 : 1 - (age - 35) / 5;
  const bwScore = bwDev < 3 ? 8 : bwDev < 6 ? 45 : bwDev < 10 ? 78 : 100;
  const firSMS = fir > 1.08 ? 90 : fir > 1.02 ? 35 : 5;
  const smsRisk = Math.min(100, ageSMS * 45 + bwScore * 0.35 + firSMS * 0.12 + mScore * 0.08);

  // ── Ascites / Pulmonary Hypertension Risk ────────────────────────
  // Pertumbuhan cepat D14-D30, diperparah suhu malam dingin (paradoks)
  const ageAsc = age >= 12 && age <= 32 ? 1 : 0;
  const growthScore = bwDev > 6 ? 75 : bwDev > 3 ? 40 : 12;
  const coldFactor = thi < 70 ? 30 : thi < 72 ? 15 : 0;
  const ascitesRisk = Math.min(100, ageAsc * (growthScore * 0.55 + coldFactor + mScore * 0.15));

  // ── Wet Litter Risk ───────────────────────────────────────────────
  // RH tinggi + WIR (actual/target) tinggi = litter basah, lebih parah di finisher
  const rhScore = rh < 68 ? 0 : rh > 85 ? 100 : ((rh - 68) / 17) * 100;
  const wirLit = wir < 1.12 ? 0 : wir > 1.45 ? 100 : ((wir - 1.12) / 0.33) * 100;
  const ageLit = Math.min(age / 42, 1) * 15;
  const litterRisk = Math.min(100, rhScore * 0.38 + wirLit * 0.42 + ageLit + mScore * 0.10);

  // ── Composite Mortality Forecast ─────────────────────────────────
  const mortForecast = Math.min(100, heatRisk * 0.35 + smsRisk * 0.28 + ascitesRisk * 0.18 + litterRisk * 0.19);

  return { heatRisk, smsRisk, ascitesRisk, litterRisk, mortForecast, bwDev };
}

/** Risk level label from the composite Mortality Forecast score. */
function riskLevel(s) {
  if (s < 25) return { label: 'RENDAH' };
  if (s < 50) return { label: 'SEDANG' };
  if (s < 75) return { label: 'TINGGI' };
  return { label: 'KRITIS' };
}

/**
 * One-call convenience wrapper: raw sensor inputs in, full breakdown out.
 * This is what both HTTP handlers below call.
 *
 * v2.0.0 CHANGE: `bodyWeight` (gram, actual sample) is now REQUIRED for a
 * meaningful SMS/Ascites score — pass 0/omit and those two categories fall
 * back to their age-window-only baseline (no BW-deviation signal), still
 * safe but less informative. `wir`/`fir` in the response now mean
 * actual-vs-target compliance ratios, not the old water:feed internal ratio.
 */
function evaluate({ ageDays, population, temperature, humidity, mortality, waterLiters, feedKg, bodyWeight }) {
  const age = Number(ageDays) || 0;
  const pop = Number(population) || 0;
  const temp = Number(temperature);
  const hum = Number(humidity);
  const mort = Number(mortality) || 0;
  const feed = Number(feedKg) || 0;
  const water = Number(waterLiters) || 0;
  const bw = Number(bodyWeight) || 0;

  const ref = getRef();
  const thi = cTHI(temp, hum);
  const z = gTZ(age);
  const cls = clsTHI(thi, z);
  const { wTarget, fTarget } = getTargets(age, pop, ref);
  const wir = wTarget > 0 ? +(water / wTarget).toFixed(3) : 1;
  const fir = fTarget > 0 ? +(feed / fTarget).toFixed(3) : 1;
  const mortRate = pop > 0 ? (mort / pop) * 100 : 0;

  const rk = calcRisksClinical({ age, thi, z, rh: hum, wir, fir, mortRate, bw, ref });
  const risk = Math.round(rk.mortForecast);

  return {
    engineVersion: VERSION,
    thi,
    thiZone: cls,
    phase: z.phase,
    wir,
    fir,
    wTarget,
    fTarget,
    bwTarget: ref.bw[Math.min(age, 42)] || null,
    bwDev: +rk.bwDev.toFixed(1),
    risk,
    riskLevel: riskLevel(risk).label,
    breakdown: [
      { name: 'Heat Stress',    v: Math.round(rk.heatRisk),    max: 100, severity: riskColor(rk.heatRisk) },
      { name: 'SMS/SDS',        v: Math.round(rk.smsRisk),     max: 100, severity: riskColor(rk.smsRisk) },
      { name: 'Ascites/PHS',    v: Math.round(rk.ascitesRisk), max: 100, severity: riskColor(rk.ascitesRisk) },
      { name: 'Wet Litter',     v: Math.round(rk.litterRisk),  max: 100, severity: riskColor(rk.litterRisk) },
      { name: 'Mort. Forecast', v: Math.round(rk.mortForecast),max: 100, severity: riskColor(rk.mortForecast) },
    ],
  };
}

// ----------------------------------------------------------------------------
// EXPRESS ROUTER
// ----------------------------------------------------------------------------
function createRiskRouter({ pool, auth, requireSuperAdmin }) {
  if (typeof auth !== 'function' || typeof requireSuperAdmin !== 'function') {
    throw new Error(
      'createRiskRouter requires { pool, auth, requireSuperAdmin } — pass your ' +
      'existing auth and requireSuperAdmin middleware from index.js, not new ones.'
    );
  }

  const express = require('express');
  const rateLimitPkg = require('express-rate-limit');
  const rateLimit = rateLimitPkg.rateLimit || rateLimitPkg; // supports both v6/v7 (default export) and v8 (named export)
  const ipKeyGenerator = rateLimitPkg.ipKeyGenerator; // v8+ only; undefined on older installs, handled below
  const router = express.Router();

  // Same shape as index.js's enumerationLimiter — this endpoint is public
  // (DWP-99 trial devices have no JWT/login), so it needs its own throttle
  // instead of `auth` to stop abuse.
  //
  // NOTE: index.js's own enumerationLimiter uses `req.headers['cf-connecting-ip']
  // || req.ip` as its keyGenerator. If your installed express-rate-limit is
  // v7+, that exact pattern throws/warns ERR_ERL_KEY_GEN_IPV6 (an IPv6 address
  // can be written multiple equivalent ways, so using it raw as a key lets
  // someone bypass the limit by varying the representation) — worth checking
  // that on enumerationLimiter too, not just here. This route uses the
  // library's own ipKeyGenerator() to normalize when available.
  const trialTelemetryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60, // one DWP-99 install reports a handful of times a day; 60/15min is generous headroom, not a real ceiling
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || (ipKeyGenerator ? ipKeyGenerator(req.ip) : req.ip),
    message: { error: 'Terlalu banyak permintaan. Coba lagi dalam 15 menit.' },
  });

  /**
   * POST /api/risk/calculate
   * Paid-tenant use. `auth` is index.js's own middleware — any logged-in
   * user (Operator/Supervisor/Manager) may call this; it's a stateless
   * calculation with no floorId, so no verifyFloorOwnership check applies
   * (nothing tenant-specific is read or written).
   */
  router.post('/risk/calculate', auth, (req, res) => {
    try {
      const result = evaluate(req.body || {});
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: 'invalid_input', message: e.message });
    }
  });

  /**
   * POST /api/dwp99/trial/telemetry
   * DWP-99 trial/lead ingestion. Deliberately NOT behind `auth` — DWP-99
   * field installs are not BroilerOS tenant users and have no JWT to send.
   * Protected instead by trialTelemetryLimiter, same spirit as index.js's
   * enumerationLimiter on other public endpoints (/api/clients/resolve etc.)
   */
  router.post('/dwp99/trial/telemetry', trialTelemetryLimiter, async (req, res) => {
    const b = req.body || {};
    if (!b.deviceId) {
      return res.status(400).json({ error: 'missing_device_id' });
    }
    try {
      const result = evaluate(b);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Ensure a lead row exists for this device (idempotent).
        const leadRes = await client.query(
          `INSERT INTO dwp99_trial.leads (device_id, display_name, phone_number, farm_label, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, now(), now())
           ON CONFLICT (device_id)
           DO UPDATE SET last_seen_at = now(),
                         display_name = COALESCE(EXCLUDED.display_name, dwp99_trial.leads.display_name),
                         phone_number = COALESCE(EXCLUDED.phone_number, dwp99_trial.leads.phone_number)
           RETURNING id`,
          [b.deviceId, b.displayName || null, b.phoneNumber || null, b.farmLabel || null]
        );
        const leadId = leadRes.rows[0].id;

        await client.query(
          `INSERT INTO dwp99_trial.trial_records
             (lead_id, unit_label, age_days, population, temperature, humidity, mortality, wind_speed,
              water_liters, feed_kg, body_weight, thi, thi_zone, risk_score, risk_level, risk_breakdown,
              engine_version, recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, COALESCE($18, now()))`,
          [
            leadId, b.unitLabel || null, b.ageDays || 0, b.population || 0, b.temperature, b.humidity,
            b.mortality || 0, b.windSpeed ?? 2, b.waterLiters || 0, b.feedKg || 0, b.bodyWeight || null,
            result.thi, result.thiZone, result.risk, result.riskLevel,
            JSON.stringify(result.breakdown), result.engineVersion, b.recordedAt || null,
          ]
        );

        await client.query('COMMIT');
        res.json({ ok: true, leadId, ...result });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      res.status(500).json({ error: 'server_error', message: e.message });
    }
  });

  /**
   * GET /api/dwp99/trial/leads
   * Powers the "Prospek DWP-99" panel in BroilerOS's Global Monitor. Reads
   * from the dwp99_trial.lead_readiness view (see
   * neon-dwp99-trial-schema.sql) — ungraduated leads only, ranked by report
   * volume. Gated to Super Admin, same as /api/admin/clients.
   */
  router.get('/dwp99/trial/leads', auth, requireSuperAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, device_id, display_name, phone_number, farm_label,
                first_seen_at, last_seen_at, total_reports, high_risk_reports,
                distinct_units_reported, last_report_at, high_risk_pct
         FROM dwp99_trial.lead_readiness
         ORDER BY total_reports DESC
         LIMIT 200`
      );
      res.json({ leads: result.rows });
    } catch (e) {
      res.status(500).json({ error: 'server_error', message: e.message });
    }
  });

  return router;
}

module.exports = {
  VERSION,
  TZ,
  cTHI,
  gTZ,
  clsTHI,
  getRef,
  getTargets,
  calcRisksClinical,
  riskLevel,
  evaluate,
  createRiskRouter,
};
