// Derived facts shared by scoring (gates/subscores) and the board (display + filters).
// One definition, so what the board shows is exactly what the score used.
import { normLocation } from './db.mjs';
import { loadProfile } from './util.mjs';

const PROFILE = loadProfile() ?? {};

// Interpret a source pay figure by magnitude; discard implausible values (data glitches).
// (Adzuna labels everything "year": 26 means $26/hour, 6240 is garbage.)
export function hourlyPay(job) {
  if (job.pay_min == null) return null;
  const v = Number(job.pay_min);
  if (!Number.isFinite(v) || v <= 0) return null;
  const hourly = v < 200 ? v : v / 2080;
  return hourly >= 8 && hourly <= 500 ? hourly : null;
}

// Commute origin (campus or home), from profile.yaml candidate.home. Default: SDSU campus.
export const HOME = PROFILE.candidate?.home ?? { lat: 32.7757, lon: -117.0719 };

// The candidate's own school as an employer (on-campus jobs): candidate.school plus campus_aliases.
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const schoolNames = [PROFILE.candidate?.school, ...(PROFILE.candidate?.campus_aliases ?? [])].filter(Boolean);
export const SCHOOL_RE = schoolNames.length ? new RegExp(schoolNames.map(n => `\\b${escRe(n)}\\b`).join('|'), 'i') : /$^/;
export function milesFromHome(job) {
  let raw = null; try { raw = job.raw ? JSON.parse(job.raw) : null; } catch {}
  if (raw?.lat == null || raw?.lon == null) return null;
  const R = 3958.8, rad = d => d * Math.PI / 180;
  const dLat = rad(raw.lat - HOME.lat), dLon = rad(raw.lon - HOME.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(HOME.lat)) * Math.cos(rad(raw.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The board groups by role type. Coarse on purpose: a handful of readable buckets.
const STUDENT_RE = /\b(student|peer|ambassador|grader|reader|mentor|work[- ]study|research assistant|teaching assistant|lab assistant)\b/i;
export function roleGroup(job) {
  const t = `${job.title ?? ''}`;
  if (job.track === 'internship') {
    return ({ 'Software': 'Software', 'AI/ML/Data': 'AI, ML & data', 'Quant': 'Quant & finance',
              'Hardware': 'Hardware & engineering', 'Product': 'Product & design', 'IT/Support': 'IT & support' })[job.category] ?? 'Other';
  }
  if (STUDENT_RE.test(t) || SCHOOL_RE.test(job.company ?? '')) return 'On-campus & student';
  if (/\b(tutor|teach|instruct|adjunct|lecturer|educator|coach)\b/i.test(t)) return 'Tutoring & teaching';
  // Tech only when the TITLE says so. The inferred category is too noisy for part-time
  // ("Night Auditor" and "Mobile Examiner" both came out as Software via description text).
  if (/\b(software|developer|engineer|programm\w*|firmware|devops|web|cloud|cyber\w*|network\w*|computer|it (support|help|tech\w*)|help ?desk|data (analy\w*|scien\w*|engineer\w*)|python|java)\b/i.test(t)) return 'Tech & data';
  if (/\b(nurse|lvn|rn\b|caregiver|care\b|medical|dental|therapist|clinic|health|hospital|pharmac|psychiatr)\b/i.test(t)) return 'Healthcare & care';
  if (/\b(barista|server|cashier|retail|sales|host|guest|hotel|food|kitchen|cook|fitness|spa|floor staff|concierge|restaurant|bartender|recreation)\b/i.test(t)) return 'Retail, food & hospitality';
  if (/\b(data entry|clerk|call (taker|handler)|receptionist|admin|coordinator|office|scheduling|typist|transcri)\b/i.test(t)) return 'Admin & data entry';
  return 'Other';
}

// ── Location tier (M12, 2026-11-04): California first ─────────────────────────────
// The user: anywhere in the US is fine, but San Diego area and the Bay Area come first, then the rest
// of California. Calibrated against the real location strings in the corpus (558 distinct): Simplify
// shorthands ("SF", "NYC", "LA", "Remote in USA"), bare state names ("Georgia"), "City, ST",
// "City, ON, Canada", SerpApi's "San Diego, San Diego County". City names that also exist outside
// California (San Marcos TX, Oceanside NY, Dublin OH/Ireland, Newark NJ, Fremont OH…) only count as
// California when the string itself says CA/California.
const CA_MARK = /,\s*ca\b|\bcalifornia\b|\bca\s*\d{5}/i;
const SD_ALWAYS = /\b(san diego|la jolla|sorrento valley|del mar|poway|chula vista|rancho bernardo|kearny mesa|mira mesa|carlsbad|encinitas|el cajon|national city)\b/i;
const SD_IF_CA  = /\b(san marcos|oceanside|vista|coronado|escondido|la mesa|santee|solana beach)\b/i;
const BAY_ALWAYS = /\b(san francisco|south san francisco|san jose|santa clara|sunnyvale|mountain view|palo alto|menlo park|redwood city|redwood shores|cupertino|milpitas|san mateo|foster city|burlingame|oakland|emeryville|silicon valley|bay area)\b/i;
const BAY_IF_CA  = /\b(berkeley|dublin|newark|fremont|hayward|pleasanton|livermore|union city|belmont|san carlos|campbell|los gatos|saratoga|walnut creek|san bruno|alameda|san leandro|san ramon)\b/i;
const OTHER_CA   = /\b(los angeles|irvine|santa monica|pasadena|sacramento|santa barbara|long beach|burbank|el segundo|culver city|playa vista|torrance|anaheim|costa mesa|newport beach|glendale|thousand oaks|san luis obispo|fresno|riverside)\b/i;
const NON_US = /\b(canada|uk|united kingdom|england|scotland|ireland|india|germany|france|spain|italy|portugal|netherlands|belgium|switzerland|austria|sweden|denmark|norway|finland|poland|czech|romania|hungary|greece|israel|singapore|japan|china|hong kong|taiwan|korea|australia|new zealand|mexico|brazil|argentina|chile|colombia|costa rica|philippines|vietnam|thailand|malaysia|indonesia|uae|dubai|saudi|south africa|egypt|nigeria|kenya|turkey|pakistan)\b|,\s*(on|bc|qc|ab|mb|ns|nb|nl|pe|sk)\b/i;

export const REGION_LABEL = { sd: 'San Diego', bay: 'Bay Area', ca: 'California', remote: 'Remote (US)', us: 'Rest of US', nonus: 'Outside US' };

function tierOfOne(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^unspecified$/i.test(s)) return 'us';                 // unknown — never gate on it
  if (NON_US.test(s)) return 'nonus';
  if (/^sf$/i.test(s)) return 'bay';
  if (/^la$/i.test(s)) return 'ca';
  const ca = CA_MARK.test(s);
  if (SD_ALWAYS.test(s) || (ca && SD_IF_CA.test(s))) return 'sd';
  if (BAY_ALWAYS.test(s) || (ca && BAY_IF_CA.test(s))) return 'bay';
  if (ca || OTHER_CA.test(s)) return 'ca';
  if (/\bremote\b|work\s?from\s?home|\banywhere\b/i.test(s)) return 'remote';
  return 'us';
}
const RANK = { sd: 0, bay: 1, ca: 2, remote: 3, us: 4, nonus: 5 };
// A posting listing several cities takes its BEST tier (a role offered in "NYC, SF" is a Bay Area option).
export function locationTier(job) {
  let locs = [];
  try { const r = job.raw ? JSON.parse(job.raw) : null; if (Array.isArray(r?.locations)) locs = r.locations; } catch {}
  if (!locs.length) locs = String(job.location ?? '').split(/\s*[•|;]\s*/);
  let best = 'nonus';
  for (const l of locs) { const t = tierOfOne(l); if (RANK[t] < RANK[best]) best = t; }
  // The remote flag only says "remote", not where: it may upgrade an unplaced US posting, but never a
  // posting whose locations are all outside the US ("Remote in UK" is still UK — caught 2026-11-04).
  if (job.remote && best === 'us') best = 'remote';
  return best;
}
