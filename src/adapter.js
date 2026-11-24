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
const IDB_VERSION = 6;
const IDB_STORE = 'chat_digests';
const IDB_SUMMARY_STORE = 'character_summaries';
const DIGEST_SCHEMA_VERSION = 'v5';
const SUMMARY_SCHEMA_VERSION = 'v1';
const DEFAULT_SUMMARY_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_DIGEST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWITCH_VERIFY_TIMEOUT_MS = 600;
const DEFAULT_SWITCH_POLL_INTERVAL_MS = 40;

function normalizeSaveMeta(entry = {}) {
  return {
    starred: Boolean(entry?.starred),
    customTitle: entry?.customTitle || '',
    tags: Array.isArray(entry?.tags) ? entry.tags : [],
    note: entry?.note || '',
    updatedAt: entry?.updatedAt || '',
  };
}

export function stripJsonl(fileName = '') {
  return String(fileName).replace(/\.jsonl$/i, '').trim();
}

export function formatFileSize(size) {
  if (size === null || size === undefined || size === '') return '';
  if (typeof size === 'string') {
    const trimmed = size.trim();
    if (!trimmed) return '';
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
    size = Number(trimmed);
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
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
    if (!Number.isFinite(input)) return NaN;
    return input >= 1e9 && input < 1e11 ? input * 1000 : input;
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
 * TauriTavern 严格 JSON 数组解析器（对应 ChatPayload §1.1：首个非空记录按位置为 header，
 * header 与后续消息均须为 JSON object，无记录数组 [] 为合法空聊天，读取不跳过坏记录）
 */
export function parseTauriChatPayload(rawText = '') {
  const cleaned = String(rawText).replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    throw new Error('聊天响应为空');
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`聊天 JSON 解析失败: ${err?.message || err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('聊天响应不是有效的 JSON 数组');
  }
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`聊天第 ${i} 条记录不是有效的 JSON 对象`);
    }
  }
  return parsed;
}

/**
 * 兼容解析 /api/chats/get 返回结果（支持 JSON 数组或逐行 JSONL 文本）
 */
export function parseChatResponsePayload(rawText = '') {
  const trimmed = String(rawText).replace(/^\uFEFF/, '').trim();
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

function hashString64(str = '') {
  const text = String(str);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + ((i & 0xff) << 1);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}_${text.length}`;
}

function quickTextHash(str = '') {
  const normalized = String(str).replace(/\s+/g, ' ').trim();
  return hashString64(normalized);
}

function quickExactHash(str = '') {
  return hashString64(String(str));
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) {
        Object.defineProperty(out, key, {
          value: canonicalizeJsonValue(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  return value;
}

/**
 * 将原始聊天记录压缩为轻量楼层摘要（避免在 IndexedDB 中存储几十 MB 的完整正文与 swipes）
 */
export function compactChatLines(rawLines = [], { strictHeader = false, skipHeaderDetection = false } = {}) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { header: {}, floors: [] };
  }

  let header = {};
  let startIndex = 0;
  const first = rawLines[0];
  const isPlainFirst = Boolean(first && typeof first === 'object' && !Array.isArray(first));
  const isHeaderLine =
    !skipHeaderDetection &&
    isPlainFirst &&
    (strictHeader ||
      (first.mes === undefined &&
        (first.chat_metadata ||
          first.user_name ||
          first.character_name ||
          first.create_date ||
          (first.is_user === undefined &&
            first.role === undefined &&
            first.tool_call_id === undefined &&
            !Array.isArray(first.tool_calls)))));
  if (isHeaderLine) {
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
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rawMes = String(item.mes ?? '');
    const cleanMes = rawMes.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const role = typeof item.role === 'string' ? item.role : '';
    const toolCallId = typeof item.tool_call_id === 'string' ? item.tool_call_id : '';
    const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    const legacyToolInvocations =
      Array.isArray(item.extra?.tool_invocations) && item.extra.tool_invocations.length > 0
        ? item.extra.tool_invocations
        : null;
    const hasToolProtocol = Boolean(role || toolCallId || toolCalls.length > 0 || legacyToolInvocations);
    const toolNames =
      toolCalls.length > 0
        ? toolCalls
            .map((tc) => tc?.function?.name || tc?.name)
            .filter(Boolean)
            .join(', ')
        : legacyToolInvocations
        ? legacyToolInvocations
            .map((inv) => inv?.name || inv?.function?.name)
            .filter(Boolean)
            .join(', ')
        : '';
    const displaySnippet = cleanMes
      ? cleanMes.slice(0, 140)
      : toolNames
      ? `[工具调用: ${toolNames}]`.slice(0, 140)
      : role === 'tool'
      ? '[工具返回]'
      : '';
    // 工具协议楼层（含一等 tool_calls/tool_call_id 及旧版 extra.tool_invocations）保留原始字符与结构字段
    const floorHash = hasToolProtocol
      ? quickExactHash(
          JSON.stringify({
            isUser: Boolean(item.is_user),
            isSystem: Boolean(item.is_system),
            role,
            toolCallId,
            mes: rawMes,
            toolCalls: toolCalls.map((tc) => ({
              id: tc?.id ?? '',
              type: tc?.type ?? '',
              name: tc?.function?.name ?? tc?.name ?? '',
              arguments: tc?.function?.arguments ?? tc?.arguments ?? '',
            })),
            legacyToolInvocations: legacyToolInvocations ? canonicalizeJsonValue(legacyToolInvocations) : null,
          })
        )
      : quickTextHash(`${Boolean(item.is_user)}|${Boolean(item.is_system)}|${rawMes}`);
    floors.push({
      floor: floors.length + 1,
      name: item.name || (role === 'tool' ? 'Tool' : item.is_user ? '你' : '角色'),
      isUser: Boolean(item.is_user),
      isSystem: Boolean(item.is_system),
      role,
      toolCallId,
      sendDate: item.send_date || '',
      // 使用完整正文计算 64 位双哈希 + 长度，避免长消息在 240 字后分叉被误判为相同
      hash: floorHash,
      snippet: displaySnippet,
      bookmarkLink: item.extra?.bookmark_link ? stripJsonl(item.extra.bookmark_link) : '',
    });
  }

  return { header, floors };
}

class IndexedDbDigestCache {
  constructor(options = {}) {
    this.dbPromise = null;
    this.openTimeoutMs = options.openTimeoutMs ?? 1500;
  }

  open() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;

    const pending = new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const finish = (db, { clearOnNull = false } = {}) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!db && clearOnNull && this.dbPromise === pending) {
          this.dbPromise = null;
        }
        resolve(db);
      };

      const attachVersionChange = (db) => {
        if (!db) return;
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // ignore close errors
          }
          this.dbPromise = null;
        };
      };

      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);

        if (typeof this.openTimeoutMs === 'number' && this.openTimeoutMs > 0) {
          timer = setTimeout(() => {
            finish(null, { clearOnNull: true });
          }, this.openTimeoutMs);
        }

        req.onupgradeneeded = (event) => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'cacheKey' });
          } else if (event.oldVersion < 5) {
            req.transaction.objectStore(IDB_STORE).clear();
          }
          if (!db.objectStoreNames.contains(IDB_SUMMARY_STORE)) {
            db.createObjectStore(IDB_SUMMARY_STORE, { keyPath: 'avatar' });
          }
        };

        req.onblocked = () => {
          // 其他旧标签页持有旧版连接导致升级受阻时，立即降级绕过本地缓存，避免卡死存档树加载
          finish(null, { clearOnNull: true });
        };

        req.onsuccess = () => {
          const db = req.result;
          attachVersionChange(db);
          if (settled) {
            this.dbPromise = Promise.resolve(db);
            return;
          }
          finish(db);
        };

        req.onerror = () => finish(null, { clearOnNull: true });
      } catch {
        finish(null, { clearOnNull: true });
      }
    });

    this.dbPromise = pending;
    return pending;
  }

  async get(cacheKey, fingerprint, maxAgeMs = DEFAULT_DIGEST_CACHE_TTL_MS) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
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
            done(record.digest);
          } else {
            done(null);
          }
        };
        req.onerror = () => done(null);
        tx.onerror = () => done(null);
        tx.onabort = () => done(null);
      } catch {
        done(null);
      }
    });
  }

  async getMany(entries = [], maxAgeMs = DEFAULT_DIGEST_CACHE_TTL_MS, chunkSize = 32) {
    const hits = new Map();
    if (!Array.isArray(entries) || entries.length === 0) return hits;
    const db = await this.open();
    if (!db) return hits;

    const step = Math.max(1, chunkSize);
    for (let offset = 0; offset < entries.length; offset += step) {
      const chunk = entries.slice(offset, offset + step);
      await new Promise((resolve) => {
        let settled = false;
        let remaining = chunk.length;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const store = tx.objectStore(IDB_STORE);
          tx.onerror = done;
          tx.onabort = done;
          for (const { cacheKey, fingerprint } of chunk) {
            const req = store.get(cacheKey);
            req.onsuccess = () => {
              const record = req.result;
              const isFresh =
                typeof maxAgeMs !== 'number' ||
                maxAgeMs <= 0 ||
                (typeof record?.savedAt === 'number' && Date.now() - record.savedAt < maxAgeMs);
              if (record && record.fingerprint === fingerprint && record.digest && isFresh) {
                hits.set(cacheKey, record.digest);
              }
              remaining -= 1;
              if (remaining === 0) done();
            };
            req.onerror = () => {
              remaining -= 1;
              if (remaining === 0) done();
            };
          }
        } catch {
          done();
        }
      });
    }
    return hits;
  }

  async set(cacheKey, fingerprint, digest) {
    const db = await this.open();
    if (!db) return false;
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({
          cacheKey,
          fingerprint,
          digest,
          savedAt: Date.now(),
        });
        tx.oncomplete = () => done(true);
        tx.onerror = () => done(false);
        tx.onabort = () => done(false);
      } catch {
        done(false);
      }
    });
  }

  async delete(cacheKey) {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(cacheKey);
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done();
      }
    });
  }

  async clearAll() {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const stores = db.objectStoreNames?.contains?.(IDB_SUMMARY_STORE)
          ? [IDB_STORE, IDB_SUMMARY_STORE]
          : [IDB_STORE];
        const tx = db.transaction(stores, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        if (stores.includes(IDB_SUMMARY_STORE)) {
          tx.objectStore(IDB_SUMMARY_STORE).clear();
        }
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done();
      }
    });
  }

  async getAllSummaries() {
    const map = new Map();
    const db = await this.open();
    if (!db || (db.objectStoreNames && !db.objectStoreNames.contains?.(IDB_SUMMARY_STORE))) return map;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(map);
      };
      try {
        const tx = db.transaction(IDB_SUMMARY_STORE, 'readonly');
        const store = tx.objectStore(IDB_SUMMARY_STORE);
        if (typeof store.getAll !== 'function') {
          done();
          return;
        }
        const req = store.getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          for (const rec of rows) {
            if (
              rec &&
              rec.avatar &&
              rec.schema === SUMMARY_SCHEMA_VERSION &&
              Array.isArray(rec.summaries) &&
              typeof rec.savedAt === 'number'
            ) {
              map.set(rec.avatar, { data: rec.summaries, fetchedAt: rec.savedAt });
            }
          }
          done();
        };
        req.onerror = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done();
      }
    });
  }

  async setSummaries(avatar, summaries) {
    if (!avatar || !Array.isArray(summaries)) return false;
    const db = await this.open();
    if (!db || (db.objectStoreNames && !db.objectStoreNames.contains?.(IDB_SUMMARY_STORE))) return false;
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const tx = db.transaction(IDB_SUMMARY_STORE, 'readwrite');
        tx.objectStore(IDB_SUMMARY_STORE).put({
          avatar,
          schema: SUMMARY_SCHEMA_VERSION,
          summaries,
          savedAt: Date.now(),
        });
        tx.oncomplete = () => done(true);
        tx.onerror = () => done(false);
        tx.onabort = () => done(false);
      } catch {
        done(false);
      }
    });
  }

  async deleteSummary(avatar) {
    if (!avatar) return;
    const db = await this.open();
    if (!db || (db.objectStoreNames && !db.objectStoreNames.contains?.(IDB_SUMMARY_STORE))) return;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const tx = db.transaction(IDB_SUMMARY_STORE, 'readwrite');
        tx.objectStore(IDB_SUMMARY_STORE).delete(avatar);
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done();
      }
    });
  }
}

export class SaveManagerAdapter {
  constructor(options = {}) {
    this.digestCache = new IndexedDbDigestCache({ openTimeoutMs: options.idbOpenTimeoutMs });
    this.summaryCache = new Map();
    this.summaryCacheHydrated = false;
    this.inFlightSummaries = new Map();
    this.lastKnownSummaries = new Map();
    this.dirtyDigestKeys = new Set();
    this.summaryEpoch = 0;
    this.summaryRequestSeq = new Map();
    this.digestEpoch = 0;
    this.digestRequestSeq = new Map();
    this.lastKnownActiveChatByAvatar = new Map();
    this.summaryCacheTtlMs = options.summaryCacheTtlMs ?? DEFAULT_SUMMARY_CACHE_TTL_MS;
    this.digestCacheTtlMs = options.digestCacheTtlMs ?? DEFAULT_DIGEST_CACHE_TTL_MS;
    this.switchVerifyTimeoutMs = options.switchVerifyTimeoutMs ?? DEFAULT_SWITCH_VERIFY_TIMEOUT_MS;
    this.switchPollIntervalMs = options.switchPollIntervalMs ?? DEFAULT_SWITCH_POLL_INTERVAL_MS;
    this.eventsBound = false;
    this.lastObservedActiveChat = null;
    this.jumpQueue = Promise.resolve();
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
    const liveChatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
    const chatId = stripJsonl(liveChatId || ctx.chatId || ch.chat || '');
    return { avatar: ch.avatar, chatId };
  }

  invalidateCharacterCache(avatar) {
    if (!avatar) return;
    this.summaryRequestSeq.set(avatar, (this.summaryRequestSeq.get(avatar) || 0) + 1);
    this.summaryCache.delete(avatar);
    this.inFlightSummaries.delete(avatar);
    if (typeof this.digestCache.deleteSummary === 'function') {
      void this.digestCache.deleteSummary(avatar);
    }
  }

  invalidateChatCache(avatar, chatId) {
    if (!avatar) return;
    this.summaryRequestSeq.set(avatar, (this.summaryRequestSeq.get(avatar) || 0) + 1);
    this.summaryCache.delete(avatar);
    this.inFlightSummaries.delete(avatar);
    if (typeof this.digestCache.deleteSummary === 'function') {
      void this.digestCache.deleteSummary(avatar);
    }
    const cleanChatId = stripJsonl(chatId || '');
    if (!cleanChatId) return;
    const cacheKey = `${avatar}::${cleanChatId}`;
    this.dirtyDigestKeys.add(cacheKey);
    this.digestRequestSeq.set(cacheKey, (this.digestRequestSeq.get(cacheKey) || 0) + 1);
    void this.digestCache.delete(cacheKey);
  }

  /**
   * 重开大厅前的增量失效：仅失效当前活跃角色、上次活跃角色以及 activeChatId 发生变更的角色，
   * 其余未变动的角色卡继续复用内存摘要缓存，避免每次重开大厅都全量扫描所有角色卡。
   */
  invalidateStaleSummaryTargets() {
    const activeRef = this.getActiveCharacterChatRef();
    if (this.lastObservedActiveChat?.avatar) {
      this.invalidateCharacterCache(this.lastObservedActiveChat.avatar);
    }
    if (activeRef?.avatar) {
      this.invalidateCharacterCache(activeRef.avatar);
      this.lastObservedActiveChat = activeRef;
    }

    const characters = this.getCharacters();
    for (const ch of characters) {
      if (!ch?.avatar) continue;
      const prevActive = this.lastKnownActiveChatByAvatar.get(ch.avatar) || '';
      if (ch.isCurrentCharacter) {
        this.invalidateCharacterCache(ch.avatar);
      } else if (prevActive && ch.activeChatId && prevActive !== ch.activeChatId) {
        this.invalidateChatCache(ch.avatar, prevActive);
        this.invalidateChatCache(ch.avatar, ch.activeChatId);
        this.lastKnownActiveChatByAvatar.set(ch.avatar, ch.activeChatId);
      }
    }
  }

  /**
   * 监听 SillyTavern / TauriTavern 聊天与消息生命周期事件，及时失效被编辑或切换的存档缓存
   */
  bindSillyTavernEvents() {
    if (this.eventsBound) return false;
    const ctx = this.getContext();
    const eventSource = ctx?.eventSource;
    const eventTypes = ctx?.eventTypes || ctx?.event_types;
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
      'TOOL_CALLS_PERFORMED',
      'CHARACTER_EDITED',
      'CHARACTER_DELETED',
      'CHARACTER_DUPLICATED',
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

  isTauriTavern() {
    return Boolean(
      typeof window !== 'undefined' &&
        (window.__TAURITAVERN__ || window.__TAURI_RUNNING__ || window.__TAURITAVERN_HOST__)
    );
  }

  isMobileHost() {
    if (typeof window === 'undefined') return false;
    if (window.__TAURITAVERN_HOST__?.kind === 'mobile') return true;
    const ctx = this.getContext();
    if (typeof ctx?.isMobile === 'function') {
      try {
        return Boolean(ctx.isMobile());
      } catch {
        // ignore
      }
    }
    return false;
  }

  getHostLabel() {
    if (this.isTauriTavern()) {
      return this.isMobileHost() ? 'TauriTavern 移动端' : '已连接 TauriTavern';
    }
    if (this.isSillyTavern()) {
      return '已连接酒馆实时数据';
    }
    return '本地 Mock 预览模式';
  }

  async waitForHostReady() {
    if (typeof window === 'undefined') return;
    const readyPromise = window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__;
    if (readyPromise && typeof readyPromise.then === 'function') {
      await readyPromise;
    }
  }

  resolveApiUrl(endpoint) {
    const clean = String(endpoint || '').replace(/^\/+/, '');
    return this.isTauriTavern() ? `/${clean}` : clean;
  }

  resolveAvatarUrls(ctx, avatar) {
    if (!avatar) {
      return { avatarSrc: '', avatarFallbackSrc: '' };
    }
    const isTT = this.isTauriTavern();
    const rawAvatarUrl = `${isTT ? '/' : ''}characters/${encodeURIComponent(avatar)}`;
    let thumbUrl = '';

    if (isTT) {
      const ttThumb = window.__TAURITAVERN__?.assets?.thumbnailUrl || window.__TAURITAVERN_THUMBNAIL__;
      if (typeof ttThumb === 'function') {
        try {
          thumbUrl = ttThumb('avatar', avatar) || '';
        } catch {
          // ignore and fallback
        }
      }
    }

    if (!thumbUrl && typeof ctx?.getThumbnailUrl === 'function') {
      try {
        thumbUrl = ctx.getThumbnailUrl('avatar', avatar) || '';
      } catch {
        // ignore and fallback
      }
    }

    if (!thumbUrl) {
      thumbUrl = `${isTT ? '/' : ''}thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
    }

    return {
      avatarSrc: thumbUrl || rawAvatarUrl,
      avatarFallbackSrc: rawAvatarUrl,
    };
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

    // TauriTavern 的 SillyTavern.getContext() 已完整暴露上述方法；仅在旧版 SillyTavern 缺失时尝试动态回退导入 script.js
    if ((!resolved.selectCharacterById || !resolved.openCharacterChat || !resolved.getRequestHeaders) && this.isSillyTavern() && !this.isTauriTavern()) {
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

  getSaveMeta(avatar, chatId, allMetadata = null) {
    const all = allMetadata || this.getAllMetadata();
    const key = `${avatar}::${stripJsonl(chatId)}`;
    return normalizeSaveMeta(all[key]);
  }

  updateSaveMeta(avatar, chatId, patch) {
    const key = `${avatar}::${stripJsonl(chatId)}`;
    const ctx = this.getContext();
    if (ctx && ctx.extensionSettings) {
      if (!ctx.extensionSettings[EXTENSION_KEY]) {
        ctx.extensionSettings[EXTENSION_KEY] = { items: {} };
      }
      const items = ctx.extensionSettings[EXTENSION_KEY].items || (ctx.extensionSettings[EXTENSION_KEY].items = {});
      const next = {
        ...normalizeSaveMeta(items[key]),
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      items[key] = next;
      if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
      }
      return next;
    }

    const all = this.getAllMetadata();
    const next = {
      ...normalizeSaveMeta(all[key]),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    try {
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
        const { avatarSrc, avatarFallbackSrc } = this.resolveAvatarUrls(ctx, ch.avatar);
        const rawDesc = ch.description || ch.data?.description || '';
        const isCurrentCharacter = idx === activeIdx && !ctx.groupId;
        const liveChatId = isCurrentCharacter
          ? typeof ctx.getCurrentChatId === 'function'
            ? ctx.getCurrentChatId()
            : ctx.chatId
          : '';
        return {
          id: idx,
          name: ch.name || stripJsonl(ch.avatar),
          avatar: ch.avatar,
          avatarSrc,
          avatarFallbackSrc,
          description: rawDesc ? String(rawDesc).slice(0, 80) : '',
          activeChatId: stripJsonl(liveChatId || ch.chat || ''),
          isCurrentCharacter,
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

    const epochBeforeFetch = this.summaryEpoch;
    const currentSeq = this.summaryRequestSeq.get(character.avatar) || 0;
    const existingInFlight = !forceRefresh ? this.inFlightSummaries.get(character.avatar) : null;
    if (existingInFlight && existingInFlight.epoch === epochBeforeFetch && existingInFlight.reqSeq === currentSeq) {
      return existingInFlight.promise;
    }

    const reqSeq = currentSeq + 1;
    this.summaryRequestSeq.set(character.avatar, reqSeq);

    const requestEntry = { epoch: epochBeforeFetch, reqSeq, promise: null };
    const fetchPromise = (async () => {
      const headers = await this.buildHeaders();
      const res = await fetch(this.resolveApiUrl('api/characters/chats'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ avatar_url: character.avatar, ch_name: character.name }),
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
          const rawLastMes = item.mes ?? item.last_message ?? item.preview_message ?? '';
          const rawFileSize = item.file_size ?? '';
          const hostRevision = item.revision ?? item.etag ?? item.mtime ?? item.updated_at ?? '';
          return {
            chatId,
            fileName: item.file_name,
            rawFileSize: String(rawFileSize),
            fileSize: formatFileSize(rawFileSize),
            hostRevision: hostRevision === '' ? '' : String(hostRevision),
            messageCount: Number(item.chat_items ?? item.message_count ?? item.mes_count ?? 0),
            lastModified: item.last_mes ?? item.last_message_date ?? '',
            previewText: rawLastMes ? String(rawLastMes).replace(/<[^>]*>/g, ' ').trim().slice(0, 120) : '',
            rawLastMesHash: rawLastMes ? quickTextHash(String(rawLastMes)) : '',
          };
        });

      // 仅当当前请求仍是最新的且未经历全局/单角色失效时才写入列表缓存，防止慢请求覆盖较新结果
      if (this.summaryEpoch === epochBeforeFetch && this.summaryRequestSeq.get(character.avatar) === reqSeq) {
        this.summaryCache.set(character.avatar, { data: summaries, fetchedAt: Date.now() });
        this.lastKnownSummaries.set(character.avatar, summaries);
        if (typeof this.digestCache.setSummaries === 'function') {
          void this.digestCache.setSummaries(character.avatar, summaries);
        }
      }
      return summaries;
    })().finally(() => {
      if (this.inFlightSummaries.get(character.avatar) === requestEntry) {
        this.inFlightSummaries.delete(character.avatar);
      }
    });

    requestEntry.promise = fetchPromise;
    this.inFlightSummaries.set(character.avatar, requestEntry);
    return fetchPromise;
  }

  /**
   * 首次冷启动时从 IndexedDB 恢复上次持久化的角色存档摘要，实现刷新页面/重启后秒开侧栏
   */
  async hydrateSummaryCacheFromPersistence() {
    if (this.summaryCacheHydrated || !this.isSillyTavern()) return false;
    this.summaryCacheHydrated = true;
    if (typeof this.digestCache.getAllSummaries !== 'function') return false;

    const epochBefore = this.summaryEpoch;
    const persisted = await this.digestCache.getAllSummaries();
    if (this.summaryEpoch !== epochBefore || !persisted || persisted.size === 0) return false;

    const activeRef = this.getActiveCharacterChatRef();
    const liveActiveChatByAvatar = new Map();
    for (const ch of this.getCharacters()) {
      if (ch?.avatar && ch.activeChatId) {
        liveActiveChatByAvatar.set(ch.avatar, stripJsonl(ch.activeChatId));
      }
    }
    let restoredAny = false;
    for (const [avatar, rec] of persisted.entries()) {
      if (!this.lastKnownSummaries.has(avatar)) {
        this.lastKnownSummaries.set(avatar, rec.data);
      }
      // 当前活跃角色、本会话已失效过的角色，或宿主记录的最近聊天已不在持久化摘要里的角色仍走实时拉取
      const alreadyInvalidated = (this.summaryRequestSeq.get(avatar) || 0) > 0;
      const isCurrentActive = activeRef?.avatar === avatar;
      const expectedChatId = liveActiveChatByAvatar.get(avatar) || '';
      const activeChatMissing = Boolean(expectedChatId && !rec.data.some((s) => stripJsonl(s.chatId) === expectedChatId));
      if (!alreadyInvalidated && !isCurrentActive && !activeChatMissing && !this.summaryCache.has(avatar)) {
        this.summaryCache.set(avatar, rec);
        restoredAny = true;
      }
    }
    return restoredAny;
  }

  /**
   * 若目标存档恰好是酒馆当前已在内存中加载的活跃对话（ctx.chat），直接零网络、零 JSONL 解析构建楼层摘要
   */
  getLiveActiveChatDigest(character, cleanChatId, expectedMessageCount = 0) {
    const ctx = this.getContext();
    if (!ctx || ctx.groupId || !Array.isArray(ctx.chat)) return null;
    const activeRef = this.getActiveCharacterChatRef(ctx);
    if (!activeRef || activeRef.avatar !== character.avatar || activeRef.chatId !== cleanChatId) return null;
    // 若酒馆尚未完成聊天水合（内存为空但摘要宣称有消息），回退走接口拉取
    if (ctx.chat.length === 0 && Number(expectedMessageCount || 0) > 0) return null;

    const { floors } = compactChatLines(ctx.chat, { skipHeaderDetection: true });
    const rawMeta = ctx.chatMetadata || ctx.chat_metadata || {};
    const header = {
      user_name: ctx.name1 || '',
      character_name: character.name || ctx.name2 || '',
      create_date: rawMeta.create_date || '',
      chat_metadata: rawMeta,
    };
    return { header, floors };
  }

  /**
   * 并发受限地加载全部角色的存档汇总统计（支持优先完成当前角色再扫后台，避免与首屏抢连接/I/O）
   */
  async loadGlobalOverview({
    forceRefresh = false,
    concurrency = 6,
    priorityAvatars = [],
    onCharacterLoaded = null,
    onPriorityReady = null,
    onProgress = null,
  } = {}) {
    if (forceRefresh) {
      this.summaryEpoch += 1;
      this.summaryCache.clear();
      this.inFlightSummaries.clear();
    } else {
      await this.hydrateSummaryCacheFromPersistence();
    }

    const characters = this.getCharacters();
    const results = new Array(characters.length);
    const prioritySet = new Set(Array.isArray(priorityAvatars) ? priorityAvatars.filter(Boolean) : []);
    const priorityIndices = [];
    const restIndices = [];
    for (let i = 0; i < characters.length; i += 1) {
      if (prioritySet.has(characters[i]?.avatar)) priorityIndices.push(i);
      else restIndices.push(i);
    }

    let completed = 0;

    const loadOne = async (index) => {
      const ch = characters[index];
      if (ch.avatar && ch.activeChatId && !this.lastKnownActiveChatByAvatar.has(ch.avatar)) {
        this.lastKnownActiveChatByAvatar.set(ch.avatar, ch.activeChatId);
      }
      let summaries = [];
      let summaryError = '';
      try {
        summaries = await this.getCharacterChatSummaries(ch, forceRefresh);
      } catch (err) {
        console.warn(`[SaveManager] 获取 ${ch.name} 存档失败:`, err);
        summaryError = err?.message || String(err || '获取存档列表失败');
        // 列表瞬态失败时保留上次成功拉取的存档摘要，不误清为“无存档”
        const previous = this.lastKnownSummaries.get(ch.avatar);
        if (Array.isArray(previous)) {
          summaries = previous;
        }
      }

      const allMeta = this.getAllMetadata();
      let starredCount = 0;
      let notedCount = 0;
      let latestTime = 0;

      const enrichedSaves = summaries.map((s) => {
        const meta = this.getSaveMeta(ch.avatar, s.chatId, allMeta);
        if (meta.starred) starredCount += 1;
        if (meta.note || meta.tags.length > 0) notedCount += 1;
        const ts = parseSillyTavernTimestamp(s.lastModified) || 0;
        if (ts > latestTime) latestTime = ts;
        return { ...s, meta };
      });

      const entry = {
        ...ch,
        saves: enrichedSaves,
        saveCount: enrichedSaves.length,
        starredCount,
        notedCount,
        latestTimestamp: latestTime,
        summaryError,
      };
      results[index] = entry;

      completed += 1;
      if (typeof onCharacterLoaded === 'function') {
        onCharacterLoaded(entry, index);
      }
      if (typeof onProgress === 'function') {
        onProgress(completed, characters.length);
      }
      return entry;
    };

    // 第一阶段：先独享通道拉取并渲染优先角色（当前/上次选中），不与后台其余角色抢连接与磁盘 I/O
    if (priorityIndices.length > 0) {
      const priorityEntries = await Promise.all(priorityIndices.map((idx) => loadOne(idx)));
      if (typeof onPriorityReady === 'function') {
        await onPriorityReady(priorityEntries);
      }
    }

    // 第二阶段：后台并发限流补齐其余角色
    let cursor = 0;
    const worker = async () => {
      while (cursor < restIndices.length) {
        const index = restIndices[cursor++];
        await loadOne(index);
      }
    };

    if (restIndices.length > 0) {
      const workers = Array.from({ length: Math.min(concurrency, restIndices.length) }, () => worker());
      await Promise.all(workers);
    }
    return results;
  }

  /**
   * 获取指定角色下所有存档的紧凑楼层摘要（温热缓存按批共用只读事务；活跃/脏/超时存档强制回源校验）
   */
  async getCharacterChatDigests(character, summaries, forceRefresh = false) {
    if (!this.isSillyTavern()) {
      const allMeta = this.getAllMetadata();
      const mockFiles = MOCK_CHATS_BY_AVATAR[character.avatar] || [];
      return summaries.map((summary) => {
        const found = mockFiles.find((f) => stripJsonl(f.file_name) === summary.chatId);
        const digest = compactChatLines(found ? found.lines : []);
        return {
          ...summary,
          meta: this.getSaveMeta(character.avatar, summary.chatId, allMeta),
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

    const items = summaries.map((summary, idx) => {
      const cleanChatId = stripJsonl(summary.chatId);
      const cacheKey = `${character.avatar}::${cleanChatId}`;
      const previewSig = summary.rawLastMesHash || quickTextHash(summary.previewText || '');
      const sizeSig = summary.rawFileSize ?? summary.fileSize ?? '';
      const revSig = summary.hostRevision ?? '';
      // 注：TauriTavern 的 last_mes 通常取自末条有效 send_date；若对非活跃存档早期消息做等长编辑，
      // 摘要指纹在 TTL 内可能不变，由 digestCacheTtlMs、活跃存档内存直读/直通、事件监听与手动重扫共同兜底。
      const fingerprint = `${DIGEST_SCHEMA_VERSION}|${summary.lastModified}|${sizeSig}|${summary.messageCount}|${previewSig}|${revSig}`;
      const isActiveChat =
        (characterActiveChatId && cleanChatId === characterActiveChatId) ||
        (liveActiveChatId && cleanChatId === liveActiveChatId);
      const liveMemoryDigest =
        !forceRefresh && isActiveChat ? this.getLiveActiveChatDigest(character, cleanChatId, summary.messageCount) : null;
      const shouldBypassCache = forceRefresh || isActiveChat || this.dirtyDigestKeys.has(cacheKey);
      return {
        idx,
        summary,
        cleanChatId,
        cacheKey,
        fingerprint,
        liveMemoryDigest,
        shouldBypassCache,
        seqBeforeBatch: this.digestRequestSeq.get(cacheKey) || 0,
      };
    });

    // 温热 IndexedDB 缓存按批在共享只读事务中一次性读取，减少大存档角色重开时的事务开销
    const cacheEligible = items.filter((item) => !item.shouldBypassCache && !item.liveMemoryDigest);
    const batchEpoch = this.digestEpoch;
    let cachedByKey = new Map();
    if (cacheEligible.length > 0) {
      if (typeof this.digestCache.getMany === 'function') {
        cachedByKey = await this.digestCache.getMany(
          cacheEligible.map(({ cacheKey, fingerprint }) => ({ cacheKey, fingerprint })),
          this.digestCacheTtlMs
        );
      } else {
        const fetched = await Promise.all(
          cacheEligible.map(async ({ cacheKey, fingerprint }) => [
            cacheKey,
            await this.digestCache.get(cacheKey, fingerprint, this.digestCacheTtlMs),
          ])
        );
        for (const [k, v] of fetched) {
          if (v) cachedByKey.set(k, v);
        }
      }
    }

    const digests = new Array(summaries.length);
    const toFetch = [];
    const hasImmediateHits = cachedByKey.size > 0 || items.some((it) => it.liveMemoryDigest);
    const hitMetaSnapshot = hasImmediateHits ? this.getAllMetadata() : null;

    for (const item of items) {
      if (item.liveMemoryDigest) {
        const memDigest = item.liveMemoryDigest;
        digests[item.idx] = {
          ...item.summary,
          meta: this.getSaveMeta(character.avatar, item.cleanChatId, hitMetaSnapshot),
          header: memDigest.header,
          floors: memDigest.floors,
          digestStatus: 'ok',
          digestError: '',
          messageCount: memDigest.floors.length,
        };
        continue;
      }
      const hit = cachedByKey.get(item.cacheKey) || null;
      const stillValidHit =
        hit &&
        this.digestEpoch === batchEpoch &&
        !this.dirtyDigestKeys.has(item.cacheKey) &&
        (this.digestRequestSeq.get(item.cacheKey) || 0) === item.seqBeforeBatch;
      if (stillValidHit) {
        digests[item.idx] = {
          ...item.summary,
          meta: this.getSaveMeta(character.avatar, item.cleanChatId, hitMetaSnapshot),
          header: hit.header,
          floors: hit.floors,
          digestStatus: 'ok',
          digestError: '',
          messageCount: hit.floors.length,
        };
      } else {
        toFetch.push(item);
      }
    }

    // 移动端冷扫适当降低并发，减轻超大聊天 JSONL 同时驻留内存的压力
    const maxConcurrency = this.isMobileHost() ? 2 : 4;
    const concurrency = Math.min(maxConcurrency, Math.max(1, toFetch.length));
    let cursor = 0;

    const worker = async () => {
      while (cursor < toFetch.length) {
        const item = toFetch[cursor++];
        const { idx, summary, cleanChatId, cacheKey, fingerprint } = item;
        let digest = null;
        let digestStatus = 'ok';
        let digestError = '';

        const epochBeforeFetch = this.digestEpoch;
        const reqSeq = (this.digestRequestSeq.get(cacheKey) || 0) + 1;
        this.digestRequestSeq.set(cacheKey, reqSeq);
        const isTT = this.isTauriTavern();
        try {
          const payloadBody = {
            ch_name: character.name,
            file_name: cleanChatId,
            avatar_url: character.avatar,
          };
          const res = await fetch(this.resolveApiUrl('api/chats/get'), {
            method: 'POST',
            headers,
            body: JSON.stringify(payloadBody),
            cache: 'no-cache',
          });

          if (res.ok) {
            const rawText = await res.text();
            const rawLines = isTT ? parseTauriChatPayload(rawText) : parseChatResponsePayload(rawText);
            // TauriTavern 在未传 allow_not_found 时，文件缺失会走非 2xx 失败，HTTP 200 [] 为合法零记录空聊天
            if (!isTT && rawLines.length === 0 && Number(summary.messageCount || 0) > 0) {
              digestStatus = 'missing';
              digestError = '存档文件缺失或内容为空';
              digest = { header: {}, floors: [] };
            } else {
              digest = compactChatLines(rawLines, { strictHeader: isTT });
              // 防止旧请求在强制刷新或编辑事件之后返回并覆盖新缓存；仅在写入事务提交成功且未再被失效后才清除脏标记
              if (this.digestEpoch === epochBeforeFetch && this.digestRequestSeq.get(cacheKey) === reqSeq) {
                const committed = await this.digestCache.set(cacheKey, fingerprint, digest);
                if (
                  committed !== false &&
                  this.digestEpoch === epochBeforeFetch &&
                  this.digestRequestSeq.get(cacheKey) === reqSeq
                ) {
                  this.dirtyDigestKeys.delete(cacheKey);
                }
              }
            }
          } else {
            let detailText = '';
            try {
              detailText = typeof res.text === 'function' ? await res.text() : '';
            } catch {
              // ignore error body read failure
            }
            const looksMissing =
              res.status === 404 || /not\s*found|enoent|no such file|missing/i.test(detailText);
            digestStatus = looksMissing ? 'missing' : 'unreadable';
            digestError = looksMissing
              ? '存档文件已缺失或被移除'
              : `读取存档失败 (HTTP ${res.status})`;
            digest = { header: {}, floors: [] };
          }
        } catch (err) {
          console.warn(`[SaveManager] 拉取存档 ${cleanChatId} 失败:`, err);
          const msg = String(err?.message || err || '');
          const looksMissing = /not\s*found|enoent|no such file/i.test(msg);
          digestStatus = looksMissing ? 'missing' : 'unreadable';
          digestError = looksMissing ? '存档文件已缺失或被移除' : `存档损坏或无法读取：${msg || '未知错误'}`;
          digest = { header: {}, floors: [] };
        }

        digests[idx] = {
          ...summary,
          meta: null,
          header: digest.header,
          floors: digest.floors,
          digestStatus,
          digestError,
          messageCount: digestStatus === 'ok' ? digest.floors.length : 0,
        };
      }
    };

    if (toFetch.length > 0) {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const postFetchMeta = this.getAllMetadata();
      for (const item of toFetch) {
        digests[item.idx].meta = this.getSaveMeta(character.avatar, item.cleanChatId, postFetchMeta);
      }
    }
    return digests;
  }

  async clearDigestCache() {
    this.summaryEpoch += 1;
    this.digestEpoch += 1;
    this.summaryCache.clear();
    this.inFlightSummaries.clear();
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
   * 跨角色一键切换存档（全流程串行化，防止并发跳转交错导致在错误角色下打开存档）
   */
  jumpToSave(character, chatId) {
    const run = () => this._performJumpToSave(character, chatId);
    const next = this.jumpQueue.then(run, run);
    this.jumpQueue = next.catch(() => {});
    return next;
  }

  async _performJumpToSave(character, chatId) {
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

    const targetAvatar = typeof character?.avatar === 'string' ? character.avatar.trim() : '';
    if (!targetAvatar) {
      throw new Error('缺少稳定的角色头像标识 (avatar)，已中止打开存档以避免误切角色');
    }

    const ctx = this.getContext();
    const { selectCharacterById, openCharacterChat } = await this.getCoreScriptFunctions();
    const freshCtx = this.getContext() || ctx;

    let targetCharId = -1;
    if (Array.isArray(freshCtx?.characters)) {
      targetCharId = freshCtx.characters.findIndex((c) => c && c.avatar === targetAvatar);
    }
    if (targetCharId < 0) {
      throw new Error(`角色「${character?.name || targetAvatar}」已不存在或已被移除，已中止打开存档`);
    }
    const resolvedTargetChar = freshCtx.characters[targetCharId];
    if (!resolvedTargetChar || resolvedTargetChar.avatar !== targetAvatar) {
      throw new Error(`角色身份校验失败（「${character?.name || targetAvatar}」），已中止打开存档`);
    }

    const isTargetCharacterActive = (context) => {
      if (!context || context.groupId) return false;
      if (context.characterId === undefined || context.characterId === null || context.characterId === '') {
        return false;
      }
      const activeIdx = Number(context.characterId);
      if (!Number.isInteger(activeIdx) || activeIdx < 0 || !Array.isArray(context.characters)) return false;
      const activeChar = context.characters[activeIdx];
      return Boolean(activeChar && activeChar.avatar === targetAvatar);
    };

    const getActiveChatId = (context) => {
      if (!context) return '';
      const fromFn = typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : '';
      const activeIdx =
        context.characterId !== undefined && context.characterId !== null && context.characterId !== ''
          ? Number(context.characterId)
          : targetCharId;
      return stripJsonl(fromFn || context.chatId || context.characters?.[activeIdx]?.chat || '');
    };

    // TauriTavern 专属原子跳转：统一经由 selectCharacterById(id, { chatFile })，不预扫、不二次加载、目标缺失时绝不新建空白对话
    if (this.isTauriTavern() && typeof selectCharacterById === 'function') {
      const alreadyOnTarget = isTargetCharacterActive(freshCtx) && getActiveChatId(freshCtx) === targetChatId;
      if (!alreadyOnTarget) {
        await selectCharacterById(String(targetCharId), { chatFile: targetChatId });
        const switched = await this.waitForCondition(
          () => isTargetCharacterActive(this.getContext()) && getActiveChatId(this.getContext()) === targetChatId
        );
        const afterCtx = this.getContext();
        if (!isTargetCharacterActive(afterCtx)) {
          throw new Error(
            `未能切换到角色「${character.name || character.avatar}」，TauriTavern 可能正忙于生成回复或保存聊天，已中止打开存档`
          );
        }
        const switchedChat = getActiveChatId(afterCtx);
        if (!switched || (switchedChat && switchedChat !== targetChatId)) {
          throw new Error(`TauriTavern 未能打开存档「${targetChatId}」，文件可能已删除、损坏或酒馆正忙`);
        }
      }
      this.invalidateChatCache(character.avatar, targetChatId);
      return true;
    }

    if (!isTargetCharacterActive(freshCtx)) {
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

    const activeChatNow = getActiveChatId(refreshedCtx);
    if (activeChatNow !== targetChatId) {
      const openChatCmd = refreshedCtx?.SlashCommandParser?.commands?.['open-chat'];
      if (typeof openCharacterChat === 'function') {
        await openCharacterChat(targetChatId);
      } else if (typeof openChatCmd?.callback === 'function') {
        // 直接以字面量参数调用命令回调，绝不经字符串拼接传入斜杠命令解析器
        await openChatCmd.callback({}, targetChatId);
      } else {
        throw new Error('未找到 SillyTavern 的 openCharacterChat 方法，无法安全切换存档');
      }

      const afterCtx = this.getContext();
      if (!isTargetCharacterActive(afterCtx)) {
        throw new Error('切换存档期间角色上下文发生变化，未能确认切换成功');
      }
      const switchedChat = getActiveChatId(afterCtx);
      if (switchedChat && switchedChat !== targetChatId) {
        throw new Error(`酒馆未能打开存档「${targetChatId}」，可能正忙于生成回复或保存聊天，请稍后重试`);
      }
    }

    this.invalidateChatCache(character.avatar, targetChatId);
    return true;
  }
}
