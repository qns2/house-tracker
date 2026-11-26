/* For You browser engine — deterministic client-side port of personalization.py.
 *
 * Input: the frozen /foryou.json snapshot produced by
 * personalization.py:foryou_snapshot_payload — {version, budget, assumptions,
 * entries:[{id, asking_price, price_effective, group|null, price_label,
 * size_sqm, floor_raw, factors:[{key, quality|null, evidence_class,
 * available_weight, earned, note}], renovation:{class, condition_state,
 * scenarios_eur{low,expected,high}|null, per_m2_eur, scopes, notes,
 * provenance?, components?}, buyer_seed_condition, seed_note,
 * construction_status}]}. All evidence
 * extraction (Greek text, catalogs) stays server-side; this engine only
 * re-derives scores/rankings from those frozen inputs plus locally-held
 * preferences — nothing about the buyer leaves the browser.
 *
 * Rule-by-rule source map (each rule cites its python function):
 *   learning     -> learn_preferences / property_vote_map / _vote_key
 *   personal fit -> personal_fit + PERSONAL_FACTORS + EVIDENCE_WEIGHT
 *   financial    -> financial_fit / acquisition_costs / financial_score
 *   ranking      -> foryou_rank (combined / personal / financial / opportunity;
 *                   similar gates on FEASIBILITY_RANK via feasRank)
 *   similarity   -> similarity_to_favorites (weighted bounded per-favorite,
 *                   exact port of the 24 Nov reference)
 *
 * pyRound replicates python 3 round(): correctly-rounded decimal rounding of
 * the double's EXACT binary value, ties to even — so every rounded figure
 * matches the server (e.g. round(1642.5) == 1642, not Math.round's 1643).
 *
 * Pure logic; attaches itself via a guarded loader (window / module.exports)
 * and never touches window when running outside a browser.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------- constants (ported) */

  // personalization.py PERSONAL_FACTORS — order defines tie-breaks/labels.
  // Weights sum to 100 before evidence scaling. Labels match the UI dict.
  var PERSONAL_FACTORS = [
    ['floor', 20, 'Floor level'],
    ['lighting', 18, 'Natural light'],
    ['corner', 12, 'Corner position'],
    ['outlook', 10, 'Outlook / openness'],
    ['size', 10, 'Size'],
    ['layout', 8, 'Layout'],
    ['bedrooms', 7, 'Bedrooms'],
    ['location', 8, 'Location'],
    ['elevator', 4, 'Elevator'],
    ['balconies', 3, 'Balconies'],
  ];
  var FACTOR_LABELS = {};
  PERSONAL_FACTORS.forEach(function (f) { FACTOR_LABELS[f[0]] = f[2]; });

  // learn_preferences caps: adjusted weights move at most MAX_DELTA (as a
  // fraction) and only after MIN_VOTES distinct vote keys (properties).
  var MAX_DELTA = 0.20;
  var MIN_VOTES = 2;

  // feedback chip -> personal factor it speaks to (personalization.py
  // REASON_FACTOR). price/renovation signals are Financial Fit concerns and
  // stay out of Personal Fit.
  var REASON_FACTOR = {
    light: 'lighting', corner: 'corner', layout: 'layout', floor: 'floor',
    location: 'location', balconies: 'balconies',
  };

  // The buyer's four supplied observations are EXPLICIT seed votes
  // (personalization.py SEED_SIGNALS): one vote per property, same policy as
  // user-given reasons. Keys are ad ids, resolved through _vote_key like any
  // review when a matching snapshot entry exists.
  var SEED_SIGNALS = {
    shortlist: {
      '1120101887': ['corner', 'light', 'layout'],
      '1121023524': ['layout', 'light'],
      '1121033535': ['layout', 'light'],
    },
    dismiss: {
      '1120126978': ['floor'],
    },
  };

  // personalization.py EVIDENCE_WEIGHT
  var EVIDENCE_WEIGHT = { verified: 1.0, claimed: 0.75, inferred: 0.5, unknown: 0.0 };

  // personalization.py DEFAULTS — the editable fallbacks when the payload
  // carries no (or partial) assumptions; the payload's own assumptions are
  // merged over these with load_assumptions' dict-aware merge.
  var BUDGET = 250000;
  var DEFAULTS = {
    budget: BUDGET,
    rates: {
      transfer_tax: [0.0309, 0.0309],
      agent_commission: [0.0248, 0.0248],
      notary: [0.008, 0.013],
      registry_misc: [0.0050, 0.0060],
    },
    fixed_costs: { certificates_legal: [350, 900] },
    scope_rates: {
      kitchen: [45, 70, 100], bathroom: [35, 55, 80], windows: [70, 110, 150],
      electrical: [40, 60, 85], plumbing: [30, 50, 70], heating_ac: [40, 60, 90],
      flooring: [40, 60, 85], painting: [25, 40, 60], other: [15, 30, 50],
      snagging_painting: [8, 15, 30],
    },
    class_scopes: {
      new_construction: { low: ['snagging_painting'], expect: ['snagging_painting'],
        high: ['snagging_painting', 'other'] },
      renovated: { expect: [], low: [], high: [] },
      minor: { expect: ['painting', 'other'], low: ['painting'],
        high: ['painting', 'flooring', 'heating_ac', 'other'] },
      partial: { expect: ['kitchen', 'painting', 'flooring', 'other'],
        low: ['bathroom', 'painting'],
        high: ['kitchen', 'bathroom', 'flooring', 'windows', 'other'] },
      substantial: { expect: ['kitchen', 'bathroom', 'windows', 'electrical', 'plumbing',
        'heating_ac', 'flooring', 'painting'],
        low: ['kitchen', 'bathroom', 'windows', 'flooring', 'painting'],
        high: ['kitchen', 'bathroom', 'windows', 'electrical', 'plumbing',
          'heating_ac', 'flooring', 'painting', 'other'] },
    },
    class_flat: { renovated: [8, 15, 25] },
    unknown_bundle: [60, 130, 450],
    contingency_rate: 0.10,
    contingency_fixed: 1500,
    agent_commission_on: true,
  };

  /* ------------------------------------------------------- python rounding */

  // Exact decomposition of a double: [mantissa BigInt, exponent int, negative].
  // IEEE-754 double, little-endian byte order (as on every practical browser).
  var _f64 = new Float64Array(1);
  var _u8 = null;
  function _decompose(x) {
    if (!_u8) _u8 = new Uint8Array(_f64.buffer);
    _f64[0] = x;
    var raw = 0n;
    for (var i = 7; i >= 0; i--) raw = (raw << 8n) | BigInt(_u8[i]);
    var expBits = Number((raw >> 52n) & 0x7ffn);
    var mant = raw & ((1n << 52n) - 1n);
    if (expBits === 0) return [mant, -1074, (raw >> 63n) === 1n]; // zero / subnormal
    return [mant | (1n << 52n), expBits - 1075, (raw >> 63n) === 1n];
  }
  function _powBigInt(base, exp, cache) {
    var r = 1n, f = base, n = exp;
    while (n > 0) { if (n & 1) r *= f; f *= f; n >>= 1; }
    return r;
  }
  var _pow5c = {}, _pow10c = {};
  function pow5(n) { return _pow5c[n] || (_pow5c[n] = _powBigInt(5n, n)); }
  function pow10(n) { return _pow10c[n] || (_pow10c[n] = _powBigInt(10n, n)); }

  /* pyRound(x, nd): python 3 round() — decimal rounding of the double's exact
     value with ties to even. Math.round alone would round half-up on the
     scaled value and diverge from the server on exact halves. */
  function pyRound(x, nd) {
    if (typeof x !== 'number') { x = Number(x); if (x !== x) return 0; }
    if (x !== x) return 0;                       // NaN
    if (nd === undefined || nd === null) nd = 0;
    nd = Math.trunc(nd);
    if (!isFinite(x)) return x;
    var dec = _decompose(x);
    var m = dec[0], e = dec[1], neg = dec[2];
    if (m === 0n) return 0;
    // exact value = m * 2^e; written as N / 10^k exactly
    var N, k;
    if (e >= 0) { N = m << BigInt(e); k = 0; }   // integer value, exact
    else { N = m * pow5(-e); k = -e; }           // m / 2^k == m*5^k / 10^k
    var M;                                       // round(value * 10^nd)
    if (nd >= k) {
      M = (nd === k) ? N : N * pow10(nd - k);    // exact, no rounding needed
    } else {
      var D = pow10(k - nd);
      var q = N / D, r = N % D, h = D >> 1n;     // h = D/2 exact (D is 10^t)
      if (r > h) q += 1n;
      else if (r === h && (q % 2n) !== 0n) q += 1n; // ties to even
      M = q;
    }
    if (neg) M = -M;
    return Number(M) / Math.pow(10, nd);
  }

  /* ------------------------------------------------------------- state/init */

  var state = {
    labels: FACTOR_LABELS,
    seeds: SEED_SIGNALS,
    minVotes: MIN_VOTES,
    maxDelta: MAX_DELTA,
    entriesIndex: null,
  };

  /* init(opts): optional overrides — {labels, seeds, minVotes, maxDelta,
     entries}. Call init() with no args to reset to the engine defaults. */
  function init(opts) {
    opts = opts || {};
    state.labels = opts.labels ? Object.assign({}, FACTOR_LABELS, opts.labels) : FACTOR_LABELS;
    state.seeds = opts.seeds || SEED_SIGNALS;
    state.minVotes = (opts.minVotes !== undefined && opts.minVotes !== null) ? opts.minVotes : MIN_VOTES;
    state.maxDelta = (opts.maxDelta !== undefined && opts.maxDelta !== null) ? opts.maxDelta : MAX_DELTA;
    state.entriesIndex = opts.entries ? buildIndex(opts.entries) : null;
    return API;
  }

  function labelOf(key) { return state.labels[key] || key; }

  /* ------------------------------------------------------- preference votes */

  function buildIndex(entries) {
    var index = {};
    (entries || []).forEach(function (e) {
      // payload entries carry group {property_id, level, primary_id} or null
      index[e.id] = e.group || {};
    });
    return index;
  }

  /* _vote_key port: a decision vote collapses to the shared PROPERTY key only
     for CONFIRMED same-property groups. 'likely'/'possible' groups are
     unverified same-property hypotheses; their member ads stay INDEPENDENT
     vote targets, and an entry with a property_id but no level does not
     collapse either. */
  function voteKey(ind, rid) {
    ind = ind || {};
    var pid = ind.property_id;
    if (pid !== undefined && pid !== null && ind.level === 'confirmed') return pid;
    return rid;
  }

  function _keysOf(x) {          // reason -> vote set, passed as array/Set/map
    if (!x) return [];
    if (Array.isArray(x)) return x;
    if (typeof Set !== 'undefined' && x instanceof Set) return Array.from(x);
    return Object.keys(x);
  }

  /* computeVotes(reviews, entries?) — the vote-collection half of
     learn_preferences: reviews = {adId: {state:'shortlist'|'dismissed',
     reasons:[chip,...], reason_note}}; entries supply the group identities.
     Returns {shortlist:{reason:[distinct vote keys]}, dismiss:{...}, prop} —
     one vote per PROPERTY for confirmed groups, per AD otherwise. */
  function computeVotes(reviews, entries) {
    if (entries) state.entriesIndex = buildIndex(entries);
    var index = state.entriesIndex || {};
    reviews = reviews || {};
    var seeds = state.seeds || {};
    var seedSL = seeds.shortlist || {}, seedDM = seeds.dismiss || {};

    function addVote(side, r, key) {
      var m = votes[side][r] || (votes[side][r] = {});
      m[key] = 1;
    }
    var votes = { shortlist: {}, dismiss: {} };
    var already = {};
    // seed votes key to the property id ONLY through a confirmed group
    // identity; otherwise the seed ad votes as itself (same _vote_key policy)
    Object.keys(seedSL).forEach(function (sid) {
      var key = voteKey(index[sid], sid);
      already[key] = 1;
      seedSL[sid].forEach(function (r) { addVote('shortlist', r, key); });
    });
    Object.keys(seedDM).forEach(function (sid) {
      var key = voteKey(index[sid], sid);
      already[key] = 1;
      seedDM[sid].forEach(function (r) { addVote('dismiss', r, key); });
    });

    // property_vote_map: collapse ad-level decisions via group identity so
    // duplicate ads of one CONFIRMED property cannot amplify preferences
    var prop = {};
    Object.keys(reviews).forEach(function (rid) {
      var k = voteKey(index[rid], rid);
      (prop[k] || (prop[k] = [])).push(rid);
    });

    Object.keys(reviews).forEach(function (rid) {
      var rec = reviews[rid];
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
      var key = voteKey(index[rid], rid);
      var members = (prop[key] || []).slice();
      members.push(rid);
      for (var i = 0; i < members.length; i++) {
        if (already[members[i]]) return;   // learn_preferences: seed already voted
      }                                    // this property — never double-count
      var rs = rec.reasons || [];
      if (rec.state === 'shortlist') {
        rs.forEach(function (r) {
          if (REASON_FACTOR[r]) addVote('shortlist', r, key);
        });
        // a reason_note alone is not a structured vote (learn_preferences)
      } else if (rec.state === 'dismissed') {
        // python keeps ALL dismiss reasons in the vote map (size/condition/
        // renovation/price too); only factor-mapped ones move weights later
        rs.forEach(function (r) { addVote('dismiss', r, key); });
      }
    });

    var out = { shortlist: {}, dismiss: {}, prop: prop };
    ['shortlist', 'dismiss'].forEach(function (side) {
      Object.keys(votes[side]).forEach(function (r) {
        out[side][r] = Object.keys(votes[side][r]).sort();
      });
    });
    return out;
  }

  /* computePrefs(votes) — the stats half of learn_preferences: per factor,
     n = distinct vote keys ACROSS shortlist+dismiss (a factor mentioned on
     either side carries evidence); n >= MIN_VOTES lifts the weight by
     min(MAX_DELTA, 0.10*n), otherwise no adjustment. Returns the python prefs
     shape {version, use_case, learned:{factor_mods, detail}, votes}. */
  function computePrefs(votes) {
    votes = votes || { shortlist: {}, dismiss: {} };
    var sideOf = {};
    ['shortlist', 'dismiss'].forEach(function (side) {
      var v = votes[side] || {};
      Object.keys(v).forEach(function (r) {
        var f = REASON_FACTOR[r];
        if (!f) return;                       // non-factor chip: never moves weights
        sideOf[f] = (sideOf[f] || 0) + _keysOf(v[r]).length;
      });
    });
    var learned = {};
    Object.keys(sideOf).forEach(function (f) {
      var n = sideOf[f];
      if (n < state.minVotes) {
        learned[f] = { weight_mod: 1.0, votes: n, note: 'insufficient evidence — no adjustment' };
        return;
      }
      var delta = Math.min(state.maxDelta, 0.10 * n);   // learn_preferences caps
      learned[f] = { weight_mod: pyRound(1.0 + delta, 3), votes: n };
    });
    var mods = {};
    Object.keys(learned).forEach(function (f) { mods[f] = learned[f].weight_mod; });
    return {
      version: 1,
      use_case: 'personal',
      learned: { factor_mods: mods, detail: learned },
      votes: { shortlist: votes.shortlist || {}, dismiss: votes.dismiss || {} },
    };
  }

  /* ------------------------------------------------------------ personal fit */

  /* personal_fit port for one snapshot entry. For each factor:
     w = available_weight * mod (learned, or manual edit override);
     got = w * quality * EVIDENCE_WEIGHT[evidence_class] (the exact
     personal_fit line, incl. the evidence scaling — a 'claimed' factor earns
     0.75 of its weight, python line `got = w * q * EVIDENCE_WEIGHT.get(cls, 0)`);
     unknown quality is NEUTRAL and REPORTED, excluded from both sums.
     score is coverage-weighted: min(1, avail / (0.60 * TOTAL_BASE_WEIGHTS))
     so a row known on few factors cannot ride the unknown-excluded
     denominator to an inflated score. TOTAL_BASE_WEIGHTS = sum of
     available_weight across the entry's 10 snapshot factors. */
  function personalFit(entry, mods) {
    mods = mods || {};
    var fcts = (entry && Array.isArray(entry.factors)) ? entry.factors : [];
    var factors = [], unknown = [];
    var earned = 0, avail = 0, known = 0, totalBase = 0;
    fcts.forEach(function (f) { totalBase += (f.available_weight || 0); });

    fcts.forEach(function (f) {
      var key = f.key || '';
      var base = f.available_weight || 0;
      var q = (f.quality === undefined) ? null : f.quality;
      var cls = f.evidence_class || 'unknown';
      var note = (f.note === undefined) ? null : f.note;
      var mod = (mods[key] !== undefined && mods[key] !== null) ? Number(mods[key]) : 1.0;
      var w = base * mod;
      if (q === null) {
        factors.push({ key: key, label: labelOf(key), weight: base, applied_weight: w,
          quality: null, evidence_class: cls, earned: null, note: note });
        return;
      }
      var evw = (EVIDENCE_WEIGHT[cls] !== undefined) ? EVIDENCE_WEIGHT[cls] : 0.0;
      var got = w * q * evw;                 // personal_fit: got = w * q * evweight
      earned += got;
      avail += w;
      known++;
      factors.push({ key: key, label: labelOf(key), weight: base, applied_weight: w,
        quality: q, evidence_class: cls, earned: got, note: note });
    });

    var score1 = avail ? pyRound(earned / avail * 100, 1) : 0.0;
    var cov = totalBase ? Math.min(1, avail / (0.60 * totalBase)) : 1.0;
    var score = pyRound(score1 * cov, 1);

    // positives/negatives: top-4 by (base) weight, stable like python sorted()
    var pos = factors.filter(function (f) { return (f.quality || 0) >= 0.8; })
      .sort(function (a, b) { return b.weight - a.weight; }).slice(0, 4)
      .map(function (f) { return f.label + (f.note ? ' — ' + f.note : ''); });
    var neg = factors.filter(function (f) {
      return f.quality !== null && f.quality !== undefined && f.quality < 0.5;
    }).sort(function (a, b) { return b.weight - a.weight; }).slice(0, 4)
      .map(function (f) { return f.label + (f.note ? ' — ' + f.note : ''); });

    fcts.forEach(function (f) {
      if (f.quality === null || f.quality === undefined) unknown.push(labelOf(f.key));
    });
    var coverage = fcts.length ? pyRound(known / fcts.length, 2) : 0;

    return {
      score: score,
      earned: pyRound(earned, 1),
      available: pyRound(avail, 1),
      coverage: coverage,
      unknown_factors: unknown,
      positives: pos,
      negatives: neg,
      factors: factors,          // includes applied w (applied_weight) + got (earned)
    };
  }

  /* --------------------------------------------------------------- financial */

  function isPlainObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  /* load_assumptions merge semantics: the payload EDITS tables per key, it
     never replaces them wholesale — dict values merge over this module's
     DEFAULTS so unmentioned classes/rates survive. */
  function mergeAssumptions(base, over) {
    var out = Object.assign({}, base);
    if (!over) return out;
    Object.keys(over).forEach(function (k) {
      if (isPlainObj(over[k]) && isPlainObj(out[k])) out[k] = Object.assign({}, out[k], over[k]);
      else out[k] = over[k];
    });
    return out;
  }
  function assumptionsFromPayload(payload) {
    var a = mergeAssumptions(DEFAULTS, (payload && payload.assumptions) || null);
    if (payload && payload.budget !== undefined && payload.budget !== null) {
      a.budget = Number(payload.budget) || 0;
    }
    return a;
  }

  /* acquisition_costs port: price-dependent acquisition expenses (taxable base
     conservatively the full price; no first-residence exemption assumed).
     parts[key] = {low, expected, high} with mid = (lo+hi)/2; the buyer-side
     agent commission is SKIPPED when agent_commission_on is false; the fixed
     certificates/legal cost joins parts and the totals. rate_mid (solver
     input) = sum of per-key mids rounded to 4 decimals, fixed costs separate. */
  function acquisitionCosts(price, a) {
    a = a || DEFAULTS;
    if (!price || price <= 0) return null;
    var parts = {}, totalLow = 0, totalMid = 0, totalHigh = 0, rateSum = 0;
    Object.keys(a.rates || {}).forEach(function (key) {
      if (key === 'agent_commission' && !a.agent_commission_on) return;
      var r = a.rates[key] || [0, 0];
      var lo = r[0], hi = r[1], mid = (lo + hi) / 2.0;
      parts[key] = { low: pyRound(price * lo), expected: pyRound(price * mid), high: pyRound(price * hi) };
      totalLow += price * lo;
      totalMid += price * mid;
      totalHigh += price * hi;
      rateSum += mid;
    });
    var fx = ((a.fixed_costs || {}).certificates_legal) || [350, 900];
    parts.fixed_certificates = { low: fx[0], expected: pyRound((fx[0] + fx[1]) / 2), high: fx[1] };
    totalLow += fx[0];
    totalMid += (fx[0] + fx[1]) / 2;
    totalHigh += fx[1];
    return {
      parts: parts,
      scenarios_eur: { low: pyRound(totalLow), expected: pyRound(totalMid), high: pyRound(totalHigh) },
      rate_mid: pyRound(rateSum, 4),
    };
  }

  function usableScenarios(reno) {
    var s = reno && reno.scenarios_eur;
    return (s && typeof s.low === 'number' && typeof s.expected === 'number'
      && typeof s.high === 'number') ? s : null;
  }

  /* financial_fit.all_in at a chosen price (expected scenario) — exposed so
     the solver identity all_in(max_offer) ≈ budget can be checked directly:
       all_in(p) = round(p + acquisition(p).expected + reno_expected
                          + contingency(reno_expected))                    */
  function allInExpectedAt(entry, price, payload) {
    var a = assumptionsFromPayload(payload);
    var scen = usableScenarios(entry && entry.renovation);
    var acq = acquisitionCosts(price, a);
    if (!acq || !scen) return null;
    var contRate = (a.contingency_rate !== undefined) ? a.contingency_rate : 0.10;
    var contFixed = (a.contingency_fixed !== undefined) ? a.contingency_fixed : 1500;
    return pyRound(price + acq.scenarios_eur.expected + scen.expected
      + (scen.expected * contRate + contFixed));
  }

  /* financial_fit port for one snapshot entry. Uses the payload's frozen
     renovation range (the snapshot was computed WITH the payload's own
     assumptions) and its asking_price (already the group-basis or own ask —
     the same precedence financial_fit applies server-side).
       max_offer solves P in BUDGET = P*(1+rate_mid) + fixed + reno + cont,
       i.e. P = (budget - reno - contingency - fx_mid)/(1+rate_mid) per
       scenario; fixed costs enter the solver as fx_mid only (never taxed,
       renovation never in a taxable base).
       5-class feasibility ladder (financial_fit, 24 Nov corrective pass):
         insufficient_information — unsolvable triggers unchanged (scenario
           range unusable, class unknown/under_construction, or no price;
           max_offer nulled for the reno-caused ones);
         within_budget            — expected all-in fits the budget AS ASKED;
         within_budget_optimistic — only the LOW renovation scenario fits
           (expected-scenario fees + low reno + its own contingency);
         negotiation_required     — the solved max offer sits within
           negotiation_max_pct (payload assumptions, fallback 0.15) of the ask;
         over_budget              — beyond that threshold (score decays
           quadratically on the max-offer/ask ratio).
       negotiation_required/over_budget additionally carry
       required_discount_eur/pct (the priced gap the ask must close; rounded
       3 like python round(required_discount_eur/price, 3)). */
  function financialFit(entry, payload) {
    var a = assumptionsFromPayload(payload);
    var budget = (a.budget !== undefined) ? a.budget : BUDGET;
    var price = Number((entry && entry.asking_price) || 0);
    if (!isFinite(price) || price <= 0) price = 0;
    var reno = (entry && entry.renovation) || null;
    var scen = usableScenarios(reno);
    var acq = acquisitionCosts(price, a);

    var contRate = (a.contingency_rate !== undefined) ? a.contingency_rate : 0.10;
    var contFixed = (a.contingency_fixed !== undefined) ? a.contingency_fixed : 1500;
    function contingency(v) { return pyRound(v * contRate + contFixed); }
    var cont = {};
    if (scen) ['low', 'expected', 'high'].forEach(function (s) { cont[s] = contingency(scen[s]); });

    // all_in per scenario: expected recomputed via acquisition at the price
    // (python's all_in()); low/high add the low/high acquisition analogues
    var allExp = (price && scen) ? pyRound(price + acq.scenarios_eur.expected + scen.expected + cont.expected) : null;
    var allLow = (price && scen) ? pyRound(price + acq.scenarios_eur.low + scen.low + cont.low) : null;
    var allHigh = (price && scen) ? pyRound(price + acq.scenarios_eur.high + scen.high + cont.high) : null;

    var fxc = ((a.fixed_costs || {}).certificates_legal) || [350, 900];
    var fxMid = (fxc[0] + fxc[1]) / 2.0;       // solver fixed mid (unrounded)
    var rate = acq ? acq.rate_mid : null;
    var maxOffer = null;
    if (rate !== null && scen) {
      maxOffer = {};
      ['low', 'expected', 'high'].forEach(function (s) {
        var rv = scen[s];
        if (typeof rv !== 'number') return;    // skip missing scenario value
        var p = (budget - rv - contingency(rv) - fxMid) / (1.0 + rate);
        maxOffer[s] = pyRound(Math.max(0, p));
      });
    }

    var cls = reno ? (reno.class || null) : null;
    var unknownCondition = cls === 'unknown';
    var unsolvable = unknownCondition || !scen || cls === 'under_construction';
    // negotiation_max_pct travels in the payload assumptions (the snapshot
    // was computed with them); fall back to 0.15 like financial_fit does
    var negMax = (a.negotiation_max_pct !== undefined && a.negotiation_max_pct !== null)
      ? a.negotiation_max_pct : 0.15;
    var feasibility = null, diff = null;
    var requiredEur = null, requiredPct = null;
    if (unsolvable || !price) {
      feasibility = 'insufficient_information';
      if (unknownCondition || !scen || cls === 'under_construction') maxOffer = null;
    } else {
      // asking_vs_max_offer: positive => asking sits ABOVE the solved max offer
      diff = (maxOffer && maxOffer.expected !== undefined && maxOffer.expected !== null)
        ? price - maxOffer.expected : null;
      var moExp = (maxOffer && maxOffer.expected !== undefined && maxOffer.expected !== null)
        ? maxOffer.expected : null;
      // optimistic basis: expected-scenario fees + LOW renovation scenario —
      // the row only fits if every favorable assumption holds at once
      var allLowExp = (price && scen)
        ? pyRound(price + acq.scenarios_eur.expected + scen.low + contingency(scen.low)) : null;
      if (allExp !== null && allExp <= budget) {
        feasibility = 'within_budget';                    // fits AS ASKED
      } else if (allLowExp !== null && allLowExp <= budget) {
        feasibility = 'within_budget_optimistic';         // fits ONLY on the low scenario
      } else if (moExp !== null && moExp > 0 && (price - moExp) / price <= negMax) {
        feasibility = 'negotiation_required';             // a realistic discount closes it
      } else {
        feasibility = 'over_budget';
      }
      if ((feasibility === 'negotiation_required' || feasibility === 'over_budget')
        && moExp !== null) {
        requiredEur = price - moExp;
        requiredPct = price ? pyRound(requiredEur / price, 3) : null;
      }
    }

    var ff = {
      asking_price: price,
      budget: budget,
      renovation: reno,
      contingency: cont,
      acquisition: acq,
      all_in: { low: allLow, expected: allExp, high: allHigh },
      max_affordable_offer: maxOffer,
      asking_vs_max_offer: diff,
      feasibility: feasibility,
      required_discount_eur: requiredEur,
      required_discount_pct: requiredPct,
      // mirror of python financial_fit assumptions_note (fixed text, both
      // implementations must agree verbatim)
      assumptions_note: "Transfer tax 3.09% assumed on the full price — a first-residence " +
        "exemption is NOT assumed; agent commission 2%+VAT assumed on. " +
        "Renovation from description/detail evidence as ranges (low/expected/high). " +
        "Contingency = 10% of renovation + €1,500 buffer. Notary ≈1% sliding scale. " +
        "Feasibility: 'within_budget' = expected all-in inside the budget; " +
        "'within_budget_optimistic' = only the LOW renovation scenario lands " +
        "inside it (expected all-in does not); 'negotiation_required' = the " +
        "solved max affordable offer sits within a discount of at most " +
        "negotiation_max_pct=15% of the ask (configurable in " +
        "financing_assumptions.json); 'over_budget' = beyond that threshold — " +
        "do not treat optimism or negotiation as achieved savings.",
    };
    ff.financial_score = financialScoreOf(ff);
    return ff;
  }

  /* financial_score port: within_budget -> 100; optimistic/negotiation rows
     decay linearly on budget/all_in_expected; over budget is penalized
     QUADRATICALLY on the max-offer/asking ratio so a large budget shortfall
     can never be cosmetic; unknown/insufficient -> null; no solvable offer on
     an over-budget row -> 0.0 (python financial_score). */
  function financialScoreOf(ff) {
    var f = ff.feasibility;
    if (f === 'insufficient_information') return null;
    if (f === 'within_budget') return 100.0;
    var aire = (ff.all_in || {}).expected;
    if (f === 'within_budget_optimistic' || f === 'negotiation_required') {
      return aire ? pyRound(Math.min(100.0, 100.0 * (ff.budget || BUDGET) / aire), 1) : null;
    }
    var mo = (ff.max_affordable_offer || {}).expected;
    var asking = ff.asking_price || 0;
    if (!mo || !asking) return 0.0;
    var ratio = Math.max(0.0, mo / asking);
    // over_budget: quadratic shortfall penalty
    return pyRound(Math.max(0.0, Math.min(100.0, 100.0 * ratio * ratio)), 1);
  }

  /* ------------------------------------------------------------- similarity */

  // base weight per factor key (PERSONAL_FACTORS [weight,label] pairs)
  var FACTOR_WEIGHT = {};
  PERSONAL_FACTORS.forEach(function (f) { FACTOR_WEIGHT[f[0]] = f[1]; });

  function evidW(cls) { return (EVIDENCE_WEIGHT[cls] !== undefined) ? EVIDENCE_WEIGHT[cls] : 0.0; }

  // numeric floor value from a raw floor field: 2, '2', '2ος όροφος',
  // '5ος όροφος' -> number; anything else -> null (unknown).
  // similarity_to_favorites compares floor VALUES against the dismissed
  // seed's floor; the snapshot freezes floor_raw verbatim, so the engine
  // parses the leading digits.
  function floorNum(raw) {
    if (typeof raw === 'number' && isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      var m = raw.match(/^\s*(\d+)/);
      return m ? parseInt(m[1], 10) : null;
    }
    return null;
  }

  /* {key: {q, ev}} from the frozen snapshot factors — the _factor_table
     read side (personal_fit internals at BASE weights, quality null unknown) */
  function factab(entry) {
    var t = {};
    var fcts = (entry && Array.isArray(entry.factors)) ? entry.factors : [];
    fcts.forEach(function (f) {
      t[f.key] = { q: (f.quality === undefined) ? null : f.quality,
        ev: f.evidence_class || 'unknown' };
    });
    return t;
  }

  /* labels sorted by strongest contributing weight desc, capped at 4
     (python: sorted(items, key=lambda kv: (-kv[1], kv[0]))[:4]) */
  function topLabels(map) {
    return Object.keys(map).map(function (k) { return { lab: labelOf(k), w: map[k] }; })
      .sort(function (a, b) {
        return (b.w - a.w) || (a.lab < b.lab ? -1 : (a.lab > b.lab ? 1 : 0));
      })
      .slice(0, 4).map(function (x) { return x.lab; });
  }

  /* Weighted, bounded, PER-FAVORITE similarity — exact port of
     personalization.py similarity_to_favorites (24 Nov corrective pass), the
     reference implementation. The engine consumes the SNAPSHOT's frozen
     personal-fit factors — {quality, evidence_class} at BASE weights, exactly
     what python's _factor_table reads out of the personal-fit internals.

     favorites = seed-shortlist ads + reviews with state 'shortlist', deduped
     by the voteKey policy (confirmed collapse only); favorites with no
     snapshot entry are skipped, and favorites carrying NO strong factor
     (neither q >= 0.7 nor q <= 0.35) are skipped — a bland favorite cannot
     dilute the aggregate (python favs gate).

     Per candidate vs favorite pair, over the PERSONAL_FACTORS [weight,label]
     pairs:
     - a factor contributes ONLY when BOTH sides have quality != null; unknown
       attributes earn nothing, punish nothing and NEVER grow the denominator;
     - pair weight wE = factor weight * EVIDENCE_WEIGHT[ev_candidate] *
       EVIDENCE_WEIGHT[ev_favorite] — evidence classes multiply on BOTH sides
       (conservative);
     - positive match (q_c >= 0.7 AND q_f >= 0.7): credit += wE;
     - shared strong negative (both <= 0.35): credit -= 0.7 * wE;
     - explicit dismissal (dismiss votes -> REASON_FACTOR chips, seed +
       user): a candidate with q_c <= 0.35 on a dismissed factor incurs
       1.2 * (weight * ev_c) per pair. Floor is VALUE-carried: the dismissal
       rides the dismissed seed row's floor VALUE (parsed numerically from its
       frozen floor_raw; the personalization.py SEED_DISMISS_FLOOR constant
       backs the case where the seed row is not in the snapshot), so a
       candidate whose floor is KNOWN and <= that value takes the penalty EVEN
       IF q_c > 0.35, and its floor additionally counts as a strong negative
       against any favorite whose floor q <= 0.35 (a 2nd-floor apartment must
       not be rewarded despite the explicit dislike). Candidate floor unknown:
       no floor penalty, no floor credit, ever.
     - pair score s = clamp(credit / maxAttainable, -1, 1) with maxAttainable
       = wE summed over factors known on BOTH sides (the credit of a perfect
       all-positive match); s = 0 for an empty denominator.
     - aggregate S = mean of the pair scores over favorites.

     Returns {id: {sim, matched, penalties}} — sim = round(100*max(0,S), 1)
     (pyRound parity); matched/penalties are factor labels over ALL favorites
     (union, keyed by their strongest contributing weight, capped at 4).
     Entries are null when there are no scorable favorites.

     INVARIANT: sim in [0,100]; 100 ONLY when every known-shared factor pair
     is a positive match and nothing was penalized. (The PREVIOUS engine
     version unionized favorite signatures and count-normalized the sum — it
     saturated, pinning candidates at 100 for a handful of shared traits; the
     identical candidate also shifted with the favorites COUNT. This port
     scores each pair against its own attainable ceiling instead.) */
  function computeSimilar(reviews, entries, votes) {
    var index = state.entriesIndex || (state.entriesIndex = buildIndex(entries));
    reviews = reviews || {};
    var byId = {};
    (entries || []).forEach(function (e) { byId[e.id] = e; });

    // favorites: seeds first, then shortlist-state reviews; dedup by
    // voteKey (similarity_to_favorites fav_ids/fav_seen)
    var keyCands = {};
    var seedSL = (state.seeds && state.seeds.shortlist) || {};
    Object.keys(seedSL).forEach(function (sid) {
      var k = voteKey(index[sid], sid);
      if ((keyCands[k] || []).indexOf(sid) < 0) { keyCands[k] = (keyCands[k] || []).concat([sid]); }
    });
    Object.keys(reviews).forEach(function (rid) {
      var rec = reviews[rid];
      if (rec && typeof rec === 'object' && rec.state === 'shortlist') {
        var k = voteKey(index[rid], rid);
        if ((keyCands[k] || []).indexOf(rid) < 0) { keyCands[k] = (keyCands[k] || []).concat([rid]); }
      }
    });
    // resolve ONE favorite per property key, preferring the seed ad itself
    // but falling back to any LIVE member of the same group — the favorite
    // must survive its canonical ad leaving the snapshot (python parity)
    var favIds = [];
    Object.keys(keyCands).forEach(function (k) {
      var cands = keyCands[k];
      for (var ci = 0; ci < cands.length; ci++) {
        if (byId[cands[ci]]) { favIds.push(cands[ci]); return; }
      }
    });

    // explicitly dismissed factor keys (seed + user dismiss reasons through
    // REASON_FACTOR). Source BOTH from votes.dismiss AND directly from the
    // review records: the vote-collision policy skips reviews whose key
    // overlaps a seed key for the SAME reason, so a user dismissing a SEED ad
    // with a different trait would otherwise be dropped here (python applies
    // it — read the reviews directly, like similarity_to_favorites does)
    var dismissed = [];
    function trackDismiss(reason) {
      var f = REASON_FACTOR[reason];
      if (f && dismissed.indexOf(f) < 0) dismissed.push(f);
    }
    var dv = (votes && votes.dismiss) || {};
    Object.keys(dv).forEach(trackDismiss);          // dismissed keys = reasons
    Object.keys(reviews).forEach(function (rid) {
      var rec = reviews[rid];
      if (rec && typeof rec === 'object' && rec.state === 'dismissed') {
        (rec.reasons || []).forEach(trackDismiss);
      }
    });

    // the dislike VALUE rides on the dismissed seed row's floor when present
    // (parsed from floor_raw); otherwise SEED_DISMISS_FLOOR (python 1056-1062:
    // "when it IS present, its own (fresh) floor value wins")
    var floorDislike = null;
    var seedDM = (state.seeds && state.seeds.dismiss) || {};
    var sdIds = Object.keys(seedDM);
    for (var si = 0; si < sdIds.length && floorDislike === null; si++) {
      var srow = byId[sdIds[si]];
      var sval = srow ? floorNum(srow.floor_raw) : null;
      if (sval !== null) floorDislike = sval;
    }
    if (floorDislike === null) floorDislike = 2;    // SEED_DISMISS_FLOOR

    // scorable favorites: entry present + at least one strong factor
    var favs = [];
    favIds.forEach(function (fid) {
      var e = byId[fid];
      if (!e) return;                               // favorite outside snapshot: skip
      var t = factab(e);
      var strong = Object.keys(t).some(function (key) {
        var q = t[key].q;
        return q !== null && q !== undefined && (q >= 0.7 || q <= 0.35);
      });
      if (strong) favs.push(t);
    });

    var out = {};
    (entries || []).forEach(function (e) {
      if (!favs.length) { out[e.id] = null; return; }
      var rtab = factab(e);
      var floorVal = floorNum(e.floor_raw);         // null = unknown floor

      // dismissal penalties known on the candidate side (python dis_w):
      // 'independent of favorites' in WHAT triggers them, not in how they
      // weight the aggregate — they deduct from every pair's credit
      var disW = {}, disKeys = [];
      dismissed.forEach(function (dkey) {
        var cell = rtab[dkey];
        if (!cell || cell.q === null || cell.q === undefined) return;  // never invent
        var wc = FACTOR_WEIGHT[dkey] * evidW(cell.ev);
        if (cell.q <= 0.35 || (dkey === 'floor' && floorVal !== null
          && floorVal <= floorDislike)) {
          disW[dkey] = wc;
          disKeys.push(dkey);
        }
      });
      var disSum = disKeys.reduce(function (acc, k) { return acc + disW[k]; }, 0);

      var matched = {}, penalties = {}, pairScores = [];
      var covNum = 0.0, covDen = 0.0;
      favs.forEach(function (ftab) {
        var credit = -1.2 * disSum;
        var attain = 0.0;
        var favTotal = 0.0;
        PERSONAL_FACTORS.forEach(function (pf) {
          var key = pf[0];
          var c = rtab[key], f = ftab[key];
          var qc = c ? c.q : null, qf = f ? f.q : null;
          if (qf !== null && qf !== undefined) {
            favTotal += pf[1] * evidW(f.ev);
          }
          if (qc === null || qc === undefined || qf === null || qf === undefined) {
            return;          // unknown on either side contributes nothing
          }
          var w = pf[1] * evidW(c.ev) * evidW(f.ev);
          attain += w;
          // the floor VALUE rule: a candidate at/below the disliked floor is
          // a strong negative here EVEN IF its factor quality looks fine
          var candFloorNeg = (key === 'floor' && floorVal !== null
            && floorVal <= floorDislike);
          if (qc >= 0.7 && qf >= 0.7) {
            credit += w;
            matched[key] = Math.max(matched[key] || 0, w);
          } else if ((qc <= 0.35 || candFloorNeg) && qf <= 0.35) {
            var pen = 0.7 * w;
            credit -= pen;
            penalties[key] = Math.max(penalties[key] || 0, pen);
          }
        });
        var s = attain > 0 ? Math.max(-1.0, Math.min(1.0, credit / attain)) : 0.0;
        pairScores.push(s);
        covNum += attain;
        covDen += favTotal;
        disKeys.forEach(function (dkey) {   // 1.2x dismissal, capped per label
          penalties[dkey] = Math.max(penalties[dkey] || 0, 1.2 * disW[dkey]);
        });
      });
      var S = pairScores.reduce(function (acc, v) { return acc + v; }, 0)
        / pairScores.length;
      // EVIDENCE COVERAGE (remediation 26 Nov) — exact mirror of the python
      // reference: agreement is rescaled by how much of the favorites'
      // scorable evidence the candidate RESOLVES. Proportional reliability,
      // not a cap: fully-resolved candidates keep their score.
      var conf = covDen > 0 ? Math.min(1.0, covNum / covDen) : 0.0;
      out[e.id] = {
        sim: pyRound(100 * Math.max(0, S) * conf, 1),
        coverage: Math.round(conf * 1000) / 1000,
        matched: topLabels(matched),
        penalties: topLabels(penalties),
      };
    });
    return out;
  }

  /* ---------------------------------------------------------------- ranking */

  function cmpKeys(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  /* FEASIBILITY_RANK port (personalization.py) — the similar-mode gate
     ordering: a high similarity can never hide financial infeasibility, and
     anything not feasibly assessed sorts LAST. */
  var FEASIBILITY_RANK = { within_budget: 0, within_budget_optimistic: 1,
    negotiation_required: 2, over_budget: 3 };
  function feasRank(ff) {
    var f = (ff && ff.feasibility) || '';
    return Object.prototype.hasOwnProperty.call(FEASIBILITY_RANK, f)
      ? FEASIBILITY_RANK[f] : 4;                    // insufficient/unknown last
  }

  /* foryou_rank port (combined / personal / financial / opportunity) plus the
     similar mode. All sorts are stable; ties keep snapshot order.
     opportunity = high personal fit (gate 55) with a negotiation gap, smallest
     gap first; within-budget rows and rows below the gate get 999 (last). The
     similar mode gates on FEASIBILITY first (feasRank), so a high similarity
     can never hide financial infeasibility. */
  function rankIds(fits, ids, mode) {
    function keyFor(id) {
      var fit = fits[id] || {};
      var pf = fit.personal || { score: 0 };
      var ff = fit.financial || {};
      var p = pf.score || 0;
      var f = (ff.financial_score === undefined) ? null : ff.financial_score;
      var c = (fit.combined === undefined) ? null : fit.combined;
      if (mode === 'personal') return [-p, -(f || 0)];
      if (mode === 'financial') return [-(f === null || f === undefined ? -1 : f), -p];
      if (mode === 'opportunity') {
        var mo = (ff.max_affordable_offer || {}).low;
        var asking = ff.asking_price || 0;
        var gap = (!mo || !asking || ff.feasibility === 'within_budget') ? 999.0
          : Math.max(0.0, (asking - mo) / asking * 100.0);
        return (p >= 55) ? [pyRound(gap, 1), -p] : [999.0, -p];
      }
      if (mode === 'similar') {
        var sim = (fit.similar && fit.similar.sim !== null && fit.similar.sim !== undefined)
          ? fit.similar.sim : 0;
        return [feasRank(ff), -sim, -p];
      }
      return [-(c === null || c === undefined ? p * 0.5 : c), -p];   // combined
    }
    return ids.slice().sort(function (i, j) { return cmpKeys(keyFor(i), keyFor(j)); });
  }

  /* -------------------------------------------------------------- computeAll */

  /* computeAll(reviews, prefsEdits, entries, payload) — the full For You pass.
     reviews: {adId: {state, reasons, reason_note}}; prefsEdits: {factor: mod}
     manual overrides that REPLACE learned mods; entries: the snapshot entries;
     payload: the /foryou.json payload carrying budget + assumptions.
     Returns {prefs_mods (effective), fits: {id: {personal, financial, combined,
     similar}}, ranked: {combined, personal, financial, opportunity, similar}}.
     combined = round(0.55*personal + 0.45*financial, 1) (foryou_entry) when
     the financial score is known, else null. */
  function computeAll(reviews, prefsEdits, entries, payload) {
    reviews = reviews || {};
    entries = Array.isArray(entries) ? entries : (entries ? [entries] : []);
    state.entriesIndex = buildIndex(entries);   // group identities for _vote_key
    var votes = computeVotes(reviews);
    var prefs = computePrefs(votes);
    var mods = {};
    PERSONAL_FACTORS.forEach(function (f) {
      var k = f[0];
      if (prefs.learned.factor_mods[k] !== undefined) mods[k] = prefs.learned.factor_mods[k];
    });
    Object.keys(prefs.learned.factor_mods).forEach(function (k) {
      if (mods[k] === undefined) mods[k] = prefs.learned.factor_mods[k];
    });
    Object.keys(prefsEdits || {}).forEach(function (k) {
      var v = prefsEdits[k];
      if (v === null || v === undefined || v === '') return;
      var n = Number(v);
      if (isFinite(n)) mods[k] = n;      // manual edits override learned mods
    });

    var sim = computeSimilar(reviews, entries, votes);
    var fits = {};
    entries.forEach(function (e) {
      var pf = personalFit(e, mods);
      var ff = financialFit(e, payload);
      var fs = ff.financial_score;
      var combined = (fs !== null && fs !== undefined)
        ? pyRound(0.55 * pf.score + 0.45 * fs, 1) : null;
      fits[e.id] = { personal: pf, financial: ff, combined: combined, similar: (sim[e.id] === undefined) ? null : sim[e.id] };
    });

    var ids = entries.map(function (e) { return e.id; });
    var ranked = {
      combined: rankIds(fits, ids, 'combined'),
      personal: rankIds(fits, ids, 'personal'),
      financial: rankIds(fits, ids, 'financial'),
      opportunity: rankIds(fits, ids, 'opportunity'),
      similar: rankIds(fits, ids, 'similar'),
    };
    return { prefs_mods: mods, fits: fits, ranked: ranked };
  }

  /* ------------------------------------------------------------ exports/attach */

  var API = {
    init: init,
    computeVotes: computeVotes,
    computePrefs: computePrefs,
    computeAll: computeAll,
    personalFit: personalFit,
    financialFit: financialFit,
    acquisitionCosts: acquisitionCosts,
    allInExpectedAt: allInExpectedAt,
    round: pyRound,
    FACTORS: PERSONAL_FACTORS.map(function (f) { return f[0]; }),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.ForYouEngine = API;
  if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
    console.log('foryou_engine.js: loaded (pure logic; typeof window = ' + typeof window + ')');
  }
})();
