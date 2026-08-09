const GH_MODULE = 'greyhaven-life';
const GH_VERSION = '1.0.0';
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
        return { ...GH_DEFAULT_SETTINGS };
    }

    if (!ctx.extensionSettings[GH_SETTINGS_KEY] || typeof ctx.extensionSettings[GH_SETTINGS_KEY] !== 'object') {
        ctx.extensionSettings[GH_SETTINGS_KEY] = { ...GH_DEFAULT_SETTINGS };
        ctx.saveSettingsDebounced?.();
    }

    const settings = ctx.extensionSettings[GH_SETTINGS_KEY];
    for (const [key, value] of Object.entries(GH_DEFAULT_SETTINGS)) {
        if (!(key in settings)) settings[key] = value;
    }

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
        version: 1,
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

    safe.base ||= {};
    safe.base.location ||= '';
    safe.base.status ||= '';
    safe.base.availability ||= 'unknown';
    safe.base.notes ||= '';

    safe.override ||= {};
    safe.override.enabled ??= false;
    safe.override.location ||= '';
    safe.override.status ||= '';
    safe.override.availability ||= 'inherit';
    safe.override.untilMs ??= null;

    if (!Array.isArray(safe.schedule)) safe.schedule = [];

    safe.schedule = safe.schedule.map(entry => {
        const item = entry && typeof entry === 'object' ? entry : {};
        item.id ||= ghUuid();
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
        item.notes ||= '';
        return item;
    });

    return safe;
}

function ghNormalizeState(raw) {
    const state = raw && typeof raw === 'object' ? raw : ghDefaultState();

    state.version ||= 1;
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

    for (const [id, person] of Object.entries(state.people)) {
        state.people[id] = ghNormalizePerson({ ...person, id });
    }

    state.peopleOrder = state.peopleOrder.filter(id => state.people[id]);
    for (const id of Object.keys(state.people)) {
        if (!state.peopleOrder.includes(id)) state.peopleOrder.push(id);
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

    try {
        if (ctx.chatMetadata) {
            ctx.chatMetadata[GH_META_KEY] = normalized;
        }

        // Keep compatibility with current SillyTavern helpers when available.
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
        schedule: null,
        override: null,
    };

    const schedule = ghFindActiveSchedule(person, date);
    if (schedule) {
        resolved.location = schedule.location || resolved.location;
        resolved.status = schedule.status || resolved.status;
        resolved.availability = schedule.availability || resolved.availability;
        resolved.source = 'schedule';
        resolved.sourceLabel = schedule.label || 'Schedule';
        resolved.schedule = schedule;
    }

    if (ghOverrideIsActive(person, date)) {
        const override = person.override;
        resolved.location = override.location || resolved.location;
        resolved.status = override.status || resolved.status;
        if (override.availability && override.availability !== 'inherit') {
            resolved.availability = override.availability;
        }
        resolved.source = 'override';
        resolved.sourceLabel = override.untilMs ? `Override until ${ghFormatDate(new Date(override.untilMs), { compact: true })}` : 'Current override';
        resolved.override = override;
    }

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

function ghCurrentParticipantIds() {
    const state = ghGetState({ create: false });
    const ctx = ghCtx();
    if (!state || !ctx) return [];

    const ids = new Set();

    const personaId = `persona:${String(ctx.name1 || 'User').toLowerCase()}`;
    if (state.people[personaId]) ids.add(personaId);

    if (ctx.groupId) {
        const group = ctx.groups?.find(group => String(group.id) === String(ctx.groupId));
        if (group?.members?.length) {
            const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);

            for (const memberAvatar of group.members) {
                const avatar = typeof memberAvatar === 'string' ? memberAvatar : memberAvatar?.avatar;
                if (!avatar || disabled.has(avatar)) continue;

                const character = ctx.characters?.find(item => item?.avatar === avatar);
                if (!character) continue;

                const id = ghPersonIdFromCharacter(character);
                if (state.people[id]) ids.add(id);
            }
        }
    } else if (ctx.characterId !== undefined && ctx.characterId !== null) {
        const character = ctx.characters?.[Number(ctx.characterId)];
        if (character) {
            const id = ghPersonIdFromCharacter(character);
            if (state.people[id]) ids.add(id);
        }
    }

    return [...ids];
}

function ghEnsureCurrentParticipants({ save = true } = {}) {
    const ctx = ghCtx();
    if (!ctx || !ghHasActiveChat()) return;

    const settings = ghGetSettings();
    if (!settings.autoAddParticipants) return;

    const state = ghGetState();
    let changed = false;

    const addPerson = person => {
        const normalized = ghNormalizePerson(person);
        const existing = state.people[normalized.id];

        if (!existing) {
            state.people[normalized.id] = normalized;
            state.peopleOrder.push(normalized.id);
            changed = true;
            return;
        }

        // Keep user-edited fields, but refresh identity metadata.
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

    const relevant = new Set(ghCurrentParticipantIds());
    for (const person of ghGetTrackedPeople()) {
        if (person.pinContext) relevant.add(person.id);
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

    lines.push('[Greyhaven Life — current roleplay state. Use this for continuity; do not quote this block as metadata.]');
    lines.push(`Current RP date/time: ${ghFormatDate(date)} (${ghTimeModeLabel(state)}).`);

    const sceneParts = [];
    if (state.scene.label) sceneParts.push(state.scene.label);
    if (state.scene.location) sceneParts.push(state.scene.location);

    if (sceneParts.length) {
        lines.push(`Current scene: ${sceneParts.join(' — ')}.`);
    }

    if (settings.injectSceneNotes && state.scene.notes) {
        lines.push(`Scene note: ${state.scene.notes}`);
    }

    const people = ghGetRelevantPeopleForPrompt();
    for (const person of people) {
        const resolved = ghResolvePerson(person, date);
        const fields = [];

        if (resolved.location) fields.push(`location: ${resolved.location}`);
        if (resolved.status) fields.push(`status: ${resolved.status}`);
        if (resolved.availability && resolved.availability !== 'unknown') {
            fields.push(`availability: ${ghAvailabilityLabel(resolved.availability).toLowerCase()}`);
        }
        if (resolved.source === 'schedule' && resolved.sourceLabel) {
            fields.push(`schedule: ${resolved.sourceLabel}`);
        }
        if (settings.injectPersonNotes && resolved.notes) {
            fields.push(`note: ${resolved.notes}`);
        }

        if (fields.length) {
            lines.push(`${person.name}: ${fields.join('; ')}.`);
        }
    }

    lines.push('Continuity rules: explicit events in the roleplay override this state if they conflict. Location does not imply knowledge of events elsewhere. Respect availability and schedules naturally rather than mentioning them mechanically.');

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

    const ids = ghCurrentParticipantIds();
    if (!ids.length) return;

    ghMutate(draft => {
        for (const id of ids) {
            const person = draft.people[id];
            if (!person) continue;

            person.override.enabled = true;
            person.override.location = draft.scene.location;
            person.override.untilMs = null;
        }
    }, 'people');

    globalThis.toastr?.success?.('Scene location applied to current participants.');
}

function ghAddCharacterFromLibrary(characterId) {
    const ctx = ghCtx();
    const character = ctx?.characters?.[Number(characterId)];
    if (!character) return;

    const state = ghGetState();
    const id = ghPersonIdFromCharacter(character);

    if (!state.people[id]) {
        state.people[id] = ghNormalizePerson({
            id,
            name: character.name || 'Character',
            avatar: character.avatar ? ctx.getThumbnailUrl?.('avatar', character.avatar) || '' : '',
            source: 'character',
            sourceKey: character.avatar || character.name || '',
            characterId: Number(characterId),
            pinContext: false,
        });
        state.peopleOrder.push(id);
        ghPersistState(state, { reason: 'people' });
    }
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
        });
        state.peopleOrder.push(id);
    }, 'people');
}

function ghDeletePerson(id) {
    ghMutate(state => {
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

function ghPersonAvatarHtml(person) {
    if (person.avatar) {
        return `<img class="gh-life-avatar" src="${ghEscape(person.avatar)}" alt="">`;
    }
    return `<div class="gh-life-avatar gh-life-avatar-fallback"><i class="fa-solid fa-user"></i></div>`;
}

function ghRenderOverview() {
    const state = ghGetState();
    const date = ghGetCurrentTime(state);
    const people = ghGetTrackedPeople();

    const resolvedCards = people.map(person => {
        const resolved = ghResolvePerson(person, date);

        return `
            <button type="button" class="gh-life-person-card" data-gh-edit-person="${ghEscape(person.id)}">
                ${ghPersonAvatarHtml(person)}
                <span class="gh-life-person-main">
                    <span class="gh-life-person-name">${ghEscape(person.name)}</span>
                    <span class="gh-life-person-line">
                        ${ghEscape(resolved.location || 'Location not set')}
                    </span>
                    <span class="gh-life-person-meta">
                        ${ghEscape(resolved.status || ghAvailabilityLabel(resolved.availability))}
                        ${resolved.sourceLabel ? ` · ${ghEscape(resolved.sourceLabel)}` : ''}
                    </span>
                </span>
                <span class="gh-life-availability gh-life-availability-${ghEscape(resolved.availability)}">
                    ${ghEscape(ghAvailabilityLabel(resolved.availability))}
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
                    <div class="gh-life-section-subtitle">The scene is injected into the AI context when enabled.</div>
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
                <button type="button" data-gh-apply-scene>
                    Apply location to present chat members
                </button>
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">Where is everyone?</div>
                    <div class="gh-life-section-subtitle">${people.length} tracked ${people.length === 1 ? 'person' : 'people'} in this chat timeline.</div>
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
    const currentParticipantIds = new Set(ghCurrentParticipantIds());

    const cards = people.map(person => {
        const resolved = ghResolvePerson(person, date);
        const canRemove =
            person.source === 'custom' ||
            (person.source === 'character' && !currentParticipantIds.has(person.id));

        return `
            <div class="gh-life-manage-person">
                <div class="gh-life-manage-person-top">
                    ${ghPersonAvatarHtml(person)}
                    <div class="gh-life-person-main">
                        <div class="gh-life-person-name">${ghEscape(person.name)}</div>
                        <div class="gh-life-person-line">${ghEscape(resolved.location || 'Location not set')}</div>
                        <div class="gh-life-person-meta">
                            ${ghEscape(resolved.status || ghAvailabilityLabel(resolved.availability))}
                            ${resolved.sourceLabel ? ` · ${ghEscape(resolved.sourceLabel)}` : ''}
                        </div>
                    </div>
                    <span class="gh-life-availability gh-life-availability-${ghEscape(resolved.availability)}">${ghEscape(ghAvailabilityLabel(resolved.availability))}</span>
                </div>
                <div class="gh-life-person-actions">
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

    return `
        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">People</div>
                    <div class="gh-life-section-subtitle">Only the current chat's state is changed. Other chats keep their own timeline.</div>
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
                    <strong>Pin to AI</strong> keeps someone in Greyhaven Life's AI context even when they are not a current chat participant. This is useful for an important off-screen person. Otherwise the default low-token mode only injects current participants.
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
    const state = ghGetState();
    const people = ghGetTrackedPeople();

    const sections = people.map(person => {
        const entries = [...person.schedule]
            .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

        const list = entries.map(entry => `
            <div class="gh-life-schedule-card">
                <div class="gh-life-schedule-card-main">
                    <div class="gh-life-schedule-title">${ghEscape(entry.label || 'Scheduled block')}</div>
                    <div class="gh-life-schedule-time">${ghEscape(ghDaysSummary(entry.days))} · ${ghEscape(entry.start)}–${ghEscape(entry.end)}</div>
                    <div class="gh-life-schedule-meta">
                        ${entry.location ? `<span><i class="fa-solid fa-location-dot"></i> ${ghEscape(entry.location)}</span>` : ''}
                        ${entry.status ? `<span>${ghEscape(entry.status)}</span>` : ''}
                        <span>${ghEscape(ghAvailabilityLabel(entry.availability))}</span>
                    </div>
                </div>
                <div class="gh-life-schedule-actions">
                    <button type="button" data-gh-edit-schedule="${ghEscape(person.id)}|${ghEscape(entry.id)}">Edit</button>
                    <button type="button" class="gh-life-danger-text" data-gh-delete-schedule="${ghEscape(person.id)}|${ghEscape(entry.id)}">Delete</button>
                </div>
            </div>
        `).join('');

        return `
            <div class="gh-life-schedule-person">
                <div class="gh-life-section-heading">
                    <div class="gh-life-schedule-person-heading">
                        ${ghPersonAvatarHtml(person)}
                        <div>
                            <div class="gh-life-section-title">${ghEscape(person.name)}</div>
                            <div class="gh-life-section-subtitle">${entries.length} recurring ${entries.length === 1 ? 'block' : 'blocks'}</div>
                        </div>
                    </div>
                    <button type="button" class="gh-life-small-button" data-gh-new-schedule="${ghEscape(person.id)}">+ Add</button>
                </div>
                <div class="gh-life-schedule-list">
                    ${list || `<div class="gh-life-empty">No recurring schedule yet.</div>`}
                </div>
            </div>
        `;
    }).join('');

    return `
        <section class="gh-life-section">
            <div class="gh-life-section-heading">
                <div>
                    <div class="gh-life-section-title">Recurring schedules</div>
                    <div class="gh-life-section-subtitle">Schedules resolve automatically using the roleplay clock. Temporary overrides always win.</div>
                </div>
            </div>

            <div class="gh-life-schedules">
                ${sections || `<div class="gh-life-empty">Add a person first.</div>`}
            </div>
        </section>

        <section class="gh-life-section">
            <div class="gh-life-info-box">
                <i class="fa-regular fa-moon"></i>
                <div>
                    Overnight blocks are supported. Example: Friday 22:00 → Saturday 06:00 correctly remains active after midnight.
                </div>
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
                    <small>Relevant is recommended to keep tokens low.</small>
                </span>
                <select id="gh-life-setting-scope">
                    <option value="relevant" ${settings.contextScope === 'relevant' ? 'selected' : ''}>Current chat participants + pinned people</option>
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
                <span>
                    <strong>Include scene notes</strong>
                    <small>Useful for short continuity reminders.</small>
                </span>
                <input type="checkbox" id="gh-life-setting-scene-notes" ${settings.injectSceneNotes ? 'checked' : ''}>
            </label>

            <label class="gh-life-setting-row">
                <span>
                    <strong>Include person notes</strong>
                    <small>Off by default because notes can add more tokens.</small>
                </span>
                <input type="checkbox" id="gh-life-setting-person-notes" ${settings.injectPersonNotes ? 'checked' : ''}>
            </label>

            <label class="gh-life-setting-row">
                <span>
                    <strong>Auto-add current chat participants</strong>
                    <small>Adds the active persona and current character/group members to this chat's Life state.</small>
                </span>
                <input type="checkbox" id="gh-life-setting-auto-add" ${settings.autoAddParticipants ? 'checked' : ''}>
            </label>

            <div class="gh-life-action-row">
                <button type="button" class="gh-life-primary" data-gh-save-settings>Save settings</button>
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
                <div>
                    Greyhaven Life state is stored in this chat's metadata, so normal chat branches/checkpoints can carry their own copied timeline state instead of sharing one universal world state.
                </div>
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
    const overrideUntil = person.override?.untilMs
        ? ghToDateTimeLocal(new Date(person.override.untilMs))
        : '';

    const dialog = document.createElement('dialog');
    dialog.id = 'gh-life-person-dialog';

    dialog.innerHTML = `
        <form class="gh-life-subdialog" method="dialog">
            <header class="gh-life-subdialog-header">
                <div class="gh-life-subdialog-person">
                    ${ghPersonAvatarHtml(person)}
                    <div>
                        <strong>${ghEscape(person.name)}</strong>
                        <span>Current: ${ghEscape(resolved.location || 'location not set')}</span>
                    </div>
                </div>
                <button type="button" class="gh-life-dialog-close" data-gh-person-cancel>&times;</button>
            </header>

            <div class="gh-life-subdialog-body">
                <section>
                    <div class="gh-life-section-title">Default state</div>
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
                            <div class="gh-life-section-subtitle">Temporarily override the recurring schedule.</div>
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
                    </div>
                </section>

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
        person.override = {
            enabled: false,
            location: '',
            status: '',
            availability: 'inherit',
            untilMs: null,
        };
        ghPersistState(state, { reason: 'people' });
        close();
    });

    dialog.querySelector('[data-gh-person-save]').addEventListener('click', () => {
        person.base.location = dialog.querySelector('#gh-person-base-location').value.trim();
        person.base.availability = dialog.querySelector('#gh-person-base-availability').value;
        person.base.status = dialog.querySelector('#gh-person-base-status').value.trim();
        person.base.notes = dialog.querySelector('#gh-person-base-notes').value.trim();

        person.override.enabled = dialog.querySelector('#gh-person-override-enabled').checked;
        person.override.location = dialog.querySelector('#gh-person-override-location').value.trim();
        person.override.availability = dialog.querySelector('#gh-person-override-availability').value;
        person.override.status = dialog.querySelector('#gh-person-override-status').value.trim();

        const untilValue = dialog.querySelector('#gh-person-override-until').value;
        const untilDate = untilValue ? new Date(untilValue) : null;
        person.override.untilMs = untilDate && !Number.isNaN(untilDate.getTime()) ? untilDate.getTime() : null;

        person.pinContext = dialog.querySelector('#gh-person-pin-context').checked;

        ghPersistState(state, { reason: 'people' });
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
        label: '',
        days: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '17:00',
        location: '',
        status: 'Working',
        availability: 'busy',
        priority: 0,
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
                        <span>Priority</span>
                        <input id="gh-schedule-priority" type="number" min="-100" max="100" value="${ghEscape(entry.priority)}">
                        <small>Higher wins if two blocks overlap.</small>
                    </label>

                    <label>
                        <span>Schedule note</span>
                        <input id="gh-schedule-notes" type="text" value="${ghEscape(entry.notes)}" placeholder="Optional">
                    </label>
                </div>
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

    dialog.querySelectorAll('[data-gh-schedule-cancel]').forEach(button => {
        button.addEventListener('click', close);
    });

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
            label: dialog.querySelector('#gh-schedule-label')?.value.trim() || '',
            days,
            start: dialog.querySelector('#gh-schedule-start')?.value || '09:00',
            end: dialog.querySelector('#gh-schedule-end')?.value || '17:00',
            location: dialog.querySelector('#gh-schedule-location')?.value.trim() || '',
            availability: dialog.querySelector('#gh-schedule-availability')?.value || 'busy',
            status: dialog.querySelector('#gh-schedule-status')?.value.trim() || '',
            priority: Number(dialog.querySelector('#gh-schedule-priority')?.value || 0),
            notes: dialog.querySelector('#gh-schedule-notes')?.value.trim() || '',
        };

        let saved = false;

        ghMutate(draft => {
            const currentPerson = draft.people?.[personId];
            if (!currentPerson) return;

            if (!Array.isArray(currentPerson.schedule)) {
                currentPerson.schedule = [];
            }

            const index = currentPerson.schedule.findIndex(item => item.id === savedEntry.id);
            if (index >= 0) {
                currentPerson.schedule[index] = ghClone(savedEntry);
            } else {
                currentPerson.schedule.push(ghClone(savedEntry));
            }

            saved = true;
        }, 'schedule');

        if (!saved) {
            globalThis.toastr?.error?.('Could not save this schedule. The tracked person is no longer available.');
            return;
        }

        close();

        // Force an immediate refresh after the sub-dialog disappears so the
        // newly added block is visible without switching tabs.
        window.setTimeout(() => {
            const main = document.querySelector('#gh-life-dialog');
            if (main?.open) ghRenderMainDialog();
        }, 0);

        globalThis.toastr?.success?.(
            scheduleId ? 'Schedule updated.' : 'Schedule added.'
        );
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
    const target = event.target instanceof Element ? event.target.closest('button, [data-gh-edit-person]') : null;
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
        const input = document.querySelector('#gh-life-offset-minutes');
        ghSetOffset(Number(input?.value || 0));
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
        window.setTimeout(() => {
            const card = [...document.querySelectorAll('.gh-life-schedule-person')]
                .find(element => element.textContent.includes(ghGetState()?.people?.[target.dataset.ghSchedulePerson]?.name || ''));
            card?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        }, 60);
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
        const name = ghGetState()?.people?.[id]?.name || 'this person';

        if (globalThis.confirm?.(`Remove ${name} from Greyhaven Life in this chat?\n\nTheir Life location, status, overrides, and schedules for this chat will be removed. You can add them again later.`)) {
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

    if (target.matches('[data-gh-add-character]')) {
        const select = document.querySelector('#gh-life-add-character');
        if (select?.value !== '') {
            ghAddCharacterFromLibrary(Number(select.value));
        }
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
            if (!person) return;
            person.schedule = person.schedule.filter(entry => entry.id !== scheduleId);
        }, 'schedule');
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

    ghMenuObserver = new MutationObserver(() => {
        ghBuildMenuEntry();
    });

    ghMenuObserver.observe(document.body, { childList: true, subtree: true });
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
            resolved: ghResolvePerson(person),
        })),
        getPerson: nameOrId => {
            const lower = String(nameOrId || '').toLowerCase();
            const person = ghGetTrackedPeople().find(item =>
                item.id === nameOrId || String(item.name).toLowerCase() === lower
            );
            return person ? { ...ghClone(person), resolved: ghResolvePerson(person) } : null;
        },
        getResolvedPerson: nameOrId => {
            const person = globalThis.GreyhavenLife.getPerson(nameOrId);
            return person?.resolved ? ghClone(person.resolved) : null;
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
        ghScheduleRender();
    }, 30));
    bind('CHARACTER_EDITED', () => window.setTimeout(() => {
        ghEnsureCurrentParticipants();
        ghScheduleRender();
    }, 30));
    bind('PERSONA_CHANGED', () => window.setTimeout(() => {
        ghEnsureCurrentParticipants();
        ghScheduleRender();
    }, 30));

    // Generation starts before SillyTavern assembles the prompt, so refresh the
    // roleplay time/state here without making any extra model request.
    bind('GENERATION_STARTED', () => {
        ghEnsureCurrentParticipants();
        ghUpdatePrompt();
    });

    bind('MESSAGE_SENT', () => {
        ghUpdateHud();
        ghEmitChange('message');
    });

    bind('CHARACTER_MESSAGE_RENDERED', () => {
        ghUpdateHud();
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

    ghInitialized = true;
    document.body.classList.add('gh-life-active');

    ghGetSettings();
    ghBuildMenuEntry();
    ghObserveMenu();
    ghBuildHud();
    ghBuildMainDialog();
    ghExposeApi();
    ghBindEvents();
    ghStartClock();

    ghHandleChatChanged();

    // Some extensions rebuild their menus shortly after startup.
    [250, 900, 2200].forEach(delay => {
        window.setTimeout(() => {
            ghBuildMenuEntry();
            ghUpdateHud();
        }, delay);
    });

    ghLog(`Greyhaven Life v${GH_VERSION} loaded.`);
}

ghInit();
