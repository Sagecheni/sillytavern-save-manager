/**
 * 全局存档与分支大厅 UI 控制器
 * 提供：
 * - 左栏：全角色检索过滤 + 全局星标书签视图
 * - 中栏：支持拖拽平移与滚轮缩放的剧情分支树画布 + 时间线列表双视图
 * - 右栏：分叉时刻三方对比、自定义标题、标签快捷组、自动保存备注、跨角色一键跳转
 */

import { buildCharacterBranchGraph, LAYOUT_CONFIG } from './branchEngine.js';
import { stripJsonl, parseSillyTavernTimestamp } from './adapter.js';

const PRESET_TAGS = ['主线', '高甜', '刀子', 'IF线', 'HE', 'BE', '待填坑'];

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettifySaveName(chatId = '') {
  const clean = stripJsonl(chatId);
  // 将 2026-11-23@18h20m12s_标题 简化为更易读的名称
  const match = clean.match(/^(\d{4}-\d{2}-\d{2})[@_](\d{2})h(\d{2})m(?:\d{2}s)?[_-]?(.*)$/i);
  if (match) {
    const [, date, hh, mm, suffix] = match;
    if (suffix && suffix.trim()) return suffix.trim();
    return `${date.slice(5)} ${hh}:${mm} 存档`;
  }
  return clean || '未命名存档';
}

function formatShortTime(tsOrStr) {
  if (!tsOrStr) return '';
  const ts = parseSillyTavernTimestamp(tsOrStr);
  if (!ts || Number.isNaN(ts)) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

export class SaveBranchManagerModal {
  constructor(adapter) {
    this.adapter = adapter;
    this.backdropEl = null;
    this.overviewList = [];
    this.currentCharacter = null;
    this.currentGraph = null;
    this.selectedChatId = null;

    // 视图与筛选状态
    this.sidebarTab = 'characters'; // 'characters' | 'bookmarks'
    this.charFilter = 'all'; // 'all' | 'multi' | 'starred'
    this.searchQuery = '';
    this.canvasMode = 'tree'; // 'tree' | 'list'

    // 画布平移与缩放状态
    this.scale = 1;
    this.panX = 24;
    this.panY = 24;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;

    this.pendingNoteSaves = new Map();
    this.pendingTitleSave = null;
    this.selectRequestSeq = 0;
    this.refreshRequestSeq = 0;
  }

  flushPendingTitleSave({ skipCenterRender = false } = {}) {
    if (!this.pendingTitleSave) return;
    const { avatar, chatId, value } = this.pendingTitleSave;
    this.pendingTitleSave = null;
    this.adapter.updateSaveMeta(avatar, chatId, { customTitle: value });
    this.syncOverviewMetaCounts(avatar);
    if (
      !skipCenterRender &&
      this.currentCharacter &&
      this.currentGraph &&
      this.currentGraph.characterAvatar === this.currentCharacter.avatar &&
      this.currentCharacter.avatar === avatar
    ) {
      this.renderCenterView();
    }
  }

  flushPendingNoteSaves(targetKey = null, { skipCenterRender = false } = {}) {
    if (!targetKey) {
      this.flushPendingTitleSave({ skipCenterRender });
    }
    const entries = targetKey
      ? this.pendingNoteSaves.has(targetKey)
        ? [[targetKey, this.pendingNoteSaves.get(targetKey)]]
        : []
      : Array.from(this.pendingNoteSaves.entries());

    if (entries.length === 0) return;

    const touchedAvatars = new Set();
    for (const [key, entry] of entries) {
      clearTimeout(entry.timer);
      this.pendingNoteSaves.delete(key);
      this.adapter.updateSaveMeta(entry.avatar, entry.chatId, { note: entry.value });
      touchedAvatars.add(entry.avatar);
      if (entry.statusEl && entry.statusEl.isConnected) {
        entry.statusEl.textContent = '✓ 已自动保存';
      }
    }

    for (const avatar of touchedAvatars) {
      this.syncOverviewMetaCounts(avatar);
    }

    if (
      !skipCenterRender &&
      this.currentCharacter &&
      this.currentGraph &&
      this.currentGraph.characterAvatar === this.currentCharacter.avatar &&
      touchedAvatars.has(this.currentCharacter.avatar)
    ) {
      this.renderCenterView();
    }
  }

  mount() {
    if (this.backdropEl) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'st-sbm-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = `
      <div class="st-sbm-modal" role="dialog" aria-modal="true" aria-label="全局存档与分支管理器">
        <header class="st-sbm-topbar">
          <div class="st-sbm-brand">
            <div class="st-sbm-brand-icon">🌿</div>
            <div>
              <h2 class="st-sbm-brand-title">酒馆全局存档与分支大厅</h2>
            </div>
            <span class="st-sbm-env-badge" data-role="env-badge">检测环境中</span>
          </div>

          <div class="st-sbm-stats-row" data-role="global-stats"></div>

          <div class="st-sbm-topbar-actions">
            <div class="st-sbm-search-wrap">
              <span class="st-sbm-search-icon">🔍</span>
              <input type="search" class="st-sbm-search-input" data-role="search-input" placeholder="搜角色、分支名、标签、备注或剧情..." />
            </div>
            <button type="button" class="st-sbm-btn" data-action="refresh" title="强制重新扫描全部存档并刷新缓存">🔄 刷新扫描</button>
            <button type="button" class="st-sbm-btn st-sbm-btn-icon" data-action="close" title="关闭 (Esc)">✕</button>
          </div>
        </header>

        <div class="st-sbm-body">
          <aside class="st-sbm-sidebar">
            <div class="st-sbm-nav-tabs">
              <button type="button" class="st-sbm-nav-tab is-active" data-tab="characters">👥 角色卡总览</button>
              <button type="button" class="st-sbm-nav-tab" data-tab="bookmarks">⭐ 全局星标库</button>
            </div>
            <div class="st-sbm-filter-bar" data-role="char-filters">
              <button type="button" class="st-sbm-filter-chip is-active" data-filter="all">全部</button>
              <button type="button" class="st-sbm-filter-chip" data-filter="multi">多分支 (≥2)</button>
              <button type="button" class="st-sbm-filter-chip" data-filter="starred">含星标 ★</button>
            </div>
            <div class="st-sbm-sidebar-list" data-role="sidebar-list"></div>
          </aside>

          <main class="st-sbm-main">
            <div class="st-sbm-canvas-toolbar">
              <div class="st-sbm-canvas-title-group">
                <span class="st-sbm-canvas-char-name" data-role="canvas-title">选择角色查看分支树</span>
                <span class="st-sbm-canvas-subtitle" data-role="canvas-subtitle"></span>
              </div>
              <div class="st-sbm-canvas-controls">
                <div class="st-sbm-segmented">
                  <button type="button" class="st-sbm-seg-btn is-active" data-view="tree">🌿 剧情分支树</button>
                  <button type="button" class="st-sbm-seg-btn" data-view="list">📋 时间线列表</button>
                </div>
                <button type="button" class="st-sbm-btn st-sbm-btn-icon" data-action="zoom-out" title="缩小">−</button>
                <button type="button" class="st-sbm-btn" data-action="zoom-fit" title="重置缩放并适应画布" data-role="zoom-label">100%</button>
                <button type="button" class="st-sbm-btn st-sbm-btn-icon" data-action="zoom-in" title="放大">+</button>
              </div>
            </div>

            <div class="st-sbm-viewport" data-role="viewport">
              <div class="st-sbm-stage" data-role="stage"></div>
            </div>
            <div class="st-sbm-list-view" data-role="list-view" hidden></div>
          </main>

          <aside class="st-sbm-inspector" data-role="inspector">
            <div class="st-sbm-empty-state">点击中间画布上的任意存档节点，<br/>即可查看精确的<strong>分叉楼层对比</strong>、编写备注标签或一键穿越过去继续聊天。</div>
          </aside>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    this.backdropEl = backdrop;
    this.bindEvents();
  }

  bindEvents() {
    const root = this.backdropEl;

    // 点击遮罩空白处关闭
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    // Esc 快捷键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.backdropEl && !this.backdropEl.hidden) {
        this.close();
      }
    });

    // 顶栏按钮与视图切换事件委托
    root.addEventListener('click', async (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        if (action === 'close') this.close();
        if (action === 'refresh') await this.refreshAll(true);
        if (action === 'zoom-in') this.setZoom(this.scale + 0.15);
        if (action === 'zoom-out') this.setZoom(this.scale - 0.15);
        if (action === 'zoom-fit') this.fitCanvas();
        return;
      }

      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        this.sidebarTab = tabBtn.dataset.tab;
        root.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('is-active', el === tabBtn));
        root.querySelector('[data-role="char-filters"]').hidden = this.sidebarTab !== 'characters';
        this.renderSidebar();
        return;
      }

      const filterBtn = e.target.closest('[data-filter]');
      if (filterBtn) {
        this.charFilter = filterBtn.dataset.filter;
        root.querySelectorAll('[data-filter]').forEach((el) => el.classList.toggle('is-active', el === filterBtn));
        this.renderSidebar();
        return;
      }

      const viewBtn = e.target.closest('[data-view]');
      if (viewBtn) {
        const prevMode = this.canvasMode;
        this.canvasMode = viewBtn.dataset.view;
        root.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('is-active', el === viewBtn));
        this.renderCenterView(prevMode !== 'tree' && this.canvasMode === 'tree');
      }
    });

    // 搜索框实时过滤
    const searchInput = root.querySelector('[data-role="search-input"]');
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.renderSidebar();
      if (this.currentGraph) {
        this.renderCenterView();
      }
    });

    // 画布拖拽平移与滚轮缩放
    const viewport = root.querySelector('[data-role="viewport"]');
    viewport.addEventListener('mousedown', (e) => {
      if (e.target.closest('.st-sbm-node')) return;
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
      viewport.classList.add('is-panning');
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isPanning) return;
      this.panX = e.clientX - this.panStartX;
      this.panY = e.clientY - this.panStartY;
      this.applyStageTransform();
    });

    window.addEventListener('mouseup', () => {
      if (!this.isPanning) return;
      this.isPanning = false;
      viewport.classList.remove('is-panning');
    });

    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        const rect = viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        this.setZoom(this.scale + delta, mouseX, mouseY);
      },
      { passive: false }
    );
  }

  async open() {
    this.mount();
    this.adapter.bindSillyTavernEvents?.();
    this.backdropEl.hidden = false;
    const badge = this.backdropEl.querySelector('[data-role="env-badge"]');
    const isLive = this.adapter.isSillyTavern();
    badge.textContent = isLive ? '已连接酒馆实时数据' : '本地 Mock 预览模式';
    badge.classList.toggle('is-live', isLive);

    // 重新打开大厅时始终重新拉取角色存档列表，确保新建/删除/更新的存档立即可见
    await this.refreshAll({ refreshSummaries: true, forceDigests: false });
  }

  close() {
    this.flushPendingNoteSaves(null, { skipCenterRender: true });
    if (this.backdropEl) {
      this.backdropEl.hidden = true;
    }
  }

  showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'st-sbm-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  async refreshAll(options = false) {
    this.flushPendingNoteSaves(null, { skipCenterRender: true });

    const forceDigests = typeof options === 'boolean' ? options : Boolean(options?.forceDigests);
    const refreshSummaries = typeof options === 'boolean' ? options : Boolean(options?.refreshSummaries || forceDigests);
    const refreshId = ++this.refreshRequestSeq;
    // 使此前尚未返回的 selectCharacter 立即失效
    this.selectRequestSeq += 1;

    const sidebarList = this.backdropEl.querySelector('[data-role="sidebar-list"]');
    sidebarList.innerHTML = `<div class="st-sbm-empty-state">正在扫描角色卡与存档索引...</div>`;

    let overview;
    try {
      if (forceDigests) {
        await this.adapter.clearDigestCache();
        if (refreshId !== this.refreshRequestSeq) return;
      }

      overview = await this.adapter.loadGlobalOverview({
        forceRefresh: refreshSummaries,
        onProgress: (done, total) => {
          if (refreshId !== this.refreshRequestSeq) return;
          sidebarList.innerHTML = `<div class="st-sbm-empty-state">正在扫描角色存档 (${done} / ${total})...</div>`;
        },
      });
    } catch (err) {
      if (refreshId !== this.refreshRequestSeq) return;
      sidebarList.innerHTML = `<div class="st-sbm-empty-state">扫描存档失败：${escapeHtml(err.message || String(err))}</div>`;
      return;
    }

    if (refreshId !== this.refreshRequestSeq) return;

    this.overviewList = overview;

    // 排序：当前正在游玩的角色置顶，其次按最新存档时间降序、存档数降序
    this.overviewList.sort((a, b) => {
      if (a.isCurrentCharacter !== b.isCurrentCharacter) return a.isCurrentCharacter ? -1 : 1;
      if (b.latestTimestamp !== a.latestTimestamp) return b.latestTimestamp - a.latestTimestamp;
      return b.saveCount - a.saveCount;
    });

    this.renderGlobalStats();
    this.renderSidebar();

    // 默认选中先前查看的角色或首个有存档的角色；仅当仍为同一角色时沿用先前选中的存档 ID
    const prevAvatar = this.currentCharacter?.avatar;
    const prevChatId = this.selectedChatId;
    const targetChar =
      this.overviewList.find((c) => c.avatar === prevAvatar) ||
      this.overviewList.find((c) => c.isCurrentCharacter) ||
      this.overviewList[0] ||
      null;

    if (targetChar) {
      const preferredChatId = targetChar.avatar === prevAvatar ? prevChatId : null;
      await this.selectCharacter(targetChar.avatar, preferredChatId, forceDigests);
    } else {
      this.currentCharacter = null;
      this.currentGraph = null;
      this.selectedChatId = null;
      this.renderCenterView();
      this.renderInspector();
    }
  }

  syncOverviewMetaCounts(avatar) {
    const charEntry = this.overviewList.find((c) => c.avatar === avatar);
    if (!charEntry) return;
    let starredCount = 0;
    let notedCount = 0;
    charEntry.saves = charEntry.saves.map((s) => {
      const meta = this.adapter.getSaveMeta(avatar, s.chatId);
      if (meta.starred) starredCount += 1;
      if (meta.note || meta.tags.length > 0) notedCount += 1;
      return { ...s, meta };
    });
    charEntry.starredCount = starredCount;
    charEntry.notedCount = notedCount;
    this.renderGlobalStats();
    this.renderSidebar();
  }

  renderGlobalStats() {
    const statsEl = this.backdropEl.querySelector('[data-role="global-stats"]');
    const totalChars = this.overviewList.length;
    const totalSaves = this.overviewList.reduce((sum, c) => sum + c.saveCount, 0);
    const multiBranchChars = this.overviewList.filter((c) => c.saveCount >= 2).length;
    const totalStarred = this.overviewList.reduce((sum, c) => sum + c.starredCount, 0);

    statsEl.innerHTML = `
      <span class="st-sbm-stat-pill"><strong>${totalChars}</strong>张角色卡</span>
      <span class="st-sbm-stat-pill"><strong>${totalSaves}</strong>个存档</span>
      <span class="st-sbm-stat-pill"><strong>${multiBranchChars}</strong>张含多分支</span>
      <span class="st-sbm-stat-pill"><strong>${totalStarred}</strong>个星标收藏</span>
    `;
  }

  matchesSearch(charItem, saveItem = null) {
    if (!this.searchQuery) return true;
    const q = this.searchQuery;
    if (charItem.name.toLowerCase().includes(q)) return true;

    const checkSave = (s) => {
      const meta = s.meta || {};
      return (
        s.chatId.toLowerCase().includes(q) ||
        (meta.customTitle || '').toLowerCase().includes(q) ||
        (meta.note || '').toLowerCase().includes(q) ||
        (meta.tags || []).some((t) => t.toLowerCase().includes(q)) ||
        (s.previewText || '').toLowerCase().includes(q)
      );
    };

    if (saveItem) return checkSave(saveItem);
    return charItem.saves.some(checkSave);
  }

  bindAvatarFallbacks(container) {
    container.querySelectorAll('img.st-sbm-char-avatar').forEach((img) => {
      img.addEventListener('error', () => {
        const fb = img.dataset?.fallback;
        if (fb && img.src !== fb) {
          img.dataset.fallback = '';
          img.src = fb;
        } else {
          img.style.opacity = '0.2';
        }
      });
    });
  }

  renderSidebar() {
    const listEl = this.backdropEl.querySelector('[data-role="sidebar-list"]');

    if (this.sidebarTab === 'bookmarks') {
      const starredItems = [];
      for (const ch of this.overviewList) {
        for (const s of ch.saves) {
          if (s.meta?.starred && this.matchesSearch(ch, s)) {
            starredItems.push({ ch, save: s });
          }
        }
      }

      if (starredItems.length === 0) {
        listEl.innerHTML = `<div class="st-sbm-empty-state">暂无匹配的星标存档。<br/>在分支节点上点击 ★ 即可收入全局书签库。</div>`;
        return;
      }

      listEl.innerHTML = starredItems
        .map(({ ch, save }) => {
          const isSelected = this.currentCharacter?.avatar === ch.avatar && this.selectedChatId === save.chatId;
          const displayTitle = save.meta.customTitle || prettifySaveName(save.chatId);
          return `
            <div class="st-sbm-char-item ${isSelected ? 'is-selected' : ''}" data-bookmark-avatar="${escapeHtml(ch.avatar)}" data-bookmark-chat="${escapeHtml(save.chatId)}">
              <img class="st-sbm-char-avatar" loading="lazy" src="${escapeHtml(ch.avatarSrc)}" data-fallback="${escapeHtml(ch.avatarFallbackSrc || '')}" alt="${escapeHtml(ch.name)}" />
              <div class="st-sbm-char-info">
                <div class="st-sbm-char-name-row">
                  <span class="st-sbm-char-name">★ ${escapeHtml(displayTitle)}</span>
                </div>
                <div class="st-sbm-char-meta">
                  <span>${escapeHtml(ch.name)}</span>
                  <span class="st-sbm-badge-mini">${save.messageCount} 楼</span>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      this.bindAvatarFallbacks(listEl);
      listEl.querySelectorAll('[data-bookmark-avatar]').forEach((el) => {
        el.addEventListener('click', () => {
          this.selectCharacter(el.dataset.bookmarkAvatar, el.dataset.bookmarkChat);
        });
      });
      return;
    }

    // 角色卡总览列表
    const filtered = this.overviewList.filter((ch) => {
      if (this.charFilter === 'multi' && ch.saveCount < 2) return false;
      if (this.charFilter === 'starred' && ch.starredCount < 1) return false;
      return this.matchesSearch(ch);
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="st-sbm-empty-state">没有符合筛选条件的角色卡</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((ch) => {
        const isSelected = this.currentCharacter?.avatar === ch.avatar;
        const timeText = formatShortTime(ch.latestTimestamp);
        return `
          <div class="st-sbm-char-item ${isSelected ? 'is-selected' : ''}" data-char-avatar="${escapeHtml(ch.avatar)}">
            <img class="st-sbm-char-avatar" loading="lazy" src="${escapeHtml(ch.avatarSrc)}" data-fallback="${escapeHtml(ch.avatarFallbackSrc || '')}" alt="${escapeHtml(ch.name)}" />
            <div class="st-sbm-char-info">
              <div class="st-sbm-char-name-row">
                ${ch.isCurrentCharacter ? '<span class="st-sbm-live-dot" title="酒馆当前打开的角色"></span>' : ''}
                <span class="st-sbm-char-name">${escapeHtml(ch.name)}</span>
              </div>
              <div class="st-sbm-char-meta">
                <span class="st-sbm-badge-mini">${ch.saveCount} 存档</span>
                ${ch.starredCount > 0 ? `<span class="st-sbm-badge-mini st-sbm-badge-star">★ ${ch.starredCount}</span>` : ''}
                ${timeText ? `<span>${escapeHtml(timeText)}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    this.bindAvatarFallbacks(listEl);
    listEl.querySelectorAll('[data-char-avatar]').forEach((el) => {
      el.addEventListener('click', () => {
        this.selectCharacter(el.dataset.charAvatar);
      });
    });
  }

  async selectCharacter(avatar, preferredChatId = null, forceRefresh = false) {
    const charEntry = this.overviewList.find((c) => c.avatar === avatar);
    if (!charEntry) return;

    this.flushPendingNoteSaves(null, { skipCenterRender: true });

    const requestId = ++this.selectRequestSeq;
    this.currentCharacter = charEntry;
    // 切换角色期间清空旧角色的画布与选中状态，防止在加载中误把旧存档提交给新角色
    this.currentGraph = null;
    this.selectedChatId = null;
    this.renderSidebar();

    const titleEl = this.backdropEl.querySelector('[data-role="canvas-title"]');
    const subEl = this.backdropEl.querySelector('[data-role="canvas-subtitle"]');
    const stageEl = this.backdropEl.querySelector('[data-role="stage"]');
    const listViewEl = this.backdropEl.querySelector('[data-role="list-view"]');
    titleEl.textContent = charEntry.name;
    subEl.textContent = '正在分析存档楼层与分支点...';
    if (stageEl) {
      stageEl.innerHTML = `<div class="st-sbm-empty-state" style="width:420px;">正在加载「${escapeHtml(charEntry.name)}」的存档分支...</div>`;
    }
    if (listViewEl) {
      listViewEl.innerHTML = `<div class="st-sbm-empty-state">正在加载「${escapeHtml(charEntry.name)}」的存档列表...</div>`;
    }
    this.renderInspector();

    let digests;
    try {
      digests = await this.adapter.getCharacterChatDigests(charEntry, charEntry.saves, forceRefresh);
    } catch (err) {
      if (requestId !== this.selectRequestSeq || this.currentCharacter?.avatar !== charEntry.avatar) {
        return;
      }
      subEl.textContent = `加载存档失败：${err.message || err}`;
      if (stageEl) {
        stageEl.innerHTML = `<div class="st-sbm-empty-state" style="width:420px;">加载存档失败：${escapeHtml(err.message || String(err))}</div>`;
      }
      return;
    }

    // 竞态防护：若期间已切换至其他角色或发起更新请求，直接丢弃过期响应
    if (requestId !== this.selectRequestSeq || this.currentCharacter?.avatar !== charEntry.avatar) {
      return;
    }

    const graph = buildCharacterBranchGraph(charEntry, digests);
    graph.characterAvatar = charEntry.avatar;
    this.currentGraph = graph;

    subEl.textContent = `共 ${graph.nodes.length} 个存档 · ${graph.rootCount} 条独立开局 · 识别出 ${graph.branchCount} 处剧情分叉`;

    // 选择默认高亮存档节点
    const targetNode =
      (preferredChatId && graph.nodes.find((n) => n.chatId === stripJsonl(preferredChatId))) ||
      graph.nodes.find((n) => n.isActive) ||
      graph.nodes.find((n) => n.isCharacterLastChat) ||
      graph.nodes[0] ||
      null;

    this.selectedChatId = targetNode ? targetNode.chatId : null;
    if (this.sidebarTab === 'bookmarks') {
      this.renderSidebar();
    }
    this.renderCenterView(true);
    this.renderInspector();
  }

  renderCenterView(autoFit = false) {
    const viewport = this.backdropEl.querySelector('[data-role="viewport"]');
    const listView = this.backdropEl.querySelector('[data-role="list-view"]');

    if (this.canvasMode === 'tree') {
      viewport.hidden = false;
      listView.hidden = true;
      this.renderTreeStage();
      if (autoFit) {
        requestAnimationFrame(() => this.fitCanvas());
      }
    } else {
      viewport.hidden = true;
      listView.hidden = false;
      this.renderTimelineList();
    }
  }

  renderTreeStage() {
    const stage = this.backdropEl.querySelector('[data-role="stage"]');
    const graph = this.currentGraph;

    if (!graph || graph.nodes.length === 0) {
      stage.innerHTML = `<div class="st-sbm-empty-state" style="width:420px;">该角色卡下暂无聊天存档</div>`;
      return;
    }

    stage.style.width = `${graph.canvasWidth}px`;
    stage.style.height = `${graph.canvasHeight}px`;

    // 计算当前选中节点的祖先链以高亮路径
    const highlightedEdges = new Set();
    if (this.selectedChatId) {
      const map = new Map(graph.nodes.map((n) => [n.chatId, n]));
      let cur = map.get(this.selectedChatId);
      while (cur && cur.parentId) {
        highlightedEdges.add(`${cur.parentId}->${cur.chatId}`);
        cur = map.get(cur.parentId);
      }
    }

    const svgPaths = graph.edges
      .map((edge) => {
        const hl = highlightedEdges.has(edge.id) ? 'is-highlighted' : '';
        return `<path class="st-sbm-edge-path ${hl}" d="${edge.path}" />`;
      })
      .join('');

    const edgeBadges = graph.edges
      .map((edge) => {
        const hl = highlightedEdges.has(edge.id) ? 'is-highlighted' : '';
        const label = edge.isExactCopy
          ? `📋 完整副本`
          : edge.isCheckpointSnapshot
          ? `📌 #${edge.branchFloor} 楼检查点`
          : `⚡ #${edge.branchFloor} 楼分叉`;
        return `<div class="st-sbm-edge-badge ${hl}" style="left:${edge.badgeX}px; top:${edge.badgeY}px;">${label}</div>`;
      })
      .join('');

    const ownerCharacter = this.currentCharacter;
    const ownerAvatar = ownerCharacter?.avatar || '';
    if (!ownerCharacter || (graph.characterAvatar && graph.characterAvatar !== ownerAvatar)) {
      return;
    }

    const nodeCards = graph.nodes
      .map((node) => {
        const meta = this.adapter.getSaveMeta(ownerAvatar, node.chatId);
        const title = meta.customTitle || prettifySaveName(node.chatId);
        const isSelected = node.chatId === this.selectedChatId;
        const isSearchDimmed =
          this.searchQuery &&
          !this.matchesSearch(ownerCharacter, {
            ...node,
            meta,
            previewText: node.lastFloorSnippet,
          });

        const typePill = node.branchMoment
          ? node.branchMoment.isCheckpointSnapshot
            ? `<span class="st-sbm-pill st-sbm-pill-branch">📌 #${node.branchMoment.branchFloor} 楼检查点</span>`
            : `<span class="st-sbm-pill st-sbm-pill-branch">🔀 #${node.branchMoment.branchFloor} 楼分叉</span>`
          : `<span class="st-sbm-pill st-sbm-pill-root">🌱 开局主干</span>`;

        const activePill = node.isActive
          ? `<span class="st-sbm-pill st-sbm-pill-active">当前游玩</span>`
          : node.isCharacterLastChat
          ? `<span class="st-sbm-pill st-sbm-pill-floors">上次停留</span>`
          : '';

        const summaryLine =
          node.branchMoment && node.branchMoment.childNextSnippet
            ? `↳ ${node.branchMoment.childNextSpeaker}：${node.branchMoment.childNextSnippet}`
            : node.lastFloorSnippet;

        const tagsHtml = (meta.tags || [])
          .slice(0, 3)
          .map((t) => `<span class="st-sbm-tag-mini">#${escapeHtml(t)}</span>`)
          .join('');

        return `
          <div class="st-sbm-node ${isSelected ? 'is-selected' : ''} ${node.isActive ? 'is-active-save' : ''}"
               data-node-id="${escapeHtml(node.chatId)}"
               style="left:${node.x}px; top:${node.y}px; ${isSearchDimmed ? 'opacity:0.35;' : ''}"
               title="单击查看分叉详情，双击直接切换到该存档">
            <div>
              <div class="st-sbm-node-header">
                <div class="st-sbm-node-pills">
                  ${typePill}
                  <span class="st-sbm-pill st-sbm-pill-floors">${node.floorCount} 楼</span>
                  ${activePill}
                </div>
                <button type="button" class="st-sbm-star-btn ${meta.starred ? 'is-starred' : ''}" data-star-id="${escapeHtml(node.chatId)}" title="星标收藏">
                  ${meta.starred ? '★' : '☆'}
                </button>
              </div>
              <div class="st-sbm-node-title">${escapeHtml(title)}</div>
            </div>

            <div class="st-sbm-node-snippet">${escapeHtml(summaryLine)}</div>

            <div class="st-sbm-node-footer">
              <div class="st-sbm-node-tags">${tagsHtml}</div>
              <span>${meta.note ? '📝 ' : ''}${escapeHtml(formatShortTime(node.lastModified))}</span>
            </div>
          </div>
        `;
      })
      .join('');

    stage.innerHTML = `
      <svg class="st-sbm-edges-svg" width="${graph.canvasWidth}" height="${graph.canvasHeight}">
        ${svgPaths}
      </svg>
      ${edgeBadges}
      ${nodeCards}
    `;

    // 绑定节点点击、双击与快捷星标事件
    stage.querySelectorAll('[data-star-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.currentCharacter || this.currentCharacter.avatar !== ownerAvatar) return;
        this.flushPendingNoteSaves(null, { skipCenterRender: true });
        const chatId = btn.dataset.starId;
        const cur = this.adapter.getSaveMeta(ownerAvatar, chatId);
        this.adapter.updateSaveMeta(ownerAvatar, chatId, { starred: !cur.starred });
        this.syncOverviewMetaCounts(ownerAvatar);
        this.renderTreeStage();
        if (this.selectedChatId === chatId) this.renderInspector();
      });
    });

    stage.querySelectorAll('[data-node-id]').forEach((card) => {
      card.addEventListener('click', () => {
        if (!this.currentCharacter || this.currentCharacter.avatar !== ownerAvatar) return;
        this.flushPendingNoteSaves(null, { skipCenterRender: true });
        this.selectedChatId = card.dataset.nodeId;
        if (this.sidebarTab === 'bookmarks') this.renderSidebar();
        this.renderTreeStage();
        this.renderInspector();
      });
      card.addEventListener('dblclick', () => {
        if (!this.currentCharacter || this.currentCharacter.avatar !== ownerAvatar) return;
        this.handleJump(card.dataset.nodeId, ownerCharacter);
      });
    });

    this.applyStageTransform();
  }

  renderTimelineList() {
    const listView = this.backdropEl.querySelector('[data-role="list-view"]');
    const graph = this.currentGraph;
    const ownerCharacter = this.currentCharacter;
    if (!graph || graph.nodes.length === 0 || !ownerCharacter || (graph.characterAvatar && graph.characterAvatar !== ownerCharacter.avatar)) {
      listView.innerHTML = `<div class="st-sbm-empty-state">该角色卡下暂无聊天存档</div>`;
      return;
    }

    const ownerAvatar = ownerCharacter.avatar;
    const sorted = [...graph.nodes].sort(
      (a, b) => (parseSillyTavernTimestamp(b.lastModified) || 0) - (parseSillyTavernTimestamp(a.lastModified) || 0)
    );
    listView.innerHTML = sorted
      .map((node) => {
        const meta = this.adapter.getSaveMeta(ownerAvatar, node.chatId);
        const title = meta.customTitle || prettifySaveName(node.chatId);
        const isSelected = node.chatId === this.selectedChatId;
        const isSearchDimmed =
          this.searchQuery &&
          !this.matchesSearch(ownerCharacter, {
            ...node,
            meta,
            previewText: node.lastFloorSnippet,
          });
        const branchBadge = node.branchMoment
          ? node.branchMoment.isCheckpointSnapshot
            ? `<span class="st-sbm-pill st-sbm-pill-branch">📌 #${node.branchMoment.branchFloor} 楼检查点</span>`
            : `<span class="st-sbm-pill st-sbm-pill-branch">🔀 从 #${node.branchMoment.branchFloor} 楼分叉</span>`
          : `<span class="st-sbm-pill st-sbm-pill-root">🌱 开局主干</span>`;

        return `
          <div class="st-sbm-list-row ${isSelected ? 'is-selected' : ''}" data-list-node="${escapeHtml(node.chatId)}" style="${isSearchDimmed ? 'opacity:0.35;' : ''}">
            <div style="min-width:0; flex:1;">
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
                <span style="color:var(--sbm-amber);">${meta.starred ? '★' : ''}</span>
                <strong style="font-size:14px;">${escapeHtml(title)}</strong>
                ${branchBadge}
                <span class="st-sbm-pill st-sbm-pill-floors">${node.floorCount} 楼</span>
                ${node.isActive ? '<span class="st-sbm-pill st-sbm-pill-active">当前游玩</span>' : ''}
              </div>
              <div style="font-size:12px; color:var(--sbm-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${escapeHtml(node.lastFloorSnippet)}
              </div>
            </div>
            <div style="text-align:right; font-size:12px; color:var(--sbm-text-muted); flex-shrink:0;">
              <div>${escapeHtml(formatShortTime(node.lastModified))}</div>
              <div style="margin-top:4px;">${escapeHtml(node.fileSize || '')}</div>
            </div>
          </div>
        `;
      })
      .join('');

    listView.querySelectorAll('[data-list-node]').forEach((row) => {
      row.addEventListener('click', () => {
        if (!this.currentCharacter || this.currentCharacter.avatar !== ownerAvatar) return;
        this.flushPendingNoteSaves(null, { skipCenterRender: true });
        this.selectedChatId = row.dataset.listNode;
        if (this.sidebarTab === 'bookmarks') this.renderSidebar();
        this.renderTimelineList();
        this.renderInspector();
      });
      row.addEventListener('dblclick', () => {
        if (!this.currentCharacter || this.currentCharacter.avatar !== ownerAvatar) return;
        this.handleJump(row.dataset.listNode, ownerCharacter);
      });
    });
  }

  applyStageTransform() {
    const stage = this.backdropEl.querySelector('[data-role="stage"]');
    const zoomLabel = this.backdropEl.querySelector('[data-role="zoom-label"]');
    if (stage) {
      stage.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px) scale(${this.scale.toFixed(3)})`;
    }
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }

  setZoom(nextScale, originX = null, originY = null) {
    const clamped = Math.min(1.6, Math.max(0.45, nextScale));
    const viewport = this.backdropEl.querySelector('[data-role="viewport"]');
    const cx = originX ?? viewport.clientWidth / 2;
    const cy = originY ?? viewport.clientHeight / 2;

    const ratio = clamped / this.scale;
    this.panX = cx - (cx - this.panX) * ratio;
    this.panY = cy - (cy - this.panY) * ratio;
    this.scale = clamped;
    this.applyStageTransform();
  }

  fitCanvas() {
    const viewport = this.backdropEl.querySelector('[data-role="viewport"]');
    const graph = this.currentGraph;
    if (!viewport || !graph || viewport.clientWidth === 0 || viewport.clientHeight === 0) return;

    const scaleX = (viewport.clientWidth - 48) / graph.canvasWidth;
    const scaleY = (viewport.clientHeight - 48) / graph.canvasHeight;
    this.scale = Math.min(1, Math.max(0.45, Math.min(scaleX, scaleY)));
    this.panX = Math.max(20, Math.round((viewport.clientWidth - graph.canvasWidth * this.scale) / 2));
    this.panY = Math.max(20, Math.round((viewport.clientHeight - graph.canvasHeight * this.scale) / 2));
    this.applyStageTransform();
  }

  renderInspector() {
    const insp = this.backdropEl.querySelector('[data-role="inspector"]');
    if (
      !this.currentCharacter ||
      !this.currentGraph ||
      !this.selectedChatId ||
      (this.currentGraph.characterAvatar && this.currentGraph.characterAvatar !== this.currentCharacter.avatar)
    ) {
      insp.innerHTML = `<div class="st-sbm-empty-state">点击中间画布上的任意存档节点，查看分叉楼层对比与备注。</div>`;
      return;
    }

    const node = this.currentGraph.nodes.find((n) => n.chatId === this.selectedChatId);
    if (!node) return;

    const ownerCharacter = this.currentCharacter;
    const avatar = ownerCharacter.avatar;
    const meta = this.adapter.getSaveMeta(avatar, node.chatId);
    const parentNode = node.parentId ? this.currentGraph.nodes.find((n) => n.chatId === node.parentId) : null;
    const parentTitle = parentNode
      ? this.adapter.getSaveMeta(avatar, parentNode.chatId).customTitle || prettifySaveName(parentNode.chatId)
      : '';

    let branchSectionHtml = '';
    if (node.branchMoment && parentNode) {
      const bm = node.branchMoment;
      const parentNextHtml = bm.parentNextSnippet
        ? `<div class="st-sbm-diff-box is-parent-next">
             <div class="st-sbm-diff-label">原存档后续 (第 ${bm.branchFloor + 1} 楼 · ${escapeHtml(bm.parentNextSpeaker)})</div>
             <div>${escapeHtml(bm.parentNextSnippet)}</div>
           </div>`
        : `<div class="st-sbm-diff-box is-parent-next">
             <div class="st-sbm-diff-label">原存档状态</div>
             <div>父存档在此第 ${bm.branchFloor} 楼定格（作为检查点存档）</div>
           </div>`;

      const childNextHtml = bm.childNextSnippet
        ? `<div class="st-sbm-diff-box is-child-next">
             <div class="st-sbm-diff-label">⚡ 本分支新走向 (第 ${bm.branchFloor + 1} 楼 · ${escapeHtml(bm.childNextSpeaker)})</div>
             <div>${escapeHtml(bm.childNextSnippet)}</div>
           </div>`
        : `<div class="st-sbm-diff-box is-child-next">
             <div class="st-sbm-diff-label">本分支状态</div>
             <div>${
               bm.isCheckpointSnapshot
                 ? `在父存档第 ${bm.branchFloor} 楼处定格（检查点存档）`
                 : `与父存档前 ${bm.branchFloor} 楼完全一致（备份存档）`
             }</div>
           </div>`;

      branchSectionHtml = `
        <section class="st-sbm-section">
          <div class="st-sbm-section-title">
            <span>${bm.isCheckpointSnapshot ? `📌 检查点 · 第 ${bm.branchFloor} 楼` : `🔀 分叉时刻 · 第 ${bm.branchFloor} 楼`}</span>
            <button type="button" class="st-sbm-link-btn" data-select-parent="${escapeHtml(parentNode.chatId)}">
              源头：${escapeHtml(parentTitle)}
            </button>
          </div>
          <div class="st-sbm-diff-box is-anchor">
            <div class="st-sbm-diff-label">分叉前最后共同剧情 (第 ${bm.branchFloor} 楼 · ${escapeHtml(bm.anchorSpeaker)})</div>
            <div>${escapeHtml(bm.anchorSnippet || '无文本摘要')}</div>
          </div>
          ${parentNextHtml}
          ${childNextHtml}
        </section>
      `;
    } else {
      const firstFloor = node.floors[0];
      branchSectionHtml = `
        <section class="st-sbm-section">
          <div class="st-sbm-section-title">
            <span>🌱 开局起点主干</span>
            <span>派生子分支：${node.childrenIds.length} 个</span>
          </div>
          <div class="st-sbm-diff-box is-anchor">
            <div class="st-sbm-diff-label">开场白 (第 1 楼 · ${escapeHtml(firstFloor?.name || '开局')})</div>
            <div>${escapeHtml(firstFloor?.snippet || '暂无消息')}</div>
          </div>
        </section>
      `;
    }

    const allTags = Array.from(new Set([...PRESET_TAGS, ...(meta.tags || [])]));
    const tagsChipsHtml = allTags
      .map((tag) => {
        const selected = (meta.tags || []).includes(tag);
        return `<button type="button" class="st-sbm-tag-chip ${selected ? 'is-selected' : ''}" data-toggle-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`;
      })
      .join('');

    const tailFloors = node.floors.slice(-3);
    const tailHtml = tailFloors
      .map(
        (f) => `
        <div class="st-sbm-tail-msg">
          <strong>#${f.floor} ${escapeHtml(f.name)}：</strong>${escapeHtml(f.snippet)}
        </div>
      `
      )
      .join('');

    insp.innerHTML = `
      <div class="st-sbm-insp-header">
        <input type="text" class="st-sbm-title-input" data-role="custom-title"
               value="${escapeHtml(meta.customTitle)}"
               placeholder="${escapeHtml(prettifySaveName(node.chatId))} (点击设置易记别名)" />
        <div class="st-sbm-file-sub">
          文件：${escapeHtml(node.chatId)}.jsonl · 共 ${node.floorCount} 楼 ${node.fileSize ? `· ${escapeHtml(node.fileSize)}` : ''}
        </div>
      </div>

      <div class="st-sbm-cta-row">
        <button type="button" class="st-sbm-btn st-sbm-btn-primary st-sbm-cta-jump" data-role="jump-btn">
          ${node.isActive ? '✅ 当前正在此存档中' : '🚀 切换到此存档继续游玩'}
        </button>
        <button type="button" class="st-sbm-btn" data-role="insp-star-btn" title="收藏到全局星标库">
          ${meta.starred ? '⭐ 已星标' : '☆ 星标'}
        </button>
      </div>

      ${branchSectionHtml}

      <section class="st-sbm-section">
        <div class="st-sbm-section-title">
          <span>🏷️ 分支标签</span>
        </div>
        <div class="st-sbm-tags-wrap">${tagsChipsHtml}</div>
        <div class="st-sbm-custom-tag-row">
          <input type="text" class="st-sbm-small-input" data-role="new-tag-input" placeholder="输入自定义标签回车添加..." />
          <button type="button" class="st-sbm-btn" data-role="add-tag-btn">添加</button>
        </div>
      </section>

      <section class="st-sbm-section">
        <div class="st-sbm-section-title">
          <span>📝 剧情进度备注</span>
          <span data-role="save-status" style="font-weight:400; font-size:11px; color:var(--sbm-text-muted);">自动保存</span>
        </div>
        <textarea class="st-sbm-note-textarea" data-role="note-input" placeholder="记录这条分支的攻略路线、世界书开关状态或待填的坑...">${escapeHtml(meta.note)}</textarea>
      </section>

      <section class="st-sbm-section">
        <div class="st-sbm-section-title">
          <span>💬 存档末尾进度预览</span>
        </div>
        ${tailHtml || '<div style="font-size:12px;color:var(--sbm-text-muted);">暂无聊天记录</div>'}
      </section>
    `;

    // 绑定检查器交互事件
    const noteSaveKey = `${avatar}::${stripJsonl(node.chatId)}`;
    const titleInput = insp.querySelector('[data-role="custom-title"]');
    titleInput.addEventListener('input', () => {
      this.pendingTitleSave = {
        avatar,
        chatId: node.chatId,
        value: titleInput.value.trim(),
      };
    });
    titleInput.addEventListener('change', () => {
      this.pendingTitleSave = {
        avatar,
        chatId: node.chatId,
        value: titleInput.value.trim(),
      };
      this.flushPendingNoteSaves(noteSaveKey, { skipCenterRender: true });
      this.flushPendingTitleSave();
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleInput.blur?.();
        this.pendingTitleSave = {
          avatar,
          chatId: node.chatId,
          value: titleInput.value.trim(),
        };
        this.flushPendingTitleSave();
      }
    });

    insp.querySelector('[data-role="insp-star-btn"]').addEventListener('click', () => {
      this.flushPendingNoteSaves(noteSaveKey, { skipCenterRender: true });
      const cur = this.adapter.getSaveMeta(avatar, node.chatId);
      this.adapter.updateSaveMeta(avatar, node.chatId, { starred: !cur.starred });
      this.syncOverviewMetaCounts(avatar);
      this.renderCenterView();
      this.renderInspector();
    });

    insp.querySelector('[data-role="jump-btn"]').addEventListener('click', () => {
      this.handleJump(node.chatId, ownerCharacter);
    });

    const parentBtn = insp.querySelector('[data-select-parent]');
    if (parentBtn) {
      parentBtn.addEventListener('click', () => {
        this.flushPendingNoteSaves(null, { skipCenterRender: true });
        this.selectedChatId = parentBtn.dataset.selectParent;
        this.renderCenterView();
        this.renderInspector();
      });
    }

    insp.querySelectorAll('[data-toggle-tag]').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.flushPendingNoteSaves(noteSaveKey, { skipCenterRender: true });
        const tag = chip.dataset.toggleTag;
        const curTags = new Set(this.adapter.getSaveMeta(avatar, node.chatId).tags);
        if (curTags.has(tag)) curTags.delete(tag);
        else curTags.add(tag);
        this.adapter.updateSaveMeta(avatar, node.chatId, { tags: Array.from(curTags) });
        this.syncOverviewMetaCounts(avatar);
        this.renderCenterView();
        this.renderInspector();
      });
    });

    const addCustomTag = () => {
      const input = insp.querySelector('[data-role="new-tag-input"]');
      const val = input.value.trim().replace(/^#/, '');
      if (!val) return;
      this.flushPendingNoteSaves(noteSaveKey, { skipCenterRender: true });
      const curTags = new Set(this.adapter.getSaveMeta(avatar, node.chatId).tags);
      curTags.add(val);
      this.adapter.updateSaveMeta(avatar, node.chatId, { tags: Array.from(curTags) });
      this.syncOverviewMetaCounts(avatar);
      this.renderCenterView();
      this.renderInspector();
    };

    insp.querySelector('[data-role="add-tag-btn"]').addEventListener('click', addCustomTag);
    insp.querySelector('[data-role="new-tag-input"]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addCustomTag();
      }
    });

    const noteInput = insp.querySelector('[data-role="note-input"]');
    const statusEl = insp.querySelector('[data-role="save-status"]');
    noteInput.addEventListener('input', () => {
      statusEl.textContent = '正在输入...';
      const existing = this.pendingNoteSaves.get(noteSaveKey);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const value = noteInput.value.trim();
      const timer = setTimeout(() => {
        this.flushPendingNoteSaves(noteSaveKey);
      }, 320);
      this.pendingNoteSaves.set(noteSaveKey, {
        avatar,
        chatId: node.chatId,
        value,
        timer,
        statusEl,
      });
    });
    noteInput.addEventListener('blur', () => {
      this.flushPendingNoteSaves(noteSaveKey);
    });
  }

  async handleJump(chatId, characterOverride = null) {
    const targetCharacter = characterOverride || this.currentCharacter;
    if (!targetCharacter) return;
    if (
      this.currentGraph?.characterAvatar &&
      this.currentGraph.characterAvatar !== targetCharacter.avatar
    ) {
      return;
    }
    this.flushPendingNoteSaves(null, { skipCenterRender: true });
    try {
      await this.adapter.jumpToSave(targetCharacter, chatId);
      const meta = this.adapter.getSaveMeta(targetCharacter.avatar, chatId);
      const label = meta.customTitle || prettifySaveName(chatId);
      this.showToast(`已切换至「${targetCharacter.name} · ${label}」`);
      this.close();
    } catch (err) {
      this.showToast(`切换存档失败：${err.message}`);
    }
  }
}
