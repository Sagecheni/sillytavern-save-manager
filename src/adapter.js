/**
 * 数据与存储适配层 (Adapter)
 * 自动兼容：
 * 1. 真实 SillyTavern 环境（通过 SillyTavern.getContext() + /api/characters/chats + /api/chats/get）
 * 2. 本地 Mock 预览环境（preview.html 离线调试）
 *
 * 性能设计：
 * - 全局列表仅并发受限拉取轻量摘要（/api/characters/chats）
 * - 点击具体角色时才按需拉取聊天详情，并将每层消息哈希与摘要缓存到 IndexedDB
 * - 备注、星标与标签存储在 SillyTavern extensionSettings 中，跨设备/浏览器漫游同步
 */

import { MOCK_CHARACTERS, MOCK_CHATS_BY_AVATAR, MOCK_DEFAULT_METADATA } from './mockData.js';

const EXTENSION_KEY = 'save_branch_manager';
const LOCAL_META_KEY = 'st_save_branch_manager_meta_v1';
const IDB_NAME = 'st_save_branch_manager_cache_v1';
const IDB_VERSION = 2;
const IDB_STORE = 'chat_digests';
const DIGEST_SCHEMA_VERSION = 'v2';
const DEFAULT_SUMMARY_CACHE_TTL_MS = 15 * 1000;
const DEFAULT_DIGEST_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SWITCH_VERIFY_TIMEOUT_MS = 600;
const DEFAULT_SWITCH_POLL_INTERVAL_MS = 40;

export function stripJsonl(fileName = '') {
  return String(fileName).replace(/\.jsonl$/i, '').trim();
}

/**
 * 兼容解析 SillyTavern 各类时间格式：
 * - ISO / RFC2822 / Unix 时间戳
 * - SillyTavern 默认格式：2026-11-23@18h20m12s / 2026-11-23 @18h 20m 12s 345ms
 * - moment.js 格式：November 23, 2026 6:20pm / 2026年11月23日 18:20
 */
export function parseSillyTavernTimestamp(input) {
  if (input === null || input === undefined || input === '') return NaN;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : NaN;
  }
  const str = String(input).trim();
  if (!str) return NaN;

  if (/^\d{10,13}$/.test(str)) {
    const num = Number(str);
    return str.length === 10 ? num * 1000 : num;
  }

  const stMatch = str.match(
    /(\d{4}-\d{2}-\d{2})\s*[@_T ]\s*(\d{1,2})h\s*(\d{1,2})m(?:\s*(\d{1,2})s)?(?:\s*(\d{1,3})ms)?/i
  );
  if (stMatch) {
    const [, datePart, hh, mm, ss = '00', ms = '000'] = stMatch;
    const iso = `${datePart}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}.${ms.padStart(3, '0')}`;
    const ts = Date.parse(iso);
    if (!Number.isNaN(ts)) return ts;
  }

  const zhMatch = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (zhMatch) {
    const [, y, mo, d, hh, mm, ss = '00'] = zhMatch;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}`;
    const ts = Date.parse(iso);
    if (!Number.isNaN(ts)) return ts;
  }

  const normalizedAmPm = str.replace(/(\d{1,2}:\d{2}(?::\d{2})?)\s*([ap]m)\b/i, '$1 $2');
  const direct = Date.parse(normalizedAmPm);
  if (!Number.isNaN(direct)) return direct;

  return NaN;
}

/**
 * 兼容解析 /api/chats/get 返回结果（支持 JSON 数组或逐行 JSONL 文本）
 */
export function parseChatResponsePayload(rawText = '') {
  const trimmed = String(rawText).trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.chat)) return parsed.chat;
  } catch {
    // 回退按 JSONL 逐行解析
  }
  const lines = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      lines.push(JSON.parse(s));
    } catch {
      // 忽略损坏单行
    }
  }
  return lines;
}

function quickTextHash(str = '') {
  const normalized = String(str).replace(/\s+/g, ' ').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + ((i & 0xff) << 1);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}_${normalized.length}`;
}

/**
 * 将原始聊天记录压缩为轻量楼层摘要（避免在 IndexedDB 中存储几十 MB 的完整正文与 swipes）
 */
export function compactChatLines(rawLines = []) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { header: {}, floors: [] };
  }

  let header = {};
  let startIndex = 0;
  const first = rawLines[0];
  if (first && typeof first === 'object' && first.mes === undefined && (first.chat_metadata || first.user_name || first.character_name)) {
    header = {
      user_name: first.user_name || '',
      character_name: first.character_name || '',
      create_date: first.create_date || '',
      chat_metadata: first.chat_metadata || {},
    };
    startIndex = 1;
  }

  const floors = [];
  for (let i = startIndex; i < rawLines.length; i++) {
    const item = rawLines[i];
    if (!item || typeof item !== 'object') continue;
    const rawMes = String(item.mes ?? '');
    const cleanMes = rawMes.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    floors.push({
      floor: floors.length + 1,
      name: item.name || (item.is_user ? '你' : '角色'),
      isUser: Boolean(item.is_user),
      isSystem: Boolean(item.is_system),
      sendDate: item.send_date || '',
      // 使用完整正文计算 64 位双哈希 + 长度，避免长消息在 240 字后分叉被误判为相同
      hash: quickTextHash(`${Boolean(item.is_user)}|${Boolean(item.is_system)}|${rawMes}`),
      snippet: cleanMes.slice(0, 140),
      bookmarkLink: item.extra?.bookmark_link ? stripJsonl(item.extra.bookmark_link) : '',
    });
  }

  return { header, floors };
}

class IndexedDbDigestCache {
  constructor() {
    this.dbPromise = null;
  }

  open() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'cacheKey' });
          } else if (event.oldVersion < IDB_VERSION) {
            req.transaction.objectStore(IDB_STORE).clear();
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async get(cacheKey, fingerprint, maxAgeMs = DEFAULT_DIGEST_CACHE_TTL_MS) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(cacheKey);
        req.onsuccess = () => {
          const record = req.result;
          const isFresh =
            typeof maxAgeMs !== 'number' ||
            maxAgeMs <= 0 ||
            (typeof record?.savedAt === 'number' && Date.now() - record.savedAt < maxAgeMs);
          if (record && record.fingerprint === fingerprint && record.digest && isFresh) {
            resolve(record.digest);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async set(cacheKey, fingerprint, digest) {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({
          cacheKey,
          fingerprint,
          digest,
          savedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async delete(cacheKey) {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(cacheKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async clearAll() {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export class SaveManagerAdapter {
  constructor(options = {}) {
    this.digestCache = new IndexedDbDigestCache();
    this.summaryCache = new Map();
    this.dirtyDigestKeys = new Set();
    this.digestInvalidationVersion = new Map();
    this.lastKnownActiveChatByAvatar = new Map();
    this.summaryCacheTtlMs = options.summaryCacheTtlMs ?? DEFAULT_SUMMARY_CACHE_TTL_MS;
    this.digestCacheTtlMs = options.digestCacheTtlMs ?? DEFAULT_DIGEST_CACHE_TTL_MS;
    this.switchVerifyTimeoutMs = options.switchVerifyTimeoutMs ?? DEFAULT_SWITCH_VERIFY_TIMEOUT_MS;
    this.switchPollIntervalMs = options.switchPollIntervalMs ?? DEFAULT_SWITCH_POLL_INTERVAL_MS;
    this.eventsBound = false;
    this.lastObservedActiveChat = null;
    this.coreScriptModule = null;
    this.mockCharacters = structuredClone(MOCK_CHARACTERS);
    this.mockActiveCharId = 0;
    this.onMockSwitchCallbacks = [];
  }

  getActiveCharacterChatRef(ctx = this.getContext()) {
    if (!ctx || ctx.groupId || !Array.isArray(ctx.characters)) return null;
    if (ctx.characterId === undefined || ctx.characterId === null || ctx.characterId === '') return null;
    const idx = Number(ctx.characterId);
    if (Number.isNaN(idx) || idx < 0 || idx >= ctx.characters.length) return null;
    const ch = ctx.characters[idx];
    if (!ch?.avatar) return null;
    const chatId = stripJsonl(ctx.chatId || ch.chat || '');
    return { avatar: ch.avatar, chatId };
  }

  invalidateCharacterCache(avatar) {
    if (!avatar) return;
    this.summaryCache.delete(avatar);
  }

  invalidateChatCache(avatar, chatId) {
    if (!avatar) return;
    this.summaryCache.delete(avatar);
    const cleanChatId = stripJsonl(chatId || '');
    if (!cleanChatId) return;
    const cacheKey = `${avatar}::${cleanChatId}`;
    this.dirtyDigestKeys.add(cacheKey);
    this.digestInvalidationVersion.set(cacheKey, (this.digestInvalidationVersion.get(cacheKey) || 0) + 1);
    void this.digestCache.delete(cacheKey);
  }

  /**
   * 监听 SillyTavern 聊天与消息生命周期事件，及时失效被编辑或切换的存档缓存
   */
  bindSillyTavernEvents() {
    if (this.eventsBound) return false;
    const ctx = this.getContext();
    const eventSource = ctx?.eventSource;
    const eventTypes = ctx?.event_types;
    if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) return false;

    this.lastObservedActiveChat = this.getActiveCharacterChatRef(ctx);

    const invalidateActive = () => {
      const current = this.getActiveCharacterChatRef();
      if (this.lastObservedActiveChat) {
        this.invalidateChatCache(this.lastObservedActiveChat.avatar, this.lastObservedActiveChat.chatId);
      }
      if (current) {
        this.invalidateChatCache(current.avatar, current.chatId);
        this.lastObservedActiveChat = current;
      }
    };

    const eventNames = [
      'CHAT_CHANGED',
      'CHAT_CREATED',
      'CHAT_DELETED',
      'MESSAGE_SENT',
      'MESSAGE_RECEIVED',
      'MESSAGE_EDITED',
      'MESSAGE_SWIPED',
      'MESSAGE_DELETED',
      'CHARACTER_EDITED',
    ];

    for (const name of eventNames) {
      const evt = eventTypes[name];
      if (evt) {
        eventSource.on(evt, invalidateActive);
      }
    }

    this.eventsBound = true;
    return true;
  }

  isSillyTavern() {
    return Boolean(typeof window !== 'undefined' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function');
  }

  getContext() {
    return this.isSillyTavern() ? window.SillyTavern.getContext() : null;
  }

  async getCoreScriptFunctions() {
    const ctx = this.getContext();
    const resolved = {
      getRequestHeaders: ctx?.getRequestHeaders || window.getRequestHeaders || null,
      selectCharacterById: ctx?.selectCharacterById || window.selectCharacterById || null,
      openCharacterChat: ctx?.openCharacterChat || window.openCharacterChat || null,
    };

    if ((!resolved.selectCharacterById || !resolved.openCharacterChat || !resolved.getRequestHeaders) && this.isSillyTavern()) {
      if (!this.coreScriptModule) {
        const candidates = [];
        const metaUrl = typeof import.meta !== 'undefined' && import.meta.url ? import.meta.url : '';
        const extMarker = '/scripts/extensions/';
        const markerIdx = metaUrl.indexOf(extMarker);
        if (markerIdx !== -1) {
          candidates.push(`${metaUrl.slice(0, markerIdx)}/script.js`);
        }
        // 兼容 third-party/<ext>/src/ (5层) 与 extensions/<ext>/src/ (4层)
        candidates.push('../../../../../script.js', '../../../../script.js');

        for (const scriptPath of candidates) {
          try {
            this.coreScriptModule = await import(/* @vite-ignore */ scriptPath);
            if (this.coreScriptModule) break;
          } catch {
            // 继续尝试下一个候选路径
          }
        }
        if (!this.coreScriptModule) {
          this.coreScriptModule = {};
        }
      }
      resolved.getRequestHeaders = resolved.getRequestHeaders || this.coreScriptModule.getRequestHeaders;
      resolved.selectCharacterById = resolved.selectCharacterById || this.coreScriptModule.selectCharacterById;
      resolved.openCharacterChat = resolved.openCharacterChat || this.coreScriptModule.openCharacterChat;
    }

    return resolved;
  }

  async buildHeaders() {
    const { getRequestHeaders } = await this.getCoreScriptFunctions();
    const base = typeof getRequestHeaders === 'function' ? getRequestHeaders() : {};
    return {
      'Content-Type': 'application/json',
      ...base,
    };
  }

  /**
   * 获取所有用户自定义的备注、星标、标签字典
   */
  getAllMetadata() {
    const ctx = this.getContext();
    if (ctx && ctx.extensionSettings) {
      if (!ctx.extensionSettings[EXTENSION_KEY]) {
        ctx.extensionSettings[EXTENSION_KEY] = { items: {} };
      }
      return ctx.extensionSettings[EXTENSION_KEY].items || {};
    }

    try {
      const raw = localStorage.getItem(LOCAL_META_KEY);
      if (raw) return JSON.parse(raw);
      localStorage.setItem(LOCAL_META_KEY, JSON.stringify(MOCK_DEFAULT_METADATA));
      return structuredClone(MOCK_DEFAULT_METADATA);
    } catch {
      return structuredClone(MOCK_DEFAULT_METADATA);
    }
  }

  getSaveMeta(avatar, chatId) {
    const all = this.getAllMetadata();
    const key = `${avatar}::${stripJsonl(chatId)}`;
    const entry = all[key] || {};
    return {
      starred: Boolean(entry.starred),
      customTitle: entry.customTitle || '',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      note: entry.note || '',
      updatedAt: entry.updatedAt || '',
    };
  }

  updateSaveMeta(avatar, chatId, patch) {
    const key = `${avatar}::${stripJsonl(chatId)}`;
    const current = this.getSaveMeta(avatar, chatId);
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    const ctx = this.getContext();
    if (ctx && ctx.extensionSettings) {
      if (!ctx.extensionSettings[EXTENSION_KEY]) {
        ctx.extensionSettings[EXTENSION_KEY] = { items: {} };
      }
      ctx.extensionSettings[EXTENSION_KEY].items[key] = next;
      if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
      }
      return next;
    }

    try {
      const all = this.getAllMetadata();
      all[key] = next;
      localStorage.setItem(LOCAL_META_KEY, JSON.stringify(all));
    } catch {
      // ignore storage errors
    }
    return next;
  }

  /**
   * 获取所有角色卡基础信息
   */
  getCharacters() {
    const ctx = this.getContext();
    if (ctx && Array.isArray(ctx.characters)) {
      const hasActiveChar = ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '';
      const activeIdx = hasActiveChar ? Number(ctx.characterId) : -1;
      return ctx.characters.map((ch, idx) => {
        const rawAvatarUrl = ch.avatar ? `characters/${encodeURIComponent(ch.avatar)}` : '';
        const thumbUrl = ch.avatar
          ? typeof ctx.getThumbnailUrl === 'function'
            ? ctx.getThumbnailUrl('avatar', ch.avatar)
            : `thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}`
          : '';
        return {
          id: idx,
          name: ch.name || stripJsonl(ch.avatar),
          avatar: ch.avatar,
          avatarSrc: thumbUrl || rawAvatarUrl,
          avatarFallbackSrc: rawAvatarUrl,
          description: ch.description ? String(ch.description).slice(0, 80) : '',
          activeChatId: stripJsonl(ch.chat || ''),
          isCurrentCharacter: idx === activeIdx && !ctx.groupId,
        };
      });
    }

    return this.mockCharacters.map((ch, idx) => ({
      id: idx,
      name: ch.name,
      avatar: ch.avatar,
      avatarSrc: ch.avatarSrc,
      description: ch.description,
      activeChatId: stripJsonl(ch.chat),
      isCurrentCharacter: idx === this.mockActiveCharId,
    }));
  }

  /**
   * 获取指定角色的轻量存档摘要列表（带 TTL 过期机制）
   */
  async getCharacterChatSummaries(character, forceRefresh = false) {
    const cached = this.summaryCache.get(character.avatar);
    const isFresh =
      cached &&
      typeof this.summaryCacheTtlMs === 'number' &&
      this.summaryCacheTtlMs > 0 &&
      Date.now() - cached.fetchedAt < this.summaryCacheTtlMs;

    if (!forceRefresh && isFresh) {
      return cached.data;
    }

    if (!this.isSillyTavern()) {
      const mockFiles = MOCK_CHATS_BY_AVATAR[character.avatar] || [];
      const summaries = mockFiles.map((f) => {
        const chatId = stripJsonl(f.file_name);
        const msgLines = f.lines.slice(1);
        const lastLine = msgLines[msgLines.length - 1];
        return {
          chatId,
          fileName: f.file_name,
          fileSize: f.file_size || '',
          messageCount: msgLines.length,
          lastModified: f.last_mes || '',
          previewText: lastLine ? String(lastLine.mes).slice(0, 120) : '',
        };
      });
      this.summaryCache.set(character.avatar, { data: summaries, fetchedAt: Date.now() });
      return summaries;
    }

    const headers = await this.buildHeaders();
    const res = await fetch('api/characters/chats', {
      method: 'POST',
      headers,
      body: JSON.stringify({ avatar_url: character.avatar }),
    });

    if (!res.ok) {
      throw new Error(`获取角色存档列表失败 (${res.status})`);
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : Object.values(data || {});
    const summaries = list
      .filter((item) => item && item.file_name)
      .map((item) => {
        const chatId = stripJsonl(item.file_name);
        return {
          chatId,
          fileName: item.file_name,
          fileSize: item.file_size || '',
          messageCount: Number(item.chat_items ?? item.mes_count ?? 0),
          lastModified: item.last_mes || '',
          previewText: item.mes ? String(item.mes).replace(/<[^>]*>/g, ' ').trim().slice(0, 120) : '',
          rawLastMesHash: item.mes ? quickTextHash(String(item.mes)) : '',
        };
      });

    this.summaryCache.set(character.avatar, { data: summaries, fetchedAt: Date.now() });
    return summaries;
  }

  /**
   * 并发受限地加载全部角色的存档汇总统计（防止角色过多打爆 NAS/远程后端）
   */
  async loadGlobalOverview({ forceRefresh = false, concurrency = 5, onProgress = null } = {}) {
    if (forceRefresh) {
      this.summaryCache.clear();
    }

    const characters = this.getCharacters();
    const results = new Array(characters.length);
    let completed = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < characters.length) {
        const index = cursor++;
        const ch = characters[index];
        let summaries = [];
        try {
          summaries = await this.getCharacterChatSummaries(ch, forceRefresh);
        } catch (err) {
          console.warn(`[SaveManager] 获取 ${ch.name} 存档失败:`, err);
        }

        let starredCount = 0;
        let notedCount = 0;
        let latestTime = 0;

        const enrichedSaves = summaries.map((s) => {
          const meta = this.getSaveMeta(ch.avatar, s.chatId);
          if (meta.starred) starredCount += 1;
          if (meta.note || meta.tags.length > 0) notedCount += 1;
          const ts = parseSillyTavernTimestamp(s.lastModified) || 0;
          if (ts > latestTime) latestTime = ts;
          return { ...s, meta };
        });

        results[index] = {
          ...ch,
          saves: enrichedSaves,
          saveCount: enrichedSaves.length,
          starredCount,
          notedCount,
          latestTimestamp: latestTime,
        };

        completed += 1;
        if (typeof onProgress === 'function') {
          onProgress(completed, characters.length);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, characters.length)) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /**
   * 获取指定角色下所有存档的紧凑楼层摘要（优先命中 IndexedDB 缓存；活跃存档、脏标记存档及超时缓存强制回源校验）
   */
  async getCharacterChatDigests(character, summaries, forceRefresh = false) {
    if (!this.isSillyTavern()) {
      const mockFiles = MOCK_CHATS_BY_AVATAR[character.avatar] || [];
      return summaries.map((summary) => {
        const found = mockFiles.find((f) => stripJsonl(f.file_name) === summary.chatId);
        const digest = compactChatLines(found ? found.lines : []);
        return {
          ...summary,
          meta: this.getSaveMeta(character.avatar, summary.chatId),
          header: digest.header,
          floors: digest.floors,
          messageCount: digest.floors.length || summary.messageCount,
        };
      });
    }

    const headers = await this.buildHeaders();
    const activeRef = this.getActiveCharacterChatRef();
    const characterActiveChatId = stripJsonl(character.activeChatId || '');
    const liveActiveChatId = activeRef && activeRef.avatar === character.avatar ? activeRef.chatId : '';
    const observedActive = liveActiveChatId || characterActiveChatId;
    const prevKnownActive = this.lastKnownActiveChatByAvatar.get(character.avatar) || '';
    if (prevKnownActive && observedActive && prevKnownActive !== observedActive) {
      this.invalidateChatCache(character.avatar, prevKnownActive);
    }
    if (observedActive) {
      this.lastKnownActiveChatByAvatar.set(character.avatar, observedActive);
    }
    const digests = new Array(summaries.length);
    const concurrency = Math.min(4, Math.max(1, summaries.length));
    let cursor = 0;

    const worker = async () => {
      while (cursor < summaries.length) {
        const idx = cursor++;
        const summary = summaries[idx];
        const cleanChatId = stripJsonl(summary.chatId);
        const cacheKey = `${character.avatar}::${cleanChatId}`;
        const previewSig = summary.rawLastMesHash || quickTextHash(summary.previewText || '');
        const fingerprint = `${DIGEST_SCHEMA_VERSION}|${summary.lastModified}|${summary.fileSize}|${summary.messageCount}|${previewSig}`;

        // 活跃存档和已收到编辑/切换事件的脏存档绕过本地缓存，避免等长编辑早期消息导致读到旧摘要
        const isActiveChat =
          (characterActiveChatId && cleanChatId === characterActiveChatId) ||
          (liveActiveChatId && cleanChatId === liveActiveChatId);
        const isDirty = this.dirtyDigestKeys.has(cacheKey);
        const shouldBypassCache = forceRefresh || isActiveChat || isDirty;

        let digest = !shouldBypassCache
          ? await this.digestCache.get(cacheKey, fingerprint, this.digestCacheTtlMs)
          : null;

        if (!digest) {
          const versionBeforeFetch = this.digestInvalidationVersion.get(cacheKey) || 0;
          try {
            const res = await fetch('api/chats/get', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                ch_name: character.name,
                file_name: cleanChatId,
                avatar_url: character.avatar,
              }),
              cache: 'no-cache',
            });

            if (res.ok) {
              const rawText = await res.text();
              const rawLines = parseChatResponsePayload(rawText);
              digest = compactChatLines(rawLines);
              // 防止请求在途期间发生的编辑事件被旧响应覆盖：仅当失效版本号未变化时才清理脏标记并写回缓存
              if ((this.digestInvalidationVersion.get(cacheKey) || 0) === versionBeforeFetch) {
                this.dirtyDigestKeys.delete(cacheKey);
                await this.digestCache.set(cacheKey, fingerprint, digest);
              }
            } else {
              digest = { header: {}, floors: [] };
            }
          } catch (err) {
            console.warn(`[SaveManager] 拉取存档 ${cleanChatId} 失败:`, err);
            digest = { header: {}, floors: [] };
          }
        }

        digests[idx] = {
          ...summary,
          meta: this.getSaveMeta(character.avatar, cleanChatId),
          header: digest.header,
          floors: digest.floors,
          messageCount: digest.floors.length || summary.messageCount,
        };
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return digests;
  }

  async clearDigestCache() {
    this.summaryCache.clear();
    this.dirtyDigestKeys.clear();
    await this.digestCache.clearAll();
  }

  onMockStateChange(cb) {
    this.onMockSwitchCallbacks.push(cb);
  }

  getMockCurrentChatLines() {
    const ch = this.mockCharacters[this.mockActiveCharId];
    if (!ch) return { character: null, chatId: '', lines: [] };
    const list = MOCK_CHATS_BY_AVATAR[ch.avatar] || [];
    const found = list.find((f) => stripJsonl(f.file_name) === stripJsonl(ch.chat)) || list[0];
    return {
      character: ch,
      chatId: found ? stripJsonl(found.file_name) : '',
      lines: found ? found.lines.slice(1) : [],
    };
  }

  async waitForCondition(predicate, { timeoutMs = this.switchVerifyTimeoutMs, intervalMs = this.switchPollIntervalMs } = {}) {
    if (predicate()) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, intervalMs)));
      if (predicate()) return true;
    }
    return Boolean(predicate());
  }

  /**
   * 跨角色一键切换存档
   */
  async jumpToSave(character, chatId) {
    const targetChatId = stripJsonl(chatId);

    if (!this.isSillyTavern()) {
      const idx = this.mockCharacters.findIndex((c) => c.avatar === character.avatar);
      if (idx >= 0) {
        this.mockActiveCharId = idx;
        this.mockCharacters[idx].chat = targetChatId;
      }
      for (const cb of this.onMockSwitchCallbacks) {
        cb(this.getMockCurrentChatLines());
      }
      return true;
    }

    const ctx = this.getContext();
    const { selectCharacterById, openCharacterChat } = await this.getCoreScriptFunctions();

    let targetCharId = Number(character.id);
    if (Array.isArray(ctx?.characters) && character.avatar) {
      const liveIdx = ctx.characters.findIndex((c) => c && c.avatar === character.avatar);
      if (liveIdx >= 0) {
        targetCharId = liveIdx;
      }
    }

    const isTargetCharacterActive = (context) => {
      if (!context || context.groupId) return false;
      if (context.characterId === undefined || context.characterId === null || context.characterId === '') {
        return false;
      }
      const activeIdx = Number(context.characterId);
      if (Number.isNaN(activeIdx) || activeIdx !== targetCharId) return false;
      if (character.avatar && Array.isArray(context.characters)) {
        const activeChar = context.characters[activeIdx];
        if (activeChar?.avatar && activeChar.avatar !== character.avatar) return false;
      }
      return true;
    };

    if (!isTargetCharacterActive(ctx)) {
      if (typeof selectCharacterById !== 'function') {
        throw new Error('未找到 SillyTavern 的 selectCharacterById 方法，请检查酒馆版本');
      }
      await selectCharacterById(String(targetCharId));
      const switched = await this.waitForCondition(() => isTargetCharacterActive(this.getContext()));
      if (!switched) {
        throw new Error(
          `未能切换到角色「${character.name || character.avatar}」，酒馆可能正忙于生成回复或保存聊天，已中止打开存档`
        );
      }
    }

    const refreshedCtx = this.getContext();
    if (!isTargetCharacterActive(refreshedCtx)) {
      throw new Error(`角色上下文与目标「${character.name || character.avatar}」不一致，已中止打开存档`);
    }

    const activeChatNow = stripJsonl(refreshedCtx?.chatId || refreshedCtx?.characters?.[targetCharId]?.chat || '');
    if (activeChatNow !== targetChatId) {
      if (typeof openCharacterChat === 'function') {
        await openCharacterChat(targetChatId);
      } else if (refreshedCtx?.SlashCommandParser?.commands?.['open-chat']) {
        await refreshedCtx.executeSlashCommandsWithOptions(`/open-chat ${targetChatId}`);
      } else {
        throw new Error('未找到 SillyTavern 的 openCharacterChat 方法');
      }

      const afterCtx = this.getContext();
      if (!isTargetCharacterActive(afterCtx)) {
        throw new Error('切换存档期间角色上下文发生变化，未能确认切换成功');
      }
      const switchedChat = stripJsonl(afterCtx?.chatId || afterCtx?.characters?.[targetCharId]?.chat || '');
      if (switchedChat && switchedChat !== targetChatId) {
        throw new Error(`酒馆未能打开存档「${targetChatId}」，可能正忙于生成回复或保存聊天，请稍后重试`);
      }
    }

    this.invalidateChatCache(character.avatar, targetChatId);
    return true;
  }
}
