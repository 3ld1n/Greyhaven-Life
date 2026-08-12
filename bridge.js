import './index.js';

/*
 * Greyhaven Life v1.6.0 bridge layer
 * Builds on Greyhaven Life core v1.3.1 and adds:
 * - shared Greyhaven World/Event Ledger
 * - RP -> Phone hidden action bridge
 * - one-time plans/events
 * - compact bridge settings and public APIs
 */

const GHW_VERSION = '1.6.0';
const CORE_VERSION = '1.3.1';
const WORLD_META_KEY = 'greyhavenWorld';
const LIFE_META_KEY = 'greyhavenLife';
const LIFE_SETTINGS_KEY = 'greyhavenLife';
const ACTION_PROMPT_KEY = 'greyhaven_world_bridge_actions';
const PLAN_PROMPT_KEY = 'greyhaven_life_one_time_plans';
const WORLD_PROMPT_KEY = 'greyhaven_world_recent_events';
const PROMPT_POSITION_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;
const MARKER_RE = /<!--\s*GH_ACTION\s+([\s\S]*?)-->/gi;
const MAX_WORLD_EVENTS = 400;
const MAX_PROCESSED = 320;
const SUPPORTED_ACTION_TYPES = new Set([
    'message.send', 'media.send', 'call.place',
    'contact.block', 'contact.unblock', 'contact.add', 'contact.exchange',
    'instagram.follow', 'instagram.unfollow',
    'snapchat.add', 'snapchat.accept', 'snapchat.decline',
    'facebook.friend.request', 'facebook.friend.accept', 'facebook.friend.decline',
]);

let bridgeReady = false;
let bridgeBound = false;
let uiObserver = null;
let uiQueued = false;
let lastActionPrompt = '';
let lastPlanPrompt = '';
let lastWorldPrompt = '';

const clone = value => {
    if (value == null) return value;
    try { return structuredClone(value); } catch {}
    return JSON.parse(JSON.stringify(value));
};
const norm = value => String(value ?? '').trim();
const lc = value => norm(value).toLowerCase();
const esc = value => norm(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
const uuid = () => {
    try { return crypto.randomUUID(); }
    catch { return `ghw-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
};
const hashText = text => {
    let h = 2166136261;
    for (const ch of String(text ?? '')) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
};
const ctx = () => {
    try { return globalThis.SillyTavern?.getContext?.() ?? null; }
    catch { return null; }
};
const hasChat = () => {
    const c = ctx();
    return !!(c?.chatMetadata && (c?.getCurrentChatId?.() || c?.chatId));
};
const roleplayNowMs = () => {
    const life = globalThis.GreyhavenLife;
    try { return life?.getTime?.()?.getTime?.() ?? Date.now(); }
    catch { return Date.now(); }
};
const chatIdentity = () => {
    const c = ctx();
    if (!c) return '';
    const chatId = c.getCurrentChatId?.() || c.chatId || '';
    return c.groupId ? `group:${c.groupId}:${chatId}` : `char:${c.characterId}:${chatId}`;
};
const formatDateTime = ms => {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
};
const toLocalInput = ms => {
    const d = new Date(Number(ms));
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const parseLocalInput = value => {
    const d = new Date(String(value || ''));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
};
const formatLocation = (place='', area='') => [norm(place), norm(area)].filter(Boolean).join(' · ');

/* ---------------- Settings ---------------- */

function bridgeSettings() {
    const c = ctx();
    const defaults = {
        worldBridgeEnabled: true,
        relayMode: 'smart', // economy | smart | live
        relayResponseTokens: 420,
        oneTimePlanPromptEnabled: true,
    };
    if (!c?.extensionSettings) return defaults;
    c.extensionSettings[LIFE_SETTINGS_KEY] ||= {};
    const s = c.extensionSettings[LIFE_SETTINGS_KEY];
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in s)) s[k] = v;
    }
    if (!['economy','smart','live'].includes(s.relayMode)) s.relayMode = 'smart';
    s.relayResponseTokens = Math.max(180, Math.min(700, Number(s.relayResponseTokens || 420)));
    return s;
}
function saveBridgeSettings(patch={}) {
    const c = ctx();
    if (!c?.extensionSettings) return;
    const s = bridgeSettings();
    Object.assign(s, patch);
    c.extensionSettings[LIFE_SETTINGS_KEY] = s;
    c.saveSettingsDebounced?.();
    updateBridgePrompts();
    injectLifeUiSoon();
}

/* ---------------- Shared World Ledger ---------------- */

function defaultWorld() {
    return {
        version: 1,
        seq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
        processed: [],
    };
}
function worldRoot({create=true}={}) {
    const c = ctx();
    if (!c?.chatMetadata || !hasChat()) return create ? defaultWorld() : null;
    let root = c.chatMetadata[WORLD_META_KEY];
    if (!root && create) {
        root = defaultWorld();
        c.chatMetadata[WORLD_META_KEY] = root;
        persistWorld(root);
    }
    if (!root || typeof root !== 'object') return null;
    root.version = Math.max(1, Number(root.version || 1));
    root.seq = Math.max(0, Number(root.seq || 0));
    root.createdAt ||= Date.now();
    root.updatedAt ||= Date.now();
    if (!Array.isArray(root.events)) root.events = [];
    if (!Array.isArray(root.processed)) root.processed = [];
    root.seq = Math.max(root.seq, ...root.events.map(e => Number(e?.seq || 0)), 0);
    return root;
}
function persistWorld(root) {
    const c = ctx();
    if (!c?.chatMetadata || !hasChat() || !root) return;
    root.updatedAt = Date.now();
    root.events = Array.isArray(root.events) ? root.events.slice(-MAX_WORLD_EVENTS) : [];
    root.processed = Array.isArray(root.processed) ? root.processed.slice(-MAX_PROCESSED) : [];
    c.chatMetadata[WORLD_META_KEY] = root;
    try {
        c.updateChatMetadata?.({[WORLD_META_KEY]: root});
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c.saveMetadata?.();
    } catch (e) {
        console.warn('[greyhaven-world] metadata save failed', e);
    }
}
function normalizeWorldEvent(data={}) {
    const participants = [...new Set(
        (Array.isArray(data.participants) ? data.participants : [data.actor, data.target])
            .map(norm).filter(Boolean)
    )];
    return {
        id: norm(data.id) || `world:${uuid()}`,
        seq: 0,
        type: norm(data.type) || 'event',
        actor: norm(data.actor || data.from || data.sender),
        target: norm(data.target || data.to),
        participants,
        app: norm(data.app || (String(data.type || '').startsWith('call.') ? 'phone' : 'messages')),
        text: norm(data.text),
        summary: norm(data.summary || data.text),
        data: data.data && typeof data.data === 'object' ? clone(data.data) : {},
        roleplayMs: Number.isFinite(Number(data.roleplayMs)) ? Number(data.roleplayMs) : roleplayNowMs(),
        realMs: Number.isFinite(Number(data.realMs)) ? Number(data.realMs) : Date.now(),
        source: norm(data.source || 'greyhaven'),
        sourceKey: norm(data.sourceKey || data.mirrorId),
        persistent: data.persistent === true,
        transient: data.transient === true,
    };
}
function recordWorldEvent(data={}) {
    const root = worldRoot();
    if (!root) return null;
    const event = normalizeWorldEvent(data);
    if (!event.summary && !event.text && !event.type) return null;
    if (event.sourceKey) {
        const existing = root.events.find(e => norm(e.sourceKey) === event.sourceKey);
        if (existing) return clone(existing);
    }
    event.seq = ++root.seq;
    root.events.push(event);
    persistWorld(root);
    updateWorldPrompt();
    try {
        window.dispatchEvent(new CustomEvent('greyhaven-world:event', {detail: clone(event)}));
    } catch {}
    return clone(event);
}
function getWorldEvents(options={}) {
    const root = worldRoot({create:false});
    if (!root) return [];
    const participants = (Array.isArray(options.participants) ? options.participants : [])
        .map(lc).filter(Boolean);
    const types = new Set((Array.isArray(options.types) ? options.types : []).map(norm).filter(Boolean));
    const sinceSeq = Math.max(0, Number(options.sinceSeq || 0));
    let rows = root.events.filter(e => Number(e.seq || 0) > sinceSeq);
    if (types.size) rows = rows.filter(e => types.has(e.type));
    if (participants.length) {
        rows = rows.filter(e => {
            const names = new Set([e.actor,e.target,...(e.participants||[])].map(lc).filter(Boolean));
            return participants.some(name => names.has(name));
        });
    }
    const limit = Math.max(1, Math.min(200, Number(options.limit || 60)));
    return clone(rows.slice(-limit));
}
function markProcessed(key) {
    key = norm(key);
    if (!key) return false;
    const root = worldRoot();
    if (!root) return false;
    if (root.processed.includes(key)) return false;
    root.processed.push(key);
    persistWorld(root);
    return true;
}

function normalizeActionPayload(input={}, fallbackActor='') {
    const type = norm(input.type);
    if (!SUPPORTED_ACTION_TYPES.has(type)) return null;

    const from = norm(input.from || input.actor || fallbackActor);
    const to = norm(input.to || input.target);
    if (!from || !to || lc(from) === lc(to)) return null;

    const action = {
        type,
        from,
        to,
        text:type === 'message.send' ? norm(input.text) : '',
        mediaType:type === 'media.send' && ['photo','video'].includes(lc(input.mediaType))
            ? lc(input.mediaType) : '',
        mediaDescription:type === 'media.send'
            ? norm(input.description || input.mediaDescription) : '',
        caption:type === 'media.send' ? norm(input.caption || input.text) : '',
        expectsReply:input.expectsReply === true,
        data:input.data && typeof input.data === 'object' ? clone(input.data) : {},
    };
    if (type === 'message.send' && !action.text) return null;
    if (type === 'media.send' && (!action.mediaType || !action.mediaDescription)) return null;
    return action;
}

function actionSummary(action) {
    if (action.type === 'message.send') return `${action.from} sent ${action.to} a private message: ${action.text}`;
    if (action.type === 'media.send') return `${action.from} sent ${action.to} a ${action.mediaType}: ${action.mediaDescription}${action.caption ? ` | caption: ${action.caption}` : ''}`;
    if (action.type === 'call.place') return `${action.from} placed a phone call to ${action.to}.`;
    if (action.type === 'contact.block') return `${action.from} blocked ${action.to}.`;
    if (action.type === 'contact.unblock') return `${action.from} unblocked ${action.to}.`;
    if (action.type === 'contact.add') return `${action.from} saved ${action.to}'s phone number.`;
    if (action.type === 'contact.exchange') return `${action.from} and ${action.to} exchanged phone numbers.`;
    if (action.type === 'instagram.follow') return `${action.from} followed ${action.to} on Instagram.`;
    if (action.type === 'instagram.unfollow') return `${action.from} unfollowed ${action.to} on Instagram.`;
    if (action.type === 'snapchat.add') return `${action.from} sent ${action.to} a Snapchat friend request.`;
    if (action.type === 'snapchat.accept') return `${action.from} accepted ${action.to}'s Snapchat friend request.`;
    if (action.type === 'snapchat.decline') return `${action.from} declined ${action.to}'s Snapchat friend request.`;
    if (action.type === 'facebook.friend.request') return `${action.from} sent ${action.to} a Facebook friend request.`;
    if (action.type === 'facebook.friend.accept') return `${action.from} accepted ${action.to}'s Facebook friend request.`;
    if (action.type === 'facebook.friend.decline') return `${action.from} declined ${action.to}'s Facebook friend request.`;
    return `${action.from} performed ${action.type} with ${action.to}.`;
}

function actionApp(type='') {
    if (String(type).startsWith('instagram.')) return 'instagram';
    if (String(type).startsWith('snapchat.')) return 'snapchat';
    if (String(type).startsWith('facebook.')) return 'facebook';
    if (String(type).startsWith('call.')) return 'phone';
    return 'messages';
}

/**
 * One public, idempotent action entry point for RP, Guided Generations and Phone AI.
 * Consumers materialize the resulting event through the same greyhaven-world-action bus.
 */
function dispatchWorldAction(input={}, options={}) {
    const action = normalizeActionPayload(input, options.fallbackActor || '');
    if (!action) return null;

    const sourceKey = norm(options.sourceKey || input.sourceKey);
    if (sourceKey && !markProcessed(sourceKey)) return null;
    const persistent = ['contact.block','contact.unblock','contact.add','contact.exchange','instagram.follow','instagram.unfollow','snapchat.add','snapchat.accept','snapchat.decline','facebook.friend.request','facebook.friend.accept','facebook.friend.decline'].includes(action.type);
    const event = recordWorldEvent({
        type:action.type,
        actor:action.from,
        target:action.to,
        participants:[action.from,action.to],
        app:actionApp(action.type),
        text:action.type === 'message.send' ? action.text : action.type === 'media.send' ? action.caption : '',
        summary:actionSummary(action),
        roleplayMs:Number.isFinite(Number(options.roleplayMs)) ? Number(options.roleplayMs) : roleplayNowMs(),
        realMs:Number.isFinite(Number(options.realMs)) ? Number(options.realMs) : Date.now(),
        source:norm(options.source || input.source || 'greyhaven-action-bus'),
        sourceKey,
        persistent,
        data:{
            ...action.data,
            expectsReply:action.expectsReply,
            rawType:action.type,
            mediaType:action.mediaType,
            mediaDescription:action.mediaDescription,
            caption:action.caption,
            inferred:options.inferred === true,
            relayDepth:Math.max(0, Number(options.relayDepth || action.data?.relayDepth || 0)),
        },
    });
    if (event) {
        try { window.dispatchEvent(new CustomEvent('greyhaven-world-action', {detail:clone(event)})); }
        catch {}
    }
    return event;
}

/* Import already-working manual Phone events into the shared ledger. */
function importPhoneContinuity(detail) {
    if (!detail || typeof detail !== 'object') return;
    const kind = norm(detail.kind || 'message');
    const participants = Array.isArray(detail.participants) ? detail.participants.map(norm).filter(Boolean) : [];
    const sender = norm(detail.sender);
    const target = participants.find(n => lc(n) !== lc(sender)) || '';
    const sourceKey = `phone-cont:${norm(detail.mirrorId || detail.id || `${detail.seq}:${detail.realMs}`)}`;
    recordWorldEvent({
        type: kind === 'call' ? 'call.activity' : kind === 'social' ? 'social.activity' : kind === 'media' ? 'message.media' : 'message.activity',
        actor: sender,
        target,
        participants,
        app: kind === 'call' ? 'phone' : kind === 'social' ? 'social' : 'messages',
        text: norm(detail.summary),
        summary: norm(detail.summary),
        roleplayMs: detail.roleplayMs,
        realMs: detail.realMs,
        source: 'greyhaven-phone',
        sourceKey,
        persistent: detail.persistent === true,
        transient: detail.transient === true,
        data: {phoneKind: kind, threadTitle: detail.threadTitle || '', mirrorId: detail.mirrorId || ''},
    });
}

/* ---------------- One-time plans ---------------- */

function lifeStateRaw({create=true}={}) {
    const c = ctx();
    if (!c?.chatMetadata || !hasChat()) return null;
    let state = c.chatMetadata[LIFE_META_KEY];
    if (!state && create) {
        // Let core create first when possible.
        globalThis.GreyhavenLife?.refresh?.();
        state = c.chatMetadata[LIFE_META_KEY];
    }
    if (!state || typeof state !== 'object') return null;
    if (!Array.isArray(state.oneTimePlans)) state.oneTimePlans = [];
    state.oneTimePlans = state.oneTimePlans.map(normalizePlan);
    return state;
}
function normalizePlan(input={}) {
    const p = input && typeof input === 'object' ? input : {};
    p.id ||= `plan:${uuid()}`;
    p.title = norm(p.title || 'Plan');
    p.participants = [...new Set(
        (Array.isArray(p.participants) ? p.participants : norm(p.participants).split(','))
            .map(norm).filter(Boolean)
    )];
    p.startMs = Number.isFinite(Number(p.startMs)) ? Number(p.startMs) : roleplayNowMs() + 3600000;
    p.endMs = Number.isFinite(Number(p.endMs)) ? Number(p.endMs) : p.startMs + 3600000;
    if (p.endMs <= p.startMs) p.endMs = p.startMs + 3600000;
    p.location = norm(p.location);
    p.area = norm(p.area);
    p.status = norm(p.status);
    p.availability = ['unknown','available','limited','busy','unavailable','sleeping'].includes(p.availability)
        ? p.availability : 'busy';
    p.reminderMinutes = Math.max(0, Math.min(10080, Number(p.reminderMinutes ?? 60)));
    p.graceMinutes = Math.max(0, Math.min(1440, Number(p.graceMinutes ?? 10)));
    p.notes = norm(p.notes);
    p.state = ['planned','completed','missed','cancelled'].includes(p.state) ? p.state : 'planned';
    p.createdAt ||= Date.now();
    p.updatedAt ||= Date.now();
    return p;
}
function saveLifeState(state, reason='one-time-plan') {
    const c = ctx();
    if (!c?.chatMetadata || !state) return;
    state.updatedAt = Date.now();
    c.chatMetadata[LIFE_META_KEY] = state;
    try {
        c.updateChatMetadata?.({[LIFE_META_KEY]: state});
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c.saveMetadata?.();
    } catch (e) {
        console.warn('[greyhaven-life-bridge] Life state save failed', e);
    }
    try {
        window.dispatchEvent(new CustomEvent('greyhaven-life:changed', {
            detail: {reason, chatId: c.getCurrentChatId?.() || c.chatId || '', state: clone(state), time: new Date(roleplayNowMs()).toISOString()}
        }));
    } catch {}
    globalThis.GreyhavenLife?.refresh?.();
    updatePlanPrompt();
    updateWorldPrompt();
    refreshPlansUi();
}
function planTemporalState(plan, nowMs=roleplayNowMs()) {
    if (plan.state !== 'planned') return plan.state;
    if (nowMs < plan.startMs) return 'upcoming';
    if (nowMs <= plan.endMs) return 'active';
    return 'past-unconfirmed';
}
function planMatchesPerson(plan, name) {
    name = lc(name);
    return !name || (plan.participants || []).some(p => lc(p) === name);
}
function getOneTimePlans(name='', options={}) {
    const state = lifeStateRaw({create:false});
    if (!state) return [];
    const nowMs = roleplayNowMs();
    let rows = state.oneTimePlans.filter(p => planMatchesPerson(p, name));
    if (options.state) {
        const wanted = Array.isArray(options.state) ? new Set(options.state) : new Set([options.state]);
        rows = rows.filter(p => wanted.has(p.state) || wanted.has(planTemporalState(p, nowMs)));
    }
    if (Number.isFinite(Number(options.fromMs))) rows = rows.filter(p => p.endMs >= Number(options.fromMs));
    if (Number.isFinite(Number(options.toMs))) rows = rows.filter(p => p.startMs <= Number(options.toMs));
    rows.sort((a,b) => a.startMs - b.startMs);
    return clone(rows);
}
function addOneTimePlan(input={}) {
    const state = lifeStateRaw();
    if (!state) return null;
    const p = normalizePlan({...input, id:`plan:${uuid()}`, createdAt:Date.now(), updatedAt:Date.now()});
    state.oneTimePlans.push(p);
    saveLifeState(state);
    recordWorldEvent({
        type:'calendar.plan.created', actor:'', participants:p.participants,
        app:'calendar', summary:`Planned "${p.title}" for ${formatDateTime(p.startMs)}${p.participants.length ? ` with ${p.participants.join(', ')}` : ''}.`,
        roleplayMs:roleplayNowMs(), source:'greyhaven-life', sourceKey:`plan-create:${p.id}`, persistent:true,
        data:{planId:p.id},
    });
    return clone(p);
}
function updateOneTimePlan(id, patch={}) {
    const state = lifeStateRaw();
    const p = state?.oneTimePlans?.find(x => x.id === id);
    if (!p) return null;
    Object.assign(p, clone(patch || {}), {id:p.id, updatedAt:Date.now()});
    normalizePlan(p);
    saveLifeState(state);
    return clone(p);
}
function setPlanState(id, next) {
    const p = updateOneTimePlan(id, {state:next});
    if (p) {
        recordWorldEvent({
            type:`calendar.plan.${next}`, participants:p.participants, app:'calendar',
            summary:`"${p.title}" was marked ${next}.`, roleplayMs:roleplayNowMs(),
            source:'greyhaven-life', sourceKey:`plan-state:${p.id}:${next}:${Date.now()}`, persistent:true,
            data:{planId:p.id},
        });
    }
    return p;
}
function deleteOneTimePlan(id) {
    const state = lifeStateRaw();
    if (!state) return false;
    const before = state.oneTimePlans.length;
    state.oneTimePlans = state.oneTimePlans.filter(p => p.id !== id);
    if (state.oneTimePlans.length === before) return false;
    saveLifeState(state);
    return true;
}
function getCurrentPlan(name='') {
    const nowMs = roleplayNowMs();
    return getOneTimePlans(name).find(p => p.state === 'planned' && nowMs >= p.startMs && nowMs <= p.endMs) || null;
}
function getUpcomingPlans(name='', horizonHours=168) {
    const nowMs = roleplayNowMs();
    const toMs = nowMs + Math.max(1, Number(horizonHours || 168)) * 3600000;
    return getOneTimePlans(name, {fromMs:nowMs, toMs})
        .filter(p => p.state === 'planned' && p.startMs > nowMs);
}

/* ---------------- Context bundle ---------------- */

function recentRp(limit=18, charBudget=10000) {
    const c = ctx();
    const chat = Array.isArray(c?.chat) ? c.chat : [];
    const out = [];
    let chars = 0;
    for (let i=chat.length-1; i>=0 && out.length<limit; i--) {
        const m = chat[i];
        const text = norm(m?.mes ?? m?.text).replace(MARKER_RE, '').trim();
        if (!text) continue;
        const who = norm(m?.name || (m?.is_user ? c?.name1 : 'Character'));
        const row = `${who}: ${text}`.slice(0, 2200);
        if (chars + row.length > charBudget && out.length) break;
        out.push(row); chars += row.length;
    }
    return out.reverse();
}
function getContextBundle(options={}) {
    const life = globalThis.GreyhavenLife;
    const nowMs = roleplayNowMs();
    const participants = Array.isArray(options.participants) ? options.participants : [];
    return {
        version: 1,
        time: new Date(nowMs).toISOString(),
        scene: clone(life?.getScene?.() || null),
        people: clone(life?.getPeople?.() || []),
        snapshot: clone(life?.getWorldSnapshot?.() || null),
        schedules: participants.map(name => ({
            name,
            current: clone(life?.getCurrentSchedule?.(name) || null),
            upcoming: clone(life?.getUpcomingSchedules?.(name, 18) || []),
        })),
        oneTimePlans: participants.flatMap(name => getOneTimePlans(name, {
            fromMs: nowMs - 48*3600000,
            toMs: nowMs + 7*86400000,
        })),
        scenario: norm(ctx()?.chatMetadata?.scenario || ''),
        recentRoleplay: recentRp(
            Math.max(4, Math.min(30, Number(options.rpMessages || 18))),
            Math.max(2000, Math.min(20000, Number(options.rpChars || 10000)))
        ),
        worldEvents: getWorldEvents({participants, limit: Math.max(8, Math.min(80, Number(options.eventLimit || 36)))}),
    };
}

/* ---------------- Prompt injection ---------------- */

function buildPlanPrompt() {
    const s = bridgeSettings();
    if (!s.oneTimePlanPromptEnabled) return '';
    const state = lifeStateRaw({create:false});
    if (!state?.oneTimePlans?.length) return '';
    const nowMs = roleplayNowMs();
    const candidates = state.oneTimePlans
        .filter(p => p.endMs >= nowMs - 48*3600000 && p.startMs <= nowMs + 7*86400000)
        .sort((a,b)=>a.startMs-b.startMs)
        .slice(0, 14);
    if (!candidates.length) return '';

    const lines = [
        'GREYHAVEN LIFE — ONE-TIME PLANS / CALENDAR (authoritative continuity cues):',
        `Exact current fictional time: ${new Date(nowMs).toString()}`,
    ];
    for (const p of candidates) {
        const temporal = planTemporalState(p, nowMs);
        const loc = formatLocation(p.location,p.area);
        const parts = p.participants.length ? ` | people: ${p.participants.join(', ')}` : '';
        const reminder = p.reminderMinutes ? ` | reminder: ${p.reminderMinutes}m before` : '';
        const grace = p.graceMinutes ? ` | grace: ${p.graceMinutes}m` : '';
        lines.push(`- ${p.title}: ${formatDateTime(p.startMs)} → ${formatDateTime(p.endMs)} | ${temporal}${parts}${loc?` | ${loc}`:''}${p.status?` | activity: ${p.status}`:''}${reminder}${grace}${p.notes?` | note: ${p.notes}`:''}`);
    }
    lines.push(
        'Rules: These are plans/expectations, not teleportation commands. Newer explicit roleplay reality wins.',
        'Before an upcoming plan, relevant participants may remember it, prepare for it, mention its exact start/end, or make choices around it.',
        'During its window, treat it as the expected activity only when newer roleplay has not established something else.',
        'A planned event whose time passed is NOT proof it happened. It may have been completed, missed, cancelled, delayed, or replaced; use roleplay evidence.',
        'Cancelled events never become active. Completed/missed states are historical evidence.',
    );
    return lines.join('\n');
}
function buildActionPrompt() {
    const s = bridgeSettings();
    if (!s.worldBridgeEnabled) return '';
    return `GREYHAVEN WORLD BRIDGE — HIDDEN PHONE ACTION RECORDING:
When the character whose roleplay reply you are generating ACTUALLY performs a phone action NOW, append one machine-readable HTML comment at the VERY END of the response for each completed action.

Supported forms:
<!--GH_ACTION {"type":"message.send","from":"Aurora","to":"Jack","text":"Hey Jack, where are you rn?","expectsReply":true}-->
<!--GH_ACTION {"type":"media.send","from":"Zara","to":"Jack","mediaType":"photo","description":"a selfie of Zara and Aurora together on the couch","caption":"look who I'm with 😂","expectsReply":true}-->
<!--GH_ACTION {"type":"media.send","from":"Aurora","to":"Eldin","mediaType":"video","description":"a short video of the beach and Aurora waving at the camera","caption":"","expectsReply":false}-->
<!--GH_ACTION {"type":"call.place","from":"Aurora","to":"Jack"}-->
<!--GH_ACTION {"type":"contact.block","from":"Aurora","to":"Jack"}-->
<!--GH_ACTION {"type":"contact.unblock","from":"Aurora","to":"Jack"}-->
<!--GH_ACTION {"type":"contact.add","from":"Aurora","to":"Jack"}-->
<!--GH_ACTION {"type":"contact.exchange","from":"Aurora","to":"Jack"}-->
<!--GH_ACTION {"type":"instagram.follow","from":"Aurora","to":"Eldin"}-->
<!--GH_ACTION {"type":"instagram.unfollow","from":"Aurora","to":"Marcus"}-->
<!--GH_ACTION {"type":"snapchat.add","from":"Aurora","to":"Eldin"}-->
<!--GH_ACTION {"type":"snapchat.accept","from":"Aurora","to":"Eldin"}-->
<!--GH_ACTION {"type":"facebook.friend.request","from":"Aurora","to":"Eldin"}-->
<!--GH_ACTION {"type":"facebook.friend.accept","from":"Aurora","to":"Eldin"}-->

IMPORTANT:
- The marker is hidden system data. Never explain it.
- Use actual character names, never "I", "me", "you", or {{user}} in from/to.
- Use names exactly as they already exist. Never invent, expand, or guess a surname.
- Only emit a marker if the action is completed NOW. "I'll text Jack later", thinking about texting, preparing a photo, or promising to call is NOT an action.
- For message.send, put the natural exact private message in "text".
- For media.send, mediaType MUST be "photo" or "video". "description" is what the recipient can actually see in the fictional media. "caption" is optional text sent with the media.
- If a photo/video and a caption are one combined send, use ONE media.send marker. Do not also emit a duplicate message.send unless the character truly sends a separate additional text.
- A character may spontaneously send media when that is what the roleplay actually depicts; do not wait for somebody to request it.
- In ordinary visible roleplay, DO NOT reproduce the exact private text/caption body. Describe only the act/result naturally. Example: *I grab my phone and text Jack, then set it down.* Done, I asked him. The exact message belongs only in the hidden marker/Phone.
- It is fine for the visible roleplay to describe what kind of photo/video was sent when that is naturally observable in the scene (for example, *I send Jack a selfie of Aurora and me*).
- Only quote exact private text visibly when the scene itself explicitly requires the character to show, read aloud, or quote that message to someone present.
- expectsReply should be true for a question/request or a send clearly intended to get a reaction; false for simple FYI/closure.
- contact.add means only the actor saves the other person's real stored number. contact.exchange means both people explicitly exchange/save numbers. Merely meeting, learning a name, following on social media, or becoming friendly is never a number exchange.
- instagram.follow/unfollow, snapchat.add/accept/decline and facebook.friend.request/accept/decline record completed social actions. A visible "I follow you back" or "I sent the request" requires the matching marker when it really happened now.
- Social relationships are app-specific. Following on Instagram does not save a number, accept Snapchat, or create a Facebook friendship.
- Do not create incoming replies yourself. The bridge may generate at most one background reply separately.
- Never invent a phone action merely because this instruction exists.`;
}

function buildWorldPrompt() {
    const s = bridgeSettings();
    if (!s.worldBridgeEnabled) return '';
    const root = worldRoot({create:false});
    if (!root?.events?.length) return '';
    const nowMs = roleplayNowMs();

    // Keep the RP prompt compact: newest events matter most, with a few persistent
    // older facts (plans/blocking/calls) retained when they are still useful.
    const phoneHasDedicatedPrompt = !!globalThis.GreyhavenPhone;
    const promptEligible = root.events.filter(e => {
        if (!phoneHasDedicatedPrompt) return true;
        // Greyhaven Phone v1.2.2+ already injects chronological private
        // message/call continuity. Do not pay for the same facts twice.
        if (['messages','phone'].includes(norm(e?.app)) &&
            !['contact.block','contact.unblock'].includes(norm(e?.type))) return false;
        return true;
    });
    const newest = promptEligible.slice(-28);
    const persistent = promptEligible
        .filter(e => e?.persistent && !newest.includes(e))
        .slice(-6);
    const rows = [...persistent, ...newest]
        .filter(Boolean)
        .sort((a,b) => Number(a.seq||0) - Number(b.seq||0));

    if (!rows.length) return '';
    const out = [
        'GREYHAVEN WORLD — RECENT CROSS-APP EVENTS (continuity facts):',
        `Current fictional time: ${new Date(nowMs).toString()}`,
        'Privacy rule: a private message/call is known only to its listed participants unless the roleplay later establishes that somebody else learned it.',
        'Chronology rule: these events happened at the listed fictional times. Newer explicit roleplay or a later event overrides stale transient phone/world state.',
        'Use these as facts/memories when relevant; do NOT force characters to mention them or narrate them every turn.',
    ];

    for (const e of rows) {
        const when = formatDateTime(Number(e.roleplayMs || e.realMs || nowMs));
        const participants = (e.participants || [e.actor,e.target]).map(norm).filter(Boolean);
        const privacy = ['message.send','message.reply','message.activity','message.media','media.send','call.place','call.activity','contact.block','contact.unblock']
            .includes(norm(e.type)) ? 'PRIVATE' : 'EVENT';
        let detail = norm(e.summary);
        if (!detail && e.text) detail = `${norm(e.actor)} → ${norm(e.target)}: ${norm(e.text)}`;
        if (e.text && ['message.send','message.reply'].includes(norm(e.type))) {
            detail = `${norm(e.actor)} → ${norm(e.target)}: "${norm(e.text)}"`;
        }
        if (!detail) detail = norm(e.type);
        out.push(`- [${when}] ${privacy}${participants.length?` (${participants.join(', ')})`:''}: ${detail}`);
    }
    return out.join('\n');
}

function setPrompt(key, text) {
    const c = ctx();
    if (!c?.setExtensionPrompt) return;
    try { c.setExtensionPrompt(key, text || '', PROMPT_POSITION_IN_CHAT, 1, false, PROMPT_ROLE_SYSTEM); }
    catch (e) { console.warn('[greyhaven-life-bridge] prompt update failed', key, e); }
}
function updatePlanPrompt() {
    const next = buildPlanPrompt();
    if (next === lastPlanPrompt) return;
    lastPlanPrompt = next;
    setPrompt(PLAN_PROMPT_KEY, next);
}
function updateActionPrompt() {
    const next = buildActionPrompt();
    if (next === lastActionPrompt) return;
    lastActionPrompt = next;
    setPrompt(ACTION_PROMPT_KEY, next);
}
function updateWorldPrompt() {
    const next = buildWorldPrompt();
    if (next === lastWorldPrompt) return;
    lastWorldPrompt = next;
    setPrompt(WORLD_PROMPT_KEY, next);
}
function updateBridgePrompts() {
    updatePlanPrompt();
    updateActionPrompt();
    updateWorldPrompt();
}

/* ---------------- Hidden GH_ACTION extraction ---------------- */

function getReceivedMessageFromArgs(args) {
    const c = ctx();
    const chat = Array.isArray(c?.chat) ? c.chat : [];
    for (const arg of args) {
        if (Number.isInteger(arg) && chat[arg]) return {message:chat[arg], index:arg};
        if (arg && typeof arg === 'object') {
            if (Number.isInteger(arg.messageId) && chat[arg.messageId]) return {message:chat[arg.messageId], index:arg.messageId};
            if ('mes' in arg || 'text' in arg) {
                const idx = chat.indexOf(arg);
                return {message:arg, index:idx};
            }
        }
    }
    for (let i=chat.length-1;i>=0;i--) if (!chat[i]?.is_user) return {message:chat[i], index:i};
    return {message:null,index:-1};
}
function parseActionsAndStrip(raw) {
    const actions = [];
    const clean = String(raw || '').replace(MARKER_RE, (full, payload) => {
        try {
            const data = JSON.parse(String(payload || '').trim());
            if (data && typeof data === 'object') actions.push({data, raw:full});
        } catch (e) {
            console.warn('[greyhaven-world] invalid GH_ACTION marker', payload, e);
        }
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return {clean, actions};
}

function actionKnownNames() {
    const names = new Set();
    const c = ctx();
    for (const ch of c?.characters || []) {
        const name = norm(ch?.name);
        if (name) names.add(name);
    }
    const personaName = norm(c?.name1);
    if (personaName) names.add(personaName);
    try {
        for (const p of globalThis.GreyhavenLife?.getPeople?.() || []) {
            const name = norm(p?.name);
            if (name) names.add(name);
        }
    } catch {}
    try {
        for (const p of globalThis.GreyhavenPhone?.getContacts?.() || []) {
            const name = norm(p?.name);
            if (name) names.add(name);
        }
    } catch {}
    return [...names].sort((a,b) => b.length - a.length);
}
function escapeRegExp(value='') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function findClosestActionTarget(text, actor, position=0) {
    const source = String(text || '');
    let best = null;
    for (const name of actionKnownNames()) {
        if (!name || lc(name) === lc(actor)) continue;
        const q = escapeRegExp(name);
        const re = new RegExp(q, 'giu');
        for (const match of source.matchAll(re)) {
            const idx = Number(match.index || 0);
            let score = Math.abs(idx - position);
            const around = source.slice(Math.max(0, idx - 8), Math.min(source.length, idx + name.length + 42));
            if (new RegExp(`${q}(?:'s|’s)\\s+(?:contact|chat|conversation|number|profile|name)`, 'iu').test(around)) {
                score -= 180;
            }
            const afterAction = source.slice(Math.max(0, position - 10), Math.min(source.length, position + 120));
            if (new RegExp(`(?:unblock|block)\\w*\\s+${q}`, 'iu').test(afterAction)) score -= 150;
            if (!best || score < best.score) best = {name,score,idx};
        }
    }
    return best && best.score <= 520 ? best.name : '';
}
function visibleActionTarget(text, actor, position=0) {
    const source=String(text||''),local=source.slice(Math.max(0,position-16),Math.min(source.length,position+220)),persona=norm(ctx()?.name1);
    if (persona && lc(persona)!==lc(actor) && /\b(?:you|your|yours)\b/iu.test(local)) return persona;
    return findClosestActionTarget(source,actor,position);
}
function visiblePrivateMessageBody(source, matchEnd=0) {
    const tail=String(source||'').slice(matchEnd,matchEnd+950);
    let m=tail.match(/^\s*(?:a\s+(?:private\s+)?(?:text|message))?\s*(?:saying|that\s+says|which\s+says|with)?\s*[:\-–,]?\s*["“]([^"”]{1,700})["”]/iu);
    if (m?.[1]) return norm(m[1]);
    // Common RP form: *I send Jack a message.* Hey Jack, ... *I put my phone down.*
    m=tail.match(/^[^*]{0,120}\*\s*([^*]{1,700}?)(?=\s*\*|$)/u);
    if (m?.[1] && !/^I\s+(?:put|set|show|look|glance|turn|wait)\b/iu.test(norm(m[1]))) return norm(m[1]);
    m=tail.match(/^\s*(?:a\s+(?:private\s+)?(?:text|message))?\s*(?:saying|that\s+says|which\s+says|with)?\s*[:\-–]\s*([^*]{1,700}?)(?=\s*\*|$)/u);
    if (m?.[1]) return norm(m[1]).replace(/^["“]|["”]$/g,'');
    const intent=tail.match(/^[^.!?*]{0,100}\b(?:ask(?:ing)?|tell(?:ing)?|say(?:ing)?)\s+(?:him|her|them)\s+(to\s+|whether\s+|if\s+)?([^.!?*]{1,280})/iu);
    if (intent?.[2]) {
        let body=norm(intent[2]).replace(/\b(?:him|her|them)\b/giu,'you').replace(/\b(?:his|her|their)\b/giu,'your');
        if (/^where\s+(?:he|she|they)\s+(?:is|are)\b/iu.test(body)) body=body.replace(/^where\s+(?:he|she|they)\s+(?:is|are)\b/iu,'where are you');
        if (/^to\s+/iu.test(intent[1]||'')) return `hey, can you ${body.replace(/^to\s+/iu,'')}?`;
        return `hey, ${body}${/[?!]$/.test(body)?'':'?'}`;
    }
    const about=tail.match(/^[^.!?*]{0,90}\babout\s+([^.!?*]{1,260})/iu);
    return about?.[1]?`hey, ${norm(about[1])}`:'hey';
}
function visibleMediaCaption(text='') {
    const source = String(text || '');
    const m = source.match(/\b(?:with\s+(?:the\s+)?caption|caption(?:ed)?(?:\s+it)?(?:\s+with)?)\s*[:\-–]?\s*["“]([^"”]{1,500})["”]/iu);
    return norm(m?.[1] || '');
}
function normalizeVisibleMediaDescription(kindWord, tail, actor='') {
    const lower = lc(kindWord);
    const label = lower === 'selfie' ? 'selfie' : (lower === 'video' || lower === 'clip') ? (lower === 'clip' ? 'video clip' : 'video') : 'photo';
    let detail = norm(tail || '');
    detail = detail
        .replace(/\b(?:with\s+(?:the\s+)?caption|caption(?:ed)?(?:\s+it)?(?:\s+with)?)\b[\s\S]*$/iu, '')
        .replace(/\s+(?:and\s+)?(?:then\s+)?(?:I\s+)?(?:hit|press)\s+send\b[\s\S]*$/iu, '')
        .replace(/^[,;:\-–]+\s*/, '')
        .trim();
    if (detail) return `a ${label} ${detail}`;
    return `a ${label}${actor ? ` sent by ${actor}` : ''}`;
}
function inferVisibleActions(message, index, raw) {
    const actor = norm(message?.name);
    if (!actor) return [];
    const source = String(raw || '').replace(MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
    if (!source) return [];
    const inferred = [];

    // Guided generations and some models may omit hidden markers even though the
    // visible roleplay clearly completes a block/unblock action. Only accept
    // first-person completed actions, never promises or requests to somebody else.
    const contactPatterns = [
        /\bI\s+(?:finally\s+|then\s+|immediately\s+)?(?:press(?:ed)?|tap(?:ped)?|hit|click(?:ed)?|select(?:ed)?|choose|chose)\s+(?:the\s+)?(unblock|block)(?:\s+(?:button|option))?\b/giu,
        /\bI\s+(?:finally\s+|then\s+|immediately\s+)?(unblock|block)(?:ed)?\b/giu,
    ];
    for (const re of contactPatterns) {
        for (const match of source.matchAll(re)) {
            const target = visibleActionTarget(source, actor, Number(match.index || 0));
            if (!target) continue;
            inferred.push({
                data:{type:`contact.${lc(match[1])}`,from:actor,to:target},
                raw:`visible:${index}:${match[0]}:${target}`,
                inferred:true,
            });
        }
    }

    // Explicitly completed Instagram/Snapchat/Facebook actions. This is the
    // conservative safety net for Guided Generations or models that omit the
    // hidden marker; the marker still wins when both are present.
    const subject=`(?:I|${escapeRegExp(actor)})`,lead=`\\b${subject}\\b[^.!?*]{0,100}?`,socialPatterns=[
        {type:'instagram.unfollow',re:new RegExp(`${lead}\\bunfollow(?:ed|s)?\\b[^.!?*]{0,150}\\bInstagram\\b`,'giu')},
        {type:'instagram.follow',re:new RegExp(`${lead}\\bfollow(?:ed|s)?\\b[^.!?*]{0,150}\\bInstagram\\b`,'giu')},
        {type:'snapchat.accept',re:new RegExp(`${lead}\\baccept(?:ed|s)?\\b[^.!?*]{0,150}\\b(?:Snapchat|Snap)\\b`,'giu')},
        {type:'snapchat.decline',re:new RegExp(`${lead}\\b(?:decline(?:d|s)?|ignore(?:d|s)?)\\b[^.!?*]{0,150}\\b(?:Snapchat|Snap)\\b`,'giu')},
        {type:'snapchat.add',re:new RegExp(`${lead}(?:(?:\\badd(?:ed|s)?\\b[^.!?*]{0,160}\\b(?:Snapchat|Snap))|(?:\\b(?:send(?:ing|s)?|sent)\\b[^.!?*]{0,100}\\b(?:friend\\s+)?request\\b[^.!?*]{0,80}\\b(?:Snapchat|Snap)))`,'giu')},
        {type:'facebook.friend.accept',re:new RegExp(`${lead}\\baccept(?:ed|s)?\\b[^.!?*]{0,150}\\bFacebook\\b`,'giu')},
        {type:'facebook.friend.decline',re:new RegExp(`${lead}\\b(?:decline(?:d|s)?|ignore(?:d|s)?)\\b[^.!?*]{0,150}\\bFacebook\\b`,'giu')},
        {type:'facebook.friend.request',re:new RegExp(`${lead}(?:(?:\\badd(?:ed|s)?\\b[^.!?*]{0,160}\\bFacebook)|(?:\\b(?:send(?:ing|s)?|sent)\\b[^.!?*]{0,100}\\b(?:friend\\s+)?request\\b[^.!?*]{0,80}\\bFacebook))`,'giu')},
    ];
    for (const {type,re} of socialPatterns) {
        for (const match of source.matchAll(re)) {
            if (/\b(?:ask|tell|want|need|try|plan|promise|consider)\b[^.!?*]{0,90}\bto\s+(?:unfollow|follow|accept|decline|ignore|add|send)\b/iu.test(match[0])) continue;
            if ((type==='snapchat.add'||type==='facebook.friend.request') && /\b(?:accept(?:ed|s)?|add(?:ed|s)?\s+(?:you\s+|[\p{L}\p{M}'’-]+\s+)?back)\b/iu.test(match[0])) continue;
            const target=visibleActionTarget(source,actor,Number(match.index||0));if(!target)continue;
            inferred.push({data:{type,from:actor,to:target},raw:`visible-social:${index}:${type}:${actor}:${target}`,inferred:true});
        }
    }

    // Completed visible texts, including the common Guided/RP form:
    // *I send Jack a message.* Hey Jack, ... *I put my phone away.*
    // Requests such as "I ask Zara to text Jack" are deliberately rejected.
    const messageVerb='(?:text(?:ed|ing|s)?|messag(?:e|ed|ing|es)|send(?:ing|s)?|sent)',knownTargets=actionKnownNames();
    for (const targetName of knownTargets) {
        if (!targetName || lc(targetName)===lc(actor)) continue;
        const targetToken=lc(targetName)===lc(ctx()?.name1)?`(?:you|${escapeRegExp(targetName)})`:escapeRegExp(targetName),re=new RegExp(`\\b${subject}\\b([^.!?*]{0,130}?)\\b${messageVerb}\\s+(?:a\\s+(?:private\\s+)?(?:text|message)\\s+to\\s+)?${targetToken}\\b`,'giu');
        for (const match of source.matchAll(re)) {
            if (/\b(?:ask|tell|want|need)\s+[\p{L}\p{M}'’-]+\s+to\s*$/iu.test(norm(match[1]||''))) continue;
            const immediate=source.slice(Number(match.index||0)+match[0].length,Number(match.index||0)+match[0].length+90);
            if (/^\s+(?:(?:a|an|the|another|this)\s+)?(?:selfie|photo|picture|pic|video|clip)\b/iu.test(immediate)) continue;
            if (/^\s+(?:(?:a|the)\s+)?(?:friend\s+)?request\b[^.!?*]{0,70}\b(?:Instagram|Snapchat|Snap|Facebook)\b/iu.test(immediate)) continue;
            const text=visiblePrivateMessageBody(source,Number(match.index||0)+match[0].length);if(!text)continue;
            inferred.push({data:{type:'message.send',from:actor,to:targetName,text,expectsReply:/[?]\s*$/.test(text)||/\b(?:can you|could you|would you|will you|please|let me know|reply|answer)\b/iu.test(text)},raw:`visible-message:${index}:${actor}:${targetName}:${text}`,inferred:true});
            break;
        }
    }

    // Fallback for an explicitly completed RP media send. Hidden GH_ACTION
    // remains the preferred path because it can preserve a richer description.
    const adverbs = '(?:(?:finally|then|quickly|immediately|playfully|casually|secretly|quietly|smiling|laughing)\\s+){0,3}';
    const kind = '(selfie|photo|picture|pic|video|clip)';
    const caption = visibleMediaCaption(source);
    for (const target of actionKnownNames()) {
        if (!target || lc(target) === lc(actor)) continue;
        const q = escapeRegExp(target);
        const patterns = [
            // "I send Jack a selfie of Aurora and me"
            new RegExp(`\\bI\\s+${adverbs}(?:send|sent)\\s+${q}\\s+(?:(?:a|an|the|another|this)\\s+)?${kind}\\b([^.!?*]{0,360})`, 'iu'),
            // "I send a selfie of Aurora and me to Jack"
            new RegExp(`\\bI\\s+${adverbs}(?:send|sent)\\s+(?:(?:a|an|the|another|this)\\s+)?${kind}\\b([^.!?*]{0,360}?)\\s+to\\s+${q}\\b`, 'iu'),
            // "I snap/take a selfie of Aurora and me and send it to Jack"
            new RegExp(`\\bI\\s+${adverbs}(?:take|took|snap|snapped|record|recorded|film|filmed)\\s+(?:(?:a|an|the|another|this)\\s+)?${kind}\\b([^.!?*]{0,360}?)\\b(?:and\\s+)?(?:then\\s+)?(?:I\\s+)?(?:send|sent)\\s+(?:it|that|the\\s+(?:selfie|photo|picture|pic|video|clip))\\s+to\\s+${q}\\b`, 'iu'),
            // "I take the photo ... then send Jack the photo"
            new RegExp(`\\bI\\s+${adverbs}(?:take|took|snap|snapped|record|recorded|film|filmed)\\s+(?:(?:a|an|the|another|this)\\s+)?${kind}\\b([^.!?*]{0,360}?)\\b(?:and\\s+)?(?:then\\s+)?(?:I\\s+)?(?:send|sent)\\s+${q}\\s+(?:it|that|the\\s+(?:selfie|photo|picture|pic|video|clip))\\b`, 'iu'),
        ];
        for (const re of patterns) {
            const m = source.match(re);
            if (!m) continue;
            const kindWord = norm(m[1]);
            const tail = norm(m[2]);
            const mediaType = /video|clip/i.test(kindWord) ? 'video' : 'photo';
            const description = normalizeVisibleMediaDescription(kindWord, tail, actor);
            const intentWindow = source.slice(
                Math.max(0, Number(m.index || 0) - 80),
                Math.min(source.length, Number(m.index || 0) + m[0].length + 180),
            );
            const expectsReply = /\b(?:see what (?:he|she|they) says?|wait(?:ing)? for (?:a |his |her |their )?(?:reply|reaction|response)|ask(?:ing)? (?:him|her|them)|hope (?:he|she|they) (?:likes?|responds?|replies?)|tell me what (?:he|she|they) thinks?)\b/iu.test(intentWindow);
            inferred.push({
                data:{
                    type:'media.send',from:actor,to:target,mediaType,
                    description,caption,expectsReply,
                },
                raw:`visible-media:${index}:${actor}:${target}:${mediaType}:${description}:${caption}`,
                inferred:true,
            });
            break;
        }
    }
    return inferred;
}
async function handleMessageReceived(...args) {
    if (!bridgeSettings().worldBridgeEnabled) return;
    const c = ctx();
    const lifecycle = args.find(arg => arg && typeof arg === 'object' && arg.__greyhavenLifecycle)?.__greyhavenLifecycle || 'message-received';
    const {message,index} = getReceivedMessageFromArgs(args);
    if (!message || message.is_user) return;
    const raw = String(message.mes ?? message.text ?? '');

    const parsed = raw.includes('GH_ACTION')
        ? parseActionsAndStrip(raw)
        : {clean:raw,actions:[]};
    const inferred = inferVisibleActions(message,index,raw);
    const allActions = [...parsed.actions, ...inferred];
    if (!allActions.length) return;

    if (parsed.actions.length) {
        if ('mes' in message) message.mes = parsed.clean;
        if ('text' in message) message.text = parsed.clean;
        if (Array.isArray(message.swipes) && Number.isInteger(Number(message.swipe_id))) {
            const swipeIndex = Number(message.swipe_id);
            if (swipeIndex >= 0 && swipeIndex < message.swipes.length) message.swipes[swipeIndex] = parsed.clean;
        }

        // Guided Continue/Edit/Swipe can finish after the normal pre-render hook.
        // Refresh the visible message when reconciliation happens later.
        const messageElement = index >= 0 ? document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`) : null;
        if (messageElement && typeof c?.messageFormatting === 'function') {
            try {
                messageElement.innerHTML = c.messageFormatting(
                    parsed.clean, message.name, message.is_system, message.is_user, index,
                );
            } catch {}
        }

        // Saving here keeps hidden markers stripped across reloads for normal and
        // Guided Generations paths alike.
        try {
            if (typeof c?.saveChatConditional === 'function') await c.saveChatConditional();
            else if (typeof c?.saveChat === 'function') await c.saveChat();
        } catch (e) {
            console.warn('[greyhaven-world] stripped message save deferred', e);
        }
    }

    const seen = new Set();
    const slotCounts = new Map();
    const explicitSlots = new Set(parsed.actions.map(item => {
        const action = normalizeActionPayload(item.data || {}, message.name);
        return action ? [action.type,lc(action.from),lc(action.to),action.mediaType].join('|') : '';
    }).filter(Boolean));

    for (const item of allActions) {
        const data = item.data || {};
        const action = normalizeActionPayload(data, message.name);
        if (!action) continue;

        const slotBase = [action.type,lc(action.from),lc(action.to),action.mediaType].join('|');
        // The explicit hidden marker has richer data and always wins over the
        // conservative visible-prose fallback for the same completed action.
        if (item.inferred && explicitSlots.has(slotBase)) continue;

        const signature = [
            action.type,lc(action.from),lc(action.to),action.text,
            action.mediaType,action.mediaDescription,action.caption,
        ].join('|');
        if (seen.has(signature)) continue;
        seen.add(signature);

        // The slot intentionally ignores generated prose and exact message text.
        // A swipe/regeneration at the same assistant-message index therefore cannot
        // commit the same actor -> target action twice.
        const ordinal = slotCounts.get(slotBase) || 0;
        slotCounts.set(slotBase, ordinal + 1);
        const key = `rp-action-slot:${chatIdentity()}:${index}:${hashText(slotBase)}:${ordinal}`;

        dispatchWorldAction(data, {
            fallbackActor:message.name,
            source:item.inferred ? 'roleplay-visible-fallback' : (lifecycle.startsWith('guided') ? 'guided-generation' : 'roleplay'),
            sourceKey:key,
            inferred:item.inferred === true,
            roleplayMs:roleplayNowMs(),
            realMs:Date.now(),
        });
    }
}

function reconcileAssistantMessage(source, ...args) {
    const marker = {__greyhavenLifecycle:norm(source || 'guided-reconcile')};
    Promise.resolve(handleMessageReceived(marker, ...args))
        .catch(error => console.error('[greyhaven-world] action reconciliation', source, error));
}

function reconcileRecentAssistantMessages(source='guided-generation') {
    const chat = Array.isArray(ctx()?.chat) ? ctx().chat : [];
    const indexes = [];
    for (let i=chat.length-1; i>=0 && indexes.length<3; i--) {
        if (!chat[i]?.is_user) indexes.push(i);
    }
    for (const index of indexes.reverse()) reconcileAssistantMessage(source, index);
}

/* ---------------- UI: one-time plans ---------------- */

function planCard(p) {
    const nowMs = roleplayNowMs();
    const temporal = planTemporalState(p, nowMs);
    const badge = temporal.replaceAll('-', ' ');
    const loc = formatLocation(p.location,p.area);
    const participants = p.participants.join(', ');
    return `<article class="ghw-plan-card ${esc(temporal)}">
        <div class="ghw-plan-card-top">
            <div class="ghw-plan-card-main">
                <div class="ghw-plan-title-row">
                    <strong>${esc(p.title)}</strong>
                    <span class="ghw-plan-kind">ONCE</span>
                </div>
                <div class="ghw-plan-time">${esc(formatDateTime(p.startMs))} → ${esc(formatDateTime(p.endMs))}</div>
                <div class="ghw-plan-meta-row">
                    ${participants?`<span><i class="fa-solid fa-user-group"></i>${esc(participants)}</span>`:''}
                    ${loc?`<span><i class="fa-solid fa-location-dot"></i>${esc(loc)}</span>`:''}
                    ${p.status?`<span><i class="fa-solid fa-circle-dot"></i>${esc(p.status)}</span>`:''}
                    ${p.availability?`<span class="ghw-plan-availability is-${esc(p.availability)}">${esc(p.availability)}</span>`:''}
                </div>
                ${p.notes?`<div class="ghw-plan-note">${esc(p.notes)}</div>`:''}
            </div>
            <span class="ghw-plan-badge">${esc(badge)}</span>
        </div>
        <div class="ghw-plan-actions">
            <button type="button" data-ghw-plan-edit="${esc(p.id)}"><i class="fa-solid fa-pen"></i> Edit</button>
            ${p.state==='planned'?`
                <button type="button" data-ghw-plan-complete="${esc(p.id)}"><i class="fa-solid fa-check"></i> Done</button>
                <button type="button" data-ghw-plan-missed="${esc(p.id)}"><i class="fa-regular fa-clock"></i> Missed</button>
                <button type="button" data-ghw-plan-cancel="${esc(p.id)}"><i class="fa-solid fa-ban"></i> Cancel</button>`:''}
            <button type="button" class="ghw-danger" data-ghw-plan-delete="${esc(p.id)}"><i class="fa-solid fa-trash"></i></button>
        </div>
    </article>`;
}

function plansSectionHtml() {
    const rows = getOneTimePlans();
    const nowMs = roleplayNowMs();
    const ordered = [...rows].sort((a,b) => {
        const aPast = a.endMs < nowMs ? 1 : 0, bPast = b.endMs < nowMs ? 1 : 0;
        return aPast-bPast || a.startMs-b.startMs;
    });
    return `<section class="gh-life-section ghw-one-time-section" id="ghw-one-time-plans">
        <div class="gh-life-section-heading">
            <div>
                <div class="gh-life-section-title"><i class="fa-regular fa-calendar-check"></i> One-time plans</div>
                <div class="gh-life-section-subtitle">Dates, appointments, trips and plans that happen once. They are remembered like schedules but never repeat.</div>
            </div>
            <button type="button" class="gh-life-small-button" data-ghw-plan-new>+ Plan</button>
        </div>
        <div class="ghw-plan-list">
            ${ordered.length ? ordered.map(planCard).join('') : `<div class="gh-life-empty">No one-time plans yet.</div>`}
        </div>
        <div class="gh-life-info-box">
            <i class="fa-solid fa-scale-balanced"></i>
            <div>Plans are expectations, not commands. Newer roleplay can cancel, delay, replace or skip them. Passed plans stay as history without being assumed completed.</div>
        </div>
    </section>`;
}
function settingsSectionHtml() {
    const s = bridgeSettings();
    return `<section class="gh-life-section ghw-bridge-settings" id="ghw-bridge-settings">
        <div class="gh-life-section-title"><i class="fa-solid fa-link"></i> World & Phone bridge</div>
        <div class="gh-life-section-subtitle">Connect completed texts, calls, media, blocks and unblocks in normal roleplay to Greyhaven Phone and optionally allow one private background reply.</div>
        <label class="gh-life-setting-row">
            <span><strong>World Bridge</strong><small>Records completed phone actions as shared world events and hides machine markers before messages render.</small></span>
            <input type="checkbox" id="ghw-setting-enabled" ${s.worldBridgeEnabled?'checked':''}>
        </label>
        <label class="gh-life-setting-row gh-life-setting-row-stack">
            <span><strong>Background relay mode</strong><small>At most one hidden reply per RP action. A hidden reply never starts another automatic reply.</small></span>
            <select id="ghw-setting-relay">
                <option value="economy" ${s.relayMode==='economy'?'selected':''}>Economy — record only</option>
                <option value="smart" ${s.relayMode==='smart'?'selected':''}>Smart — reply to questions/requests</option>
                <option value="live" ${s.relayMode==='live'?'selected':''}>Live — one reply to most direct texts</option>
            </select>
        </label>
        <label class="gh-life-setting-row gh-life-setting-row-stack">
            <span><strong>Hidden reply budget</strong><small>Only used for the optional one-hop background reply.</small></span>
            <input type="number" id="ghw-setting-tokens" min="180" max="700" step="20" value="${esc(s.relayResponseTokens)}">
        </label>
        <label class="gh-life-setting-row">
            <span><strong>Inject one-time plans</strong><small>Lets characters anticipate, remember and reason about one-time calendar plans.</small></span>
            <input type="checkbox" id="ghw-setting-plans" ${s.oneTimePlanPromptEnabled?'checked':''}>
        </label>
        <div class="gh-life-action-row"><button type="button" class="gh-life-primary" data-ghw-save-settings>Save bridge settings</button></div>
    </section>`;
}
function injectLifeUi() {
    const dialog = document.querySelector('#gh-life-dialog');
    if (!dialog?.open) return;
    const body = dialog.querySelector('.gh-life-dialog-body');
    if (!body) return;
    const active = dialog.querySelector('.gh-life-tab.active')?.dataset?.ghTab || '';
    if (active === 'schedules' && !body.querySelector('#ghw-one-time-plans')) {
        body.insertAdjacentHTML('afterbegin', plansSectionHtml());
    }
    if (active === 'settings' && !body.querySelector('#ghw-bridge-settings')) {
        const first = body.querySelector('.gh-life-section');
        if (first) first.insertAdjacentHTML('beforebegin', settingsSectionHtml());
        else body.insertAdjacentHTML('afterbegin', settingsSectionHtml());
    }
}
function injectLifeUiSoon() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => { uiQueued=false; injectLifeUi(); });
}
function refreshPlansUi() {
    const section = document.querySelector('#ghw-one-time-plans');
    if (section) {
        section.outerHTML = plansSectionHtml();
        return;
    }
    injectLifeUiSoon();
}
function watchLifeUi() {
    if (uiObserver) return;
    const attach = () => {
        const dialog = document.querySelector('#gh-life-dialog');
        if (!dialog) return false;
        uiObserver = new MutationObserver(injectLifeUiSoon);
        uiObserver.observe(dialog, {childList:true, subtree:true});
        injectLifeUiSoon();
        return true;
    };
    if (attach()) return;
    const boot = new MutationObserver(() => {
        if (attach()) boot.disconnect();
    });
    boot.observe(document.body, {childList:true, subtree:true});
}
function openPlanEditor(planId='') {
    const current = planId ? getOneTimePlans().find(p => p.id===planId) : null;
    const nowMs = roleplayNowMs();
    const p = current || normalizePlan({
        id:`plan:${uuid()}`,
        title:'',
        participants:[],
        startMs:nowMs+3600000,
        endMs:nowMs+2*3600000,
        availability:'busy',
        reminderMinutes:60,
        graceMinutes:10,
        state:'planned',
    });
    document.querySelector('#ghw-plan-dialog')?.remove();
    const d = document.createElement('dialog');
    d.id = 'ghw-plan-dialog';
    d.innerHTML = `<form class="gh-life-subdialog ghw-plan-dialog-shell" method="dialog">
        <header class="gh-life-subdialog-header">
            <div><strong>${current?'Edit':'Add'} one-time plan</strong><span>One event, no recurrence.</span></div>
            <button type="button" class="gh-life-dialog-close" data-ghw-plan-close>&times;</button>
        </header>
        <div class="gh-life-subdialog-body">
            <div class="gh-life-form-grid">
                <label class="gh-life-span-2"><span>Title</span><input id="ghw-plan-title" type="text" value="${esc(p.title)}" placeholder="Dinner with Eldin, dentist, party…" required></label>
                <label class="gh-life-span-2"><span>Participants</span><input id="ghw-plan-participants" type="text" value="${esc(p.participants.join(', '))}" placeholder="Aurora, Eldin"></label>
                <label><span>Starts</span><input id="ghw-plan-start" type="datetime-local" value="${esc(toLocalInput(p.startMs))}"></label>
                <label><span>Ends</span><input id="ghw-plan-end" type="datetime-local" value="${esc(toLocalInput(p.endMs))}"></label>
                <label><span>Place / venue</span><input id="ghw-plan-location" type="text" value="${esc(p.location)}" placeholder="Restaurant, hospital…"></label>
                <label><span>City / area</span><input id="ghw-plan-area" type="text" value="${esc(p.area)}" placeholder="Greyhaven, Vienna…"></label>
                <label><span>Activity / status</span><input id="ghw-plan-status" type="text" value="${esc(p.status)}" placeholder="Dinner date, appointment…"></label>
                <label><span>Availability</span><select id="ghw-plan-availability">
                    ${['available','limited','busy','unavailable','sleeping','unknown'].map(x=>`<option value="${x}" ${p.availability===x?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}
                </select></label>
                <label><span>Reminder minutes</span><input id="ghw-plan-reminder" type="number" min="0" max="10080" value="${esc(p.reminderMinutes)}"></label>
                <label><span>Grace minutes</span><input id="ghw-plan-grace" type="number" min="0" max="1440" value="${esc(p.graceMinutes)}"></label>
                <label class="gh-life-span-2"><span>Notes</span><textarea id="ghw-plan-notes" placeholder="Optional continuity note">${esc(p.notes)}</textarea></label>
            </div>
        </div>
        <footer class="gh-life-subdialog-footer">
            <button type="button" data-ghw-plan-close>Cancel</button>
            <button type="button" class="gh-life-primary" data-ghw-plan-save="${esc(current?.id || '')}">Save plan</button>
        </footer>
    </form>`;
    document.body.appendChild(d);
    try { d.showModal(); } catch { d.setAttribute('open',''); }
}
function closePlanEditor() {
    const d=document.querySelector('#ghw-plan-dialog');
    if (!d) return;
    try { d.close(); } catch {}
    d.remove();
}
function savePlanFromEditor(existingId='') {
    const title=norm(document.querySelector('#ghw-plan-title')?.value);
    const startMs=parseLocalInput(document.querySelector('#ghw-plan-start')?.value);
    const endMs=parseLocalInput(document.querySelector('#ghw-plan-end')?.value);
    if (!title || !startMs || !endMs || endMs<=startMs) {
        globalThis.toastr?.warning?.('Give the plan a title and a valid start/end time.');
        return;
    }
    const data={
        title,
        participants:norm(document.querySelector('#ghw-plan-participants')?.value).split(',').map(norm).filter(Boolean),
        startMs,endMs,
        location:norm(document.querySelector('#ghw-plan-location')?.value),
        area:norm(document.querySelector('#ghw-plan-area')?.value),
        status:norm(document.querySelector('#ghw-plan-status')?.value),
        availability:norm(document.querySelector('#ghw-plan-availability')?.value)||'busy',
        reminderMinutes:Number(document.querySelector('#ghw-plan-reminder')?.value||60),
        graceMinutes:Number(document.querySelector('#ghw-plan-grace')?.value||10),
        notes:norm(document.querySelector('#ghw-plan-notes')?.value),
    };
    if (existingId) updateOneTimePlan(existingId,data);
    else addOneTimePlan(data);
    closePlanEditor();
    globalThis.toastr?.success?.('One-time plan saved.');
}
function onDocumentClick(event) {
    const target = event.target?.closest?.('button,[data-ghw-plan-new]');
    if (!target) return;
    if (target.matches('[data-ghw-plan-new]')) return openPlanEditor();
    if (target.matches('[data-ghw-plan-close]')) return closePlanEditor();
    if (target.matches('[data-ghw-plan-save]')) return savePlanFromEditor(target.dataset.ghwPlanSave || '');
    if (target.matches('[data-ghw-plan-edit]')) return openPlanEditor(target.dataset.ghwPlanEdit);
    if (target.matches('[data-ghw-plan-complete]')) return setPlanState(target.dataset.ghwPlanComplete,'completed');
    if (target.matches('[data-ghw-plan-missed]')) return setPlanState(target.dataset.ghwPlanMissed,'missed');
    if (target.matches('[data-ghw-plan-cancel]')) return setPlanState(target.dataset.ghwPlanCancel,'cancelled');
    if (target.matches('[data-ghw-plan-delete]')) {
        if (confirm('Delete this one-time plan?')) deleteOneTimePlan(target.dataset.ghwPlanDelete);
        return;
    }
    if (target.matches('[data-ghw-save-settings]')) {
        saveBridgeSettings({
            worldBridgeEnabled:document.querySelector('#ghw-setting-enabled')?.checked ?? true,
            relayMode:norm(document.querySelector('#ghw-setting-relay')?.value)||'smart',
            relayResponseTokens:Number(document.querySelector('#ghw-setting-tokens')?.value||420),
            oneTimePlanPromptEnabled:document.querySelector('#ghw-setting-plans')?.checked ?? true,
        });
        globalThis.toastr?.success?.('World Bridge settings saved.');
    }
}

/* ---------------- API patch ---------------- */

function exposeBridgeApi() {
    const life = globalThis.GreyhavenLife;
    if (!life) return false;
    Object.assign(life, {
        version: GHW_VERSION,
        coreVersion: CORE_VERSION,
        worldBridgeVersion: 1,
        recordWorldEvent,
        dispatchWorldAction,
        getWorldEvents,
        getWorldState: () => clone(worldRoot({create:false})),
        getContextBundle,
        getOneTimePlans,
        getCurrentPlan,
        getUpcomingPlans,
        addOneTimePlan,
        updateOneTimePlan,
        deleteOneTimePlan,
        cancelOneTimePlan: id => setPlanState(id,'cancelled'),
        completeOneTimePlan: id => setPlanState(id,'completed'),
        missOneTimePlan: id => setPlanState(id,'missed'),
        getWorldBridgeSettings: () => clone(bridgeSettings()),
    });
    return true;
}

/* ---------------- Initialization ---------------- */

function bindEvents() {
    if (bridgeBound) return;
    const c = ctx();
    if (!c?.eventSource || !c?.eventTypes) return;
    const bind=(key,fn)=>{const name=c.eventTypes[key];if(name)c.eventSource.on(name,fn);};
    bind('GENERATION_STARTED', updateBridgePrompts);
    bind('MESSAGE_RECEIVED', (...args)=>reconcileAssistantMessage('message-received', ...args));
    // Guided Generations can create a normal trigger, append with Continue, edit
    // the current message, or navigate/generate a swipe. Reconcile every relevant
    // lifecycle path through the same idempotent extractor/action bus.
    for (const key of ['CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED']) {
        bind(key, (...args)=>setTimeout(()=>reconcileAssistantMessage(`guided-${key.toLowerCase()}`, ...args), 20));
    }
    for (const key of ['GENERATION_ENDED','GENERATION_STOPPED']) {
        bind(key, ()=>setTimeout(()=>reconcileRecentAssistantMessages(`guided-${key.toLowerCase()}`), 80));
    }
    bind('CHAT_CHANGED', ()=>setTimeout(()=>{ lastActionPrompt='';lastPlanPrompt='';lastWorldPrompt='';updateBridgePrompts();injectLifeUiSoon(); },40));
    bind('CHAT_CREATED', ()=>setTimeout(()=>{ lastActionPrompt='';lastPlanPrompt='';lastWorldPrompt='';updateBridgePrompts();injectLifeUiSoon(); },40));
    bind('PERSONA_CHANGED', ()=>setTimeout(updateBridgePrompts,40));
    window.addEventListener('greyhaven-life:tick', ()=>{ updatePlanPrompt(); updateWorldPrompt(); refreshPlansUi(); });
    window.addEventListener('greyhaven-life:changed', ()=>{ updatePlanPrompt(); updateWorldPrompt(); refreshPlansUi(); });
    window.addEventListener('greyhaven-phone-continuity', e=>importPhoneContinuity(e.detail));
    document.addEventListener('click', onDocumentClick);
    bridgeBound=true;
}
function injectStyle() {
    if (document.querySelector('#ghw-bridge-style')) return;
    const s=document.createElement('style');s.id='ghw-bridge-style';
    s.textContent=`
#ghw-one-time-plans .ghw-plan-list{display:flex;flex-direction:column;gap:9px;margin-top:10px}
.ghw-plan-card{padding:10px;border:1px solid var(--gh-life-border,rgba(255,255,255,.1));border-radius:14px;background:rgba(255,255,255,.024);color:var(--gh-life-text,#fff)}
.ghw-plan-card.active{border-color:rgba(102,194,181,.34);background:linear-gradient(135deg,rgba(102,194,181,.075),rgba(255,255,255,.018));box-shadow:inset 3px 0 0 rgba(102,194,181,.62)}
.ghw-plan-card.cancelled,.ghw-plan-card.completed,.ghw-plan-card.missed{opacity:.68}
.ghw-plan-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}
.ghw-plan-card-main{min-width:0;flex:1 1 auto}
.ghw-plan-title-row{display:flex;align-items:center;gap:7px;min-width:0}
.ghw-plan-title-row strong{min-width:0;font-size:12px;line-height:1.25;font-weight:720;overflow:hidden;text-overflow:ellipsis}
.ghw-plan-kind{flex:0 0 auto;padding:3px 6px;border-radius:999px;background:rgba(255,255,255,.055);color:rgba(255,255,255,.48);font-size:7.5px;font-weight:800;letter-spacing:.06em}
.ghw-plan-time{margin-top:4px;color:var(--gh-life-accent,#70d3c8);font-size:9.5px;font-weight:700;line-height:1.3}
.ghw-plan-badge{flex:0 0 auto;padding:4px 7px;border-radius:999px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.56);font-size:7.5px;text-transform:uppercase;letter-spacing:.055em;font-weight:750;white-space:nowrap}
.ghw-plan-card.active .ghw-plan-badge{background:rgba(102,194,181,.14);color:#aee9df}
.ghw-plan-meta-row{margin-top:6px;display:flex;align-items:center;flex-wrap:wrap;gap:5px 9px;color:var(--gh-life-muted,rgba(255,255,255,.55));font-size:9px;line-height:1.35}
.ghw-plan-meta-row>span{display:inline-flex;align-items:center;gap:4px;min-width:0}
.ghw-plan-meta-row i{font-size:8px;color:rgba(255,255,255,.46)}
.ghw-plan-availability{padding:3px 6px;border-radius:999px;background:rgba(255,255,255,.055);text-transform:capitalize}
.ghw-plan-availability.is-busy{background:rgba(235,139,92,.13);color:#f0ad86}.ghw-plan-availability.is-available{background:rgba(93,200,130,.13);color:#9be3b4}.ghw-plan-availability.is-limited{background:rgba(231,186,91,.13);color:#e7c675}.ghw-plan-availability.is-unavailable{background:rgba(230,96,96,.13);color:#ef9a9a}.ghw-plan-availability.is-sleeping{background:rgba(139,124,216,.14);color:#bcb0f2}
.ghw-plan-note{margin-top:7px;padding:7px 8px;border-radius:9px;background:rgba(255,255,255,.025);color:var(--gh-life-muted,rgba(255,255,255,.55));font-size:8.8px;line-height:1.4}
.ghw-plan-actions{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:9px}
.ghw-plan-actions button{min-height:31px!important;margin:0!important;padding:5px 8px!important;border:1px solid var(--gh-life-border,rgba(255,255,255,.1))!important;border-radius:9px!important;background:rgba(255,255,255,.032)!important;color:rgba(255,255,255,.78)!important;font-size:9px!important;line-height:1.1!important}
.ghw-plan-actions button i{font-size:8px;margin-right:3px}
.ghw-plan-actions .ghw-danger{margin-left:auto!important;color:#ef9a9a!important;min-width:31px!important;padding-inline:7px!important}
.ghw-plan-dialog-shell{max-height:min(86dvh,780px)}
#ghw-plan-dialog{background:transparent;border:0;padding:0;color:inherit;max-width:min(94vw,760px);width:100%}
#ghw-plan-dialog::backdrop{background:rgba(0,0,0,.72);backdrop-filter:blur(5px)}
#ghw-plan-dialog textarea{min-height:90px}
.ghw-bridge-settings .gh-life-section-title i,#ghw-one-time-plans .gh-life-section-title i{color:#66d1c5}
@media(max-width:520px){.ghw-plan-card{padding:9px}.ghw-plan-card-top{gap:6px}.ghw-plan-actions button{flex:1 1 auto}.ghw-plan-actions .ghw-danger{flex:0 0 34px}}
`;
    document.head.appendChild(s);
}

async function initBridge() {
    if (bridgeReady) return;
    for (let i=0;i<200;i++) {
        if (globalThis.GreyhavenLife && globalThis.SillyTavern?.getContext) break;
        await new Promise(r=>setTimeout(r,50));
    }
    if (!globalThis.GreyhavenLife) {
        console.error('[greyhaven-life-bridge] Greyhaven Life core did not initialize.');
        return;
    }
    bridgeSettings();
    exposeBridgeApi();
    injectStyle();
    watchLifeUi();
    bindEvents();
    updateBridgePrompts();
    bridgeReady=true;
    console.info(`[greyhaven-life-bridge] v${GHW_VERSION} ready on core ${CORE_VERSION}`);
}
initBridge().catch(e=>console.error('[greyhaven-life-bridge] init failed',e));
