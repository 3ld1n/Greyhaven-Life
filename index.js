const GH_MODULE = 'greyhaven-life';
const GH_VERSION = '1.2.2';
const GH_META_KEY = 'greyhavenLife';
const GH_PROMPT_KEY = 'greyhaven_life_state';
const GH_SETTINGS_KEY = 'greyhavenLife';

const GH_PROMPT_POSITION_IN_CHAT = 1;
const GH_PROMPT_ROLE_SYSTEM = 0;

const GH_DEFAULT_SETTINGS = Object.freeze({
    hudEnabled: true,
    hudShowScene: true,
    promptEnabled: true,
    promptDepth: 1,
    contextScope: 'relevant', // relevant | all
    autoAddParticipants: true,
    injectSceneNotes: true,
    injectPersonNotes: false,
    analysisMaxMessages: 50,
    analysisCharBudget: 24000,
    analysisResponseTokens: 1200,
});

const GH_AVAILABILITY = [
    ['unknown', 'Unknown'],
    ['available', 'Available'],
    ['limited', 'Limited'],
    ['busy', 'Busy'],
    ['unavailable', 'Unavailable'],
    ['sleeping', 'Sleeping'],
];

const GH_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GH_LONG_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let ghInitialized = false;
let ghClockTimer = null;
let ghMinuteKey = '';
let ghActiveTab = 'overview';
let ghChangeListeners = new Set();
let ghRenderScheduled = false;
let ghBoundEvents = false;
let ghCurrentChatIdentity = '';
let ghMenuObserver = null;
let ghCharacterPanelObserver = null;
let ghPendingAnalysis = null;

function ghLog(...args) {
    console.log(`[${GH_MODULE}]`, ...args);
}

function ghCtx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        console.warn(`[${GH_MODULE}] getContext failed`, error);
        return null;
    }
}

function ghClone(value) {
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch {}
    }
    return JSON.parse(JSON.stringify(value));
}

function ghUuid() {
    const ctx = ghCtx();
    try {
        return ctx?.uuidv4?.() || crypto.randomUUID();
    } catch {
        return `gh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

function ghEscape(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function ghChatIdentity() {
    const ctx = ghCtx();
    if (!ctx) return '';
    const chatId = ctx.getCurrentChatId?.() || ctx.chatId || '';
    if (!chatId) return '';
    return ctx.groupId ? `group:${ctx.groupId}:${chatId}` : `char:${ctx.characterId}:${chatId}`;
}

function ghHasActiveChat() {
    const ctx = ghCtx();
    return !!(ctx && (ctx.groupId || ctx.characterId !== undefined) && (ctx.getCurrentChatId?.() || ctx.chatId));
}

function ghGetSettings() {
    const ctx = ghCtx();
    if (!ctx?.extensionSettings) {
        return {
            ...GH_DEFAULT_SETTINGS,
            defaultProfiles: {},
        };
    }

    if (!ctx.extensionSettings[GH_SETTINGS_KEY] || typeof ctx.extensionSettings[GH_SETTINGS_KEY] !== 'object') {
        ctx.extensionSettings[GH_SETTINGS_KEY] = {
            ...GH_DEFAULT_SETTINGS,
            defaultProfiles: {},
        };
        ctx.saveSettingsDebounced?.();
    }

    const settings = ctx.extensionSettings[GH_SETTINGS_KEY];
    for (const [key, value] of Object.entries(GH_DEFAULT_SETTINGS)) {
        if (!(key in settings)) settings[key] = value;
    }

    if (!settings.defaultProfiles || typeof settings.defaultProfiles !== 'object' || Array.isArray(settings.defaultProfiles)) {
        settings.defaultProfiles = {};
    }

    settings.analysisMaxMessages = Math.max(10, Math.min(100, Number(settings.analysisMaxMessages || 50)));
    settings.analysisCharBudget = Math.max(6000, Math.min(60000, Number(settings.analysisCharBudget || 24000)));
    settings.analysisResponseTokens = Math.max(500, Math.min(2400, Number(settings.analysisResponseTokens || 1200)));

    return settings;
}

function ghSaveSettings(partial) {
    const ctx = ghCtx();
    if (!ctx?.extensionSettings) return;

    const settings = ghGetSettings();
    Object.assign(settings, partial);
    ctx.extensionSettings[GH_SETTINGS_KEY] = settings;
    ctx.saveSettingsDebounced?.();

    ghUpdateHud();
    ghUpdatePrompt();
    ghScheduleRender();
    ghEmitChange('settings');
}

function ghDefaultState() {
    return {
        version: 3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        time: {
            mode: 'real', // real | offset | manual
            offsetMinutes: 0,
            manualEpochMs: Date.now(),
            manualAnchorRealMs: Date.now(),
            manualRunning: true,
        },
        scene: {
            label: '',
            location: '',
            notes: '',
            sinceMs: Date.now(),
        },
        people: {},
        peopleOrder: [],
        ignoredPeople: [],
        worldSnapshot: null,
    };
}

function ghNormalizePerson(person) {
    const safe = person && typeof person === 'object' ? person : {};

    safe.id ||= `custom:${ghUuid()}`;
    safe.name ||= 'Unknown';
    safe.avatar ||= '';
    safe.source ||= 'custom';
    safe.sourceKey ||= '';
    safe.characterId ??= null;
    safe.pinContext ??= false;

    if (!['auto', 'present', 'offscreen'].includes(safe.presenceMode)) {
        safe.presenceMode =
            safe.source === 'character' ? 'auto' :
            safe.source === 'persona' ? 'present' :
            'offscreen';
    }

    safe.base ||= {};
    safe.base.location ||= '';
    safe.base.status ||= '';
    safe.base.availability ||= 'unknown';
    safe.base.notes ||= '';
    safe.base.sinceMs = Number.isFinite(Number(safe.base.sinceMs)) ? Number(safe.base.sinceMs) : null;

    safe.override ||= {};
    safe.override.enabled ??= false;
    safe.override.location ||= '';
    safe.override.status ||= '';
    safe.override.availability ||= 'inherit';
    safe.override.untilMs ??= null;
    safe.override.sinceMs = Number.isFinite(Number(safe.override.sinceMs)) ? Number(safe.override.sinceMs) : null;
    safe.override.excusesObligations = safe.override.excusesObligations === true;

    if (!Array.isArray(safe.schedule)) safe.schedule = [];

    safe.schedule = safe.schedule.map(entry => {
        const item = entry && typeof entry === 'object' ? entry : {};
        item.id ||= ghUuid();
        item.templateId ||= '';
        item.label ||= '';
        item.days = Array.isArray(item.days)
            ? item.days.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6)
            : [];
        item.start ||= '09:00';
        item.end ||= '17:00';
        item.location ||= '';
        item.status ||= '';
        item.availability ||= 'busy';
        item.priority = Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0;
        item.type = item.type === 'obligation' ? 'obligation' : 'routine';
        item.reminderMinutes = Math.max(0, Math.min(1440, Number(item.reminderMinutes ?? 60)));
        item.graceMinutes = Math.max(0, Math.min(240, Number(item.graceMinutes ?? 10)));
        item.notes ||= '';
        return item;
    });

    if (!Array.isArray(safe.exceptions)) safe.exceptions = [];
    safe.exceptions = safe.exceptions.map(entry => {
        const item = entry && typeof entry === 'object' ? entry : {};
        item.id ||= ghUuid();
        item.type = ['vacation', 'dayoff', 'sick', 'leave', 'cancelled', 'custom'].includes(item.type)
            ? item.type
            : 'custom';
        item.label ||= '';
        item.startMs = Number.isFinite(Number(item.startMs)) ? Number(item.startMs) : Date.now();
        item.endMs = Number.isFinite(Number(item.endMs)) ? Number(item.endMs) : null;
        item.suppressObligations = item.suppressObligations !== false;
        item.notes ||= '';
        return item;
    });

    return safe;
}

function ghNormalizeState(raw) {
    const state = raw && typeof raw === 'object' ? raw : ghDefaultState();

    state.version = Math.max(3, Number(state.version || 1));
    state.createdAt ||= Date.now();
    state.updatedAt ||= Date.now();

    state.time ||= {};
    state.time.mode = ['real', 'offset', 'manual'].includes(state.time.mode) ? state.time.mode : 'real';
    state.time.offsetMinutes = Number.isFinite(Number(state.time.offsetMinutes)) ? Number(state.time.offsetMinutes) : 0;
    state.time.manualEpochMs = Number.isFinite(Number(state.time.manualEpochMs)) ? Number(state.time.manualEpochMs) : Date.now();
    state.time.manualAnchorRealMs = Number.isFinite(Number(state.time.manualAnchorRealMs)) ? Number(state.time.manualAnchorRealMs) : Date.now();
    state.time.manualRunning = state.time.manualRunning !== false;

    state.scene ||= {};
    state.scene.label ||= '';
    state.scene.location ||= '';
    state.scene.notes ||= '';
    state.scene.sinceMs = Number.isFinite(Number(state.scene.sinceMs)) ? Number(state.scene.sinceMs) : Date.now();

    if (!state.people || typeof state.people !== 'object' || Array.isArray(state.people)) {
        state.people = {};
    }
    if (!Array.isArray(state.peopleOrder)) state.peopleOrder = [];
    if (!Array.isArray(state.ignoredPeople)) state.ignoredPeople = [];
    state.ignoredPeople = [...new Set(state.ignoredPeople.map(String))];

    for (const [id, person] of Object.entries(state.people)) {
        state.people[id] = ghNormalizePerson({ ...person, id });
    }

    state.peopleOrder = state.peopleOrder.filter(id => state.people[id]);
    for (const id of Object.keys(state.people)) {
        if (!state.peopleOrder.includes(id)) state.peopleOrder.push(id);
    }

    if (state.worldSnapshot && typeof state.worldSnapshot === 'object') {
        state.worldSnapshot.createdAt = Number.isFinite(Number(state.worldSnapshot.createdAt))
            ? Number(state.worldSnapshot.createdAt)
            : Date.now();
        state.worldSnapshot.chatLength = Math.max(0, Number(state.worldSnapshot.chatLength || 0));
        state.worldSnapshot.rpTimeMs = Number.isFinite(Number(state.worldSnapshot.rpTimeMs))
            ? Number(state.worldSnapshot.rpTimeMs)
            : null;
        state.worldSnapshot.dirty = state.worldSnapshot.dirty === true;
        state.worldSnapshot.summary ||= '';
        state.worldSnapshot.scene ||= {};
        state.worldSnapshot.people = Array.isArray(state.worldSnapshot.people) ? state.worldSnapshot.people : [];
        state.worldSnapshot.source ||= {};
    } else {
        state.worldSnapshot = null;
    }

    return state;
}

function ghGetState({ create = true } = {}) {
    const ctx = ghCtx();
    if (!ctx?.chatMetadata || !ghHasActiveChat()) {
        return create ? ghDefaultState() : null;
    }

    let raw = ctx.chatMetadata[GH_META_KEY];

    if (!raw && create) {
        raw = ghDefaultState();
        ghPersistState(raw, { emit: false, render: false });
    }

    return raw ? ghNormalizeState(raw) : null;
}

function ghPersistState(state, { emit = true, render = true, reason = 'state' } = {}) {
    const ctx = ghCtx();
    if (!ctx || !ghHasActiveChat()) return;

    state.updatedAt = Date.now();
    const normalized = ghNormalizeState(state);

    const snapshotSafeReasons = new Set(['snapshot', 'analysis-apply']);
    if (normalized.worldSnapshot && !snapshotSafeReasons.has(reason)) {
        normalized.worldSnapshot.dirty = true;
    }

    try {
        if (ctx.chatMetadata) {
            ctx.chatMetadata[GH_META_KEY] = normalized;
        }

        ctx.updateChatMetadata?.({ [GH_META_KEY]: normalized });

        if (typeof ctx.saveMetadataDebounced === 'function') {
            ctx.saveMetadataDebounced();
        } else if (typeof ctx.saveMetadata === 'function') {
            Promise.resolve(ctx.saveMetadata()).catch(error => {
                console.error(`[${GH_MODULE}] saveMetadata failed`, error);
            });
        }
    } catch (error) {
        console.error(`[${GH_MODULE}] Failed to save metadata`, error);
    }

    if (emit) ghEmitChange(reason);
    if (render) ghScheduleRender();
    ghUpdateHud();
    ghUpdatePrompt();
}

function ghMutate(mutator, reason = 'state') {
    const state = ghGetState();
    if (!state) return null;

    mutator(state);
    ghPersistState(state, { reason });
    return state;
}

function ghGetCurrentTime(state = ghGetState()) {
    const now = Date.now();
    if (!state) return new Date(now);

    const time = state.time;

    if (time.mode === 'offset') {
        return new Date(now + Number(time.offsetMinutes || 0) * 60_000);
    }

    if (time.mode === 'manual') {
        const elapsed = time.manualRunning ? Math.max(0, now - Number(time.manualAnchorRealMs || now)) : 0;
        return new Date(Number(time.manualEpochMs || now) + elapsed);
    }

    return new Date(now);
}

function ghSetManualTime(date, { running = true } = {}) {
    const ms = date instanceof Date ? date.getTime() : Number(date);
    if (!Number.isFinite(ms)) return;

    ghMutate(state => {
        state.time.mode = 'manual';
        state.time.manualEpochMs = ms;
        state.time.manualAnchorRealMs = Date.now();
        state.time.manualRunning = !!running;
    }, 'time');
}

function ghSetRealTime() {
    ghMutate(state => {
        state.time.mode = 'real';
        state.time.offsetMinutes = 0;
    }, 'time');
}

function ghSetOffset(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value)) return;

    ghMutate(state => {
        state.time.mode = 'offset';
        state.time.offsetMinutes = Math.round(value);
    }, 'time');
}

function ghSetManualRunning(running) {
    ghMutate(state => {
        if (state.time.mode !== 'manual') {
            const current = ghGetCurrentTime(state).getTime();
            state.time.mode = 'manual';
            state.time.manualEpochMs = current;
            state.time.manualAnchorRealMs = Date.now();
        } else {
            const current = ghGetCurrentTime(state).getTime();
            state.time.manualEpochMs = current;
            state.time.manualAnchorRealMs = Date.now();
        }
        state.time.manualRunning = !!running;
    }, 'time');
}

function ghShiftTime(minutes) {
    const delta = Number(minutes);
    if (!Number.isFinite(delta) || delta === 0) return;

    ghMutate(state => {
        if (state.time.mode === 'real') {
            state.time.mode = 'offset';
            state.time.offsetMinutes = delta;
            return;
        }

        if (state.time.mode === 'offset') {
            state.time.offsetMinutes = Number(state.time.offsetMinutes || 0) + delta;
            return;
        }

        const current = ghGetCurrentTime(state).getTime();
        state.time.manualEpochMs = current + delta * 60_000;
        state.time.manualAnchorRealMs = Date.now();
    }, 'time');
}

function ghAdvanceToNextMorning() {
    const current = ghGetCurrentTime();
    const target = new Date(current);
    target.setDate(target.getDate() + 1);
    target.setHours(8, 0, 0, 0);
    ghSetManualTime(target, { running: true });
}

function ghAdvanceToNextDaySameTime() {
    const current = ghGetCurrentTime();
    current.setDate(current.getDate() + 1);
    ghSetManualTime(current, { running: true });
}

function ghUseLatestMessageTime() {
    const ctx = ghCtx();
    const messages = Array.isArray(ctx?.chat) ? [...ctx.chat].reverse() : [];

    const message = messages.find(item => item?.send_date);
    if (!message) {
        globalThis.toastr?.warning?.('No message timestamp was found in this chat.');
        return;
    }

    const parsed = new Date(message.send_date);
    if (Number.isNaN(parsed.getTime())) {
        globalThis.toastr?.warning?.('The latest message timestamp could not be parsed.');
        return;
    }

    ghSetManualTime(parsed, { running: true });
}

function ghFormatDate(date, options = {}) {
    const { seconds = false, compact = false } = options;

    if (compact) {
        return new Intl.DateTimeFormat(undefined, {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(date);
    }

    return new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: seconds ? '2-digit' : undefined,
        hour12: false,
    }).format(date);
}

function ghToDateTimeLocal(date) {
    const pad = n => String(n).padStart(2, '0');
    return [
        date.getFullYear(),
        '-',
        pad(date.getMonth() + 1),
        '-',
        pad(date.getDate()),
        'T',
        pad(date.getHours()),
        ':',
        pad(date.getMinutes()),
    ].join('');
}

function ghTimeModeLabel(state) {
    if (!state) return '';
    if (state.time.mode === 'offset') {
        const minutes = Number(state.time.offsetMinutes || 0);
        const sign = minutes >= 0 ? '+' : '−';
        const abs = Math.abs(minutes);
        const h = Math.floor(abs / 60);
        const m = abs % 60;
        return `Real ${sign}${h ? `${h}h` : ''}${m ? `${m}m` : h ? '' : '0m'}`;
    }
    if (state.time.mode === 'manual') {
        return state.time.manualRunning ? 'Manual · running' : 'Manual · frozen';
    }
    return 'Real time';
}


function ghDefaultProfileKey(personLike) {
    if (!personLike) return '';
    if (personLike.id) return String(personLike.id);

    if (personLike.source === 'character') {
        const sourceKey = personLike.sourceKey || personLike.avatar || personLike.name || '';
        return sourceKey ? `char:${sourceKey}` : '';
    }

    if (personLike.source === 'persona') {
        return `persona:${String(personLike.sourceKey || personLike.name || 'User').toLowerCase()}`;
    }

    return `custom-default:${String(personLike.name || 'unknown').toLowerCase()}`;
}

function ghNormalizeDefaultSchedule(entry) {
    const item = entry && typeof entry === 'object' ? ghClone(entry) : {};
    item.id ||= `default:${ghUuid()}`;
    item.label ||= '';
    item.days = Array.isArray(item.days)
        ? item.days.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6)
        : [];
    item.start ||= '09:00';
    item.end ||= '17:00';
    item.location ||= '';
    item.status ||= '';
    item.availability ||= 'busy';
    item.priority = Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0;
    item.type = item.type === 'obligation' ? 'obligation' : 'routine';
    item.reminderMinutes = Math.max(0, Math.min(1440, Number(item.reminderMinutes ?? 60)));
    item.graceMinutes = Math.max(0, Math.min(240, Number(item.graceMinutes ?? 10)));
    item.notes ||= '';
    delete item.templateId;
    return item;
}

function ghNormalizeDefaultProfile(profile, descriptor = {}) {
    const safe = profile && typeof profile === 'object' ? profile : {};
    safe.key ||= ghDefaultProfileKey(descriptor) || '';
    safe.name = descriptor.name || safe.name || 'Unknown';
    safe.avatar = descriptor.avatar || safe.avatar || '';
    safe.source = descriptor.source || safe.source || 'character';
    safe.sourceKey = descriptor.sourceKey || safe.sourceKey || '';
    safe.updatedAt = Number.isFinite(Number(safe.updatedAt)) ? Number(safe.updatedAt) : Date.now();
    safe.schedule = Array.isArray(safe.schedule)
        ? safe.schedule.map(ghNormalizeDefaultSchedule)
        : [];
    return safe;
}

function ghGetDefaultProfiles() {
    const settings = ghGetSettings();
    if (!settings.defaultProfiles || typeof settings.defaultProfiles !== 'object') {
        settings.defaultProfiles = {};
    }
    return settings.defaultProfiles;
}

function ghGetDefaultProfile(personOrDescriptor, { create = false } = {}) {
    if (!personOrDescriptor) return null;

    const key = ghDefaultProfileKey(personOrDescriptor);
    if (!key) return null;

    const profiles = ghGetDefaultProfiles();
    const existing = profiles[key];

    if (!existing && !create) return null;

    const profile = ghNormalizeDefaultProfile(
        existing || {
            key,
            name: personOrDescriptor.name || 'Unknown',
            avatar: personOrDescriptor.avatar || '',
            source: personOrDescriptor.source || 'character',
            sourceKey: personOrDescriptor.sourceKey || '',
            schedule: [],
        },
        personOrDescriptor,
    );

    profiles[key] = profile;
    return profile;
}

function ghSaveDefaultProfiles(reason = 'defaults') {
    const ctx = ghCtx();
    if (!ctx?.extensionSettings) return;

    const settings = ghGetSettings();
    ctx.extensionSettings[GH_SETTINGS_KEY] = settings;
    ctx.saveSettingsDebounced?.();

    ghScheduleRender();
    ghEmitChange(reason);
}

function ghCloneDefaultScheduleIntoChat(entry) {
    const normalized = ghNormalizeDefaultSchedule(entry);
    return {
        ...ghClone(normalized),
        id: ghUuid(),
        templateId: normalized.id,
    };
}

function ghApplyDefaultsToNewPerson(person) {
    const profile = ghGetDefaultProfile(person, { create: false });
    if (!profile?.schedule?.length || person.schedule?.length) return person;

    person.schedule = profile.schedule.map(ghCloneDefaultScheduleIntoChat);
    return person;
}


function ghMergeDefaultsIntoPerson(personId) {
    const state = ghGetState();
    const person = state?.people?.[personId];
    if (!person) return false;

    const profile = ghGetDefaultProfile(person, { create: false });
    if (!profile) {
        globalThis.toastr?.info?.(`No global defaults exist for ${person.name} yet.`);
        return false;
    }

    ghMutate(draft => {
        const current = draft.people?.[personId];
        if (!current) return;

        const defaultIds = new Set(profile.schedule.map(entry => entry.id));

        // Remove chat copies that are still linked to a global default that no
        // longer exists. Completely chat-local schedules (no templateId) are
        // intentionally preserved.
        current.schedule = current.schedule.filter(entry =>
            !entry.templateId || defaultIds.has(entry.templateId)
        );

        const byTemplate = new Map(
            current.schedule
                .filter(entry => entry.templateId)
                .map(entry => [entry.templateId, entry]),
        );

        for (const defaultEntry of profile.schedule) {
            const linked = byTemplate.get(defaultEntry.id);
            if (linked) {
                const keepId = linked.id;
                Object.assign(linked, ghClone(defaultEntry), {
                    id: keepId,
                    templateId: defaultEntry.id,
                });
            } else {
                current.schedule.push(ghCloneDefaultScheduleIntoChat(defaultEntry));
            }
        }
    }, 'schedule');

    return true;
}

function ghResetPersonToDefaults(personId) {
    const state = ghGetState();
    const person = state?.people?.[personId];
    if (!person) return false;

    const profile = ghGetDefaultProfile(person, { create: false });
    if (!profile) {
        globalThis.toastr?.info?.(`No global defaults exist for ${person.name} yet.`);
        return false;
    }

    ghMutate(draft => {
        const current = draft.people?.[personId];
        if (!current) return;
        current.schedule = profile.schedule.map(ghCloneDefaultScheduleIntoChat);
    }, 'schedule');

    return true;
}

function ghSavePersonScheduleAsDefaults(personId) {
    const state = ghGetState();
    const person = state?.people?.[personId];
    if (!person) return false;

    const profile = ghGetDefaultProfile(person, { create: true });
    const newDefaults = person.schedule.map(entry => {
        const item = ghNormalizeDefaultSchedule(entry);
        item.id = `default:${ghUuid()}`;
        return item;
    });

    profile.schedule = newDefaults;
    profile.updatedAt = Date.now();

    ghMutate(draft => {
        const current = draft.people?.[personId];
        if (!current) return;

        current.schedule = current.schedule.map((entry, index) => ({
            ...entry,
            templateId: newDefaults[index]?.id || '',
        }));
    }, 'schedule');

    ghSaveDefaultProfiles('defaults');
    return true;
}

function ghDescriptorFromCharacter(characterId) {
    const ctx = ghCtx();
    const index = Number(characterId);
    const character = ctx?.characters?.[index];
    if (!character) return null;

    return {
        id: ghPersonIdFromCharacter(character),
        name: character.name || 'Character',
        avatar: character.avatar ? ctx.getThumbnailUrl?.('avatar', character.avatar) || '' : '',
        source: 'character',
        sourceKey: character.avatar || character.name || '',
        characterId: index,
    };
}

function ghDescriptorFromCurrentPersona() {
    const ctx = ghCtx();
    if (!ctx) return null;

    const name = ctx.name1 || 'User';
    return {
        id: `persona:${String(name).toLowerCase()}`,
        name,
        avatar: ghCurrentPersonaAvatar(),
        source: 'persona',
        sourceKey: name,
        characterId: null,
    };
}

function ghLocationComparable(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function ghLocationsMatch(a, b) {
    const aa = ghLocationComparable(a);
    const bb = ghLocationComparable(b);
    if (!aa || !bb) return false;
    return aa === bb || aa.includes(bb) || bb.includes(aa);
}

function ghGetActiveException(person, date = ghGetCurrentTime()) {
    if (!person?.exceptions?.length) return null;

    const now = date.getTime();
    return [...person.exceptions]
        .filter(entry => {
            const start = Number(entry.startMs || 0);
            const end = entry.endMs ? Number(entry.endMs) : null;
            return now >= start && (!end || now < end);
        })
        .sort((a, b) => Number(b.startMs || 0) - Number(a.startMs || 0))[0] || null;
}

function ghExceptionLabel(entry) {
    if (!entry) return '';
    if (entry.label) return entry.label;

    return {
        vacation: 'Vacation',
        dayoff: 'Day off',
        sick: 'Called sick',
        leave: 'Leave',
        cancelled: 'Schedule cancelled',
        custom: 'Schedule exception',
    }[entry.type] || 'Schedule exception';
}

function ghScheduleWindow(entry, startDate) {
    const startMinutes = ghMinutesFromClock(entry.start);
    const endMinutes = ghMinutesFromClock(entry.end);
    if (startMinutes === null || endMinutes === null) return null;

    const start = new Date(startDate);
    start.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

    const end = new Date(start);
    end.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);

    if (endMinutes <= startMinutes) {
        end.setDate(end.getDate() + 1);
    }

    return { start, end };
}



function ghGetObligationCandidates(person, date = ghGetCurrentTime()) {
    if (!person?.schedule?.length) return [];

    const now = date.getTime();
    const activeOverride = ghOverrideIsActive(person, date) ? person.override : null;
    const candidates = [];

    for (const entry of person.schedule) {
        if (entry.type !== 'obligation' || !entry.days?.length) continue;

        for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
            const startDate = new Date(date);
            startDate.setHours(0, 0, 0, 0);
            startDate.setDate(startDate.getDate() + dayOffset);

            if (!entry.days.includes(startDate.getDay())) continue;

            const window = ghScheduleWindow(entry, startDate);
            if (!window) continue;

            const reminderMs = Number(entry.reminderMinutes || 0) * 60_000;
            const graceMs = Number(entry.graceMinutes || 0) * 60_000;
            const missedMs = 120 * 60_000;
            const startMs = window.start.getTime();
            const endMs = window.end.getTime();

            if (now < startMs - reminderMs || now >= endMs + missedMs) continue;

            const coveringException = (person.exceptions || [])
                .filter(exception => exception?.suppressObligations)
                .find(exception => {
                    const exceptionStart = Number(exception.startMs || 0);
                    const exceptionEnd = exception.endMs ? Number(exception.endMs) : Infinity;
                    return exceptionStart < endMs && exceptionEnd > startMs;
                }) || null;

            candidates.push({
                entry,
                start: window.start,
                end: window.end,
                graceMs,
                excused: !!(coveringException || activeOverride?.excusesObligations),
                exception: coveringException,
                override: activeOverride,
            });
        }
    }

    return candidates.sort((a, b) => {
        const delta = Math.abs(a.start.getTime() - now) - Math.abs(b.start.getTime() - now);
        if (delta) return delta;
        return Number(b.entry.priority || 0) - Number(a.entry.priority || 0);
    });
}


function ghGetRelevantObligation(person, date = ghGetCurrentTime()) {
    return ghGetObligationCandidates(person, date)[0] || null;
}

function ghActualLocationEvidence(person, date = ghGetCurrentTime()) {
    const state = ghGetState({ create: false });
    const present = ghIsPersonPresent(person);
    const override = ghOverrideIsActive(person, date) ? person.override : null;

    if (override?.location) {
        return {
            location: override.location,
            source: 'override',
            sinceMs: Number(override.sinceMs || 0) || null,
        };
    }

    if (present && state?.scene?.location) {
        return {
            location: state.scene.location,
            source: 'scene',
            sinceMs: Number(state.scene.sinceMs || 0) || null,
        };
    }

    if (person?.base?.location) {
        return {
            location: person.base.location,
            source: 'base',
            sinceMs: Number(person.base.sinceMs || 0) || null,
        };
    }

    return { location: '', source: '', sinceMs: null };
}



function ghBuildObligationCue(person, date = ghGetCurrentTime()) {
    const now = date.getTime();
    const actual = ghActualLocationEvidence(person, date);
    const cues = [];

    for (const obligation of ghGetObligationCandidates(person, date)) {
        if (obligation.excused) continue;

        const { entry, start, end, graceMs } = obligation;
        const startMs = start.getTime();
        const endMs = end.getTime();
        const expectedLocation = entry.location || '';
        const mismatch =
            expectedLocation &&
            actual.location &&
            !ghLocationsMatch(actual.location, expectedLocation);

        const base = {
            label: entry.label || 'Obligation',
            start,
            end,
            entryStart: entry.start,
            entryEnd: entry.end,
            expectedLocation,
            actualLocation: actual.location,
        };

        if (now < startMs) {
            const minutes = Math.max(0, Math.ceil((startMs - now) / 60_000));
            cues.push({
                ...base,
                kind: 'upcoming',
                minutes,
                text: `${entry.label || 'Obligation'} starts at ${entry.start} in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            });
            continue;
        }

        if (now >= startMs + graceMs && now < endMs && mismatch) {
            const minutes = Math.max(0, Math.floor((now - startMs) / 60_000));
            cues.push({
                ...base,
                kind: 'late',
                minutes,
                text: `${entry.label || 'Obligation'} started at ${entry.start}; ${person.name} is about ${minutes} minutes late.`,
            });
            continue;
        }

        const hasMissEvidence =
            mismatch &&
            actual.sinceMs &&
            Number(actual.sinceMs) <= startMs + graceMs;

        if (now >= endMs && now < endMs + 120 * 60_000 && hasMissEvidence) {
            cues.push({
                ...base,
                kind: 'missed',
                minutes: Math.max(0, Math.floor((now - startMs) / 60_000)),
                text: `${entry.label || 'Obligation'} has ended and appears to have been missed.`,
            });
        }
    }

    const rank = { late: 0, missed: 1, upcoming: 2 };
    return cues.sort((a, b) =>
        (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) ||
        Number(a.minutes || 0) - Number(b.minutes || 0)
    )[0] || null;
}

function ghMinutesFromClock(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

function ghScheduleMatches(entry, date) {
    if (!entry?.days?.length) return false;

    const start = ghMinutesFromClock(entry.start);
    const end = ghMinutesFromClock(entry.end);
    if (start === null || end === null) return false;

    const day = date.getDay();
    const previousDay = (day + 6) % 7;
    const nowMinutes = date.getHours() * 60 + date.getMinutes();

    if (start === end) {
        return entry.days.includes(day);
    }

    if (start < end) {
        return entry.days.includes(day) && nowMinutes >= start && nowMinutes < end;
    }

    // Overnight schedule, e.g. Friday 22:00 -> Saturday 06:00.
    return (
        (entry.days.includes(day) && nowMinutes >= start) ||
        (entry.days.includes(previousDay) && nowMinutes < end)
    );
}

function ghFindActiveSchedule(person, date) {
    if (!person?.schedule?.length) return null;

    return [...person.schedule]
        .filter(entry => ghScheduleMatches(entry, date))
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0] || null;
}

function ghOverrideIsActive(person, date) {
    const override = person?.override;
    if (!override?.enabled) return false;

    if (override.untilMs && date.getTime() >= Number(override.untilMs)) {
        return false;
    }

    return true;
}



function ghResolvePerson(person, date = ghGetCurrentTime()) {
    const state = ghGetState({ create: false });
    const present = ghIsPersonPresent(person);
    const schedule = ghFindActiveSchedule(person, date);
    const exception = ghGetActiveException(person, date);
    const overrideActive = ghOverrideIsActive(person, date);
    const override = overrideActive ? person.override : null;

    const nowMs = date.getTime();
    const hasActiveSuppressingException = (person.exceptions || []).some(item => {
        if (!item?.suppressObligations) return false;
        const startMs = Number(item.startMs || 0);
        const endMs = item.endMs ? Number(item.endMs) : Infinity;
        return nowMs >= startMs && nowMs < endMs;
    });
    const obligationSuppressed = !!(
        hasActiveSuppressingException ||
        override?.excusesObligations
    );
    const scheduleSuppressed =
        schedule?.type === 'obligation' && obligationSuppressed;

    const resolved = {
        id: person.id,
        name: person.name,
        avatar: person.avatar || '',
        location: person.base?.location || '',
        status: person.base?.status || '',
        availability: person.base?.availability || 'unknown',
        notes: person.base?.notes || '',
        source: 'base',
        sourceLabel: '',
        schedule: schedule || null,
        expectedSchedule: schedule || null,
        exception: exception || null,
        override: override || null,
        present,
        presenceMode: person.presenceMode || 'offscreen',
        obligationCue: null,
    };

    // Actual-state evidence, strongest first: explicit override, current scene
    // for a present person, then manually/analyzer stored base state.
    const ordinaryActualLocation =
        (present && state?.scene?.location) ||
        person.base?.location ||
        '';

    if (present && state?.scene?.location) {
        const baseLocation = person.base?.location || '';
        const baseConflictsWithScene =
            baseLocation && !ghLocationsMatch(baseLocation, state.scene.location);

        resolved.location = state.scene.location;
        resolved.source = 'scene';
        resolved.sourceLabel = state.scene.label || 'Current scene';

        // Do not drag an old location-specific activity into a clearly new
        // scene. A matching schedule/override below can provide the new status.
        if (baseConflictsWithScene) {
            resolved.status = '';
            resolved.availability = 'unknown';
        }
    }

    // A schedule can become the likely actual state only when no stronger
    // actual location conflicts with it. This keeps an off-screen Jack in
    // Paris from being teleported to a Greyhaven routine, while a person with
    // no known location can still be inferred from their active schedule.
    if (schedule && !scheduleSuppressed) {
        const actualLocation = override?.location || ordinaryActualLocation;
        const scheduleMatchesActual =
            !schedule.location ||
            !actualLocation ||
            ghLocationsMatch(actualLocation, schedule.location);

        if (scheduleMatchesActual) {
            resolved.location = schedule.location || resolved.location;
            resolved.status = schedule.status || resolved.status;
            resolved.availability = schedule.availability || resolved.availability;
            resolved.source = 'schedule';
            resolved.sourceLabel = schedule.label || 'Schedule';
        }
    }

    // Explicit overrides always describe actual state, even when that exposes
    // a conflict with an obligation. The "excuses" flag decides whether the
    // conflict should produce a late cue.
    if (overrideActive) {
        resolved.location = override.location || resolved.location;
        resolved.status = override.status || resolved.status;
        if (override.availability && override.availability !== 'inherit') {
            resolved.availability = override.availability;
        }
        resolved.source = 'override';
        resolved.sourceLabel = override.untilMs
            ? `Override until ${ghFormatDate(new Date(override.untilMs), { compact: true })}`
            : 'Current override';
    }

    resolved.obligationCue = ghBuildObligationCue(person, date);
    return resolved;
}

function ghPersonIdFromCharacter(character) {
    const avatar = character?.avatar || '';
    if (avatar) return `char:${avatar}`;
    return `char-name:${String(character?.name || 'unknown').toLowerCase()}`;
}

function ghCurrentPersonaAvatar() {
    const quick = document.querySelector('#quickPersonaImg');
    if (quick?.src) return quick.src;

    const userAvatar = document.querySelector('.mes[is_user="true"] .avatar img');
    return userAvatar?.src || '';
}


function ghGetActiveCharacterIds(ctx = ghCtx()) {
    if (!ctx) return [];

    const ids = new Set();

    if (ctx.groupId) {
        const group = ctx.groups?.find(group => String(group.id) === String(ctx.groupId));
        if (group?.members?.length) {
            const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);

            for (const memberAvatar of group.members) {
                const avatar = typeof memberAvatar === 'string' ? memberAvatar : memberAvatar?.avatar;
                if (!avatar || disabled.has(avatar)) continue;

                const character = ctx.characters?.find(item => item?.avatar === avatar);
                if (!character) continue;
                ids.add(ghPersonIdFromCharacter(character));
            }
        }
    } else if (ctx.characterId !== undefined && ctx.characterId !== null) {
        const character = ctx.characters?.[Number(ctx.characterId)];
        if (character) ids.add(ghPersonIdFromCharacter(character));
    }

    return [...ids];
}

function ghCurrentParticipantIds() {
    const state = ghGetState({ create: false });
    const ctx = ghCtx();
    if (!state || !ctx) return [];

    const ids = new Set(ghGetActiveCharacterIds(ctx));

    // This is a technical "current SillyTavern participants" helper, not a
    // physical-presence helper. A selected persona is not automatically present.
    const personaId = `persona:${String(ctx.name1 || 'User').toLowerCase()}`;
    if (state.people[personaId]) ids.add(personaId);

    return [...ids].filter(id => state.people[id]);
}

function ghIsPersonPresent(person) {
    if (!person) return false;

    if (person.presenceMode === 'present') return true;
    if (person.presenceMode === 'offscreen') return false;

    // "Auto" is intentionally only meaningful for SillyTavern characters.
    // It follows enabled group members / the current solo character.
    if (person.presenceMode === 'auto' && person.source === 'character') {
        return ghGetActiveCharacterIds().includes(person.id);
    }

    return false;
}

function ghGetPresentPeople() {
    return ghGetTrackedPeople().filter(ghIsPersonPresent);
}

function ghLatestUserMessageText() {
    const ctx = ghCtx();
    const messages = Array.isArray(ctx?.chat) ? ctx.chat : [];

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message?.is_user) continue;

        const value = message.mes ?? message.message ?? message.text ?? '';
        if (typeof value === 'string') return value;
    }

    return '';
}

function ghNameAppearsInText(name, text) {
    const cleanName = String(name || '').trim();
    const cleanText = String(text || '');
    if (!cleanName || !cleanText) return false;

    const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    try {
        // Unicode-aware loose boundaries handle names with spaces/apostrophes
        // better than \b while still avoiding accidental substring matches.
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu');
        return pattern.test(cleanText);
    } catch {
        return cleanText.toLowerCase().includes(cleanName.toLowerCase());
    }
}

function ghGetMentionedPersonIds() {
    const text = ghLatestUserMessageText();
    if (!text) return [];

    return ghGetTrackedPeople()
        .filter(person => ghNameAppearsInText(person.name, text))
        .map(person => person.id);
}

function ghEnsureCurrentParticipants({ save = true } = {}) {
    const ctx = ghCtx();
    if (!ctx || !ghHasActiveChat()) return;

    const settings = ghGetSettings();
    if (!settings.autoAddParticipants) return;

    const state = ghGetState();
    let changed = false;
    const ignored = new Set((state.ignoredPeople || []).map(String));

    const addPerson = person => {
        let normalized = ghNormalizePerson(person);
        if (ignored.has(normalized.id)) return;

        const existing = state.people[normalized.id];

        if (!existing) {
            normalized = ghApplyDefaultsToNewPerson(normalized);
            state.people[normalized.id] = normalized;
            state.peopleOrder.push(normalized.id);
            changed = true;
            return;
        }

        if (normalized.name && existing.name !== normalized.name) {
            existing.name = normalized.name;
            changed = true;
        }
        if (normalized.avatar && existing.avatar !== normalized.avatar) {
            existing.avatar = normalized.avatar;
            changed = true;
        }
        if (normalized.characterId !== null && existing.characterId !== normalized.characterId) {
            existing.characterId = normalized.characterId;
            changed = true;
        }
        if (normalized.sourceKey && existing.sourceKey !== normalized.sourceKey) {
            existing.sourceKey = normalized.sourceKey;
            changed = true;
        }
    };

    const personaName = ctx.name1 || 'User';
    addPerson({
        id: `persona:${String(personaName).toLowerCase()}`,
        name: personaName,
        avatar: ghCurrentPersonaAvatar(),
        source: 'persona',
        sourceKey: personaName,
        characterId: null,
        pinContext: false,
        presenceMode: 'offscreen',
        base: {
            location: '',
            status: '',
            availability: 'available',
            notes: '',
        },
    });

    if (ctx.groupId) {
        const group = ctx.groups?.find(group => String(group.id) === String(ctx.groupId));
        if (group?.members?.length) {
            const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);

            for (const member of group.members) {
                const avatar = typeof member === 'string' ? member : member?.avatar;
                if (!avatar || disabled.has(avatar)) continue;

                const characterId = ctx.characters?.findIndex(item => item?.avatar === avatar);
                if (characterId === undefined || characterId < 0) continue;

                const character = ctx.characters[characterId];
                addPerson({
                    id: ghPersonIdFromCharacter(character),
                    name: character?.name || 'Character',
                    avatar: character?.avatar ? ctx.getThumbnailUrl?.('avatar', character.avatar) || '' : '',
                    source: 'character',
                    sourceKey: character?.avatar || character?.name || '',
                    characterId,
                    pinContext: false,
                    presenceMode: 'auto',
                    base: {
                        location: '',
                        status: '',
                        availability: 'available',
                        notes: '',
                    },
                });
            }
        }
    } else if (ctx.characterId !== undefined && ctx.characterId !== null) {
        const characterId = Number(ctx.characterId);
        const character = ctx.characters?.[characterId];

        if (character) {
            addPerson({
                id: ghPersonIdFromCharacter(character),
                name: character?.name || 'Character',
                avatar: character?.avatar ? ctx.getThumbnailUrl?.('avatar', character.avatar) || '' : '',
                source: 'character',
                sourceKey: character?.avatar || character?.name || '',
                characterId,
                pinContext: false,
                presenceMode: 'auto',
                base: {
                    location: '',
                    status: '',
                    availability: 'available',
                    notes: '',
                },
            });
        }
    }

    if (changed && save) {
        ghPersistState(state, { reason: 'participants' });
    } else if (changed) {
        const fresh = ghCtx();
        if (fresh?.chatMetadata) fresh.chatMetadata[GH_META_KEY] = state;
        fresh?.updateChatMetadata?.({ [GH_META_KEY]: state });
    }
}

function ghGetTrackedPeople() {
    const state = ghGetState();
    if (!state) return [];

    return state.peopleOrder
        .map(id => state.people[id])
        .filter(Boolean);
}


function ghGetRelevantPeopleForPrompt() {
    const state = ghGetState();
    if (!state) return [];

    const settings = ghGetSettings();

    if (settings.contextScope === 'all') {
        return ghGetTrackedPeople();
    }

    const relevant = new Set();

    // 1) Everybody physically present in the current scene.
    for (const person of ghGetPresentPeople()) {
        relevant.add(person.id);
    }

    // 2) Current SillyTavern characters remain relevant as possible responders,
    // even if the user has manually marked one off-screen (for example, a
    // remote text-message exchange inside a group chat).
    for (const id of ghGetActiveCharacterIds()) {
        if (state.people[id]) relevant.add(id);
    }

    // 3) Explicitly pinned off-screen people.
    for (const person of ghGetTrackedPeople()) {
        if (person.pinContext) relevant.add(person.id);
    }

    // 4) Anyone specifically named in the newest user message. This makes
    // questions such as "Where is Jack?" work without permanently pinning Jack.
    for (const id of ghGetMentionedPersonIds()) {
        if (state.people[id]) relevant.add(id);
    }

    return [...relevant].map(id => state.people[id]).filter(Boolean);
}

function ghAvailabilityLabel(value) {
    return GH_AVAILABILITY.find(([id]) => id === value)?.[1] || 'Unknown';
}


function ghBuildPromptSummary() {
    const state = ghGetState({ create: false });
    const settings = ghGetSettings();

    if (!state || !settings.promptEnabled || !ghHasActiveChat()) return '';

    const date = ghGetCurrentTime(state);
    const lines = [];
    const exactTime = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);
    const exactDate = new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(date);

    lines.push('[Greyhaven Life — authoritative current roleplay state. Use silently for continuity; do not quote this block as metadata.]');
    lines.push(`AUTHORITATIVE RP CLOCK: ${exactTime} on ${exactDate} (${ghTimeModeLabel(state)}).`);
    lines.push(`Time rule: this is the exact current fictional time NOW. If anyone asks, reads, states, or reasons about the current time, use ${exactTime}. Do not infer a different current time from schedules, old messages, chat timestamps, prior narration, or assumptions. Only an explicit time change in the newest roleplay message may override this clock.`);

    const sceneParts = [];
    if (state.scene.label) sceneParts.push(state.scene.label);
    if (state.scene.location) sceneParts.push(state.scene.location);
    if (sceneParts.length) lines.push(`Current scene: ${sceneParts.join(' — ')}.`);
    if (settings.injectSceneNotes && state.scene.notes) lines.push(`Scene note: ${state.scene.notes}`);

    const people = ghGetRelevantPeopleForPrompt();
    for (const person of people) {
        const resolved = ghResolvePerson(person, date);
        const fields = [];
        const present = ghIsPersonPresent(person);

        fields.push(`presence: ${present ? 'present in the current scene' : 'off-screen'}`);
        if (resolved.location) fields.push(`actual/likely location: ${resolved.location}`);
        if (resolved.status) fields.push(`status: ${resolved.status}`);
        if (resolved.availability && resolved.availability !== 'unknown') {
            fields.push(`availability: ${ghAvailabilityLabel(resolved.availability).toLowerCase()}`);
        }
        if (resolved.source === 'schedule' && resolved.sourceLabel) {
            fields.push(`active schedule: ${resolved.sourceLabel}`);
        }
        if (resolved.exception) {
            fields.push(`exception: ${ghExceptionLabel(resolved.exception)}${resolved.exception.suppressObligations ? ' (scheduled obligations excused)' : ''}`);
        }
        if (settings.injectPersonNotes && resolved.notes) fields.push(`note: ${resolved.notes}`);

        lines.push(`${person.name}: ${fields.join('; ')}.`);

        const cue = resolved.obligationCue;
        if (cue?.kind === 'upcoming') {
            lines.push(`Obligation cue for ${person.name}: ${cue.label} starts at ${cue.entryStart || cue.start?.toLocaleTimeString?.([], { hour: '2-digit', minute: '2-digit' }) || ''} in about ${cue.minutes} minutes${cue.expectedLocation ? ` at ${cue.expectedLocation}` : ''}. This is an upcoming responsibility, not a forced action.`);
        } else if (cue?.kind === 'late') {
            lines.push(`IMPORTANT realism cue for ${person.name}: ${cue.label} began at ${cue.entryStart || cue.start?.toLocaleTimeString?.([], { hour: '2-digit', minute: '2-digit' }) || ''}. ${person.name} appears to still be at ${cue.actualLocation || 'another location'} instead of ${cue.expectedLocation || 'the expected place'} and is about ${cue.minutes} minutes late. Unless the newest roleplay established an excuse, cancellation, leave, or deliberate choice to skip it, ${person.name} should realistically be aware of this obligation. Do NOT teleport them there.`);
        } else if (cue?.kind === 'missed') {
            lines.push(`Obligation cue for ${person.name}: ${cue.label} appears to have ended while ${person.name} was elsewhere. Treat this as a potentially missed obligation unless the roleplay established an excuse. Do not retroactively force attendance.`);
        }
    }

    lines.push('Continuity rules: tracked does not mean physically present. Off-screen world-state facts are not automatic character knowledge. Schedules describe expectations or likely routines; they are cues, not commands. Characters may forget, skip, call sick, take leave, be on vacation, or otherwise deviate when the roleplay supports it. For a present person, explicit scene/override state is actual reality and must not be replaced by a conflicting schedule. The newest explicit roleplay events override stale Life state.');

    return lines.join('\n');
}

function ghUpdatePrompt() {
    const ctx = ghCtx();
    if (!ctx?.setExtensionPrompt) return;

    const settings = ghGetSettings();
    const summary = settings.promptEnabled ? ghBuildPromptSummary() : '';

    try {
        ctx.setExtensionPrompt(
            GH_PROMPT_KEY,
            summary,
            GH_PROMPT_POSITION_IN_CHAT,
            Math.max(0, Math.min(20, Number(settings.promptDepth || 1))),
            false,
            GH_PROMPT_ROLE_SYSTEM,
        );
    } catch (error) {
        console.error(`[${GH_MODULE}] setExtensionPrompt failed`, error);
    }
}

function ghSetScene(partial) {
    ghMutate(state => {
        Object.assign(state.scene, partial || {});
        state.scene.sinceMs = ghGetCurrentTime(state).getTime();
    }, 'scene');
}


function ghApplySceneLocationToCurrentParticipants() {
    const state = ghGetState();
    if (!state?.scene?.location) {
        globalThis.toastr?.warning?.('Set a scene location first.');
        return;
    }

    const ids = ghGetPresentPeople().map(person => person.id);
    if (!ids.length) {
        globalThis.toastr?.warning?.('Nobody is currently marked present in this scene.');
        return;
    }

    ghMutate(draft => {
        for (const id of ids) {
            const person = draft.people[id];
            if (!person) continue;

            person.override.enabled = true;
            person.override.location = draft.scene.location;
            person.override.untilMs = null;
            person.override.sinceMs = ghGetCurrentTime(draft).getTime();
        }
    }, 'people');

    globalThis.toastr?.success?.('Scene location applied to present people.');
}

function ghAddCharacterFromLibrary(characterId) {
    const ctx = ghCtx();
    const character = ctx?.characters?.[Number(characterId)];
    if (!character) return;

    const state = ghGetState();
    const id = ghPersonIdFromCharacter(character);

    state.ignoredPeople = (state.ignoredPeople || []).filter(item => item !== id);

    if (!state.people[id]) {
        let person = ghNormalizePerson({
            id,
            name: character.name || 'Character',
            avatar: character.avatar ? ctx.getThumbnailUrl?.('avatar', character.avatar) || '' : '',
            source: 'character',
            sourceKey: character.avatar || character.name || '',
            characterId: Number(characterId),
            pinContext: false,
            presenceMode: 'auto',
        });
        person = ghApplyDefaultsToNewPerson(person);
        state.people[id] = person;
        state.peopleOrder.push(id);
    }

    ghPersistState(state, { reason: 'people' });
}

function ghAddCurrentPersona() {
    const ctx = ghCtx();
    if (!ctx) return;

    const personaName = ctx.name1 || 'User';
    const id = `persona:${String(personaName).toLowerCase()}`;
    const state = ghGetState();

    state.ignoredPeople = (state.ignoredPeople || []).filter(item => item !== id);

    if (!state.people[id]) {
        let person = ghNormalizePerson({
            id,
            name: personaName,
            avatar: ghCurrentPersonaAvatar(),
            source: 'persona',
            sourceKey: personaName,
            characterId: null,
            pinContext: false,
            presenceMode: 'offscreen',
            base: {
                location: '',
                status: '',
                availability: 'available',
                notes: '',
            },
        });
        person = ghApplyDefaultsToNewPerson(person);
        state.people[id] = person;
        state.peopleOrder.push(id);
    }

    ghPersistState(state, { reason: 'people' });
}

function ghAddCustomPerson(name) {
    const clean = String(name || '').trim();
    if (!clean) return;

    ghMutate(state => {
        const id = `custom:${ghUuid()}`;
        state.people[id] = ghNormalizePerson({
            id,
            name: clean,
            source: 'custom',
            pinContext: false,
            presenceMode: 'offscreen',
        });
        state.peopleOrder.push(id);
    }, 'people');
}

function ghDeletePerson(id) {
    ghMutate(state => {
        if (!state.ignoredPeople.includes(id)) state.ignoredPeople.push(id);
        delete state.people[id];
        state.peopleOrder = state.peopleOrder.filter(item => item !== id);
    }, 'people');
}

function ghAvailabilityOptions(selected, { inherit = false } = {}) {
    const options = inherit ? [['inherit', 'Inherit current/schedule'], ...GH_AVAILABILITY] : GH_AVAILABILITY;
    return options.map(([value, label]) =>
        `<option value="${ghEscape(value)}" ${value === selected ? 'selected' : ''}>${ghEscape(label)}</option>`
    ).join('');
}


function ghPresenceLabel(person) {
    return ghIsPersonPresent(person) ? 'Present' : 'Off-screen';
}

function ghPresenceModeLabel(person) {
    if (person?.presenceMode === 'auto') return 'Auto from chat';
    return person?.presenceMode === 'present' ? 'Present' : 'Off-screen';
}

function ghPresenceModeOptions(person) {
    const options = [];

    if (person?.source === 'character') {
        options.push(['auto', 'Auto from SillyTavern chat']);
    }

    options.push(['present', 'Present in current scene']);
    options.push(['offscreen', 'Off-screen']);

    return options.map(([value, label]) =>
        `<option value="${ghEscape(value)}" ${person?.presenceMode === value ? 'selected' : ''}>${ghEscape(label)}</option>`
    ).join('');
}

function ghPersonAvatarHtml(person) {
    if (person.avatar) {
        return `<img class="gh-life-avatar" src="${ghEscape(person.avatar)}" alt="">`;
    }
    return `<div class="gh-life-avatar gh-life-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;
}


function ghScheduleTypeLabel(type) {
    return type === 'obligation' ? 'Obligation' : 'Routine';
}

function ghExceptionTypeOptions(selected = 'vacation') {
    const items = [
        ['vacation', 'Vacation'],
        ['dayoff', 'Day off'],
        ['sick', 'Called sick'],
        ['leave', 'Leave'],
        ['cancelled', 'Cancelled'],
        ['custom', 'Custom'],
    ];
    return items
        .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`)
        .join('');
}

function ghDateTimeValueFromMs(value) {
    if (!value) return '';
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? '' : ghToDateTimeLocal(date);
}

function ghGetDefaultProfileSummary(person) {
    const profile = ghGetDefaultProfile(person, { create: false });
    const count = profile?.schedule?.length || 0;
    return {
        exists: !!profile,
        count,
        label: count ? `${count} global default ${count === 1 ? 'schedule' : 'schedules'}` : 'No global defaults',
    };
}

function ghOpenExceptionEditor(personId, exceptionId = null) {
    const state = ghGetState();
    const person = state?.people?.[personId];
    if (!person) return;

    const existing = exceptionId
        ? person.exceptions?.find(item => item.id === exceptionId)
        : null;

    const now = ghGetCurrentTime(state);
    const entry = existing ? ghClone(existing) : {
        id: ghUuid(),
        type: 'vacation',
        label: '',
        startMs: now.getTime(),
        endMs: null,
        suppressObligations: true,
        notes: '',
    };

    document.querySelector('#gh-life-exception-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-exception-dialog';

    dialog.innerHTML = `
        <form class="gh-life-subdialog" method="dialog">
            <header class="gh-life-subdialog-header">
                <div>
                    <strong>${exceptionId ? 'Edit exception' : 'Add exception'}</strong>
                    <span>${ghEscape(person.name)}</span>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-exception-cancel>&times;</button>
            </header>

            <div class="gh-life-subdialog-body">
                <div class="gh-life-form-grid">
                    <label>
                        <span>Type</span>
                        <select id="gh-exception-type">${ghExceptionTypeOptions(entry.type)}</select>
                    </label>
                    <label>
                        <span>Label</span>
                        <input id="gh-exception-label" type="text" value="${ghEscape(entry.label)}" placeholder="Greece trip, sick day…">
                    </label>
                    <label>
                        <span>Starts</span>
                        <input id="gh-exception-start" type="datetime-local" value="${ghEscape(ghDateTimeValueFromMs(entry.startMs))}">
                    </label>
                    <label>
                        <span>Ends</span>
                        <input id="gh-exception-end" type="datetime-local" value="${ghEscape(ghDateTimeValueFromMs(entry.endMs))}">
                        <small>Leave empty for no automatic end.</small>
                    </label>
                    <label class="gh-life-span-2 gh-life-setting-row">
                        <span>
                            <strong>Excuse scheduled obligations</strong>
                            <small>Vacation, sick leave and days off should normally keep this on.</small>
                        </span>
                        <input id="gh-exception-suppress" type="checkbox" ${entry.suppressObligations ? 'checked' : ''}>
                    </label>
                    <label class="gh-life-span-2">
                        <span>Notes</span>
                        <textarea id="gh-exception-notes" rows="2" placeholder="Optional reason or continuity note">${ghEscape(entry.notes)}</textarea>
                    </label>
                </div>
            </div>

            <footer class="gh-life-subdialog-footer">
                <button type="button" data-gh-exception-cancel>Cancel</button>
                <button type="button" class="gh-life-primary" data-gh-exception-save>Save exception</button>
            </footer>
        </form>
    `;

    const close = () => {
        try { if (dialog.open) dialog.close(); } catch {}
        dialog.remove();
    };

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });
    dialog.querySelectorAll('[data-gh-exception-cancel]').forEach(button => {
        button.addEventListener('click', close);
    });

    dialog.querySelector('[data-gh-exception-save]').addEventListener('click', () => {
        const startValue = dialog.querySelector('#gh-exception-start')?.value;
        const endValue = dialog.querySelector('#gh-exception-end')?.value;
        const start = startValue ? new Date(startValue) : now;
        const end = endValue ? new Date(endValue) : null;

        if (Number.isNaN(start.getTime())) {
            globalThis.toastr?.warning?.('Choose a valid exception start time.');
            return;
        }
        if (end && Number.isNaN(end.getTime())) {
            globalThis.toastr?.warning?.('Choose a valid exception end time.');
            return;
        }
        if (end && end.getTime() <= start.getTime()) {
            globalThis.toastr?.warning?.('Exception end must be after its start.');
            return;
        }

        const saved = {
            id: entry.id || ghUuid(),
            type: dialog.querySelector('#gh-exception-type')?.value || 'custom',
            label: dialog.querySelector('#gh-exception-label')?.value.trim() || '',
            startMs: start.getTime(),
            endMs: end ? end.getTime() : null,
            suppressObligations: dialog.querySelector('#gh-exception-suppress')?.checked ?? true,
            notes: dialog.querySelector('#gh-exception-notes')?.value.trim() || '',
        };

        ghMutate(draft => {
            const current = draft.people?.[personId];
            if (!current) return;
            if (!Array.isArray(current.exceptions)) current.exceptions = [];
            const index = current.exceptions.findIndex(item => item.id === saved.id);
            if (index >= 0) current.exceptions[index] = saved;
            else current.exceptions.push(saved);
        }, 'exception');

        close();
        globalThis.toastr?.success?.(exceptionId ? 'Exception updated.' : 'Exception added.');
    });

    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

function ghOpenDefaultScheduleEditor(descriptor, scheduleId = null, onDone = null) {
    if (!descriptor) return;

    const profile = ghGetDefaultProfile(descriptor, { create: true });
    const existing = scheduleId
        ? profile.schedule.find(item => item.id === scheduleId)
        : null;

    const entry = existing ? ghClone(existing) : ghNormalizeDefaultSchedule({
        id: `default:${ghUuid()}`,
        label: '',
        days: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '17:00',
        location: '',
        status: 'Working',
        availability: 'busy',
        priority: 0,
        type: 'routine',
        reminderMinutes: 60,
        graceMinutes: 10,
        notes: '',
    });

    document.querySelector('#gh-life-default-schedule-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-default-schedule-dialog';

    const dayButtons = GH_LONG_DAY_NAMES.map((label, day) => `
        <label class="gh-life-day-chip">
            <input type="checkbox" value="${day}" ${entry.days.includes(day) ? 'checked' : ''}>
            <span>${ghEscape(label.slice(0, 3))}</span>
        </label>
    `).join('');

    dialog.innerHTML = `
        <form class="gh-life-subdialog" method="dialog">
            <header class="gh-life-subdialog-header">
                <div>
                    <strong>${scheduleId ? 'Edit global default' : 'Add global default'}</strong>
                    <span>${ghEscape(descriptor.name)}</span>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-default-schedule-cancel>&times;</button>
            </header>
            <div class="gh-life-subdialog-body">
                <div class="gh-life-info-box">
                    <i class="fa-solid fa-globe"></i>
                    <div>This is a reusable default for future chats. Existing chat copies stay independent unless you explicitly update or reset them.</div>
                </div>
                <div class="gh-life-form-grid">
                    <label class="gh-life-span-2">
                        <span>Label</span>
                        <input id="gh-default-schedule-label" type="text" value="${ghEscape(entry.label)}" placeholder="Hospital shift, class, gym…">
                    </label>
                    <label>
                        <span>Type</span>
                        <select id="gh-default-schedule-type">
                            <option value="routine" ${entry.type !== 'obligation' ? 'selected' : ''}>Routine</option>
                            <option value="obligation" ${entry.type === 'obligation' ? 'selected' : ''}>Obligation</option>
                        </select>
                    </label>
                    <label>
                        <span>Priority</span>
                        <input id="gh-default-schedule-priority" type="number" min="-100" max="100" value="${ghEscape(entry.priority)}">
                        <small>Only resolves overlapping blocks.</small>
                    </label>
                    <div class="gh-life-span-2">
                        <span class="gh-life-field-label">Days</span>
                        <div class="gh-life-day-grid">${dayButtons}</div>
                        <div class="gh-life-chip-presets">
                            <button type="button" data-gh-days="weekdays">Weekdays</button>
                            <button type="button" data-gh-days="weekend">Weekend</button>
                            <button type="button" data-gh-days="all">Every day</button>
                        </div>
                    </div>
                    <label>
                        <span>Start</span>
                        <input id="gh-default-schedule-start" type="time" value="${ghEscape(entry.start)}">
                    </label>
                    <label>
                        <span>End</span>
                        <input id="gh-default-schedule-end" type="time" value="${ghEscape(entry.end)}">
                    </label>
                    <label>
                        <span>Location</span>
                        <input id="gh-default-schedule-location" type="text" value="${ghEscape(entry.location)}" placeholder="Greyhaven City Hospital">
                    </label>
                    <label>
                        <span>Availability</span>
                        <select id="gh-default-schedule-availability">${ghAvailabilityOptions(entry.availability)}</select>
                    </label>
                    <label class="gh-life-span-2">
                        <span>Status</span>
                        <input id="gh-default-schedule-status" type="text" value="${ghEscape(entry.status)}" placeholder="Working, sleeping, at class…">
                    </label>
                    <label>
                        <span>Obligation reminder</span>
                        <input id="gh-default-schedule-reminder" type="number" min="0" max="1440" value="${ghEscape(entry.reminderMinutes)}">
                        <small>Minutes before start. Used only for obligations.</small>
                    </label>
                    <label>
                        <span>Late grace</span>
                        <input id="gh-default-schedule-grace" type="number" min="0" max="240" value="${ghEscape(entry.graceMinutes)}">
                        <small>Minutes after start before a late cue.</small>
                    </label>
                    <label class="gh-life-span-2">
                        <span>Schedule note</span>
                        <input id="gh-default-schedule-notes" type="text" value="${ghEscape(entry.notes)}" placeholder="Optional">
                    </label>
                </div>
            </div>
            <footer class="gh-life-subdialog-footer">
                <button type="button" data-gh-default-schedule-cancel>Cancel</button>
                <button type="button" class="gh-life-primary" data-gh-default-schedule-save>Save default</button>
            </footer>
        </form>
    `;

    const close = () => {
        try { if (dialog.open) dialog.close(); } catch {}
        dialog.remove();
    };

    dialog.querySelectorAll('[data-gh-days]').forEach(button => {
        button.addEventListener('click', () => {
            const mode = button.dataset.ghDays;
            const wanted = mode === 'weekdays'
                ? [1,2,3,4,5]
                : mode === 'weekend'
                    ? [0,6]
                    : [0,1,2,3,4,5,6];
            dialog.querySelectorAll('.gh-life-day-chip input').forEach(input => {
                input.checked = wanted.includes(Number(input.value));
            });
        });
    });

    dialog.querySelectorAll('[data-gh-default-schedule-cancel]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });

    dialog.querySelector('[data-gh-default-schedule-save]').addEventListener('click', () => {
        const days = [...dialog.querySelectorAll('.gh-life-day-chip input:checked')]
            .map(input => Number(input.value))
            .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);

        if (!days.length) {
            globalThis.toastr?.warning?.('Choose at least one day.');
            return;
        }

        const saved = ghNormalizeDefaultSchedule({
            id: entry.id,
            label: dialog.querySelector('#gh-default-schedule-label')?.value.trim() || '',
            type: dialog.querySelector('#gh-default-schedule-type')?.value || 'routine',
            priority: Number(dialog.querySelector('#gh-default-schedule-priority')?.value || 0),
            days,
            start: dialog.querySelector('#gh-default-schedule-start')?.value || '09:00',
            end: dialog.querySelector('#gh-default-schedule-end')?.value || '17:00',
            location: dialog.querySelector('#gh-default-schedule-location')?.value.trim() || '',
            availability: dialog.querySelector('#gh-default-schedule-availability')?.value || 'busy',
            status: dialog.querySelector('#gh-default-schedule-status')?.value.trim() || '',
            reminderMinutes: Number(dialog.querySelector('#gh-default-schedule-reminder')?.value || 60),
            graceMinutes: Number(dialog.querySelector('#gh-default-schedule-grace')?.value || 10),
            notes: dialog.querySelector('#gh-default-schedule-notes')?.value.trim() || '',
        });

        const currentProfile = ghGetDefaultProfile(descriptor, { create: true });
        const index = currentProfile.schedule.findIndex(item => item.id === saved.id);
        if (index >= 0) currentProfile.schedule[index] = saved;
        else currentProfile.schedule.push(saved);
        currentProfile.updatedAt = Date.now();
        ghSaveDefaultProfiles('defaults');

        close();
        globalThis.toastr?.success?.(scheduleId ? 'Global default updated.' : 'Global default added.');
        if (typeof onDone === 'function') onDone();
    });

    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

function ghOpenDefaultProfileDialog(descriptor) {
    if (!descriptor) {
        globalThis.toastr?.warning?.('No character or persona is selected.');
        return;
    }

    document.querySelector('#gh-life-default-profile-dialog')?.remove();

    const profile = ghGetDefaultProfile(descriptor, { create: true });
    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-default-profile-dialog';

    const render = () => {
        const current = ghGetDefaultProfile(descriptor, { create: true });
        const cards = current.schedule.map(entry => `
            <div class="gh-life-schedule-card">
                <div class="gh-life-schedule-card-main">
                    <div class="gh-life-schedule-title-row">
                        <div class="gh-life-schedule-title">${ghEscape(entry.label || 'Scheduled block')}</div>
                        <span class="gh-life-schedule-kind ${entry.type === 'obligation' ? 'is-obligation' : ''}">${ghEscape(ghScheduleTypeLabel(entry.type))}</span>
                    </div>
                    <div class="gh-life-schedule-time">${ghEscape(ghDaysSummary(entry.days))} · ${ghEscape(entry.start)}–${ghEscape(entry.end)}</div>
                    <div class="gh-life-schedule-meta">
                        ${entry.location ? `<span><i class="fa-solid fa-location-dot"></i> ${ghEscape(entry.location)}</span>` : ''}
                        ${entry.status ? `<span>${ghEscape(entry.status)}</span>` : ''}
                        <span>${ghEscape(ghAvailabilityLabel(entry.availability))}</span>
                        ${entry.type === 'obligation' ? `<span>Reminder ${ghEscape(entry.reminderMinutes)}m · grace ${ghEscape(entry.graceMinutes)}m</span>` : ''}
                    </div>
                </div>
                <div class="gh-life-schedule-actions">
                    <button type="button" data-gh-default-edit="${ghEscape(entry.id)}">Edit</button>
                    <button type="button" class="gh-life-danger-text" data-gh-default-delete="${ghEscape(entry.id)}">Delete</button>
                </div>
            </div>
        `).join('');

        dialog.innerHTML = `
            <div class="gh-life-subdialog gh-life-default-profile">
                <header class="gh-life-subdialog-header">
                    <div class="gh-life-subdialog-person">
                        ${descriptor.avatar ? `<img class="gh-life-avatar" src="${ghEscape(descriptor.avatar)}" alt="">` : '<span class="gh-life-avatar gh-life-avatar-placeholder"><i class="fa-solid fa-user"></i></span>'}
                        <div>
                            <strong>${ghEscape(descriptor.name)} — Life Defaults</strong>
                            <span>Reusable schedules for new Greyhaven Life chats</span>
                        </div>
                    </div>
                    <button type="button" class="gh-life-dialog-close" data-gh-default-profile-close>&times;</button>
                </header>

                <div class="gh-life-subdialog-body">
                    <div class="gh-life-info-box">
                        <i class="fa-solid fa-copy"></i>
                        <div>Defaults are copied into a chat when this person is first tracked. Editing the chat later does not change these defaults.</div>
                    </div>

                    <div class="gh-life-section-heading">
                        <div>
                            <div class="gh-life-section-title">Default schedules</div>
                            <div class="gh-life-section-subtitle">${current.schedule.length} saved ${current.schedule.length === 1 ? 'block' : 'blocks'}</div>
                        </div>
                        <button type="button" class="gh-life-small-button" data-gh-default-add>+ Add</button>
                    </div>
                    <div class="gh-life-schedule-list">
                        ${cards || '<div class="gh-life-empty">No global default schedules yet.</div>'}
                    </div>
                </div>
            </div>
        `;

        dialog.querySelector('[data-gh-default-profile-close]')?.addEventListener('click', close);
        dialog.querySelector('[data-gh-default-add]')?.addEventListener('click', () => {
            close();
            ghOpenDefaultScheduleEditor(descriptor, null, () => ghOpenDefaultProfileDialog(descriptor));
        });
        dialog.querySelectorAll('[data-gh-default-edit]').forEach(button => {
            button.addEventListener('click', () => {
                const id = button.dataset.ghDefaultEdit;
                close();
                ghOpenDefaultScheduleEditor(descriptor, id, () => ghOpenDefaultProfileDialog(descriptor));
            });
        });
        dialog.querySelectorAll('[data-gh-default-delete]').forEach(button => {
            button.addEventListener('click', () => {
                const id = button.dataset.ghDefaultDelete;
                if (!globalThis.confirm?.('Delete this global default schedule? Existing chat copies will not be deleted.')) return;
                const currentProfile = ghGetDefaultProfile(descriptor, { create: true });
                currentProfile.schedule = currentProfile.schedule.filter(item => item.id !== id);
                currentProfile.updatedAt = Date.now();
                ghSaveDefaultProfiles('defaults');
                render();
            });
        });
    };

    const close = () => {
        try { if (dialog.open) dialog.close(); } catch {}
        dialog.remove();
    };

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });

    document.body.appendChild(dialog);
    render();
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

function ghGetCharacterManagementDescriptor() {
    const ctx = ghCtx();
    if (!ctx?.characters?.length) return null;

    // Character Management uses the same panel for create and edit. Prefer the
    // visible name field so a stale characterId cannot make a new-card screen
    // accidentally edit somebody else's Life defaults.
    const name = document.querySelector('#character_name_pole')?.value?.trim();
    if (name) {
        const index = ctx.characters.findIndex(character =>
            String(character?.name || '').trim() === name
        );
        return index >= 0 ? ghDescriptorFromCharacter(index) : null;
    }

    return ghDescriptorFromCharacter(ctx.characterId);
}


function ghEnsureCharacterManagementButton() {
    const panel = document.querySelector('#rm_ch_create_block');
    if (!panel) return;

    let button = panel.querySelector('#gh-life-character-defaults-button');
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.id = 'gh-life-character-defaults-button';
        button.className = 'menu_button interactable';
        button.innerHTML = '<i class="fa-solid fa-city"></i><span>Greyhaven Life Defaults</span>';
        button.title = 'Edit reusable Greyhaven Life schedules for this character';
        button.addEventListener('click', () => {
            const descriptor = ghGetCharacterManagementDescriptor();
            if (!descriptor) {
                globalThis.toastr?.warning?.('Select an existing character first.');
                return;
            }
            ghOpenDefaultProfileDialog(descriptor);
        });

        const anchor = panel.querySelector('#avatar-and-name-block');
        if (anchor?.parentElement) {
            anchor.insertAdjacentElement('afterend', button);
        } else {
            panel.prepend(button);
        }
    }

    const descriptor = ghGetCharacterManagementDescriptor();
    button.disabled = !descriptor;
}

function ghGetChatScenarioText() {
    const ctx = ghCtx();
    if (!ctx) return '';

    let text = '';

    /*
       SillyTavern's current per-chat "Character Settings Override > Scenario"
       lives in chat metadata as `scenario`. This must be checked FIRST for
       both solo and group chats, because it is the exact chat-specific setup
       the user sees and edits in the override panel.
    */
    const chatScenario = String(ctx.chatMetadata?.scenario || '').trim();
    if (chatScenario) {
        text = chatScenario;
    }

    // Fallbacks only apply when the current chat has no explicit override.
    if (!text && ctx.groupId) {
        const group = ctx.groups?.find(item => String(item?.id) === String(ctx.groupId));

        // Keep a legacy/group-field fallback for older/custom SillyTavern builds,
        // but do NOT treat the group's description as the scenario.
        const legacyGroupScenario = String(group?.scenario || '').trim();
        if (legacyGroupScenario) {
            text = legacyGroupScenario;
        }
    }

    if (!text && !ctx.groupId) {
        try {
            const fields = ctx.getCharacterCardFields?.();
            const scenario = fields?.scenario || fields?.data?.scenario;
            if (scenario) text = String(scenario).trim();
        } catch {}

        if (!text) {
            const character = ctx.characters?.[Number(ctx.characterId)];
            text = String(character?.scenario || character?.data?.scenario || '').trim();
        }
    }

    // Scenario is always useful, but do not let a giant setup field dominate
    // the optional analysis request.
    const maxChars = 12_000;
    if (text.length <= maxChars) return text;

    return `${text.slice(0, 8_000)}\n\n[...scenario shortened...]\n\n${text.slice(-4_000)}`;
}


function ghBuildAnalysisRecentMessages(settings = ghGetSettings()) {
    const ctx = ghCtx();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const maxMessages = Math.max(10, Math.min(100, Number(settings.analysisMaxMessages || 50)));
    const charBudget = Math.max(6000, Math.min(60000, Number(settings.analysisCharBudget || 24000)));

    const chosen = [];
    let usedChars = 0;

    for (let index = chat.length - 1; index >= 0 && chosen.length < maxMessages; index--) {
        const item = chat[index];
        const raw = String(item?.mes || '').trim();
        if (!raw) continue;

        const name =
            String(item?.name || item?.ch_name || '').trim() ||
            (item?.is_user ? String(ctx?.name1 || 'User') : 'Character');

        const prefix = `[${index}] ${name}: `;
        const remaining = charBudget - usedChars - prefix.length;
        if (remaining <= 100) break;

        const text = raw.length > remaining ? raw.slice(raw.length - remaining) : raw;
        chosen.push({ index, name, text });
        usedChars += prefix.length + text.length + 1;
    }

    chosen.reverse();
    return {
        messages: chosen,
        usedMessages: chosen.length,
        usedChars,
        chatLength: chat.length,
    };
}

function ghWorldStateForAnalysis() {
    const state = ghGetState();
    const date = ghGetCurrentTime(state);

    return {
        scene: ghClone(state.scene),
        people: ghGetTrackedPeople().map(person => {
            const resolved = ghResolvePerson(person, date);
            return {
                name: person.name,
                presence: ghIsPersonPresent(person) ? 'present' : 'offscreen',
                location: resolved.location || '',
                status: resolved.status || '',
                availability: resolved.availability || 'unknown',
                notes: person.base?.notes || '',
            };
        }),
    };
}

function ghNormalizeAnalysisResult(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const confidence = value => ['high', 'medium', 'low'].includes(value) ? value : 'low';
    const availability = value =>
        ['available', 'limited', 'busy', 'unavailable', 'sleeping', 'unknown', 'unchanged'].includes(value)
            ? value
            : 'unchanged';
    const presence = value => ['present', 'offscreen', 'unchanged'].includes(value) ? value : 'unchanged';

    const scene = data.scene && typeof data.scene === 'object' ? data.scene : {};
    return {
        summary: String(data.summary || '').trim(),
        scene: {
            label: String(scene.label || '').trim(),
            location: String(scene.location || '').trim(),
            notes: String(scene.notes || '').trim(),
            confidence: confidence(scene.confidence),
            reason: String(scene.reason || '').trim(),
        },
        people: Array.isArray(data.people)
            ? data.people
                .filter(item => item && typeof item === 'object' && String(item.name || '').trim())
                .map(item => ({
                    name: String(item.name || '').trim(),
                    presence: presence(String(item.presence || '').toLowerCase()),
                    location: String(item.location || '').trim(),
                    status: String(item.status || '').trim(),
                    availability: availability(String(item.availability || '').toLowerCase()),
                    confidence: confidence(String(item.confidence || '').toLowerCase()),
                    reason: String(item.reason || '').trim(),
                }))
            : [],
    };
}

function ghParseAnalysisJson(text) {
    if (text && typeof text === 'object') {
        return ghNormalizeAnalysisResult(text);
    }

    const raw = String(text || '').trim();
    if (!raw) throw new Error('The analyzer returned an empty response.');

    const attempts = [raw];
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) attempts.push(fenced[1].trim());

    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));

    // Local repair only — never spend a second model request just because the
    // model left a trailing comma in otherwise valid JSON.
    const repaired = [...attempts].map(candidate =>
        candidate
            .replace(/^\uFEFF/, '')
            .replace(/,\s*([}\]])/g, '$1')
            .trim()
    );
    attempts.push(...repaired);

    for (const candidate of [...new Set(attempts)]) {
        try {
            return ghNormalizeAnalysisResult(JSON.parse(candidate));
        } catch {}
    }

    throw new Error('The analyzer did not return valid JSON.');
}


function ghGetWorldSnapshotStatus() {
    const state = ghGetState({ create: false });
    const snapshot = state?.worldSnapshot || null;
    const chatLength = Array.isArray(ghCtx()?.chat) ? ghCtx().chat.length : 0;

    if (!snapshot) {
        return {
            exists: false,
            dirty: false,
            messagesBehind: 0,
            timeShiftMinutes: 0,
            stale: true,
            label: 'No world snapshot yet',
        };
    }

    const messagesBehind = Math.max(0, chatLength - Number(snapshot.chatLength || 0));
    const dirty = snapshot.dirty === true;
    const currentRpMs = ghGetCurrentTime(state).getTime();
    const timeShiftMinutes = snapshot.rpTimeMs
        ? Math.max(0, Math.floor(Math.abs(currentRpMs - Number(snapshot.rpTimeMs)) / 60_000))
        : 0;
    const staleByTime = timeShiftMinutes >= 120;
    const stale = dirty || messagesBehind >= 10 || staleByTime;

    let label;
    if (dirty) {
        label = `World state changed since analysis${messagesBehind ? ` · ${messagesBehind} new messages` : ''}`;
    } else if (messagesBehind) {
        label = `${messagesBehind} new ${messagesBehind === 1 ? 'message' : 'messages'} since analysis`;
    } else if (staleByTime) {
        label = `About ${timeShiftMinutes} RP minutes have passed since analysis`;
    } else {
        label = 'Analyzed through the latest message';
    }

    return {
        exists: true,
        dirty,
        messagesBehind,
        timeShiftMinutes,
        stale,
        label,
    };
}


function ghBuildCurrentWorldSnapshot({ summary = '', source = {} } = {}) {
    const state = ghGetState();
    const date = ghGetCurrentTime(state);
    const chatLength = Array.isArray(ghCtx()?.chat) ? ghCtx().chat.length : 0;

    return {
        createdAt: Date.now(),
        rpTimeMs: date.getTime(),
        chatLength,
        dirty: false,
        summary: String(summary || '').trim(),
        scene: ghClone(state.scene),
        people: ghGetTrackedPeople().map(person => {
            const resolved = ghResolvePerson(person, date);
            return {
                id: person.id,
                name: person.name,
                present: ghIsPersonPresent(person),
                location: resolved.location || '',
                status: resolved.status || '',
                availability: resolved.availability || 'unknown',
                exception: resolved.exception ? ghExceptionLabel(resolved.exception) : '',
            };
        }),
        source: {
            kind: 'chat-analysis',
            ...ghClone(source),
        },
    };
}

async function ghAnalyzeCurrentChat() {
    if (ghPendingAnalysis) {
        globalThis.toastr?.info?.('Greyhaven Life is already analyzing this chat.');
        return ghPendingAnalysis;
    }

    const ctx = ghCtx();
    if (!ctx?.generateRaw) {
        globalThis.toastr?.error?.('The current SillyTavern build does not expose raw generation to this extension.');
        return null;
    }

    const settings = ghGetSettings();
    const recent = ghBuildAnalysisRecentMessages(settings);
    if (!recent.usedMessages) {
        globalThis.toastr?.warning?.('There are no roleplay messages to analyze yet.');
        return null;
    }

    const state = ghGetState();
    const now = ghGetCurrentTime(state);
    const exactTime = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(now);
    const exactDate = new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    }).format(now);
    const scenario = ghGetChatScenarioText();
    const existingState = ghWorldStateForAnalysis();

    const transcript = recent.messages
        .map(item => `[${item.index}] ${item.name}: ${item.text}`)
        .join('\n\n');

    const systemPrompt = `You are Greyhaven Life's conservative world-state extractor for a realistic roleplay.
Return ONLY one valid JSON object. Do not write markdown.
You are not a storyteller. Never invent a location, action, availability, or presence just to fill a field.
Use strong recent evidence. The CHAT-SPECIFIC SCENARIO / SETUP is strong world-state evidence. Treat its stated location, participants, and current activity as true unless newer roleplay explicitly changes them.
Newer roleplay overrides conflicting scenario details, but silence does NOT erase the scenario.
If a field cannot be established from the scenario, newer roleplay, or existing state, return an empty string or "unchanged" so existing state can be preserved.
"present" means physically in the current scene. "offscreen" means not physically there.
Availability must be one of: available, limited, busy, unavailable, sleeping, unknown, unchanged.
Confidence must be high, medium, or low.
Do not alter or infer recurring schedules; only infer current actual world state.`;

    const prompt = `AUTHORITATIVE CURRENT RP TIME: ${exactTime} on ${exactDate}.

CHAT-SPECIFIC SCENARIO / SETUP:
${scenario || '(No explicit chat scenario override or character scenario is available.)'}

EXISTING GREYHAVEN LIFE STATE:
${JSON.stringify(existingState)}

RECENT ROLEPLAY (oldest to newest; bounded excerpt):
${transcript}

Extract the current state at the END of the newest message.

Required JSON shape:
{
  "summary": "one short factual snapshot summary",
  "scene": {
    "label": "",
    "location": "",
    "notes": "",
    "confidence": "high|medium|low",
    "reason": "short evidence"
  },
  "people": [
    {
      "name": "exact character/persona name",
      "presence": "present|offscreen|unchanged",
      "location": "",
      "status": "",
      "availability": "available|limited|busy|unavailable|sleeping|unknown|unchanged",
      "confidence": "high|medium|low",
      "reason": "short evidence"
    }
  ]
}

Rules:
- Treat explicit scenario statements as valid evidence even if the recent transcript does not repeat them.
- Example: if the scenario says "Aurora is at the cafe near the gym with Marcus" and no newer message moves either person, infer that cafe as the current scene/location and both as present.
- Include tracked people when the scenario or recent evidence updates them.
- You may include an untracked named SillyTavern character if the scenario OR recent roleplay clearly establishes their current state.
- No evidence means preserve: use empty strings / unchanged, not guesses.
- If somebody left the room/scene, mark offscreen.
- If somebody arrived, mark present.
- A scheduled obligation is not evidence that the person actually traveled there.
- Do not infer knowledge; extract world facts only.`;

    const run = (async () => {
        const button = document.querySelector('[data-gh-analyze-chat]');
        const original = button?.innerHTML;
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing…';
        }

        try {
            globalThis.toastr?.info?.(`Analyzing ${recent.usedMessages} recent messages…`);
            const response = await ctx.generateRaw({
                systemPrompt,
                prompt,
                responseLength: settings.analysisResponseTokens,
            });

            const result = ghParseAnalysisJson(response);
            result._source = {
                maxMessages: settings.analysisMaxMessages,
                charBudget: settings.analysisCharBudget,
                usedMessages: recent.usedMessages,
                usedChars: recent.usedChars,
                chatLength: recent.chatLength,
            };
            ghOpenAnalysisPreview(result);
            return result;
        } catch (error) {
            console.error(`[${GH_MODULE}] Chat analysis failed`, error);
            globalThis.toastr?.error?.(`Chat analysis failed: ${error?.message || error}`);
            return null;
        } finally {
            if (button?.isConnected) {
                button.disabled = false;
                button.innerHTML = original || '<i class="fa-solid fa-wand-magic-sparkles"></i> Analyze current chat';
            }
            ghPendingAnalysis = null;
        }
    })();

    ghPendingAnalysis = run;
    return run;
}

function ghOpenAnalysisPreview(result) {
    document.querySelector('#gh-life-analysis-dialog')?.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-analysis-dialog';

    const sceneHasChange = !!(
        result.scene?.label ||
        result.scene?.location ||
        result.scene?.notes
    );
    const sceneChecked = sceneHasChange && result.scene.confidence !== 'low';

    const rows = result.people.map((person, index) => {
        const details = [];
        if (person.presence !== 'unchanged') details.push(person.presence === 'present' ? 'Present' : 'Off-screen');
        if (person.location) details.push(person.location);
        if (person.status) details.push(person.status);
        if (person.availability !== 'unchanged') details.push(ghAvailabilityLabel(person.availability));

        const checked = person.confidence !== 'low' && details.length;
        return `
            <label class="gh-life-analysis-row">
                <input type="checkbox" data-gh-analysis-person="${index}" ${checked ? 'checked' : ''}>
                <span class="gh-life-analysis-row-main">
                    <strong>${ghEscape(person.name)}</strong>
                    <span>${ghEscape(details.join(' · ') || 'No concrete change')}</span>
                    ${person.reason ? `<small>${ghEscape(person.reason)}</small>` : ''}
                </span>
                <span class="gh-life-confidence is-${ghEscape(person.confidence)}">${ghEscape(person.confidence)}</span>
            </label>
        `;
    }).join('');

    dialog.innerHTML = `
        <div class="gh-life-subdialog gh-life-analysis-preview">
            <header class="gh-life-subdialog-header">
                <div>
                    <strong>Chat analysis</strong>
                    <span>Review before Greyhaven Life changes anything</span>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-analysis-cancel>&times;</button>
            </header>

            <div class="gh-life-subdialog-body">
                ${result.summary ? `<div class="gh-life-analysis-summary">${ghEscape(result.summary)}</div>` : ''}

                <div class="gh-life-section-title">Scene</div>
                <label class="gh-life-analysis-row ${sceneHasChange ? '' : 'is-disabled'}">
                    <input type="checkbox" data-gh-analysis-scene ${sceneChecked ? 'checked' : ''} ${sceneHasChange ? '' : 'disabled'}>
                    <span class="gh-life-analysis-row-main">
                        <strong>${ghEscape(result.scene.label || 'Current scene')}</strong>
                        <span>${ghEscape(result.scene.location || 'No location change')}</span>
                        ${result.scene.reason ? `<small>${ghEscape(result.scene.reason)}</small>` : ''}
                    </span>
                    <span class="gh-life-confidence is-${ghEscape(result.scene.confidence)}">${ghEscape(result.scene.confidence)}</span>
                </label>

                <div class="gh-life-section-title gh-life-analysis-people-title">People</div>
                <div class="gh-life-analysis-list">
                    ${rows || '<div class="gh-life-empty">No reliable person-state changes were extracted.</div>'}
                </div>

                <div class="gh-life-info-box">
                    <i class="fa-solid fa-shield-halved"></i>
                    <div>Unchecked and unknown fields preserve your current Life state. This analysis never edits schedules, global defaults, or exceptions.</div>
                </div>
            </div>

            <footer class="gh-life-subdialog-footer">
                <button type="button" data-gh-analysis-cancel>Cancel</button>
                <button type="button" class="gh-life-primary" data-gh-analysis-apply>Apply selected</button>
            </footer>
        </div>
    `;

    const close = () => {
        try { if (dialog.open) dialog.close(); } catch {}
        dialog.remove();
    };

    dialog.querySelectorAll('[data-gh-analysis-cancel]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });

    dialog.querySelector('[data-gh-analysis-apply]').addEventListener('click', () => {
        const selectedIndexes = new Set(
            [...dialog.querySelectorAll('[data-gh-analysis-person]:checked')]
                .map(input => Number(input.dataset.ghAnalysisPerson))
        );
        const applyScene = !!dialog.querySelector('[data-gh-analysis-scene]:checked');
        const ctx = ghCtx();

        ghMutate(state => {
            if (applyScene) {
                if (result.scene.label) state.scene.label = result.scene.label;
                if (result.scene.location) state.scene.location = result.scene.location;
                if (result.scene.notes) state.scene.notes = result.scene.notes;
                state.scene.sinceMs = ghGetCurrentTime(state).getTime();
            }

            for (const index of selectedIndexes) {
                const proposed = result.people[index];
                if (!proposed) continue;

                let person = Object.values(state.people).find(item =>
                    String(item.name || '').trim().toLowerCase() === proposed.name.toLowerCase()
                );

                if (!person) {
                    const characterId = ctx?.characters?.findIndex(character =>
                        String(character?.name || '').trim().toLowerCase() === proposed.name.toLowerCase()
                    );
                    if (Number.isInteger(characterId) && characterId >= 0) {
                        const descriptor = ghDescriptorFromCharacter(characterId);
                        if (descriptor) {
                            person = ghNormalizePerson({
                                ...descriptor,
                                pinContext: false,
                                presenceMode: 'offscreen',
                                base: {
                                    location: '',
                                    status: '',
                                    availability: 'unknown',
                                    notes: '',
                                },
                            });
                            person = ghApplyDefaultsToNewPerson(person);
                            state.people[person.id] = person;
                            if (!state.peopleOrder.includes(person.id)) state.peopleOrder.push(person.id);
                            state.ignoredPeople = state.ignoredPeople.filter(id => id !== person.id);
                        }
                    }
                }

                if (!person) continue;

                if (proposed.presence === 'present') person.presenceMode = 'present';
                if (proposed.presence === 'offscreen') person.presenceMode = 'offscreen';
                if (proposed.location) {
                    person.base.location = proposed.location;
                    person.base.sinceMs = ghGetCurrentTime(state).getTime();
                }
                if (proposed.status) person.base.status = proposed.status;
                if (proposed.availability !== 'unchanged') person.base.availability = proposed.availability;
            }

            // The snapshot is intentionally built from the accepted state below
            // after the mutation is normalized.
        }, 'analysis-apply');

        const state = ghGetState();
        state.worldSnapshot = ghBuildCurrentWorldSnapshot({
            summary: result.summary,
            source: result._source || {},
        });
        ghPersistState(state, { reason: 'snapshot' });

        close();
        globalThis.toastr?.success?.('Greyhaven Life world state updated.');
    });

    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}



function ghRenderOverview() {
    const state = ghGetState();
    const date = ghGetCurrentTime(state);
    const people = ghGetTrackedPeople();
    const presentCount = people.filter(ghIsPersonPresent).length;
    const snapshotStatus = ghGetWorldSnapshotStatus();

    const resolvedCards = people.map(person => {
        const resolved = ghResolvePerson(person, date);
        const present = ghIsPersonPresent(person);
        const cue = resolved.obligationCue;
        const cueHtml = cue ? `
            <span class="gh-life-obligation-cue is-${ghEscape(cue.kind)}">
                <i class="fa-solid ${cue.kind === 'late' ? 'fa-triangle-exclamation' : cue.kind === 'missed' ? 'fa-calendar-xmark' : 'fa-bell'}"></i>
                ${ghEscape(
                    cue.kind === 'upcoming'
                        ? `${cue.label} in ${cue.minutes}m`
                        : cue.kind === 'late'
                            ? `${cue.label} · ${cue.minutes}m late`
                            : `${cue.label} may have been missed`
                )}
            </span>
        ` : '';

        return `
            <button type="button" class="gh-life-person-card" data-gh-edit-person="${ghEscape(person.id)}">
                ${ghPersonAvatarHtml(person)}
                <span class="gh-life-person-main">
                    <span class="gh-life-person-name">${ghEscape(person.name)}</span>
                    <span class="gh-life-person-line">${ghEscape(resolved.location || 'Location not set')}</span>
                    <span class="gh-life-person-meta">
                        ${ghEscape(resolved.status || ghAvailabilityLabel(resolved.availability))}
                        ${resolved.sourceLabel ? ` · ${ghEscape(resolved.sourceLabel)}` : ''}
                    </span>
                    ${cueHtml}
                </span>
                <span class="gh-life-card-badges">
                    <span class="gh-life-presence ${present ? 'is-present' : 'is-offscreen'}">
                        ${present ? '<i class="fa-solid fa-location-dot"></i> Present' : '<i class="fa-regular fa-circle"></i> Off-screen'}
                    </span>
                    <span class="gh-life-availability gh-life-availability-${ghEscape(resolved.availability)}">
                        ${ghEscape(ghAvailabilityLabel(resolved.availability))}
                    </span>
                </span>
            </button>
        `;
    }).join('');

    return `
        <section class="gh-life-section">
            <div class="gh-life-clock-card">
                <div class="gh-life-clock-row">
                    <div>
                        <div class="gh-life-eyebrow">${ghEscape(ghTimeModeLabel(state))}</div>
                        <div class="gh-life-big-time">${ghEscape(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date))}</div>
                        <div class="gh-life-date">${ghEscape(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date))}</div>
                    </div>
                    <button type="button" class="gh-life-icon-button" data-gh-tab-go="time" aria-label="Edit roleplay time">
                        <i class="fa-regular fa-clock"></i>
                    </button>
                </div>

                <div class="gh-life-quick-time">
                    <button type="button" data-gh-shift="15">+15m</button>
                    <button type="button" data-gh-shift="60">+1h</button>
                    <button type="button" data-gh-shift="240">+4h</button>
                    <button type="button" data-gh-next-morning>Next morning</button>
                    <button type="button" data-gh-next-day>Next day</button>
                </div>
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">Current scene</div>
                    <div class="gh-life-section-subtitle">Actual scene state beats schedule expectations for people who are present.</div>
                </div>
            </div>

            <div class="gh-life-form-grid">
                <label>
                    <span>Scene name</span>
                    <input id="gh-life-scene-label" type="text" value="${ghEscape(state.scene.label)}" placeholder="Dinner, hospital shift, beach day…">
                </label>
                <label>
                    <span>Location</span>
                    <input id="gh-life-scene-location" type="text" value="${ghEscape(state.scene.location)}" placeholder="Aurora's apartment, Greyhaven Hospital…">
                </label>
                <label class="gh-life-span-2">
                    <span>Scene note</span>
                    <textarea id="gh-life-scene-notes" rows="2" placeholder="Optional short continuity note">${ghEscape(state.scene.notes)}</textarea>
                </label>
            </div>

            <div class="gh-life-action-row">
                <button type="button" class="gh-life-primary" data-gh-save-scene>
                    <i class="fa-solid fa-location-dot"></i> Save scene
                </button>
                <button type="button" data-gh-apply-scene>Apply location to present people</button>
            </div>
        </section>

        <section class="gh-life-section gh-life-analysis-card">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title"><i class="fa-solid fa-wand-magic-sparkles"></i> Understand this roleplay</div>
                    <div class="gh-life-section-subtitle">One optional AI pass can infer the current scene, presence, locations, activity and availability from the scenario plus recent chat.</div>
                </div>
            </div>

            <div class="gh-life-snapshot-status ${snapshotStatus.stale ? 'is-stale' : 'is-fresh'}">
                <i class="fa-solid ${snapshotStatus.exists ? (snapshotStatus.stale ? 'fa-clock-rotate-left' : 'fa-circle-check') : 'fa-circle-info'}"></i>
                <span>${ghEscape(snapshotStatus.label)}</span>
            </div>

            <div class="gh-life-action-row">
                <button type="button" class="gh-life-primary" data-gh-analyze-chat>
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Analyze current chat
                </button>
            </div>
            <small class="gh-life-muted-note">Manual only. It reviews a bounded recent excerpt and never edits schedules, defaults or exceptions. You review its suggestions before applying.</small>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">Where is everyone?</div>
                    <div class="gh-life-section-subtitle">${people.length} tracked · ${presentCount} present in this scene.</div>
                </div>
                <button type="button" class="gh-life-small-button" data-gh-tab-go="people">Manage</button>
            </div>

            <div class="gh-life-person-list">
                ${resolvedCards || `<div class="gh-life-empty">No people tracked yet. Current chat participants will be added automatically.</div>`}
            </div>
        </section>

        <section class="gh-life-section gh-life-prompt-preview-section">
            <details>
                <summary>AI context preview</summary>
                <pre>${ghEscape(ghBuildPromptSummary() || 'Prompt injection is disabled.')}</pre>
            </details>
        </section>
    `;
}

function ghRenderTimeTab() {
    const state = ghGetState();
    const date = ghGetCurrentTime(state);

    return `
        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">Roleplay clock</div>
                    <div class="gh-life-section-subtitle">The visible clock runs in JavaScript. It does not call the AI every minute.</div>
                </div>
            </div>

            <div class="gh-life-time-display">
                <div>${ghEscape(ghFormatDate(date))}</div>
                <span>${ghEscape(ghTimeModeLabel(state))}</span>
            </div>

            <div class="gh-life-mode-grid">
                <button type="button" class="${state.time.mode === 'real' ? 'active' : ''}" data-gh-mode="real">
                    <i class="fa-solid fa-earth-europe"></i>
                    <strong>Real time</strong>
                    <span>Use the phone/browser's current local date and time.</span>
                </button>

                <button type="button" class="${state.time.mode === 'offset' ? 'active' : ''}" data-gh-mode="offset">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                    <strong>Offset</strong>
                    <span>Follow real time, shifted for travel or another timezone.</span>
                </button>

                <button type="button" class="${state.time.mode === 'manual' ? 'active' : ''}" data-gh-mode="manual">
                    <i class="fa-solid fa-sliders"></i>
                    <strong>Manual</strong>
                    <span>Pick any fictional date/time, running or frozen.</span>
                </button>
            </div>
        </section>

        <section class="gh-life-section" id="gh-life-offset-section">
            <div class="gh-life-section-title">Real-time offset</div>
            <div class="gh-life-inline-control">
                <button type="button" data-gh-offset-adjust="-60">−1h</button>
                <label>
                    <input id="gh-life-offset-minutes" type="number" step="15" value="${ghEscape(state.time.offsetMinutes)}">
                    <span>minutes</span>
                </label>
                <button type="button" data-gh-offset-adjust="60">+1h</button>
            </div>
            <button type="button" data-gh-save-offset>Use this offset</button>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">Manual date & time</div>
            <div class="gh-life-form-grid">
                <label class="gh-life-span-2">
                    <span>Date and time</span>
                    <input id="gh-life-manual-datetime" type="datetime-local" value="${ghEscape(ghToDateTimeLocal(date))}">
                </label>
            </div>

            <div class="gh-life-toggle-row">
                <label class="gh-life-switch-label">
                    <input id="gh-life-manual-running" type="checkbox" ${state.time.mode === 'manual' && state.time.manualRunning ? 'checked' : ''}>
                    <span>Continue running after I set it</span>
                </label>
            </div>

            <div class="gh-life-action-row">
                <button type="button" class="gh-life-primary" data-gh-save-manual>Set manual time</button>
                <button type="button" data-gh-use-last-message>Use latest message's real timestamp</button>
                <button type="button" data-gh-sync-real>Sync back to real time</button>
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">Quick advance</div>
            <div class="gh-life-quick-time gh-life-quick-time-large">
                <button type="button" data-gh-shift="15">+15m</button>
                <button type="button" data-gh-shift="30">+30m</button>
                <button type="button" data-gh-shift="60">+1h</button>
                <button type="button" data-gh-shift="180">+3h</button>
                <button type="button" data-gh-shift="360">+6h</button>
                <button type="button" data-gh-next-morning>Next morning</button>
                <button type="button" data-gh-next-day>Next day</button>
            </div>
        </section>
    `;
}


function ghRenderPeopleTab() {
    const state = ghGetState();
    const date = ghGetCurrentTime(state);
    const people = ghGetTrackedPeople();
    const ctx = ghCtx();

    const cards = people.map(person => {
        const resolved = ghResolvePerson(person, date);
        const present = ghIsPersonPresent(person);
        const canRemove = !present;

        return `
            <div class="gh-life-manage-person ${present ? 'is-present' : 'is-offscreen'}">
                <div class="gh-life-manage-person-top">
                    ${ghPersonAvatarHtml(person)}
                    <div class="gh-life-person-main">
                        <div class="gh-life-person-name">${ghEscape(person.name)}</div>
                        <div class="gh-life-person-line">${ghEscape(resolved.location || 'Location not set')}</div>
                        <div class="gh-life-person-meta">
                            ${ghEscape(resolved.status || ghAvailabilityLabel(resolved.availability))}
                            ${resolved.sourceLabel ? ` · ${ghEscape(resolved.sourceLabel)}` : ''}
                            ${person.presenceMode === 'auto' ? ' · Auto presence' : ''}
                        </div>
                    </div>
                    <span class="gh-life-card-badges">
                        <span class="gh-life-presence ${present ? 'is-present' : 'is-offscreen'}">
                            ${present ? '<i class="fa-solid fa-location-dot"></i> Present' : '<i class="fa-regular fa-circle"></i> Off-screen'}
                        </span>
                        <span class="gh-life-availability gh-life-availability-${ghEscape(resolved.availability)}">${ghEscape(ghAvailabilityLabel(resolved.availability))}</span>
                    </span>
                </div>
                <div class="gh-life-person-actions">
                    <button type="button" data-gh-toggle-presence="${ghEscape(person.id)}" class="${present ? 'active' : ''}">
                        ${present ? '<i class="fa-solid fa-location-dot"></i> Mark off-screen' : '<i class="fa-solid fa-location-dot"></i> Mark present'}
                    </button>
                    <button type="button" data-gh-edit-person="${ghEscape(person.id)}">Edit</button>
                    <button type="button" data-gh-schedule-person="${ghEscape(person.id)}">Schedule</button>
                    <button type="button" data-gh-toggle-pin="${ghEscape(person.id)}" class="${person.pinContext ? 'active' : ''}">
                        <i class="fa-solid fa-thumbtack"></i> ${person.pinContext ? 'Pinned to AI' : 'Pin to AI'}
                    </button>
                    ${canRemove ? `<button type="button" class="gh-life-danger-text" data-gh-delete-person="${ghEscape(person.id)}">Remove</button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    const existingCharIds = new Set(
        Object.values(state.people)
            .filter(person => person.source === 'character' && person.characterId !== null)
            .map(person => Number(person.characterId))
    );

    const characterOptions = (ctx?.characters || [])
        .map((character, index) => ({ character, index }))
        .filter(({ character, index }) => character?.name && !existingCharIds.has(index))
        .sort((a, b) => String(a.character.name).localeCompare(String(b.character.name)))
        .map(({ character, index }) => `<option value="${index}">${ghEscape(character.name)}</option>`)
        .join('');

    const personaName = ctx?.name1 || 'User';
    const personaId = `persona:${String(personaName).toLowerCase()}`;
    const personaTracked = !!state.people[personaId];

    return `
        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">People</div>
                    <div class="gh-life-section-subtitle">Tracked people can be present or off-screen. Selecting a persona does not mean they are physically in the scene.</div>
                </div>
                <button type="button" class="gh-life-small-button" data-gh-rescan>Re-scan chat</button>
            </div>

            <div class="gh-life-person-manage-list">
                ${cards || `<div class="gh-life-empty">No tracked people yet.</div>`}
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">Add someone</div>
            <div class="gh-life-add-person-grid">
                ${!personaTracked ? `
                    <div class="gh-life-span-2 gh-life-inline-add-persona">
                        <span>Active persona <strong>${ghEscape(personaName)}</strong> is not currently tracked.</span>
                        <button type="button" data-gh-add-persona>Add active persona</button>
                    </div>
                ` : ''}

                <label>
                    <span>Existing character</span>
                    <select id="gh-life-add-character">
                        <option value="">Choose a SillyTavern character…</option>
                        ${characterOptions}
                    </select>
                </label>
                <button type="button" data-gh-add-character>Add character</button>

                <label>
                    <span>Custom / temporary person</span>
                    <input id="gh-life-custom-person-name" type="text" placeholder="Name">
                </label>
                <button type="button" data-gh-add-custom>Add custom person</button>
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-info-box">
                <i class="fa-solid fa-circle-info"></i>
                <div>
                    <strong>Presence is separate from tracking.</strong> Present people are physically in the current scene. Off-screen people keep their schedules, locations and overrides without being treated as standing in the room. In Relevant AI mode, Greyhaven Life includes present people, active responder characters, pinned people, and tracked people explicitly named in your newest message.
                </div>
            </div>
        </section>
    `;
}

function ghDaysSummary(days) {
    const normalized = [...new Set((days || []).map(Number))].sort((a, b) => a - b);

    const weekdays = [1, 2, 3, 4, 5];
    if (weekdays.every(day => normalized.includes(day)) && normalized.length === 5) return 'Weekdays';
    if ([0, 6].every(day => normalized.includes(day)) && normalized.length === 2) return 'Weekend';
    if (normalized.length === 7) return 'Every day';

    return normalized.map(day => GH_DAY_NAMES[day]).join(', ') || 'No days';
}


function ghRenderSchedulesTab() {
    const date = ghGetCurrentTime();
    const people = ghGetTrackedPeople();

    const sections = people.map(person => {
        const entries = [...person.schedule]
            .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
        const supportsDefaults = person.source === 'character' || person.source === 'persona';
        const defaultSummary = supportsDefaults
            ? ghGetDefaultProfileSummary(person)
            : { exists: false, count: 0, label: 'Chat-only person' };
        const activeException = ghGetActiveException(person, date);

        const list = entries.map(entry => `
            <div class="gh-life-schedule-card">
                <div class="gh-life-schedule-card-main">
                    <div class="gh-life-schedule-title-row">
                        <div class="gh-life-schedule-title">${ghEscape(entry.label || 'Scheduled block')}</div>
                        <span class="gh-life-schedule-kind ${entry.type === 'obligation' ? 'is-obligation' : ''}">${ghEscape(ghScheduleTypeLabel(entry.type))}</span>
                    </div>
                    <div class="gh-life-schedule-time">${ghEscape(ghDaysSummary(entry.days))} · ${ghEscape(entry.start)}–${ghEscape(entry.end)}</div>
                    <div class="gh-life-schedule-meta">
                        ${entry.location ? `<span><i class="fa-solid fa-location-dot"></i> ${ghEscape(entry.location)}</span>` : ''}
                        ${entry.status ? `<span>${ghEscape(entry.status)}</span>` : ''}
                        <span>${ghEscape(ghAvailabilityLabel(entry.availability))}</span>
                        ${entry.type === 'obligation' ? `<span><i class="fa-regular fa-bell"></i> ${ghEscape(entry.reminderMinutes)}m reminder · ${ghEscape(entry.graceMinutes)}m grace</span>` : ''}
                        ${entry.templateId ? '<span><i class="fa-solid fa-link"></i> from default</span>' : ''}
                    </div>
                </div>
                <div class="gh-life-schedule-actions">
                    <button type="button" data-gh-edit-schedule="${ghEscape(person.id)}|${ghEscape(entry.id)}">Edit</button>
                    <button type="button" class="gh-life-danger-text" data-gh-delete-schedule="${ghEscape(person.id)}|${ghEscape(entry.id)}">Delete</button>
                </div>
            </div>
        `).join('');

        const exceptions = [...(person.exceptions || [])]
            .sort((a, b) => Number(b.startMs || 0) - Number(a.startMs || 0));

        const exceptionCards = exceptions.map(entry => {
            const isActive = activeException?.id === entry.id;
            return `
                <div class="gh-life-exception-card ${isActive ? 'is-active' : ''}">
                    <div>
                        <div class="gh-life-exception-title">
                            ${ghEscape(entry.label || ghExceptionLabel(entry))}
                            ${isActive ? '<span>Active now</span>' : ''}
                        </div>
                        <div class="gh-life-exception-time">
                            ${ghEscape(ghFormatDate(new Date(entry.startMs), { compact: true }))}
                            ${entry.endMs ? ` → ${ghEscape(ghFormatDate(new Date(entry.endMs), { compact: true }))}` : ' → until cleared'}
                        </div>
                        <div class="gh-life-exception-meta">
                            ${entry.suppressObligations ? 'Scheduled obligations excused' : 'Obligations still apply'}
                            ${entry.notes ? ` · ${ghEscape(entry.notes)}` : ''}
                        </div>
                    </div>
                    <div class="gh-life-schedule-actions">
                        <button type="button" data-gh-edit-exception="${ghEscape(person.id)}|${ghEscape(entry.id)}">Edit</button>
                        <button type="button" class="gh-life-danger-text" data-gh-delete-exception="${ghEscape(person.id)}|${ghEscape(entry.id)}">Delete</button>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="gh-life-schedule-person">
                <div class="gh-life-section-heading">
                    <div class="gh-life-schedule-person-heading">
                        ${ghPersonAvatarHtml(person)}
                        <div>
                            <div class="gh-life-section-title">${ghEscape(person.name)}</div>
                            <div class="gh-life-section-subtitle">${entries.length} chat ${entries.length === 1 ? 'schedule' : 'schedules'} · ${ghEscape(defaultSummary.label)}</div>
                        </div>
                    </div>
                    <div class="gh-life-heading-actions">
                        ${supportsDefaults ? `<button type="button" class="gh-life-small-button" data-gh-open-defaults="${ghEscape(person.id)}"><i class="fa-solid fa-globe"></i> Defaults</button>` : ''}
                        <button type="button" class="gh-life-small-button" data-gh-new-schedule="${ghEscape(person.id)}">+ Add</button>
                    </div>
                </div>

                ${supportsDefaults ? `
                    <div class="gh-life-default-sync-row">
                        <button type="button" data-gh-update-defaults="${ghEscape(person.id)}">Update from defaults</button>
                        <button type="button" data-gh-reset-defaults="${ghEscape(person.id)}">Reset to defaults</button>
                        <button type="button" data-gh-save-as-defaults="${ghEscape(person.id)}">Save chat as default</button>
                    </div>
                ` : ''}

                <div class="gh-life-schedule-list">
                    ${list || `<div class="gh-life-empty">No recurring schedule in this chat yet.</div>`}
                </div>

                <div class="gh-life-subsection-heading">
                    <div>
                        <strong>Schedule exceptions</strong>
                        <small>Vacation, sick days, leave, cancellations and other temporary excuses.</small>
                    </div>
                    <button type="button" class="gh-life-small-button" data-gh-new-exception="${ghEscape(person.id)}">+ Exception</button>
                </div>
                <div class="gh-life-exception-list">
                    ${exceptionCards || '<div class="gh-life-empty gh-life-empty-compact">No exceptions.</div>'}
                </div>
            </div>
        `;
    }).join('');

    return `
        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">Schedules & obligations</div>
                    <div class="gh-life-section-subtitle">Routines describe likely life. Obligations can create upcoming/late cues, but never force a character's actions.</div>
                </div>
            </div>

            <div class="gh-life-schedules">
                ${sections || `<div class="gh-life-empty">Add a person first.</div>`}
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-info-box">
                <i class="fa-solid fa-scale-balanced"></i>
                <div><strong>Actual vs expected:</strong> a present person's scene/override location is treated as actual. An obligation is what they were expected to do. If those conflict, Greyhaven Life can recognize lateness instead of teleporting them.</div>
            </div>
            <div class="gh-life-info-box">
                <i class="fa-regular fa-moon"></i>
                <div>Overnight blocks are supported. Priority only chooses between overlapping blocks; it does not make an obligation more important.</div>
            </div>
        </section>
    `;
}


function ghRenderSettingsTab() {
    const settings = ghGetSettings();
    const state = ghGetState();

    return `
        <section class="gh-life-section">
            <div class="gh-life-section-title">Display</div>

            <label class="gh-life-setting-row">
                <span>
                    <strong>Show Life HUD</strong>
                    <small>Small clickable clock overlay. It does not take chat layout space.</small>
                </span>
                <input type="checkbox" id="gh-life-setting-hud" ${settings.hudEnabled ? 'checked' : ''}>
            </label>

            <label class="gh-life-setting-row">
                <span>
                    <strong>Show scene location in HUD</strong>
                    <small>Displays the scene location beside the clock when there is room.</small>
                </span>
                <input type="checkbox" id="gh-life-setting-hud-scene" ${settings.hudShowScene ? 'checked' : ''}>
            </label>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">AI continuity context</div>

            <label class="gh-life-setting-row">
                <span>
                    <strong>Inject Greyhaven Life state</strong>
                    <small>Adds a compact system context block before generation. No extra model request is made.</small>
                </span>
                <input type="checkbox" id="gh-life-setting-prompt" ${settings.promptEnabled ? 'checked' : ''}>
            </label>

            <label class="gh-life-setting-row gh-life-setting-row-stack">
                <span>
                    <strong>Context scope</strong>
                    <small>Relevant keeps tokens low while still including present, responder, mentioned and pinned people.</small>
                </span>
                <select id="gh-life-setting-scope">
                    <option value="relevant" ${settings.contextScope === 'relevant' ? 'selected' : ''}>Present + responder + mentioned + pinned people</option>
                    <option value="all" ${settings.contextScope === 'all' ? 'selected' : ''}>All tracked people</option>
                </select>
            </label>

            <label class="gh-life-setting-row gh-life-setting-row-stack">
                <span>
                    <strong>Injection depth</strong>
                    <small>1 keeps the world state close to the newest messages.</small>
                </span>
                <input id="gh-life-setting-depth" type="number" min="0" max="20" value="${ghEscape(settings.promptDepth)}">
            </label>

            <label class="gh-life-setting-row">
                <span><strong>Include scene notes</strong><small>Useful for short continuity reminders.</small></span>
                <input type="checkbox" id="gh-life-setting-scene-notes" ${settings.injectSceneNotes ? 'checked' : ''}>
            </label>

            <label class="gh-life-setting-row">
                <span><strong>Include person notes</strong><small>Off by default because notes can add more tokens.</small></span>
                <input type="checkbox" id="gh-life-setting-person-notes" ${settings.injectPersonNotes ? 'checked' : ''}>
            </label>

            <label class="gh-life-setting-row">
                <span><strong>Auto-add current chat participants</strong><small>Tracking does not automatically mean physically present.</small></span>
                <input type="checkbox" id="gh-life-setting-auto-add" ${settings.autoAddParticipants ? 'checked' : ''}>
            </label>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">Analyze current chat</div>
            <div class="gh-life-section-subtitle">These limits control the optional manual AI world-state analysis. It never runs automatically.</div>

            <div class="gh-life-form-grid gh-life-analysis-settings">
                <label>
                    <span>Maximum recent messages</span>
                    <input id="gh-life-setting-analysis-messages" type="number" min="10" max="100" value="${ghEscape(settings.analysisMaxMessages)}">
                </label>
                <label>
                    <span>Recent-chat character budget</span>
                    <input id="gh-life-setting-analysis-chars" type="number" min="6000" max="60000" step="1000" value="${ghEscape(settings.analysisCharBudget)}">
                </label>
                <label>
                    <span>Analysis response budget</span>
                    <input id="gh-life-setting-analysis-response" type="number" min="500" max="2400" step="100" value="${ghEscape(settings.analysisResponseTokens)}">
                    <small>Maximum-ish output budget for the structured snapshot.</small>
                </label>
            </div>

            <div class="gh-life-info-box">
                <i class="fa-solid fa-coins"></i>
                <div>Analysis uses one model request only when you press Analyze. Greyhaven Phone will be able to reuse the saved World Snapshot instead of paying to rediscover the same scene.</div>
            </div>

            <div class="gh-life-action-row">
                <button type="button" class="gh-life-primary" data-gh-save-settings>Save settings</button>
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">Current persona defaults</div>
            <div class="gh-life-section-subtitle">Character defaults are also available from SillyTavern Character Management.</div>
            <div class="gh-life-action-row">
                <button type="button" data-gh-persona-defaults><i class="fa-solid fa-globe"></i> Edit active persona defaults</button>
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-title">Current chat state</div>
            <div class="gh-life-action-row">
                <button type="button" data-gh-copy-state><i class="fa-regular fa-copy"></i> Copy JSON</button>
                <button type="button" data-gh-import-state><i class="fa-solid fa-file-import"></i> Import JSON</button>
                <button type="button" class="gh-life-danger-text" data-gh-reset-state>Reset this chat</button>
            </div>

            <div class="gh-life-info-box">
                <i class="fa-solid fa-code-branch"></i>
                <div>Greyhaven Life state is stored per chat. Global default schedules are separate reusable templates; chat copies remain independent.</div>
            </div>
        </section>

        <section class="gh-life-section">
            <details>
                <summary>Current raw state</summary>
                <pre>${ghEscape(JSON.stringify(state, null, 2))}</pre>
            </details>
        </section>
    `;
}

function ghTabButton(id, icon, label) {
    return `
        <button type="button" class="gh-life-tab ${ghActiveTab === id ? 'active' : ''}" data-gh-tab="${id}">
            <i class="${icon}"></i>
            <span>${label}</span>
        </button>
    `;
}

function ghRenderMainDialog() {
    const dialog = document.querySelector('#gh-life-dialog');
    if (!dialog) return;

    if (!ghHasActiveChat()) {
        dialog.querySelector('.gh-life-dialog-body').innerHTML = `
            <div class="gh-life-empty gh-life-empty-large">
                <i class="fa-regular fa-comments"></i>
                <strong>Open a chat first</strong>
                <span>Greyhaven Life stores a separate world state for each chat timeline.</span>
            </div>
        `;
        return;
    }

    ghEnsureCurrentParticipants({ save: false });

    const state = ghGetState();
    const date = ghGetCurrentTime(state);

    const content = {
        overview: ghRenderOverview,
        time: ghRenderTimeTab,
        people: ghRenderPeopleTab,
        schedules: ghRenderSchedulesTab,
        settings: ghRenderSettingsTab,
    }[ghActiveTab]?.() || ghRenderOverview();

    dialog.querySelector('.gh-life-dialog-title').textContent = 'Greyhaven Life';
    dialog.querySelector('.gh-life-dialog-subtitle').textContent =
        `${ghFormatDate(date, { compact: true })}${state.scene.location ? ` · ${state.scene.location}` : ''}`;

    dialog.querySelector('.gh-life-tabs').innerHTML = [
        ghTabButton('overview', 'fa-solid fa-house', 'Overview'),
        ghTabButton('time', 'fa-regular fa-clock', 'Time'),
        ghTabButton('people', 'fa-solid fa-user-group', 'People'),
        ghTabButton('schedules', 'fa-regular fa-calendar', 'Schedules'),
        ghTabButton('settings', 'fa-solid fa-sliders', 'Settings'),
    ].join('');

    dialog.querySelector('.gh-life-dialog-body').innerHTML = content;
}

function ghBuildMainDialog() {
    if (document.querySelector('#gh-life-dialog')) return;

    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-dialog';

    dialog.innerHTML = `
        <div class="gh-life-dialog-shell">
            <header class="gh-life-dialog-header">
                <div class="gh-life-dialog-brand">
                    <div class="gh-life-dialog-icon"><i class="fa-solid fa-city"></i></div>
                    <div>
                        <div class="gh-life-dialog-title">Greyhaven Life</div>
                        <div class="gh-life-dialog-subtitle"></div>
                    </div>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-close aria-label="Close">&times;</button>
            </header>
            <nav class="gh-life-tabs"></nav>
            <main class="gh-life-dialog-body"></main>
        </div>
    `;

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        ghClose();
    });

    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;

        const shell = dialog.querySelector('.gh-life-dialog-shell');
        const rect = shell.getBoundingClientRect();
        const inside =
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom;

        if (!inside) ghClose();
    });

    dialog.addEventListener('click', ghHandleMainDialogClick);
    dialog.addEventListener('change', ghHandleMainDialogChange);

    document.body.appendChild(dialog);
}

function ghOpen(tab = 'overview') {
    ghBuildMainDialog();
    ghActiveTab = tab || 'overview';

    ghEnsureCurrentParticipants();
    ghRenderMainDialog();

    const dialog = document.querySelector('#gh-life-dialog');
    if (!dialog) return;

    try {
        if (!dialog.open) dialog.showModal();
    } catch {
        dialog.setAttribute('open', '');
    }

    ghUpdateHud();
}

function ghClose() {
    const dialog = document.querySelector('#gh-life-dialog');
    if (!dialog) return;

    try {
        if (dialog.open && typeof dialog.close === 'function') dialog.close();
    } catch {}

    dialog.removeAttribute('open');
}

function ghScheduleRender() {
    if (ghRenderScheduled) return;

    ghRenderScheduled = true;
    requestAnimationFrame(() => {
        ghRenderScheduled = false;

        const dialog = document.querySelector('#gh-life-dialog');
        if (dialog?.open) ghRenderMainDialog();

        ghUpdateHud();
    });
}


function ghOpenPersonEditor(personId) {
    const state = ghGetState();
    const person = state?.people?.[personId];
    if (!person) return;

    document.querySelector('#gh-life-person-dialog')?.remove();

    const current = ghGetCurrentTime(state);
    const resolved = ghResolvePerson(person, current);
    const overrideUntil = person.override?.untilMs ? ghToDateTimeLocal(new Date(person.override.untilMs)) : '';

    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-person-dialog';

    dialog.innerHTML = `
        <form class="gh-life-subdialog" method="dialog">
            <header class="gh-life-subdialog-header">
                <div class="gh-life-subdialog-person">
                    ${ghPersonAvatarHtml(person)}
                    <div>
                        <strong>${ghEscape(person.name)}</strong>
                        <span>Actual: ${ghEscape(resolved.location || 'location not set')}</span>
                    </div>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-person-cancel>&times;</button>
            </header>

            <div class="gh-life-subdialog-body">
                <section>
                    <div class="gh-life-section-title">Default / last known state</div>
                    <div class="gh-life-form-grid">
                        <label>
                            <span>Location</span>
                            <input id="gh-person-base-location" type="text" value="${ghEscape(person.base.location)}" placeholder="Home, hospital, downtown…">
                        </label>
                        <label>
                            <span>Availability</span>
                            <select id="gh-person-base-availability">${ghAvailabilityOptions(person.base.availability)}</select>
                        </label>
                        <label class="gh-life-span-2">
                            <span>Status</span>
                            <input id="gh-person-base-status" type="text" value="${ghEscape(person.base.status)}" placeholder="Working, relaxing, driving…">
                        </label>
                        <label class="gh-life-span-2">
                            <span>Notes</span>
                            <textarea id="gh-person-base-notes" rows="2" placeholder="Optional continuity note">${ghEscape(person.base.notes)}</textarea>
                        </label>
                    </div>
                </section>

                <section class="gh-life-override-editor">
                    <div class="gh-life-section-heading">
                        <div>
                            <div class="gh-life-section-title">Current override</div>
                            <div class="gh-life-section-subtitle">Actual temporary state. It can conflict with a schedule without teleporting the character.</div>
                        </div>
                        <label class="gh-life-switch-label gh-life-switch-label-inline">
                            <input id="gh-person-override-enabled" type="checkbox" ${person.override.enabled ? 'checked' : ''}>
                            <span>Active</span>
                        </label>
                    </div>

                    <div class="gh-life-form-grid">
                        <label>
                            <span>Location</span>
                            <input id="gh-person-override-location" type="text" value="${ghEscape(person.override.location)}" placeholder="Leave blank to inherit">
                        </label>
                        <label>
                            <span>Availability</span>
                            <select id="gh-person-override-availability">${ghAvailabilityOptions(person.override.availability || 'inherit', { inherit: true })}</select>
                        </label>
                        <label class="gh-life-span-2">
                            <span>Status</span>
                            <input id="gh-person-override-status" type="text" value="${ghEscape(person.override.status)}" placeholder="Leave blank to inherit">
                        </label>
                        <label class="gh-life-span-2">
                            <span>Override until</span>
                            <input id="gh-person-override-until" type="datetime-local" value="${ghEscape(overrideUntil)}">
                            <small>Leave empty to keep the override active until you clear it.</small>
                        </label>
                        <label class="gh-life-span-2 gh-life-setting-row">
                            <span>
                                <strong>Excuses scheduled obligations</strong>
                                <small>Turn on for called sick, approved leave, a cancelled shift, etc. Leave off for oversleeping or simply being late.</small>
                            </span>
                            <input id="gh-person-override-excuses" type="checkbox" ${person.override.excusesObligations ? 'checked' : ''}>
                        </label>
                    </div>
                </section>

                <label class="gh-life-setting-row gh-life-setting-row-stack">
                    <span>
                        <strong>Scene presence</strong>
                        <small>${person.source === 'character'
                            ? 'Auto follows whether this character is enabled in the current SillyTavern chat. Manual choices override that.'
                            : 'This is independent from which SillyTavern persona is currently selected.'}</small>
                    </span>
                    <select id="gh-person-presence-mode">${ghPresenceModeOptions(person)}</select>
                </label>

                <label class="gh-life-setting-row">
                    <span>
                        <strong>Pin to AI context</strong>
                        <small>Keep ${ghEscape(person.name)} in Life context even when off-screen.</small>
                    </span>
                    <input id="gh-person-pin-context" type="checkbox" ${person.pinContext ? 'checked' : ''}>
                </label>
            </div>

            <footer class="gh-life-subdialog-footer">
                <button type="button" data-gh-person-clear-override>Clear override</button>
                <button type="button" class="gh-life-primary" data-gh-person-save>Save</button>
            </footer>
        </form>
    `;

    const close = () => {
        try { if (dialog.open) dialog.close(); } catch {}
        dialog.remove();
    };

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });
    dialog.querySelector('[data-gh-person-cancel]').addEventListener('click', close);

    dialog.querySelector('[data-gh-person-clear-override]').addEventListener('click', () => {
        ghMutate(draft => {
            const currentPerson = draft.people?.[personId];
            if (!currentPerson) return;
            currentPerson.override = {
                enabled: false,
                location: '',
                status: '',
                availability: 'inherit',
                untilMs: null,
                sinceMs: null,
                excusesObligations: false,
            };
        }, 'people');
        close();
    });

    dialog.querySelector('[data-gh-person-save]').addEventListener('click', () => {
        const untilValue = dialog.querySelector('#gh-person-override-until')?.value;
        const untilDate = untilValue ? new Date(untilValue) : null;

        ghMutate(draft => {
            const currentPerson = draft.people?.[personId];
            if (!currentPerson) return;

            currentPerson.base.location = dialog.querySelector('#gh-person-base-location')?.value.trim() || '';
            currentPerson.base.availability = dialog.querySelector('#gh-person-base-availability')?.value || 'unknown';
            currentPerson.base.status = dialog.querySelector('#gh-person-base-status')?.value.trim() || '';
            currentPerson.base.notes = dialog.querySelector('#gh-person-base-notes')?.value.trim() || '';
            currentPerson.base.sinceMs = ghGetCurrentTime(draft).getTime();

            const wasOverrideActive = currentPerson.override.enabled;
            currentPerson.override.enabled = dialog.querySelector('#gh-person-override-enabled')?.checked ?? false;
            currentPerson.override.location = dialog.querySelector('#gh-person-override-location')?.value.trim() || '';
            currentPerson.override.availability = dialog.querySelector('#gh-person-override-availability')?.value || 'inherit';
            currentPerson.override.status = dialog.querySelector('#gh-person-override-status')?.value.trim() || '';
            currentPerson.override.untilMs =
                untilDate && !Number.isNaN(untilDate.getTime()) ? untilDate.getTime() : null;
            currentPerson.override.excusesObligations =
                dialog.querySelector('#gh-person-override-excuses')?.checked ?? false;
            if (currentPerson.override.enabled && !wasOverrideActive) {
                currentPerson.override.sinceMs = ghGetCurrentTime(draft).getTime();
            } else if (!currentPerson.override.enabled) {
                currentPerson.override.sinceMs = null;
            } else if (!currentPerson.override.sinceMs) {
                currentPerson.override.sinceMs = ghGetCurrentTime(draft).getTime();
            }

            currentPerson.presenceMode =
                dialog.querySelector('#gh-person-presence-mode')?.value ||
                currentPerson.presenceMode ||
                'offscreen';
            currentPerson.pinContext = dialog.querySelector('#gh-person-pin-context')?.checked ?? false;
        }, 'people');

        close();
    });

    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

function ghOpenScheduleEditor(personId, scheduleId = null) {
    const state = ghGetState();
    const person = state?.people?.[personId];
    if (!person) return;

    const existing = scheduleId ? person.schedule.find(entry => entry.id === scheduleId) : null;
    const entry = existing ? ghClone(existing) : {
        id: ghUuid(),
        templateId: '',
        label: '',
        days: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '17:00',
        location: '',
        status: 'Working',
        availability: 'busy',
        priority: 0,
        type: 'routine',
        reminderMinutes: 60,
        graceMinutes: 10,
        notes: '',
    };

    document.querySelector('#gh-life-schedule-dialog')?.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-schedule-dialog';

    const dayButtons = GH_LONG_DAY_NAMES.map((label, day) => `
        <label class="gh-life-day-chip">
            <input type="checkbox" value="${day}" ${entry.days.includes(day) ? 'checked' : ''}>
            <span>${ghEscape(label.slice(0, 3))}</span>
        </label>
    `).join('');

    dialog.innerHTML = `
        <form class="gh-life-subdialog" method="dialog">
            <header class="gh-life-subdialog-header">
                <div>
                    <strong>${scheduleId ? 'Edit schedule' : 'Add schedule'}</strong>
                    <span>${ghEscape(person.name)}</span>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-schedule-cancel>&times;</button>
            </header>

            <div class="gh-life-subdialog-body">
                <div class="gh-life-form-grid">
                    <label class="gh-life-span-2">
                        <span>Label</span>
                        <input id="gh-schedule-label" type="text" value="${ghEscape(entry.label)}" placeholder="Hospital shift, sleep, gym…">
                    </label>

                    <label>
                        <span>Schedule type</span>
                        <select id="gh-schedule-type">
                            <option value="routine" ${entry.type !== 'obligation' ? 'selected' : ''}>Routine</option>
                            <option value="obligation" ${entry.type === 'obligation' ? 'selected' : ''}>Obligation</option>
                        </select>
                        <small>Obligations can create upcoming/late cues. Routines never punish a character for skipping them.</small>
                    </label>

                    <label>
                        <span>Priority</span>
                        <input id="gh-schedule-priority" type="number" min="-100" max="100" value="${ghEscape(entry.priority)}">
                        <small>Only decides which overlapping schedule wins.</small>
                    </label>

                    <div class="gh-life-span-2">
                        <span class="gh-life-field-label">Days</span>
                        <div class="gh-life-day-grid">${dayButtons}</div>
                        <div class="gh-life-chip-presets">
                            <button type="button" data-gh-days="weekdays">Weekdays</button>
                            <button type="button" data-gh-days="weekend">Weekend</button>
                            <button type="button" data-gh-days="all">Every day</button>
                        </div>
                    </div>

                    <label>
                        <span>Start</span>
                        <input id="gh-schedule-start" type="time" value="${ghEscape(entry.start)}">
                    </label>
                    <label>
                        <span>End</span>
                        <input id="gh-schedule-end" type="time" value="${ghEscape(entry.end)}">
                    </label>

                    <label>
                        <span>Location</span>
                        <input id="gh-schedule-location" type="text" value="${ghEscape(entry.location)}" placeholder="Greyhaven City Hospital">
                    </label>
                    <label>
                        <span>Availability</span>
                        <select id="gh-schedule-availability">${ghAvailabilityOptions(entry.availability)}</select>
                    </label>

                    <label class="gh-life-span-2">
                        <span>Status</span>
                        <input id="gh-schedule-status" type="text" value="${ghEscape(entry.status)}" placeholder="On shift, sleeping, at the gym…">
                    </label>

                    <label>
                        <span>Obligation reminder</span>
                        <input id="gh-schedule-reminder" type="number" min="0" max="1440" value="${ghEscape(entry.reminderMinutes)}">
                        <small>Minutes before an obligation starts.</small>
                    </label>

                    <label>
                        <span>Late grace</span>
                        <input id="gh-schedule-grace" type="number" min="0" max="240" value="${ghEscape(entry.graceMinutes)}">
                        <small>Minutes after start before it counts as late.</small>
                    </label>

                    <label class="gh-life-span-2">
                        <span>Schedule note</span>
                        <input id="gh-schedule-notes" type="text" value="${ghEscape(entry.notes)}" placeholder="Optional">
                    </label>
                </div>

                ${entry.templateId ? `
                    <div class="gh-life-info-box">
                        <i class="fa-solid fa-link"></i>
                        <div>This chat schedule came from a global default. Editing it changes only this chat.</div>
                    </div>
                ` : ''}
            </div>

            <footer class="gh-life-subdialog-footer">
                <button type="button" data-gh-schedule-cancel>Cancel</button>
                <button type="button" class="gh-life-primary" data-gh-schedule-save>Save schedule</button>
            </footer>
        </form>
    `;

    const close = () => {
        try { if (dialog.open) dialog.close(); } catch {}
        dialog.remove();
    };

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });

    dialog.querySelectorAll('[data-gh-schedule-cancel]').forEach(button => button.addEventListener('click', close));

    dialog.querySelectorAll('[data-gh-days]').forEach(button => {
        button.addEventListener('click', () => {
            const mode = button.dataset.ghDays;
            const wanted =
                mode === 'weekdays' ? [1, 2, 3, 4, 5] :
                mode === 'weekend' ? [0, 6] :
                [0, 1, 2, 3, 4, 5, 6];

            dialog.querySelectorAll('.gh-life-day-chip input').forEach(input => {
                input.checked = wanted.includes(Number(input.value));
            });
        });
    });

    dialog.querySelector('[data-gh-schedule-save]').addEventListener('click', () => {
        const days = [...dialog.querySelectorAll('.gh-life-day-chip input:checked')]
            .map(input => Number(input.value))
            .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);

        if (!days.length) {
            globalThis.toastr?.warning?.('Choose at least one day.');
            return;
        }

        const savedEntry = {
            id: entry.id || ghUuid(),
            templateId: entry.templateId || '',
            label: dialog.querySelector('#gh-schedule-label')?.value.trim() || '',
            days,
            start: dialog.querySelector('#gh-schedule-start')?.value || '09:00',
            end: dialog.querySelector('#gh-schedule-end')?.value || '17:00',
            location: dialog.querySelector('#gh-schedule-location')?.value.trim() || '',
            availability: dialog.querySelector('#gh-schedule-availability')?.value || 'busy',
            status: dialog.querySelector('#gh-schedule-status')?.value.trim() || '',
            priority: Number(dialog.querySelector('#gh-schedule-priority')?.value || 0),
            type: dialog.querySelector('#gh-schedule-type')?.value === 'obligation' ? 'obligation' : 'routine',
            reminderMinutes: Math.max(0, Math.min(1440, Number(dialog.querySelector('#gh-schedule-reminder')?.value || 0))),
            graceMinutes: Math.max(0, Math.min(240, Number(dialog.querySelector('#gh-schedule-grace')?.value || 0))),
            notes: dialog.querySelector('#gh-schedule-notes')?.value.trim() || '',
        };

        ghMutate(draft => {
            const currentPerson = draft.people?.[personId];
            if (!currentPerson) return;
            if (!Array.isArray(currentPerson.schedule)) currentPerson.schedule = [];

            const index = currentPerson.schedule.findIndex(item => item.id === savedEntry.id);
            if (index >= 0) currentPerson.schedule[index] = ghClone(savedEntry);
            else currentPerson.schedule.push(ghClone(savedEntry));
        }, 'schedule');

        close();
        globalThis.toastr?.success?.(scheduleId ? 'Schedule updated.' : 'Schedule added.');
    });

    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

async function ghCopyState() {
    const state = ghGetState();
    const text = JSON.stringify(state, null, 2);

    try {
        await navigator.clipboard.writeText(text);
        globalThis.toastr?.success?.('Greyhaven Life state copied.');
    } catch {
        globalThis.prompt?.('Copy Greyhaven Life JSON:', text);
    }
}

function ghImportState() {
    const text = globalThis.prompt?.('Paste Greyhaven Life JSON for this chat:');
    if (!text) return;

    try {
        const parsed = JSON.parse(text);
        const normalized = ghNormalizeState(parsed);
        ghPersistState(normalized, { reason: 'import' });
        globalThis.toastr?.success?.('Greyhaven Life state imported.');
    } catch (error) {
        console.error(error);
        globalThis.toastr?.error?.('That JSON could not be imported.');
    }
}

function ghResetState() {
    if (!globalThis.confirm?.('Reset Greyhaven Life for this chat only?')) return;

    const fresh = ghDefaultState();
    ghPersistState(fresh, { reason: 'reset' });
    ghEnsureCurrentParticipants();
    globalThis.toastr?.success?.('Greyhaven Life state reset for this chat.');
}

function ghHandleMainDialogChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.id === 'gh-life-manual-running') {
        // This checkbox only takes effect when Set manual time is pressed.
        return;
    }
}


function ghHandleMainDialogClick(event) {
    const target = event.target instanceof Element
        ? event.target.closest('button, [data-gh-edit-person]')
        : null;
    if (!target) return;

    if (target.matches('[data-gh-close]')) {
        ghClose();
        return;
    }

    if (target.matches('[data-gh-tab]')) {
        ghActiveTab = target.dataset.ghTab;
        ghRenderMainDialog();
        return;
    }

    if (target.matches('[data-gh-tab-go]')) {
        ghActiveTab = target.dataset.ghTabGo;
        ghRenderMainDialog();
        return;
    }

    if (target.matches('[data-gh-shift]')) {
        ghShiftTime(Number(target.dataset.ghShift));
        return;
    }

    if (target.matches('[data-gh-next-morning]')) {
        ghAdvanceToNextMorning();
        return;
    }

    if (target.matches('[data-gh-next-day]')) {
        ghAdvanceToNextDaySameTime();
        return;
    }

    if (target.matches('[data-gh-save-scene]')) {
        ghSetScene({
            label: document.querySelector('#gh-life-scene-label')?.value.trim() || '',
            location: document.querySelector('#gh-life-scene-location')?.value.trim() || '',
            notes: document.querySelector('#gh-life-scene-notes')?.value.trim() || '',
        });
        globalThis.toastr?.success?.('Scene updated.');
        return;
    }

    if (target.matches('[data-gh-apply-scene]')) {
        ghApplySceneLocationToCurrentParticipants();
        return;
    }

    if (target.matches('[data-gh-analyze-chat]')) {
        ghAnalyzeCurrentChat();
        return;
    }

    if (target.matches('[data-gh-mode="real"]')) {
        ghSetRealTime();
        return;
    }

    if (target.matches('[data-gh-mode="offset"]')) {
        const state = ghGetState();
        ghSetOffset(state.time.offsetMinutes || 0);
        return;
    }

    if (target.matches('[data-gh-mode="manual"]')) {
        ghSetManualTime(ghGetCurrentTime(), { running: true });
        return;
    }

    if (target.matches('[data-gh-offset-adjust]')) {
        const input = document.querySelector('#gh-life-offset-minutes');
        if (!input) return;
        input.value = String(Number(input.value || 0) + Number(target.dataset.ghOffsetAdjust || 0));
        return;
    }

    if (target.matches('[data-gh-save-offset]')) {
        ghSetOffset(Number(document.querySelector('#gh-life-offset-minutes')?.value || 0));
        return;
    }

    if (target.matches('[data-gh-save-manual]')) {
        const value = document.querySelector('#gh-life-manual-datetime')?.value;
        const running = document.querySelector('#gh-life-manual-running')?.checked ?? true;
        const date = value ? new Date(value) : null;

        if (!date || Number.isNaN(date.getTime())) {
            globalThis.toastr?.warning?.('Choose a valid manual date and time.');
            return;
        }

        ghSetManualTime(date, { running });
        return;
    }

    if (target.matches('[data-gh-use-last-message]')) {
        ghUseLatestMessageTime();
        return;
    }

    if (target.matches('[data-gh-sync-real]')) {
        ghSetRealTime();
        return;
    }

    const editPerson = target.closest('[data-gh-edit-person]');
    if (editPerson) {
        ghOpenPersonEditor(editPerson.dataset.ghEditPerson);
        return;
    }

    if (target.matches('[data-gh-schedule-person]')) {
        ghActiveTab = 'schedules';
        ghRenderMainDialog();
        return;
    }

    if (target.matches('[data-gh-toggle-presence]')) {
        const id = target.dataset.ghTogglePresence;
        const person = ghGetState()?.people?.[id];
        if (!person) return;

        const currentlyPresent = ghIsPersonPresent(person);
        ghMutate(state => {
            if (state.people[id]) {
                state.people[id].presenceMode = currentlyPresent ? 'offscreen' : 'present';
            }
        }, 'presence');
        return;
    }

    if (target.matches('[data-gh-toggle-pin]')) {
        const id = target.dataset.ghTogglePin;
        ghMutate(state => {
            if (state.people[id]) state.people[id].pinContext = !state.people[id].pinContext;
        }, 'people');
        return;
    }

    if (target.matches('[data-gh-delete-person]')) {
        const id = target.dataset.ghDeletePerson;
        const person = ghGetState()?.people?.[id];
        const name = person?.name || 'this person';

        if (person && ghIsPersonPresent(person)) {
            globalThis.toastr?.warning?.(`Mark ${name} off-screen before removing them from this chat's Life tracker.`);
            return;
        }

        if (globalThis.confirm?.(`Remove ${name} from Greyhaven Life in this chat?\n\nTheir chat-specific Life state, overrides, schedules and exceptions will be removed. Global default schedules are not deleted.`)) {
            ghDeletePerson(id);
            globalThis.toastr?.success?.(`${name} removed from this chat's Life tracker.`);
        }
        return;
    }

    if (target.matches('[data-gh-rescan]')) {
        ghEnsureCurrentParticipants();
        globalThis.toastr?.success?.('Current chat participants re-scanned.');
        return;
    }

    if (target.matches('[data-gh-add-persona]')) {
        ghAddCurrentPersona();
        return;
    }

    if (target.matches('[data-gh-add-character]')) {
        const select = document.querySelector('#gh-life-add-character');
        if (select?.value !== '') ghAddCharacterFromLibrary(Number(select.value));
        return;
    }

    if (target.matches('[data-gh-add-custom]')) {
        const input = document.querySelector('#gh-life-custom-person-name');
        if (input?.value.trim()) {
            ghAddCustomPerson(input.value.trim());
            input.value = '';
        }
        return;
    }

    if (target.matches('[data-gh-new-schedule]')) {
        ghOpenScheduleEditor(target.dataset.ghNewSchedule);
        return;
    }

    if (target.matches('[data-gh-edit-schedule]')) {
        const [personId, scheduleId] = String(target.dataset.ghEditSchedule).split('|');
        ghOpenScheduleEditor(personId, scheduleId);
        return;
    }

    if (target.matches('[data-gh-delete-schedule]')) {
        const [personId, scheduleId] = String(target.dataset.ghDeleteSchedule).split('|');
        ghMutate(state => {
            const person = state.people[personId];
            if (person) person.schedule = person.schedule.filter(entry => entry.id !== scheduleId);
        }, 'schedule');
        return;
    }

    if (target.matches('[data-gh-new-exception]')) {
        ghOpenExceptionEditor(target.dataset.ghNewException);
        return;
    }

    if (target.matches('[data-gh-edit-exception]')) {
        const [personId, exceptionId] = String(target.dataset.ghEditException).split('|');
        ghOpenExceptionEditor(personId, exceptionId);
        return;
    }

    if (target.matches('[data-gh-delete-exception]')) {
        const [personId, exceptionId] = String(target.dataset.ghDeleteException).split('|');
        ghMutate(state => {
            const person = state.people?.[personId];
            if (person) person.exceptions = (person.exceptions || []).filter(item => item.id !== exceptionId);
        }, 'exception');
        return;
    }

    if (target.matches('[data-gh-open-defaults]')) {
        const person = ghGetState()?.people?.[target.dataset.ghOpenDefaults];
        if (person) ghOpenDefaultProfileDialog(person);
        return;
    }

    if (target.matches('[data-gh-update-defaults]')) {
        const personId = target.dataset.ghUpdateDefaults;
        const person = ghGetState()?.people?.[personId];
        if (!person) return;
        if (ghMergeDefaultsIntoPerson(personId)) {
            globalThis.toastr?.success?.(`${person.name}'s linked/default schedules updated for this chat.`);
        }
        return;
    }

    if (target.matches('[data-gh-reset-defaults]')) {
        const personId = target.dataset.ghResetDefaults;
        const person = ghGetState()?.people?.[personId];
        if (!person) return;
        if (!globalThis.confirm?.(`Reset ${person.name}'s schedules in THIS chat to their global defaults?\n\nChat-only schedule edits will be replaced. Exceptions and other Life state are preserved.`)) return;
        if (ghResetPersonToDefaults(personId)) {
            globalThis.toastr?.success?.(`${person.name}'s chat schedules reset to global defaults.`);
        }
        return;
    }

    if (target.matches('[data-gh-save-as-defaults]')) {
        const personId = target.dataset.ghSaveAsDefaults;
        const person = ghGetState()?.people?.[personId];
        if (!person) return;
        if (!globalThis.confirm?.(`Save ${person.name}'s CURRENT CHAT schedules as their new GLOBAL defaults?\n\nFuture chats will copy these schedules. Other existing chats will not be changed.`)) return;
        if (ghSavePersonScheduleAsDefaults(personId)) {
            globalThis.toastr?.success?.(`${person.name}'s global default schedules updated.`);
        }
        return;
    }

    if (target.matches('[data-gh-persona-defaults]')) {
        ghOpenDefaultProfileDialog(ghDescriptorFromCurrentPersona());
        return;
    }

    if (target.matches('[data-gh-save-settings]')) {
        ghSaveSettings({
            hudEnabled: document.querySelector('#gh-life-setting-hud')?.checked ?? true,
            hudShowScene: document.querySelector('#gh-life-setting-hud-scene')?.checked ?? true,
            promptEnabled: document.querySelector('#gh-life-setting-prompt')?.checked ?? true,
            contextScope: document.querySelector('#gh-life-setting-scope')?.value || 'relevant',
            promptDepth: Math.max(0, Math.min(20, Number(document.querySelector('#gh-life-setting-depth')?.value || 1))),
            injectSceneNotes: document.querySelector('#gh-life-setting-scene-notes')?.checked ?? true,
            injectPersonNotes: document.querySelector('#gh-life-setting-person-notes')?.checked ?? false,
            autoAddParticipants: document.querySelector('#gh-life-setting-auto-add')?.checked ?? true,
            analysisMaxMessages: Math.max(10, Math.min(100, Number(document.querySelector('#gh-life-setting-analysis-messages')?.value || 50))),
            analysisCharBudget: Math.max(6000, Math.min(60000, Number(document.querySelector('#gh-life-setting-analysis-chars')?.value || 24000))),
            analysisResponseTokens: Math.max(500, Math.min(2400, Number(document.querySelector('#gh-life-setting-analysis-response')?.value || 1200))),
        });

        ghEnsureCurrentParticipants();
        globalThis.toastr?.success?.('Greyhaven Life settings saved.');
        return;
    }

    if (target.matches('[data-gh-copy-state]')) {
        ghCopyState();
        return;
    }

    if (target.matches('[data-gh-import-state]')) {
        ghImportState();
        return;
    }

    if (target.matches('[data-gh-reset-state]')) {
        ghResetState();
        return;
    }
}

function ghBuildHud() {
    if (document.querySelector('#gh-life-hud')) return;

    const hud = document.createElement('button');
    hud.type = 'button';
    hud.id = 'gh-life-hud';
    hud.innerHTML = `
        <span class="gh-life-hud-icon"><i class="fa-regular fa-clock"></i></span>
        <span class="gh-life-hud-time">--:--</span>
        <span class="gh-life-hud-scene"></span>
    `;
    hud.addEventListener('click', () => ghOpen('overview'));

    document.body.appendChild(hud);
}

function ghUpdateHud() {
    ghBuildHud();

    const hud = document.querySelector('#gh-life-hud');
    if (!hud) return;

    const settings = ghGetSettings();
    const state = ghGetState({ create: false });

    const shouldShow = settings.hudEnabled && !!state && ghHasActiveChat();
    hud.classList.toggle('gh-life-hud-visible', shouldShow);

    if (!shouldShow) return;

    const date = ghGetCurrentTime(state);
    const timeText = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);

    hud.querySelector('.gh-life-hud-time').textContent = timeText;

    const sceneEl = hud.querySelector('.gh-life-hud-scene');
    const scene = settings.hudShowScene ? (state.scene.location || state.scene.label || '') : '';
    sceneEl.textContent = scene;
    sceneEl.hidden = !scene;

    hud.title = `${ghFormatDate(date)} · ${ghTimeModeLabel(state)}`;
}

function ghBuildMenuEntry() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu || document.querySelector('#gh-life-menu-entry')) return;

    const entry = document.createElement('div');
    entry.id = 'gh-life-menu-entry';
    entry.className = 'list-group-item flex-container flexGap5 interactable';
    entry.tabIndex = 0;
    entry.innerHTML = `
        <i class="fa-solid fa-city"></i>
        <span>Greyhaven Life</span>
    `;

    const open = () => ghOpen('overview');

    entry.addEventListener('click', open);
    entry.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });

    menu.appendChild(entry);
}


function ghObserveMenu() {
    if (ghMenuObserver) return;

    const menu = document.querySelector('#extensionsMenu');
    if (!menu) return;

    let refreshQueued = false;

    ghMenuObserver = new MutationObserver(() => {
        if (refreshQueued) return;
        refreshQueued = true;

        requestAnimationFrame(() => {
            refreshQueued = false;
            ghBuildMenuEntry();
        });
    });

    // Only watch the actual extensions menu. Watching the entire document
    // subtree made every new chat message / popup mutation wake Greyhaven Life.
    ghMenuObserver.observe(menu, { childList: true });
}

function ghEmitChange(reason = 'state') {
    const detail = {
        reason,
        chatId: ghCtx()?.getCurrentChatId?.() || ghCtx()?.chatId || '',
        state: ghClone(ghGetState({ create: false })),
        time: ghGetCurrentTime().toISOString(),
    };

    for (const listener of [...ghChangeListeners]) {
        try { listener(detail); } catch (error) { console.error(error); }
    }

    window.dispatchEvent(new CustomEvent('greyhaven-life:changed', { detail }));
}

function ghSubscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    ghChangeListeners.add(listener);
    return () => ghChangeListeners.delete(listener);
}


function ghExposeApi() {
    const findPerson = nameOrId => {
        const lower = String(nameOrId || '').toLowerCase();
        return ghGetTrackedPeople().find(item =>
            item.id === nameOrId || String(item.name).toLowerCase() === lower
        ) || null;
    };

    globalThis.GreyhavenLife = {
        version: GH_VERSION,
        open: ghOpen,
        close: ghClose,

        getState: () => ghClone(ghGetState({ create: false })),
        getTime: () => new Date(ghGetCurrentTime()),
        getTimeISO: () => ghGetCurrentTime().toISOString(),
        getScene: () => ghClone(ghGetState({ create: false })?.scene || null),

        getPeople: () => ghGetTrackedPeople().map(person => ({
            ...ghClone(person),
            present: ghIsPersonPresent(person),
            resolved: ghResolvePerson(person),
        })),

        getPresentPeople: () => ghGetPresentPeople().map(person => ({
            ...ghClone(person),
            present: true,
            resolved: ghResolvePerson(person),
        })),

        getPerson: nameOrId => {
            const person = findPerson(nameOrId);
            return person
                ? {
                    ...ghClone(person),
                    present: ghIsPersonPresent(person),
                    resolved: ghResolvePerson(person),
                }
                : null;
        },

        getResolvedPerson: nameOrId => {
            const person = globalThis.GreyhavenLife.getPerson(nameOrId);
            return person?.resolved ? ghClone(person.resolved) : null;
        },

        isPresent: nameOrId => {
            const person = findPerson(nameOrId);
            return !!person && ghIsPersonPresent(person);
        },

        setPresence: (nameOrId, mode = 'present') => {
            const person = findPerson(nameOrId);
            if (!person) return false;

            const allowed = person.source === 'character'
                ? ['auto', 'present', 'offscreen']
                : ['present', 'offscreen'];

            if (!allowed.includes(mode)) return false;

            ghMutate(state => {
                if (state.people[person.id]) state.people[person.id].presenceMode = mode;
            }, 'presence');
            return true;
        },

        getMentionedPeople: () => {
            const ids = new Set(ghGetMentionedPersonIds());
            return ghGetTrackedPeople()
                .filter(person => ids.has(person.id))
                .map(person => ({
                    ...ghClone(person),
                    present: ghIsPersonPresent(person),
                    resolved: ghResolvePerson(person),
                }));
        },

        getWorldSnapshot: () => ghClone(ghGetState({ create: false })?.worldSnapshot || null),
        getWorldSnapshotStatus: () => ghClone(ghGetWorldSnapshotStatus()),
        analyzeCurrentChat: ghAnalyzeCurrentChat,

        getDefaultProfile: nameOrId => {
            const person = findPerson(nameOrId);
            if (person) return ghClone(ghGetDefaultProfile(person, { create: false }));

            const ctx = ghCtx();
            const characterIndex = ctx?.characters?.findIndex(character =>
                String(character?.name || '').toLowerCase() === String(nameOrId || '').toLowerCase()
            );
            if (Number.isInteger(characterIndex) && characterIndex >= 0) {
                return ghClone(ghGetDefaultProfile(ghDescriptorFromCharacter(characterIndex), { create: false }));
            }
            return null;
        },

        getPromptSummary: ghBuildPromptSummary,
        setScene: ghSetScene,
        setRealTime: ghSetRealTime,
        setOffsetMinutes: ghSetOffset,
        setManualTime: (value, running = true) => ghSetManualTime(new Date(value), { running }),
        shiftMinutes: ghShiftTime,
        subscribe: ghSubscribe,

        refresh: () => {
            ghEnsureCurrentParticipants();
            ghUpdateHud();
            ghUpdatePrompt();
            ghEnsureCharacterManagementButton();
            ghScheduleRender();
        },
    };
}

function ghHandleChatChanged() {
    const identity = ghChatIdentity();
    if (identity === ghCurrentChatIdentity) {
        ghUpdateHud();
        ghUpdatePrompt();
        return;
    }

    ghCurrentChatIdentity = identity;
    ghMinuteKey = '';

    if (ghHasActiveChat()) {
        ghGetState();
        ghEnsureCurrentParticipants();
    }

    ghUpdateHud();
    ghUpdatePrompt();

    const dialog = document.querySelector('#gh-life-dialog');
    if (dialog?.open) {
        ghActiveTab = 'overview';
        ghRenderMainDialog();
    }

    ghEmitChange('chat');
}


function ghBindEvents() {
    if (ghBoundEvents) return;

    const ctx = ghCtx();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;

    const bind = (key, callback) => {
        const eventName = ctx.eventTypes[key];
        if (!eventName) return;
        ctx.eventSource.on(eventName, callback);
    };

    bind('CHAT_CHANGED', () => window.setTimeout(ghHandleChatChanged, 20));
    bind('CHAT_CREATED', () => window.setTimeout(ghHandleChatChanged, 20));

    bind('GROUP_UPDATED', () => window.setTimeout(() => {
        ghEnsureCurrentParticipants();
        ghEnsureCharacterManagementButton();
        ghScheduleRender();
    }, 30));

    bind('CHARACTER_EDITED', () => window.setTimeout(() => {
        ghEnsureCurrentParticipants();
        ghEnsureCharacterManagementButton();
        ghScheduleRender();
    }, 30));

    bind('PERSONA_CHANGED', () => window.setTimeout(() => {
        ghEnsureCurrentParticipants();
        ghScheduleRender();
    }, 30));

    // Refresh authoritative world/time context immediately before generation.
    bind('GENERATION_STARTED', () => {
        ghEnsureCurrentParticipants();
        ghUpdatePrompt();
    });

    bind('MESSAGE_SENT', () => {
        ghUpdateHud();
        ghEmitChange('message');
        ghScheduleRender();
    });

    bind('CHARACTER_MESSAGE_RENDERED', () => {
        ghUpdateHud();
        ghScheduleRender();
    });

    ghBoundEvents = true;
}

function ghStartClock() {
    if (ghClockTimer) clearInterval(ghClockTimer);

    const tick = () => {
        const state = ghGetState({ create: false });
        if (!state) {
            ghUpdateHud();
            return;
        }

        const date = ghGetCurrentTime(state);
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;

        ghUpdateHud();

        if (key !== ghMinuteKey) {
            ghMinuteKey = key;
            ghUpdatePrompt();

            const dialog = document.querySelector('#gh-life-dialog');
            if (dialog?.open && ['overview', 'time'].includes(ghActiveTab)) {
                ghScheduleRender();
            }

            window.dispatchEvent(new CustomEvent('greyhaven-life:tick', {
                detail: {
                    chatId: ghCtx()?.getCurrentChatId?.() || '',
                    date: new Date(date),
                    iso: date.toISOString(),
                },
            }));
        }
    };

    tick();
    ghClockTimer = setInterval(tick, 15_000);
}

async function ghWaitForReady() {
    for (let index = 0; index < 180; index++) {
        if (
            globalThis.SillyTavern?.getContext &&
            document.body &&
            document.querySelector('#extensionsMenu')
        ) {
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false;
}


async function ghInit() {
    if (ghInitialized) return;

    const ready = await ghWaitForReady();
    if (!ready) {
        console.warn(`[${GH_MODULE}] SillyTavern did not become ready in time.`);
        return;
    }

    try {
        document.body.classList.add('gh-life-active');

        ghGetSettings();
        ghBuildMenuEntry();
        ghObserveMenu();
        ghBuildHud();
        ghBuildMainDialog();
        ghExposeApi();
        ghBindEvents();
        ghStartClock();
        ghEnsureCharacterManagementButton();

        ghHandleChatChanged();

        ghInitialized = true;

        // SillyTavern and other extensions can rebuild navigation shortly after
        // startup, so re-check our lightweight integration points.
        [250, 900, 2200].forEach(delay => {
            window.setTimeout(() => {
                ghBuildMenuEntry();
                ghEnsureCharacterManagementButton();
                ghUpdateHud();
            }, delay);
        });

        ghLog(`Greyhaven Life v${GH_VERSION} loaded.`);
    } catch (error) {
        ghInitialized = false;
        console.error(`[${GH_MODULE}] Initialization failed`, error);

        try {
            globalThis.toastr?.error?.(
                'Greyhaven Life failed to initialize. Check the browser console.'
            );
        } catch {}
    }
}

// Third-party SillyTavern extensions must self-initialize.
// v1.2.0 accidentally omitted this call, so none of its UI was created.
void ghInit().catch(error => {
    console.error(`[${GH_MODULE}] Boot failed`, error);
});

