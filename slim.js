import './bridge.js';

/*
 * Greyhaven Life v1.7.0 — Slim runtime
 * Keeps the proven clock, schedules, exceptions and world/phone bridge while
 * replacing the location/presence/world-snapshot prompt with a compact schedule-first prompt.
 */

const GH_SLIM_VERSION = '1.8.0';
const SETTINGS_KEY = 'greyhavenLife';
const META_KEY = 'greyhavenLifeSlim';
const OLD_META_KEY = 'greyhavenLife';
const OLD_PROMPT_KEY = 'greyhaven_life_state';
const SLIM_PROMPT_KEY = 'greyhaven_life_slim_state';
const PROMPT_POSITION = 1;
const PROMPT_ROLE_SYSTEM = 0;

const norm = value => String(value ?? '').trim();
const lc = value => norm(value).toLowerCase();
const clone = value => {
  if (value == null) return value;
  try { return structuredClone(value); } catch {}
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
};
const uid = prefix => `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
const ctx = () => {
  try { return globalThis.SillyTavern?.getContext?.() ?? null; }
  catch { return null; }
};
const life = () => globalThis.GreyhavenLife || null;
const nowDate = () => {
  try { return life()?.getTime?.() ?? new Date(); }
  catch { return new Date(); }
};
const esc = value => norm(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function settings() {
  const c = ctx();
  if (!c?.extensionSettings) return { defaultProfiles: {}, globalScheduleProfiles: {} };
  c.extensionSettings[SETTINGS_KEY] ||= {};
  const s = c.extensionSettings[SETTINGS_KEY];
  if (!s.defaultProfiles || typeof s.defaultProfiles !== 'object' || Array.isArray(s.defaultProfiles)) s.defaultProfiles = {};
  if (!s.globalScheduleProfiles || typeof s.globalScheduleProfiles !== 'object' || Array.isArray(s.globalScheduleProfiles)) s.globalScheduleProfiles = {};
  return s;
}

function saveSettings() {
  const c = ctx();
  try { c?.saveSettingsDebounced?.(); } catch {}
}

function chatState({ create = true } = {}) {
  const c = ctx();
  if (!c?.chatMetadata) return null;
  let s = c.chatMetadata[META_KEY];
  if (!s && create) {
    s = { version: 1, createdAt: Date.now(), updatedAt: Date.now(), exceptions: {}, migratedLegacyExceptions: false, migratedLegacySchedulesToGlobalV1: false };
    c.chatMetadata[META_KEY] = s;
  }
  if (!s || typeof s !== 'object') return null;
  s.version = 1;
  s.exceptions ||= {};
  if (!s.migratedLegacyExceptions) migrateLegacyExceptions(s);
  return s;
}

function persistChatState(s, reason = 'slim-state') {
  const c = ctx();
  if (!c?.chatMetadata || !s) return;
  s.updatedAt = Date.now();
  c.chatMetadata[META_KEY] = s;
  try {
    c.updateChatMetadata?.({ [META_KEY]: s });
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else c.saveMetadata?.();
  } catch (error) {
    console.warn('[greyhaven-life-slim] chat state save failed', error);
  }
  try { window.dispatchEvent(new CustomEvent('greyhaven-life-slim:changed', { detail: { reason, state: clone(s) } })); } catch {}
  updatePrompt();
}

function migrateLegacyExceptions(target) {
  target.migratedLegacyExceptions = true;
  const old = ctx()?.chatMetadata?.[OLD_META_KEY];
  if (!old?.people || typeof old.people !== 'object') return;
  for (const person of Object.values(old.people)) {
    const name = norm(person?.name);
    if (!name || !Array.isArray(person?.exceptions) || !person.exceptions.length) continue;
    const key = lc(name);
    target.exceptions[key] ||= [];
    for (const item of person.exceptions) {
      if (!item || !Number.isFinite(Number(item.startMs))) continue;
      const id = norm(item.id) || uid('exception');
      if (target.exceptions[key].some(x => x.id === id)) continue;
      target.exceptions[key].push(normalizeException({ ...item, id, personName: name }));
    }
  }
}

function characterDescriptors() {
  const c = ctx();
  const rows = [];
  const seen = new Set();
  const add = row => {
    const name = norm(row?.name);
    if (!name || seen.has(lc(name))) return;
    seen.add(lc(name));
    rows.push({ name, avatar: norm(row.avatar), source: row.source || 'character', sourceKey: norm(row.sourceKey) });
  };
  for (const ch of c?.characters || []) add({ name: ch?.name, avatar: ch?.avatar, source: 'character', sourceKey: ch?.avatar || ch?.name });
  if (c?.name1) add({ name: c.name1, avatar: '', source: 'persona', sourceKey: c.name1 });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function relevantNames() {
  const c = ctx();
  const names = [];
  const seen = new Set();
  const add = name => {
    name = norm(name);
    if (!name || seen.has(lc(name))) return;
    seen.add(lc(name));
    names.push(name);
  };
  add(c?.name1);

  if (c?.groupId && Array.isArray(c?.groups)) {
    const group = c.groups.find(g => String(g?.id) === String(c.groupId));
    for (const member of group?.members || []) {
      const value = typeof member === 'string' ? member : (member?.avatar || member?.name || '');
      const ch = (c.characters || []).find(x => x?.avatar === value || lc(x?.name) === lc(value));
      add(ch?.name || (typeof member === 'object' ? member?.name : ''));
    }
  } else {
    const current = Number.isInteger(Number(c?.characterId)) ? c?.characters?.[Number(c.characterId)] : null;
    add(current?.name || c?.name2);
  }
  return names;
}

function profileKeyForDescriptor(d) {
  return `name:${lc(d?.name || d?.sourceKey || 'unknown')}`;
}

function normalizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? { ...profile } : {};
  p.name = norm(p.name || 'Unknown');
  p.avatar = norm(p.avatar);
  p.source = norm(p.source || 'character');
  p.sourceKey = norm(p.sourceKey || p.name);
  p.schedule = Array.isArray(p.schedule) ? p.schedule.map(normalizeSchedule) : [];
  p.updatedAt = Number.isFinite(Number(p.updatedAt)) ? Number(p.updatedAt) : Date.now();
  return p;
}

function scheduleFingerprint(entry) {
  const x = normalizeSchedule(entry);
  return [lc(x.label), [...x.days].sort((a,b)=>a-b).join(','), x.start, x.end, x.type, lc(x.status)].join('|');
}

function mergeScheduleRows(target = [], incoming = []) {
  const rows = Array.isArray(target) ? target.map(normalizeSchedule) : [];
  const fingerprints = new Set(rows.map(scheduleFingerprint));
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const item = normalizeSchedule(raw);
    const fp = scheduleFingerprint(item);
    if (rows.some(x => x.id === item.id) || fingerprints.has(fp)) continue;
    rows.push(item);
    fingerprints.add(fp);
  }
  return rows;
}

let scheduleMigrationBusy = false;
function migrateLegacySchedulesToGlobal() {
  if (scheduleMigrationBusy) return;
  scheduleMigrationBusy = true;
  try {
    const s = settings();
    let settingsChanged = false;

    const absorb = (rawProfile, fallbackName = '') => {
      const p = normalizeProfile({ ...(rawProfile || {}), name: norm(rawProfile?.name || fallbackName) });
      if (!p.name || !p.schedule.length) return;
      const key = lc(p.name);
      const existing = normalizeProfile(s.globalScheduleProfiles[key] || { name:p.name, avatar:p.avatar, source:p.source, sourceKey:p.sourceKey, schedule:[] });
      const before = existing.schedule.length;
      existing.name = p.name;
      existing.avatar ||= p.avatar;
      existing.source ||= p.source;
      existing.sourceKey ||= p.sourceKey;
      existing.schedule = mergeScheduleRows(existing.schedule, p.schedule);
      if (existing.schedule.length !== before || !s.globalScheduleProfiles[key]) {
        existing.updatedAt = Date.now();
        s.globalScheduleProfiles[key] = existing;
        settingsChanged = true;
      }
    };

    // One-time migration from the former Character Management "Life Defaults".
    if (!s.globalScheduleDefaultsMigratedV1) {
      for (const p of Object.values(s.defaultProfiles || {})) absorb(p);
      s.globalScheduleDefaultsMigratedV1 = true;
      settingsChanged = true;
    }

    // Gradually rescue old chat-local schedules. Each legacy chat is imported
    // once when it is opened, so old schedules are not lost but deleted global
    // schedules are never re-created from the same chat later.
    const c = ctx();
    let slim = c?.chatMetadata?.[META_KEY];
    if (!slim && c?.chatMetadata) {
      slim = { version:1, createdAt:Date.now(), updatedAt:Date.now(), exceptions:{}, migratedLegacyExceptions:false, migratedLegacySchedulesToGlobalV1:false };
      c.chatMetadata[META_KEY] = slim;
    }
    const old = c?.chatMetadata?.[OLD_META_KEY];
    if (slim && !slim.migratedLegacySchedulesToGlobalV1) {
      if (old?.people && typeof old.people === 'object') {
        for (const person of Object.values(old.people)) {
          const name = norm(person?.name);
          if (!name || !Array.isArray(person?.schedule) || !person.schedule.length) continue;
          absorb({ name, avatar:person?.avatar || '', source:person?.source || 'character', sourceKey:person?.sourceKey || name, schedule:person.schedule });
        }
      }
      slim.migratedLegacySchedulesToGlobalV1 = true;
      slim.updatedAt = Date.now();
      try {
        c.chatMetadata[META_KEY] = slim;
        c.updateChatMetadata?.({ [META_KEY]: slim });
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
      } catch {}
    }

    if (settingsChanged) saveSettings();
  } finally {
    scheduleMigrationBusy = false;
  }
}

function findProfile(name, { create = false } = {}) {
  name = norm(name);
  if (!name) return null;
  migrateLegacySchedulesToGlobal();
  const s = settings();
  const key = lc(name);
  if (s.globalScheduleProfiles[key]) {
    const profile = normalizeProfile(s.globalScheduleProfiles[key]);
    s.globalScheduleProfiles[key] = profile;
    return { key, profile };
  }
  if (!create) return null;

  const d = characterDescriptors().find(x => lc(x.name) === key) || { name, source:'character', sourceKey:name, avatar:'' };
  const profile = normalizeProfile({ name:d.name, avatar:d.avatar, source:d.source, sourceKey:d.sourceKey, schedule:[] });
  s.globalScheduleProfiles[key] = profile;
  saveSettings();
  return { key, profile };
}
function normalizeSchedule(entry) {
  const x = entry && typeof entry === 'object' ? { ...entry } : {};
  x.id = norm(x.id) || uid('schedule');
  x.label = norm(x.label || 'Schedule');
  x.days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))] : [];
  x.start = /^\d{2}:\d{2}$/.test(norm(x.start)) ? norm(x.start) : '09:00';
  x.end = /^\d{2}:\d{2}$/.test(norm(x.end)) ? norm(x.end) : '17:00';
  x.status = norm(x.status);
  x.availability = norm(x.availability || 'busy');
  x.priority = Number.isFinite(Number(x.priority)) ? Number(x.priority) : 0;
  x.type = x.type === 'obligation' ? 'obligation' : 'routine';
  x.reminderMinutes = Math.max(0, Math.min(1440, Number(x.reminderMinutes ?? 60)));
  x.notes = norm(x.notes);
  // Location/grace fields may remain in old records but Slim deliberately ignores them.
  return x;
}

function normalizeException(entry) {
  const x = entry && typeof entry === 'object' ? { ...entry } : {};
  x.id = norm(x.id) || uid('exception');
  x.personName = norm(x.personName);
  x.type = ['vacation', 'dayoff', 'sick', 'leave', 'cancelled', 'custom'].includes(x.type) ? x.type : 'custom';
  x.label = norm(x.label || ({ vacation: 'Vacation', dayoff: 'Day off', sick: 'Sick day', leave: 'Leave', cancelled: 'Cancelled schedule' }[x.type] || 'Exception'));
  x.startMs = Number.isFinite(Number(x.startMs)) ? Number(x.startMs) : nowDate().getTime();
  x.endMs = Number.isFinite(Number(x.endMs)) ? Number(x.endMs) : null;
  x.suppressObligations = x.suppressObligations !== false;
  x.notes = norm(x.notes);
  return x;
}

function hmToMinutes(hm) {
  const [h, m] = String(hm || '00:00').split(':').map(Number);
  return (Number(h || 0) * 60) + Number(m || 0);
}

function scheduleOccurrence(entry, date) {
  entry = normalizeSchedule(entry);
  const startMin = hmToMinutes(entry.start);
  const endMin = hmToMinutes(entry.end);
  const overnight = endMin <= startMin;

  const checkDay = base => {
    const day = base.getDay();
    if (!entry.days.includes(day)) return null;
    const start = new Date(base); start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const end = new Date(base); end.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
    if (overnight) end.setDate(end.getDate() + 1);
    return { entry, start, end };
  };

  const today = new Date(date); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const candidates = [checkDay(yesterday), checkDay(today)].filter(Boolean);
  return candidates.find(o => date >= o.start && date < o.end) || null;
}

function nextOccurrence(entry, date, horizonHours = 18) {
  entry = normalizeSchedule(entry);
  for (let offset = 0; offset <= 7; offset++) {
    const base = new Date(date); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() + offset);
    if (!entry.days.includes(base.getDay())) continue;
    const startMin = hmToMinutes(entry.start);
    const endMin = hmToMinutes(entry.end);
    const start = new Date(base); start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const end = new Date(base); end.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
    if (endMin <= startMin) end.setDate(end.getDate() + 1);
    if (start <= date) continue;
    if (start.getTime() - date.getTime() > horizonHours * 3600000) return null;
    return { entry, start, end };
  }
  return null;
}

function exceptionsFor(name) {
  const s = chatState();
  return clone((s?.exceptions?.[lc(name)] || []).map(normalizeException).sort((a, b) => a.startMs - b.startMs));
}

function activeException(name, at = nowDate()) {
  const ms = at.getTime();
  return exceptionsFor(name).find(x => ms >= x.startMs && (x.endMs == null || ms <= x.endMs)) || null;
}

function activeSchedule(name, at = nowDate()) {
  const found = findProfile(name, { create: false });
  if (!found) return null;
  const occurrences = found.profile.schedule.map(x => scheduleOccurrence(x, at)).filter(Boolean);
  occurrences.sort((a, b) => Number(b.entry.priority || 0) - Number(a.entry.priority || 0));
  return occurrences[0] || null;
}

function upcomingSchedule(name, at = nowDate(), horizonHours = 6) {
  const found = findProfile(name, { create: false });
  if (!found) return null;
  const rows = found.profile.schedule.map(x => nextOccurrence(x, at, horizonHours)).filter(Boolean).sort((a, b) => a.start - b.start);
  return rows[0] || null;
}

function formatClock(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function buildPrompt() {
  const c = ctx();
  if (!c || !(c.getCurrentChatId?.() || c.chatId)) return '';
  const now = nowDate();
  const names = relevantNames();
  const lines = [
    '[Greyhaven Life — compact authoritative continuity. Use silently; never quote this block as metadata.]',
    `Current fictional time: ${formatClock(now)}. This clock is authoritative unless the newest roleplay explicitly changes time.`,
  ];

  for (const name of names) {
    const ex = activeException(name, now);
    if (ex?.suppressObligations) {
      lines.push(`${name}: active exception — ${ex.label}${ex.notes ? ` (${ex.notes})` : ''}. Normal recurring schedules are suspended for this period.`);
      continue;
    }

    const active = activeSchedule(name, now);
    if (active) {
      const type = active.entry.type === 'obligation' ? 'obligation' : 'routine';
      lines.push(`${name}: normal current ${type}: ${active.entry.label} (${active.entry.start}–${active.entry.end})${active.entry.status ? `; ${active.entry.status}` : ''}. If the newest roleplay does not establish a different current situation, use this as the default activity. Explicit roleplay always overrides the schedule.`);
      continue;
    }

    const upcoming = upcomingSchedule(name, now, 3);
    if (upcoming) {
      const mins = Math.max(1, Math.round((upcoming.start.getTime() - now.getTime()) / 60000));
      lines.push(`${name}: upcoming ${upcoming.entry.type === 'obligation' ? 'obligation' : 'routine'}: ${upcoming.entry.label} at ${upcoming.entry.start} in about ${mins} minutes. This is an expectation, not a forced action.`);
    }
  }

  lines.push('Schedule rule: never infer lateness automatically and never teleport anyone. If recent roleplay says a character skipped work, called in sick, is travelling, or is doing something different, the roleplay wins. If there is no contrary roleplay and an active schedule exists, the scheduled activity is the normal default.');
  return lines.join('\n');
}

function enforceSlimSettings() {
  const c = ctx();
  if (!c?.extensionSettings) return;
  const s = settings();
  let changed = false;
  const desired = {
    promptEnabled: false,
    autoAddParticipants: false,
    hudShowScene: false,
    injectSceneNotes: false,
    injectPersonNotes: false,
    slimMode: true,
  };
  for (const [key, value] of Object.entries(desired)) {
    if (s[key] !== value) { s[key] = value; changed = true; }
  }
  if (changed) saveSettings();
}

function updatePrompt() {
  const c = ctx();
  if (!c?.setExtensionPrompt) return;
  enforceSlimSettings();
  try {
    c.setExtensionPrompt(OLD_PROMPT_KEY, '', PROMPT_POSITION, 1, false, PROMPT_ROLE_SYSTEM);
    c.setExtensionPrompt(SLIM_PROMPT_KEY, buildPrompt(), PROMPT_POSITION, 1, false, PROMPT_ROLE_SYSTEM);
  } catch (error) {
    console.warn('[greyhaven-life-slim] prompt update failed', error);
  }
}

function getScheduleProfiles() {
  migrateLegacySchedulesToGlobal();
  const s = settings();
  const map = new Map();
  for (const d of characterDescriptors()) map.set(lc(d.name), { ...d, schedule: [] });
  for (const p of Object.values(s.globalScheduleProfiles || {})) {
    const profile = normalizeProfile(p);
    const key = lc(profile.name);
    if (!key) continue;
    const base = map.get(key) || { name:profile.name, avatar:profile.avatar || '', source:profile.source || 'character', sourceKey:profile.sourceKey || '' };
    map.set(key, { ...base, schedule:clone(profile.schedule), updatedAt:profile.updatedAt });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function saveSchedule(name, data = {}) {
  const found = findProfile(name, { create: true });
  if (!found) return null;
  const p = found.profile;
  const item = normalizeSchedule(data);
  const index = p.schedule.findIndex(x => x.id === item.id);
  if (index >= 0) p.schedule[index] = item;
  else p.schedule.push(item);
  p.updatedAt = Date.now();
  settings().globalScheduleProfiles[found.key] = p;
  saveSettings();
  updatePrompt();
  try { window.dispatchEvent(new CustomEvent('greyhaven-life-global-schedules:changed', { detail:{ name:p.name, action:index >= 0 ? 'update' : 'add' } })); } catch {}
  return clone(item);
}

function deleteSchedule(name, id) {
  const found = findProfile(name, { create: false });
  if (!found) return false;
  const before = found.profile.schedule.length;
  found.profile.schedule = found.profile.schedule.filter(x => x.id !== id);
  found.profile.updatedAt = Date.now();
  settings().globalScheduleProfiles[found.key] = found.profile;
  saveSettings();
  updatePrompt();
  const deleted = found.profile.schedule.length < before;
  if (deleted) try { window.dispatchEvent(new CustomEvent('greyhaven-life-global-schedules:changed', { detail:{ name:found.profile.name, action:'delete' } })); } catch {}
  return deleted;
}

function upcomingSchedules(name, at = nowDate(), horizonHours = 18) {
  const found = findProfile(name, { create:false });
  if (!found) return [];
  return found.profile.schedule
    .map(x => nextOccurrence(x, at, horizonHours))
    .filter(Boolean)
    .sort((a,b) => a.start - b.start);
}

function clockState() {
  try {
    const state = life()?.getState?.();
    const time = state?.time || {};
    return {
      mode: ['real','offset','manual'].includes(time.mode) ? time.mode : 'real',
      manualRunning: time.manualRunning !== false,
      offsetMinutes: Number(time.offsetMinutes || 0),
      now: nowDate().toISOString(),
    };
  } catch {
    return { mode:'real', manualRunning:true, offsetMinutes:0, now:nowDate().toISOString() };
  }
}
function saveException(name, data = {}) {
  name = norm(name);
  if (!name) return null;
  const s = chatState();
  const key = lc(name);
  s.exceptions[key] ||= [];
  const item = normalizeException({ ...data, personName: name });
  const index = s.exceptions[key].findIndex(x => x.id === item.id);
  if (index >= 0) s.exceptions[key][index] = item;
  else s.exceptions[key].push(item);
  persistChatState(s, 'exception');
  return clone(item);
}

function deleteException(name, id) {
  const s = chatState();
  const key = lc(name);
  const rows = s.exceptions[key] || [];
  const before = rows.length;
  s.exceptions[key] = rows.filter(x => x.id !== id);
  persistChatState(s, 'exception-delete');
  return s.exceptions[key].length < before;
}

let clockOpenAttempt = 0;

function phoneOverlayVisible() {
  const overlay = document.querySelector('#ghp-overlay');
  return !!(overlay && !overlay.hidden);
}

function openClock() {
  clockOpenAttempt += 1;
  const requestId = clockOpenAttempt;

  const tryOpen = (attempt = 0) => {
    if (requestId !== clockOpenAttempt) return;

    const phone = globalThis.GreyhavenPhone;
    const phoneLife = globalThis.GreyhavenPhoneLifeAssets;

    // When the Phone is already open, go straight to Life -> Clock.
    if (phoneOverlayVisible() && typeof phoneLife?.openLife === 'function') {
      try {
        phoneLife.openLife('clock');
        return;
      } catch (error) {
        console.warn('[greyhaven-life-slim] Phone Clock open failed', error);
      }
    }

    // The old v1.7.0 tried openLife while the Phone was closed. openLife had
    // nowhere to render, so the tap appeared to do nothing. Open the Phone first.
    if (attempt === 0 && typeof phone?.open === 'function') {
      try {
        Promise.resolve(phone.open()).catch(error => {
          console.warn('[greyhaven-life-slim] Phone open failed', error);
        });
      } catch (error) {
        console.warn('[greyhaven-life-slim] Phone open failed', error);
      }
    }

    // Give the Phone overlay and Life Assets module time to become available.
    if (attempt < 18) {
      setTimeout(() => tryOpen(attempt + 1), 90);
      return;
    }

    // Always leave the user with a working control surface.
    openFallback();
  };

  tryOpen(0);
}

function fallbackHtml() {
  const d = nowDate();
  return `<dialog id="gh-life-slim-fallback"><div class="gh-life-slim-card">
    <header><div><b>Greyhaven Life</b><small>Clock & schedules</small></div><button data-gh-slim-close>×</button></header>
    <section><strong>${esc(d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false }))}</strong><span>${esc(d.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' }))}</span></section>
    <div class="gh-life-slim-actions"><button data-gh-slim-shift="15">+15m</button><button data-gh-slim-shift="60">+1h</button><button data-gh-slim-shift="240">+4h</button></div>
    <p>Open Greyhaven Phone → Life → Clock for full schedule and exception management.</p>
  </div></dialog>`;
}

function openFallback() {
  document.querySelector('#gh-life-slim-fallback')?.remove();
  document.body.insertAdjacentHTML('beforeend', fallbackHtml());
  const d = document.querySelector('#gh-life-slim-fallback');
  try { d.showModal(); } catch { d.setAttribute('open', ''); }
}

function interceptLegacyOpeners() {
  document.addEventListener('click', event => {
    const target = event.target?.closest?.('#gh-life-hud,#gh-life-menu-entry');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openClock();
  }, true);

  document.addEventListener('click', event => {
    const b = event.target?.closest?.('[data-gh-slim-close],[data-gh-slim-shift]');
    if (!b) return;
    if (b.matches('[data-gh-slim-close]')) document.querySelector('#gh-life-slim-fallback')?.close();
    if (b.dataset.ghSlimShift) {
      life()?.shiftMinutes?.(Number(b.dataset.ghSlimShift));
      openFallback();
    }
  });
}

function injectStyle() {
  if (document.querySelector('#gh-life-slim-style')) return;
  const style = document.createElement('style');
  style.id = 'gh-life-slim-style';
  style.textContent = `
#gh-life-hud .gh-life-hud-scene{display:none!important}
#gh-life-character-defaults-button,#gh-life-default-profile-dialog,#gh-life-default-schedule-dialog{display:none!important}
#gh-life-slim-fallback{border:0;background:transparent;padding:0;color:#fff;max-width:min(92vw,440px);width:100%}
#gh-life-slim-fallback::backdrop{background:rgba(0,0,0,.7);backdrop-filter:blur(8px)}
.gh-life-slim-card{background:#15171c;border:1px solid rgba(255,255,255,.1);border-radius:24px;overflow:hidden;box-shadow:0 22px 70px rgba(0,0,0,.5)}
.gh-life-slim-card header{display:flex;align-items:center;justify-content:space-between;padding:18px;border-bottom:1px solid rgba(255,255,255,.09)}
.gh-life-slim-card header div{display:flex;flex-direction:column}.gh-life-slim-card header b{font-size:20px}.gh-life-slim-card header small{color:#8e929c}
.gh-life-slim-card header button{width:42px;height:42px;border:0;border-radius:50%;background:#242730;color:#fff;font-size:26px}
.gh-life-slim-card section{display:flex;flex-direction:column;gap:4px;padding:22px 18px}.gh-life-slim-card section strong{font-size:54px;line-height:1}.gh-life-slim-card section span{color:#9da1ab}
.gh-life-slim-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 18px 18px}.gh-life-slim-actions button{min-height:44px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#20232a;color:#fff}
.gh-life-slim-card p{margin:0;padding:0 18px 20px;color:#8f939c;font-size:12px;line-height:1.45}
`;
  document.head.appendChild(style);
}

function expose() {
  const api = life();
  if (!api) return false;

  // Keep the old full-panel opener available only as a compatibility escape
  // hatch, while making the normal GreyhavenLife.open() route use the new Clock.
  if (!api.openLegacyPanel && typeof api.open === 'function' && api.open !== openClock) {
    try { api.openLegacyPanel = api.open.bind(api); } catch {}
  }

  Object.assign(api, {
    slimVersion: GH_SLIM_VERSION,
    open: openClock,
    openSlim: openClock,
    openClock,
    getSlimScheduleProfiles: getScheduleProfiles,
    saveSlimSchedule: saveSchedule,
    deleteSlimSchedule: deleteSchedule,
    getSlimExceptions: exceptionsFor,
    saveSlimException: saveException,
    deleteSlimException: deleteException,
    getSlimCurrentSchedule: name => clone(activeSchedule(name, nowDate())),
    getSlimUpcomingSchedule: (name, hours = 6) => clone(upcomingSchedule(name, nowDate(), hours)),
    getSlimUpcomingSchedules: (name, hours = 18) => clone(upcomingSchedules(name, nowDate(), hours)),
    getSlimActiveException: name => clone(activeException(name, nowDate())),
    getSlimClockState: clockState,
    getSlimPromptSummary: buildPrompt,

    // Compatibility: all callers now see the same global schedule registry.
    getCurrentSchedule: name => clone(activeSchedule(name, nowDate())),
    getUpcomingSchedules: (name, hours = 18) => clone(upcomingSchedules(name, nowDate(), hours)),
    getDefaultProfile: ref => {
      const name = typeof ref === 'string' ? ref : norm(ref?.name);
      return clone(findProfile(name, { create:false })?.profile || null);
    },
  });
  return true;
}

function bindEvents() {
  const c = ctx();
  if (!c?.eventSource || !c?.eventTypes) return;
  const bind = (key, fn) => { const e = c.eventTypes[key]; if (e) c.eventSource.on(e, fn); };
  for (const key of ['GENERATION_STARTED','CHAT_CHANGED','CHAT_CREATED','PERSONA_CHANGED','GROUP_UPDATED','CHARACTER_EDITED']) {
    bind(key, () => setTimeout(() => { if (key !== 'GENERATION_STARTED') { chatState(); migrateLegacySchedulesToGlobal(); } expose(); updatePrompt(); }, key === 'GENERATION_STARTED' ? 0 : 40));
  }
  window.addEventListener('greyhaven-life:tick', updatePrompt);
  window.addEventListener('greyhaven-life:changed', updatePrompt);
  window.addEventListener('greyhaven-life-slim:changed', updatePrompt);
}

async function init() {
  for (let i = 0; i < 240; i++) {
    if (globalThis.GreyhavenLife && ctx()?.extensionSettings) break;
    await new Promise(r => setTimeout(r, 50));
  }
  if (!globalThis.GreyhavenLife) {
    console.error('[greyhaven-life-slim] core did not initialize');
    return;
  }
  injectStyle();
  enforceSlimSettings();
  chatState();
  migrateLegacySchedulesToGlobal();
  expose();
  interceptLegacyOpeners();
  bindEvents();
  updatePrompt();
  console.info(`[greyhaven-life-slim] v${GH_SLIM_VERSION} ready`);
}

void init().catch(error => console.error('[greyhaven-life-slim] init failed', error));
