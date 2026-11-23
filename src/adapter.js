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
const IDB_STORE = 'chat_digests';

export function stripJsonl(fileName = '') {
  return String(fileName).replace(/\.jsonl$/i, '').trim();
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
  let h = 0x811c9dc5;
  const normalized = String(str).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
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
      hash: quickTextHash(`${Boolean(item.is_user)}|${cleanMes.slice(0, 240)}`),
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
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'cacheKey' });
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

  async get(cacheKey, fingerprint) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(cacheKey);
        req.onsuccess = () => {
          const record = req.result;
          if (record && record.fingerprint === fingerprint && record.digest) {
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
  constructor() {
    this.digestCache = new IndexedDbDigestCache();
    this.summaryCache = new Map();
    this.coreScriptModule = null;
    this.mockCharacters = structuredClone(MOCK_CHARACTERS);
    this.mockActiveCharId = 0;
    this.onMockSwitchCallbacks = [];
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
      const activeIdx = Number(ctx.characterId);
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
   * 获取指定角色的轻量存档摘要列表
   */
  async getCharacterChatSummaries(character, forceRefresh = false) {
    if (!forceRefresh && this.summaryCache.has(character.avatar)) {
      return this.summaryCache.get(character.avatar);
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
      this.summaryCache.set(character.avatar, summaries);
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
        };
      });

    this.summaryCache.set(character.avatar, summaries);
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
          const ts = Date.parse(s.lastModified) || 0;
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
   * 获取指定角色下所有存档的紧凑楼层摘要（优先命中 IndexedDB 缓存）
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
    const digests = [];

    for (const summary of summaries) {
      const cacheKey = `${character.avatar}::${summary.chatId}`;
      const fingerprint = `${summary.lastModified}|${summary.fileSize}|${summary.messageCount}`;
      let digest = !forceRefresh ? await this.digestCache.get(cacheKey, fingerprint) : null;

      if (!digest) {
        const res = await fetch('api/chats/get', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ch_name: character.name,
            file_name: summary.chatId,
            avatar_url: character.avatar,
          }),
          cache: 'no-cache',
        });

        if (res.ok) {
          const rawText = await res.text();
          const rawLines = parseChatResponsePayload(rawText);
          digest = compactChatLines(rawLines);
          await this.digestCache.set(cacheKey, fingerprint, digest);
        } else {
          digest = { header: {}, floors: [] };
        }
      }

      digests.push({
        ...summary,
        meta: this.getSaveMeta(character.avatar, summary.chatId),
        header: digest.header,
        floors: digest.floors,
        messageCount: digest.floors.length || summary.messageCount,
      });
    }

    return digests;
  }

  async clearDigestCache() {
    this.summaryCache.clear();
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

    const currentCharIdx = Number(ctx?.characterId);
    const needCharSwitch = currentCharIdx !== Number(character.id) || Boolean(ctx?.groupId);

    if (needCharSwitch) {
      if (typeof selectCharacterById !== 'function') {
        throw new Error('未找到 SillyTavern 的 selectCharacterById 方法，请检查酒馆版本');
      }
      await selectCharacterById(String(character.id));
      // 等待角色上下文切换稳定后再切换指定聊天存档
      await new Promise((resolve) => setTimeout(resolve, 260));
    }

    const refreshedCtx = this.getContext();
    const activeChatNow = stripJsonl(refreshedCtx?.characters?.[character.id]?.chat || '');
    if (activeChatNow !== targetChatId) {
      if (typeof openCharacterChat === 'function') {
        await openCharacterChat(targetChatId);
      } else if (refreshedCtx?.SlashCommandParser?.commands?.['open-chat']) {
        await refreshedCtx.executeSlashCommandsWithOptions(`/open-chat ${targetChatId}`);
      } else {
        throw new Error('未找到 SillyTavern 的 openCharacterChat 方法');
      }
    }

    this.summaryCache.delete(character.avatar);
    return true;
  }
}
