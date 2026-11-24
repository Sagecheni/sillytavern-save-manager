/**
 * 存档与分支管理器 UI 控制器
 * 三栏：角色 · 故事线 · 阅读页
 */

import { buildCharacterBranchGraph } from './branchEngine.js';
import { stripJsonl, parseSillyTavernTimestamp } from './adapter.js';

const PRESET_TAGS = ['主线', '高甜', '刀子', 'IF线', 'HE', 'BE', '待填坑'];

// 故事线几何（与 style.css 中 .st-sbm-row 的高度保持一致）
const RAIL = { rowHeight: 64, laneWidth: 18, maxSpread: 90, inset: 20, gutter: 18, treeGap: 20 };

const svgIcon = (body, width = 1.8) =>
  `<svg class="st-sbm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const STAR_PATH =
  '<path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.8-5.4 2.8 1-6L3.2 9.6l6.1-.9z"/>';

const ICONS = {
  search: svgIcon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>', 2),
  close: svgIcon('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 2.1),
  back: svgIcon('<path d="M14.5 5l-7 7 7 7"/>', 2.2),
  chevron: svgIcon('<path d="M9.5 6l6 6-6 6"/>', 2.2),
  plus: svgIcon('<path d="M12 5.5v13M5.5 12h13"/>', 2.1),
  check: svgIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.3),
  star: svgIcon(STAR_PATH),
  starFill: svgIcon(STAR_PATH).replace('fill="none"', 'fill="currentColor"'),
};

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TIMESTAMP_RE =
  /(\d{4})-(\d{1,2})-(\d{1,2})[\s@_T-]*(\d{1,2})\s*[h:.\-_]\s*(\d{1,2})(?:\s*[m:.\-_]\s*\d{1,2}(?!\d))?(?:\s*m)?(?:\s*s)?(?:\s*\d{1,3}\s*ms)?/i;

/**
 * 从存档文件名中取出用户真正起的名字。
 * 酒馆自动生成的部分（角色名、时间戳、Branch / Checkpoint 编号）一律剥除，剥完为空即视为未命名。
 */
function extractSaveName(chatId = '', characterNames = []) {
  let label = stripJsonl(chatId).replace(TIMESTAMP_RE, ' ');
  for (const name of characterNames) {
    if (name && label.startsWith(name) && /^(\s*[-_]|\s*$)/.test(label.slice(name.length))) {
      label = label.slice(name.length);
      break;
    }
  }
  return label
    .replace(/\b(?:Branch|Checkpoint)\s*#?\d*/gi, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '');
}

function fallbackSaveName(chatId = '') {
  const label = extractSaveName(chatId);
  if (label) return label;
  const [, , month, day, hh, mm] = stripJsonl(chatId).match(TIMESTAMP_RE) || [];
  if (month) return `${Number(month)}月${Number(day)}日 ${hh.padStart(2, '0')}:${mm}`;
  return stripJsonl(chatId) || '未命名';
}

/** 去掉 Markdown 记号，只留可读的正文 */
function plainText(text = '') {
  return String(text)
    .replace(/[*_~`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取开头的短句作标题，太短的感叹会连到下一句；宽度按中文 1、西文 0.5 计 */
function headline(text = '') {
  let width = 0;
  let out = '';
  const source = plainText(text).replace(/["“”「」『』]/g, '').replace(/^[\s'‘’…—-]+/, '');
  for (const ch of source) {
    if (width >= 6 && /[。！？!?；;，,：:、.…]/.test(ch)) break;
    width += ch.charCodeAt(0) > 0xff ? 1 : 0.5;
    if (width > 18) return `${out.trim()}…`;
    out += ch;
  }
  return out.replace(/[\s。，,.；;：:、]+$/, '');
}

/** 整楼只有一对方括号的报错 / 空回复，如 [The message is empty] */
const isPlaceholder = (text) => /^[[【(（][^\]】)）]*[\]】)）]$/.test(text);

/**
 * 找出反复出现的固定开头（预设包裹的「以下是用户的本轮输入：」之类）。
 * 先按前 6 个字分组，再取每组的最长公共前缀；同一楼在多个存档里重复出现只算一次。
 */
function findBoilerplate(nodes) {
  const groups = new Map();
  const seen = new Set();
  for (const node of nodes) {
    for (const floor of node.floors) {
      if (seen.has(floor.hash)) continue;
      seen.add(floor.hash);
      const text = plainText(floor.snippet);
      if (text.length < 10) continue;
      const key = text.slice(0, 6);
      if (!groups.has(key)) groups.set(key, { count: 0, texts: new Set() });
      const group = groups.get(key);
      group.count += 1;
      group.texts.add(text);
    }
  }
  const prefixes = [];
  for (const { count, texts } of groups.values()) {
    if (texts.size < 5 || count < seen.size * 0.03) continue;
    const list = [...texts];
    let length = 0;
    while (list.every((t) => length < t.length && t[length] === list[0][length])) length += 1;
    // 退回到最近的标点，避免从词中间切断
    const shared = list[0].slice(0, length);
    const boundary = shared.search(/[\s。！？!?：:，,；;…」』”"】)）][^\s。！？!?：:，,；;…」』”"】)）]*$/) + 1;
    prefixes.push(boundary >= 6 ? shared.slice(0, boundary).trim() : shared);
  }
  return prefixes.sort((a, b) => b.length - a.length);
}

/** 多条走向的开头若相同，各自从第一处不同所在的句子读起 */
function trimSharedOpening(texts) {
  if (texts.length < 2) return texts;
  let shared = 0;
  while (texts.every((t) => shared < t.length && t[shared] === texts[0][shared])) shared += 1;
  if (shared < 12 || texts.some((t) => shared >= t.length)) return texts;
  const cut = Math.max(...['。', '！', '？', '，', '.', ',', ' '].map((p) => texts[0].lastIndexOf(p, shared - 1))) + 1;
  return cut > 0 ? texts.map((t) => `…${t.slice(cut).trim()}`) : texts;
}

function clockText(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 列表用短时间：今天显示时刻，往前依次为昨天、月日、年月日 */
function formatRelativeTime(input) {
  const ts = parseSillyTavernTimestamp(input);
  if (!ts || Number.isNaN(ts)) return '';
  const d = new Date(ts);
  const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0) return clockText(d);
  if (days === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatFullTime(input) {
  const ts = parseSillyTavernTimestamp(input);
  if (!ts || Number.isNaN(ts)) return '';
  const d = new Date(ts);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${clockText(d)}`;
}

/** 读取酒馆主题正文颜色：正文为深色说明宿主是浅色主题 */
function detectHostTheme() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim();
    if (!raw) return 'dark';
    const probe = document.createElement('span');
    probe.style.color = raw;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) || [];
    probe.remove();
    if (rgb.length < 3) return 'dark';
    const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return luminance < 110 ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function fitTextarea(el) {
  if (!el?.style) return;
  el.style.height = 'auto';
  if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
}

const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

const spinnerHtml = '<div class="st-sbm-empty"><span class="st-sbm-spinner"></span></div>';
const failureHtml = (err) =>
  `<div class="st-sbm-empty"><div>${escapeHtml(err?.message || String(err))}<button type="button" class="st-sbm-link" data-action="retry">重试</button></div></div>`;
const emptyHtml = (text) => `<div class="st-sbm-empty">${escapeHtml(text)}</div>`;

const tauriBackBridges = new WeakMap();

function getTauriBackBridge(win) {
  let bridge = tauriBackBridges.get(win);
  if (!bridge) {
    bridge = {
      openModals: [],
      registeredModals: [],
      installed: false,
      wrapper: null,
      prevHandler: null,
      retireWrapper: null,
      hostDisposer: null,
    };
    tauriBackBridges.set(win, bridge);
  }
  return bridge;
}

function getHostBackRegisterFn(win) {
  const api = win?.__TAURITAVERN__?.api;
  const candidates = [
    [api?.back, 'pushHandler'],
    [api?.back, 'push'],
    [api?.back, 'register'],
    [api?.navigation, 'pushBackHandler'],
    [api?.navigation, 'pushBackNavigationHandler'],
  ];
  for (const [owner, method] of candidates) {
    if (owner && typeof owner[method] === 'function') {
      return (handler) => owner[method](handler);
    }
  }
  return null;
}

function hasForegroundNativeDialog(rootEl) {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
  try {
    const dialogs = document.querySelectorAll('dialog[open]:not([closing])');
    for (const dialog of dialogs) {
      if (!rootEl || !rootEl.contains?.(dialog)) {
        return true;
      }
    }
  } catch {
    // ignore selector errors in minimal DOM environments
  }
  return false;
}

function isWrapperInBackChain(head, target) {
  if (!head || !target) return false;
  let cursor = head;
  const visited = new Set();
  for (let depth = 0; depth < 16 && typeof cursor === 'function'; depth += 1) {
    if (cursor === target) return true;
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    cursor =
      cursor.__stSbmPrevHandler ??
      cursor.__prevHandler ??
      cursor.__prev ??
      cursor.prevHandler ??
      cursor.previous ??
      null;
  }
  return false;
}

export class SaveBranchManagerModal {
  constructor(adapter) {
    this.adapter = adapter;
    this.backdropEl = null;
    this.overviewList = [];
    this.currentCharacter = null;
    this.currentGraph = null;
    this.selectedChatId = null;

    this.library = 'character'; // 'character' | 'starred'
    this.searchQuery = '';
    this.tagEditorOpen = false;
    this.inspectorKey = null;
    this.artKey = null;
    this.boilerplate = []; // 当前角色反复出现的固定开头
    this.autoTitles = new Map(); // `${avatar}::${chatId}` -> 未起别名时的标题

    this.pendingNoteSaves = new Map();
    this.pendingTitleSave = null;
    this.searchRefreshTimer = null;
    this.isJumping = false;
    this.hasLoadedOverview = false;
    this.selectRequestSeq = 0;
    this.refreshRequestSeq = 0;
    this.openSessionSeq = 0;
    this.layoutUnsubscribe = null;
    this.layoutSubSeq = 0;
    this.lastViewportWidth = null;
    this.fitInspectorRafId = null;
  }

  /* ---------------------------------------------------------------------- *
   * 辅助
   * ---------------------------------------------------------------------- */

  role(name) {
    return this.backdropEl.querySelector(`[data-role="${name}"]`);
  }

  /** 当前分支图；若它不属于当前角色（异步切换中）则视为不存在 */
  get activeGraph() {
    const graph = this.currentGraph;
    if (!graph || !this.currentCharacter) return null;
    if (graph.characterAvatar && graph.characterAvatar !== this.currentCharacter.avatar) return null;
    return graph;
  }

  saveTitle(avatar, chatId, allMeta = null) {
    const cleanId = stripJsonl(chatId);
    return (
      this.adapter.getSaveMeta(avatar, cleanId, allMeta).customTitle ||
      this.autoTitles.get(`${avatar}::${cleanId}`) ||
      this.summaryTitle(avatar, cleanId)
    );
  }

  /** 尚未读取过楼层时（如星标列表），用轻量摘要里的最后一句顶替 */
  summaryTitle(avatar, cleanId) {
    const ch = this.overviewList.find((c) => c.avatar === avatar);
    const label = extractSaveName(cleanId, [ch?.name]);
    if (label) return label;
    const save = ch?.saves?.find((s) => stripJsonl(s.chatId) === cleanId);
    return headline(save?.previewText) || fallbackSaveName(cleanId);
  }

  /**
   * 为整张分支图生成标题：有名字用名字；没有名字，或名字与其他存档雷同无法区分时，
   * 取这条线独有的第一句（分叉后的第一楼 / 开局后的第一次回应）
   */
  indexAutoTitles(character, graph) {
    this.boilerplate = findBoilerplate(graph.nodes);
    const labels = new Map(
      graph.nodes.map((n) => [n.chatId, extractSaveName(n.chatId, [character.name, n.header?.character_name])])
    );
    const counts = new Map();
    for (const label of labels.values()) counts.set(label, (counts.get(label) || 0) + 1);

    for (const node of graph.nodes) {
      const label = labels.get(node.chatId);
      const bm = node.branchMoment;
      const isDistinct = label && counts.get(label) === 1;
      node.isAutoNamed = !isDistinct;

      // 从这条线自己的第一楼往后找，跳过空回复和纯套话
      const start = bm ? (bm.isCheckpointSnapshot || bm.isExactCopy ? bm.branchFloor - 1 : bm.branchFloor) : 1;
      const candidates = [...node.floors.slice(start, start + 6), node.floors[0]].map((f) => this.gist(f?.snippet));
      const opening = candidates.find(
        (text) => headline(text).length >= 2 && !isPlaceholder(text) && !this.boilerplate.some((p) => text.startsWith(p))
      ) || node.previewText;
      const title = isDistinct ? label : headline(opening) || label || fallbackSaveName(node.chatId);
      this.autoTitles.set(`${character.avatar}::${node.chatId}`, title);
    }
  }

  /** 可读正文，去掉本角色反复出现的固定开头 */
  gist(text = '') {
    const plain = plainText(text);
    const prefix = this.boilerplate.find((p) => plain.startsWith(p));
    const rest = prefix ? plain.slice(prefix.length).replace(/^[\s:：,，.。!！>)\]】」]+/, '') : plain;
    return rest.length >= 2 ? rest : plain;
  }

  /** 窄屏下的导航层级：characters -> saves -> detail */
  setPane(pane) {
    if (!this.backdropEl) return;
    const prevPane = this.backdropEl.dataset.pane;
    if (prevPane === 'detail' && pane !== 'detail') {
      this.flushPendingNoteSaves(null, { skipCenterRender: true, preserveDom: true });
      const active = document.activeElement;
      if (active && this.backdropEl.contains?.(active) && typeof active.blur === 'function') {
        active.blur();
      }
    }
    const depth = ['characters', 'saves', 'detail'];
    this.backdropEl.dataset.nav = depth.indexOf(pane) < depth.indexOf(prevPane) ? 'pop' : 'push';
    this.backdropEl.dataset.pane = pane;
    this.fitInspectorFields();
  }

  /** 阅读页隐藏时量不到高度，切换层级或窗口尺寸变化后需重新量 */
  fitInspectorFields() {
    fitTextarea(this.role('custom-title'));
    fitTextarea(this.role('note-input'));
  }

  /** 将窗口 resize 与 Tauri 布局快照合并到单帧内重测，避免重复强制回流 */
  scheduleFitInspectorFields() {
    if (!this.backdropEl || this.backdropEl.hidden) return;
    if (this.fitInspectorRafId !== null) return;
    const run = () => {
      this.fitInspectorRafId = null;
      if (!this.backdropEl || this.backdropEl.hidden) return;
      this.fitInspectorFields();
    };
    if (typeof requestAnimationFrame === 'function') {
      this.fitInspectorRafId = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  cancelScheduledFitInspectorFields() {
    if (this.fitInspectorRafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.fitInspectorRafId);
      }
      this.fitInspectorRafId = null;
    }
  }

  /* ---------------------------------------------------------------------- *
   * 标题与备注的延迟落盘
   * ---------------------------------------------------------------------- */

  scheduleSearchRefresh() {
    if (!this.searchQuery) return;
    clearTimeout(this.searchRefreshTimer);
    this.searchRefreshTimer = setTimeout(() => {
      this.searchRefreshTimer = null;
      if (!this.backdropEl || this.backdropEl.hidden) return;
      this.renderSidebar();
      this.renderSaves();
    }, 0);
  }

  /** 仅就地更新文本，绝不重建交互容器 DOM，避免 blur/change 吞掉用户的第一次 click */
  patchSaveDisplayInPlace(avatar, chatId) {
    if (!this.backdropEl) return;
    const cleanId = stripJsonl(chatId);
    const title = this.saveTitle(avatar, cleanId);
    this.role('stage')
      ?.querySelectorAll('[data-save-id]')
      .forEach((row) => {
        if (row.dataset.saveAvatar !== avatar || stripJsonl(row.dataset.saveId) !== cleanId) return;
        const titleEl = row.querySelector('[data-role="row-title"]');
        if (titleEl) titleEl.textContent = title;
      });
  }

  flushPendingTitleSave({ skipCenterRender = false, preserveDom = true } = {}) {
    if (!this.pendingTitleSave) return;
    const { avatar, chatId, value } = this.pendingTitleSave;
    this.pendingTitleSave = null;
    this.adapter.updateSaveMeta(avatar, chatId, { customTitle: value });
    this.afterMetaFlush([{ avatar, chatId }], { skipCenterRender, preserveDom });
  }

  flushPendingNoteSaves(targetKey = null, { skipCenterRender = false, preserveDom = true } = {}) {
    if (!targetKey) {
      this.flushPendingTitleSave({ skipCenterRender, preserveDom });
    }
    const entries = targetKey
      ? this.pendingNoteSaves.has(targetKey)
        ? [[targetKey, this.pendingNoteSaves.get(targetKey)]]
        : []
      : Array.from(this.pendingNoteSaves.entries());
    if (entries.length === 0) return;

    const touched = [];
    for (const [key, entry] of entries) {
      clearTimeout(entry.timer);
      this.pendingNoteSaves.delete(key);
      this.adapter.updateSaveMeta(entry.avatar, entry.chatId, { note: entry.value });
      touched.push({ avatar: entry.avatar, chatId: entry.chatId });
    }
    this.afterMetaFlush(touched, { skipCenterRender, preserveDom });
  }

  afterMetaFlush(touched, { skipCenterRender, preserveDom }) {
    for (const avatar of new Set(touched.map((t) => t.avatar))) {
      this.syncOverviewMetaCounts(avatar, { renderSidebar: !preserveDom });
    }
    if (preserveDom) {
      if (!skipCenterRender) {
        touched.forEach((t) => this.patchSaveDisplayInPlace(t.avatar, t.chatId));
      }
      this.scheduleSearchRefresh();
    } else if (!skipCenterRender) {
      this.renderSaves();
    }
  }

  syncOverviewMetaCounts(avatar, { renderSidebar = true } = {}) {
    const charEntry = this.overviewList.find((c) => c.avatar === avatar);
    if (!charEntry) return;
    const allMeta = this.adapter.getAllMetadata?.() ?? null;
    let starredCount = 0;
    let notedCount = 0;
    charEntry.saves = charEntry.saves.map((s) => {
      const meta = this.adapter.getSaveMeta(avatar, s.chatId, allMeta);
      if (meta.starred) starredCount += 1;
      if (meta.note || meta.tags.length > 0) notedCount += 1;
      return { ...s, meta };
    });
    charEntry.starredCount = starredCount;
    charEntry.notedCount = notedCount;
    if (renderSidebar) this.renderSidebar();
  }

  /* ---------------------------------------------------------------------- *
   * 挂载与事件
   * ---------------------------------------------------------------------- */

  mount() {
    if (this.backdropEl) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'st-sbm-backdrop';
    backdrop.hidden = true;
    backdrop.dataset.pane = 'saves';
    backdrop.innerHTML = `
      <div class="st-sbm-window" role="dialog" aria-modal="true" aria-label="存档与分支">
        <aside class="st-sbm-sidebar">
          <label class="st-sbm-search">
            ${ICONS.search}
            <input type="search" data-role="search-input" placeholder="搜索" aria-label="搜索" autocomplete="off" spellcheck="false" />
          </label>
          <div class="st-sbm-sidebar-list" data-role="sidebar-list"></div>
        </aside>

        <section class="st-sbm-saves">
          <header class="st-sbm-saves-head">
            <button type="button" class="st-sbm-round st-sbm-back" data-action="back-characters" aria-label="返回">${ICONS.back}</button>
            <h2 data-role="saves-title"></h2>
          </header>
          <div class="st-sbm-saves-scroll" data-role="stage" role="listbox" aria-label="存档"></div>
        </section>

        <main class="st-sbm-detail">
          <div class="st-sbm-art" data-role="art" aria-hidden="true"></div>
          <button type="button" class="st-sbm-round st-sbm-back" data-action="back-saves" aria-label="返回">${ICONS.back}</button>
          <div class="st-sbm-detail-scroll" data-role="inspector"></div>
        </main>

        <button type="button" class="st-sbm-round st-sbm-close" data-action="close" aria-label="关闭" title="关闭">${ICONS.close}</button>
      </div>
    `;

    document.body.appendChild(backdrop);
    this.backdropEl = backdrop;
    this.bindEvents();
    this.installTauriBackHandler();
  }

  bindEvents() {
    const root = this.backdropEl;
    const searchInput = this.role('search-input');

    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    root.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') this.close();
      if (action === 'retry') this.refreshAll(true);
      if (action === 'retry-character') this.retryCurrentCharacter();
      if (action === 'back-characters') this.setPane('characters');
      if (action === 'back-saves') this.setPane('saves');
    });

    this.role('sidebar-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-library]');
      if (!item) return;
      if (item.dataset.library === 'starred') {
        this.openStarred();
        return;
      }
      const { avatar } = item.dataset;
      const keepSelection = this.currentCharacter?.avatar === avatar ? this.selectedChatId : null;
      this.library = 'character';
      this.setPane('saves');
      this.selectCharacter(avatar, keepSelection);
    });

    const stage = this.role('stage');
    stage.addEventListener('click', (e) => {
      const row = e.target.closest('[data-save-id]');
      if (!row) return;
      this.setPane('detail');
      this.selectSave(row.dataset.saveAvatar, row.dataset.saveId);
    });
    stage.addEventListener('dblclick', async (e) => {
      const row = e.target.closest('[data-save-id]');
      if (!row) return;
      const { saveAvatar, saveId } = row.dataset;
      await this.selectSave(saveAvatar, saveId);
      if (this.currentCharacter?.avatar === saveAvatar) this.handleJump(saveId, this.currentCharacter);
    });

    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.renderSidebar();
      this.renderSaves();
    });

    // 角色图随滚动缓慢上移并淡出
    const inspector = this.role('inspector');
    inspector.addEventListener(
      'scroll',
      () => {
        const art = this.role('art');
        art.style.transform = `translateY(${-inspector.scrollTop * 0.5}px)`;
        art.style.opacity = String(Math.max(0, 1 - inspector.scrollTop / 300));
      },
      { passive: true }
    );

    window.addEventListener('resize', () => {
      if (root.hidden) return;
      const width = typeof window.innerWidth === 'number' ? window.innerWidth : null;
      if (this.adapter.isMobileHost?.() && width !== null && width === this.lastViewportWidth) return;
      if (width !== null) this.lastViewportWidth = width;
      this.scheduleFitInspectorFields();
    });

    // 捕获阶段拦截：窗口打开时按键不应再触发酒馆自身的快捷键；若顶层存在宿主原生 dialog 则完全让出键盘输入
    document.addEventListener(
      'keydown',
      (e) => {
        if (root.hidden || e.isComposing || hasForegroundNativeDialog(root)) return;
        const focused = document.activeElement;
        const isEditing = root.contains(focused) && focused.matches('input, textarea');
        const handled = () => {
          e.preventDefault();
          e.stopPropagation();
        };

        if (e.key === 'Escape') {
          handled();
          if (focused === searchInput && searchInput.value) {
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input'));
          } else if (isEditing) {
            focused.blur();
          } else {
            this.close();
          }
          return;
        }
        if ((e.metaKey || e.ctrlKey) && ['k', 'f'].includes(e.key.toLowerCase())) {
          handled();
          this.setPane('characters');
          searchInput.focus();
          searchInput.select();
          return;
        }
        if (isEditing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          handled();
          this.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter' && focused?.tagName !== 'BUTTON' && this.selectedChatId) {
          handled();
          this.handleJump(this.selectedChatId, this.currentCharacter);
        }
      },
      true
    );
  }

  /* ---------------------------------------------------------------------- *
   * TauriTavern 宿主桥接（移动端返回手势 + 内容视口布局订阅）
   * ---------------------------------------------------------------------- */

  isNarrowViewport() {
    if (typeof window === 'undefined') return false;
    if (typeof window.innerWidth === 'number' && window.innerWidth > 0) {
      return window.innerWidth <= 860;
    }
    return Boolean(this.adapter.isMobileHost?.());
  }

  /**
   * 同步拦截 TauriTavern Android/移动端系统返回键：
   * - 弹窗不可见或存在位于顶层的宿主原生 <dialog open> 时交还宿主默认处理器
   * - 窄屏下按 detail -> saves -> characters -> 关闭 逐级回退
   * - 宽屏下直接关闭弹窗
   */
  handleTauriBack() {
    if (!this.backdropEl || this.backdropEl.hidden) return false;
    if (hasForegroundNativeDialog(this.backdropEl)) return false;
    if (this.isNarrowViewport()) {
      const pane = this.backdropEl.dataset.pane || 'saves';
      if (pane === 'detail') {
        this.setPane('saves');
        return true;
      }
      if (pane === 'saves') {
        this.setPane('characters');
        return true;
      }
    }
    this.close();
    return true;
  }

  installTauriBackHandler({ forceReattach = false } = {}) {
    if (typeof window === 'undefined') return;
    const bridge = getTauriBackBridge(window);
    if (!bridge.registeredModals.includes(this)) {
      bridge.registeredModals.push(this);
    }

    const dispatchModalBack = () => {
      for (let i = bridge.openModals.length - 1; i >= 0; i -= 1) {
        if (bridge.openModals[i]?.handleTauriBack()) return true;
      }
      for (let i = bridge.registeredModals.length - 1; i >= 0; i -= 1) {
        const candidate = bridge.registeredModals[i];
        if (!bridge.openModals.includes(candidate) && candidate?.handleTauriBack()) return true;
      }
      return false;
    };

    // 优先使用宿主托管的返回栈注册 API（若宿主提供），避免直接包装全局回调
    const registerHostBack = getHostBackRegisterFn(window);
    if (registerHostBack) {
      if (!bridge.hostDisposer) {
        try {
          const disposer = registerHostBack(dispatchModalBack);
          if (typeof disposer === 'function') {
            bridge.hostDisposer = disposer;
          }
        } catch {
          // 回退至全局回调桥接
        }
      }
      if (bridge.hostDisposer) return;
    }

    const existing = window.__TAURITAVERN_HANDLE_BACK__;
    if (bridge.installed) {
      if (existing === bridge.wrapper) return;
      // 协作式外层包装通过显式链元数据声明了包含本桥接节点时，保留外层优先顺序，绝不反包覆盖
      if (!forceReattach && typeof existing === 'function' && isWrapperInBackChain(existing, bridge.wrapper)) {
        return;
      }
      // 宿主或其他代码直接替换/清空了全局回调：先将旧包装退休为透明透传（杜绝成环），再重新挂接当前回调
      bridge.retireWrapper?.();
      bridge.installed = false;
      bridge.wrapper = null;
      bridge.prevHandler = null;
      bridge.retireWrapper = null;
    }

    if (!this.adapter.isTauriTavern?.() && typeof existing !== 'function') return;

    // 每个包装函数在闭包内不可变地捕获其创建时的前驱，并暴露链元数据供协作包装识别
    const capturedPrev = typeof existing === 'function' ? existing : null;
    let wrapperActive = true;
    const wrapped = () => {
      if (wrapperActive && dispatchModalBack()) return true;
      return capturedPrev ? Boolean(capturedPrev()) : false;
    };
    wrapped.__stSbmBackWrapper = true;
    wrapped.__stSbmPrevHandler = capturedPrev;
    bridge.wrapper = wrapped;
    bridge.prevHandler = capturedPrev;
    bridge.retireWrapper = () => {
      wrapperActive = false;
    };
    bridge.installed = true;
    window.__TAURITAVERN_HANDLE_BACK__ = wrapped;
  }

  uninstallTauriBackHandler() {
    if (typeof window === 'undefined') return;
    const bridge = tauriBackBridges.get(window);
    if (!bridge) return;
    bridge.openModals = bridge.openModals.filter((m) => m !== this);
    bridge.registeredModals = bridge.registeredModals.filter((m) => m !== this);
    if (bridge.registeredModals.length === 0) {
      if (typeof bridge.hostDisposer === 'function') {
        const dispose = bridge.hostDisposer;
        bridge.hostDisposer = null;
        try {
          dispose();
        } catch {
          // ignore disposer errors
        }
      }
      if (bridge.installed) {
        // 仅当本扩展仍是链顶时才摘除并恢复前驱；若已被后置扩展包装，保持本节点透明透传且供重装复用，既不断链也不成环
        if (window.__TAURITAVERN_HANDLE_BACK__ === bridge.wrapper) {
          bridge.retireWrapper?.();
          if (bridge.prevHandler) {
            window.__TAURITAVERN_HANDLE_BACK__ = bridge.prevHandler;
          } else {
            delete window.__TAURITAVERN_HANDLE_BACK__;
          }
          bridge.installed = false;
          bridge.wrapper = null;
          bridge.prevHandler = null;
          bridge.retireWrapper = null;
        }
      }
    }
  }

  markBackModalOpen() {
    if (typeof window === 'undefined') return;
    const bridge = tauriBackBridges.get(window);
    if (!bridge) return;
    bridge.openModals = bridge.openModals.filter((m) => m !== this);
    bridge.openModals.push(this);
  }

  markBackModalClosed() {
    if (typeof window === 'undefined') return;
    const bridge = tauriBackBridges.get(window);
    if (!bridge) return;
    bridge.openModals = bridge.openModals.filter((m) => m !== this);
  }

  subscribeTauriLayout() {
    if (typeof window === 'undefined') return;
    const layoutApi = window.__TAURITAVERN__?.api?.layout;
    if (!layoutApi || typeof layoutApi.subscribe !== 'function') return;

    this.unsubscribeTauriLayout();
    const seq = ++this.layoutSubSeq;
    this.lastViewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : null;

    const onSnapshot = (snapshot) => {
      if (seq !== this.layoutSubSeq || !this.backdropEl || this.backdropEl.hidden) return;
      const width = snapshot?.viewport?.width;
      if (typeof width === 'number' && width > 0 && width !== this.lastViewportWidth) {
        this.lastViewportWidth = width;
        this.scheduleFitInspectorFields();
      }
    };

    try {
      Promise.resolve(layoutApi.subscribe(onSnapshot))
        .then((unsub) => {
          if (typeof unsub !== 'function') return;
          if (seq !== this.layoutSubSeq || !this.backdropEl || this.backdropEl.hidden) {
            try {
              void Promise.resolve(unsub()).catch(() => {});
            } catch {
              // ignore unsubscribe errors
            }
            return;
          }
          this.layoutUnsubscribe = unsub;
        })
        .catch(() => {
          // ignore layout subscribe errors
        });
    } catch {
      // ignore synchronous subscribe errors
    }
  }

  unsubscribeTauriLayout() {
    this.layoutSubSeq += 1;
    const unsub = this.layoutUnsubscribe;
    this.layoutUnsubscribe = null;
    if (typeof unsub === 'function') {
      try {
        void Promise.resolve(unsub()).catch(() => {});
      } catch {
        // ignore unsubscribe errors
      }
    }
  }

  /* ---------------------------------------------------------------------- *
   * 打开 / 关闭 / 刷新
   * ---------------------------------------------------------------------- */

  async open({ rescan = false } = {}) {
    this.mount();
    this.openSessionSeq += 1;
    this.adapter.bindSillyTavernEvents?.();
    this.installTauriBackHandler();
    this.backdropEl.dataset.theme = detectHostTheme();
    this.backdropEl.dataset.host = this.adapter.isTauriTavern?.() ? 'tauritavern' : 'browser';
    this.backdropEl.hidden = false;
    this.markBackModalOpen();
    this.library = 'character';
    this.setPane('saves');
    document.activeElement?.blur?.();
    this.subscribeTauriLayout();

    if (this.hasLoadedOverview) {
      this.adapter.invalidateStaleSummaryTargets?.();
    }
    await this.refreshAll({ refreshSummaries: rescan, forceDigests: rescan });
  }

  close() {
    clearTimeout(this.searchRefreshTimer);
    this.searchRefreshTimer = null;
    this.cancelScheduledFitInspectorFields();
    this.unsubscribeTauriLayout();
    this.markBackModalClosed();
    this.flushPendingNoteSaves(null, { skipCenterRender: true, preserveDom: true });
    if (this.backdropEl) {
      this.backdropEl.hidden = true;
    }
  }

  showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'st-sbm-toast';
    toast.dataset.theme = detectHostTheme();
    toast.dataset.host = this.adapter.isTauriTavern?.() ? 'tauritavern' : 'browser';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2400);
  }

  async refreshAll(options = false) {
    this.flushPendingNoteSaves(null, { skipCenterRender: true, preserveDom: true });

    const forceDigests = typeof options === 'boolean' ? options : Boolean(options?.forceDigests);
    const refreshSummaries = typeof options === 'boolean' ? options : Boolean(options?.refreshSummaries || forceDigests);
    const isIncrementalReopen = this.hasLoadedOverview && !refreshSummaries && !forceDigests && this.overviewList.length > 0;
    const refreshId = ++this.refreshRequestSeq;
    this.selectRequestSeq += 1;

    const prevAvatar = this.currentCharacter?.avatar || null;
    const prevChatId = this.selectedChatId || null;
    this.currentGraph = null;
    this.selectedChatId = null;

    const sidebarList = this.role('sidebar-list');
    if (!isIncrementalReopen) sidebarList.innerHTML = spinnerHtml;
    this.role('stage').innerHTML = spinnerHtml;
    this.renderInspector();

    let overview;
    let earlySelectedAvatar = null;
    let prioritySelectPromise = null;
    try {
      if (this.adapter.isTauriTavern?.()) {
        await this.adapter.waitForHostReady?.();
        if (refreshId !== this.refreshRequestSeq) return;
        this.adapter.bindSillyTavernEvents?.();
        this.installTauriBackHandler();
      }
      if (forceDigests) {
        await this.adapter.clearDigestCache();
        if (refreshId !== this.refreshRequestSeq) return;
      }

      const liveChars = this.adapter.getCharacters?.() || [];
      const priorityChar =
        liveChars.find((c) => c.avatar === prevAvatar) ||
        liveChars.find((c) => c.isCurrentCharacter) ||
        liveChars[0] ||
        null;
      const priorityAvatar = priorityChar?.avatar || null;

      overview = await this.adapter.loadGlobalOverview({
        forceRefresh: refreshSummaries,
        priorityAvatars: priorityAvatar ? [priorityAvatar] : [],
        onCharacterLoaded: (entry) => {
          if (refreshId !== this.refreshRequestSeq || earlySelectedAvatar || !priorityAvatar || entry.avatar !== priorityAvatar) {
            return;
          }
          // 优先角色摘要一到达就立即拉取并渲染其故事线，无需阻塞等待全部角色扫描完成
          earlySelectedAvatar = entry.avatar;
          const existingIdx = this.overviewList.findIndex((c) => c.avatar === entry.avatar);
          if (existingIdx >= 0) {
            this.overviewList[existingIdx] = entry;
          } else {
            this.overviewList = isIncrementalReopen ? [...this.overviewList, entry] : [entry];
          }
          const preferredChatId = entry.avatar === prevAvatar ? prevChatId : null;
          prioritySelectPromise = this.selectCharacter(entry.avatar, preferredChatId, forceDigests, {
            skipSidebarSync: !isIncrementalReopen,
          });
        },
        onProgress: (done, total) => {
          if (refreshId !== this.refreshRequestSeq || isIncrementalReopen) return;
          sidebarList.innerHTML = `<div class="st-sbm-progress"><i style="width:${Math.round((done / Math.max(1, total)) * 100)}%"></i></div>`;
        },
      });
    } catch (err) {
      if (refreshId !== this.refreshRequestSeq) return;
      sidebarList.innerHTML = '';
      this.role('stage').innerHTML = failureHtml(err);
      return;
    }

    if (refreshId !== this.refreshRequestSeq) return;

    this.overviewList = overview;
    this.hasLoadedOverview = true;
    this.overviewList.sort((a, b) => {
      if (a.isCurrentCharacter !== b.isCurrentCharacter) return a.isCurrentCharacter ? -1 : 1;
      if (b.latestTimestamp !== a.latestTimestamp) return b.latestTimestamp - a.latestTimestamp;
      return b.saveCount - a.saveCount;
    });

    const targetChar =
      (earlySelectedAvatar && this.overviewList.find((c) => c.avatar === (this.currentCharacter?.avatar || earlySelectedAvatar))) ||
      this.overviewList.find((c) => c.avatar === prevAvatar) ||
      this.overviewList.find((c) => c.isCurrentCharacter) ||
      this.overviewList[0] ||
      null;

    if (earlySelectedAvatar && targetChar) {
      if (this.currentCharacter?.avatar === targetChar.avatar) {
        this.currentCharacter = targetChar;
      }
      this.renderSidebar();
      if (prioritySelectPromise) {
        await prioritySelectPromise;
      }
      if (refreshId === this.refreshRequestSeq && this.library === 'starred') {
        this.renderSaves();
      }
      return;
    }

    if (targetChar) {
      this.currentCharacter = targetChar;
      this.renderSidebar();
      const preferredChatId = targetChar.avatar === prevAvatar ? prevChatId : null;
      await this.selectCharacter(targetChar.avatar, preferredChatId, forceDigests, { skipSidebarSync: true });
    } else {
      this.currentCharacter = null;
      this.currentGraph = null;
      this.selectedChatId = null;
      this.renderSidebar();
      this.renderSaves();
      this.renderInspector();
    }
  }

  /* ---------------------------------------------------------------------- *
   * 选择
   * ---------------------------------------------------------------------- */

  openStarred() {
    this.flushPendingNoteSaves(null, { skipCenterRender: true });
    this.library = 'starred';
    this.setPane('saves');
    const hasStarredItem = Boolean(this.role('sidebar-list')?.querySelector('[data-library="starred"]'));
    if (!hasStarredItem || !this.updateSidebarSelection()) {
      this.renderSidebar();
    }
    this.renderSaves();

    // 当前选中的不是星标存档时，落到第一条，避免列表与阅读页各说各话
    const items = this.starredItems();
    const isListed = items.some(
      ({ ch, save }) => ch.avatar === this.currentCharacter?.avatar && save.chatId === this.selectedChatId
    );
    if (!isListed && items.length > 0) {
      this.selectCharacter(items[0].ch.avatar, items[0].save.chatId);
    }
  }

  async selectCharacter(avatar, preferredChatId = null, forceRefresh = false, { skipSidebarSync = false } = {}) {
    const charEntry = this.overviewList.find((c) => c.avatar === avatar);
    if (!charEntry) return;

    this.flushPendingNoteSaves(null, { skipCenterRender: true });

    const requestId = ++this.selectRequestSeq;
    const isStale = () => requestId !== this.selectRequestSeq || this.currentCharacter?.avatar !== charEntry.avatar;

    this.currentCharacter = charEntry;
    this.currentGraph = null;
    this.selectedChatId = null;
    if (!skipSidebarSync && !this.updateSidebarSelection()) {
      this.renderSidebar();
    }
    this.renderSaves();
    this.renderInspector();

    let digests;
    try {
      digests = await this.adapter.getCharacterChatDigests(charEntry, charEntry.saves, forceRefresh);
    } catch (err) {
      if (isStale()) return;
      this.role(this.library === 'starred' ? 'inspector' : 'stage').innerHTML = failureHtml(err);
      return;
    }
    if (isStale()) return;

    const graph = buildCharacterBranchGraph(charEntry, digests);
    graph.characterAvatar = charEntry.avatar;
    this.currentGraph = graph;
    this.indexAutoTitles(charEntry, graph);

    const selectableNodes = graph.order?.length ? graph.order : graph.nodes;
    const targetNode =
      (preferredChatId && graph.nodes.find((n) => n.chatId === stripJsonl(preferredChatId))) ||
      selectableNodes.find((n) => n.isActive) ||
      selectableNodes.find((n) => n.isCharacterLastChat) ||
      selectableNodes[0] ||
      graph.nodes[0] ||
      null;

    this.selectedChatId = targetNode ? targetNode.chatId : null;
    this.renderSaves();
    this.renderInspector();
    this.revealSelection(this.library === 'starred' ? 'nearest' : 'center');
  }

  async selectSave(avatar, chatId) {
    if (this.currentCharacter?.avatar !== avatar || !this.activeGraph) {
      await this.selectCharacter(avatar, chatId);
      return;
    }
    const cleanId = stripJsonl(chatId);
    if (cleanId === this.selectedChatId || !this.activeGraph.nodes.some((n) => n.chatId === cleanId)) return;
    this.flushPendingNoteSaves(null, { skipCenterRender: true });
    const prevId = this.selectedChatId;
    this.selectedChatId = cleanId;
    this.updateSelection(prevId);
    this.renderInspector();
    this.revealSelection();
  }

  /** 仅切换选中态，不重建列表，让轨道与行的过渡得以连续 */
  updateSelection(prevId) {
    const { avatar } = this.currentCharacter;
    this.role('stage')
      .querySelectorAll('[data-save-id]')
      .forEach((row) => {
        const isSelected = row.dataset.saveAvatar === avatar && stripJsonl(row.dataset.saveId) === this.selectedChatId;
        row.setAttribute('aria-selected', String(isSelected));
      });
    if (this.library === 'character') this.renderRail(prevId);
  }

  moveSelection(step) {
    const rows = Array.from(this.role('stage').querySelectorAll('[data-save-id]'));
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.getAttribute('aria-selected') === 'true');
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))];
    this.selectSave(next.dataset.saveAvatar, next.dataset.saveId);
  }

  revealSelection(block = 'nearest') {
    this.role('stage').querySelector('[aria-selected="true"]')?.scrollIntoView({ block });
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

  starredItems() {
    const items = [];
    for (const ch of this.overviewList) {
      for (const save of ch.saves) {
        if (save.meta?.starred && this.matchesSearch(ch, save)) items.push({ ch, save });
      }
    }
    return items.sort(
      (a, b) =>
        (parseSillyTavernTimestamp(b.save.lastModified) || 0) - (parseSillyTavernTimestamp(a.save.lastModified) || 0)
    );
  }

  /* ---------------------------------------------------------------------- *
   * 渲染：角色
   * ---------------------------------------------------------------------- */

  avatarHtml(ch) {
    return `<img class="st-sbm-avatar" loading="lazy" src="${escapeHtml(ch.avatarSrc)}" data-fallback="${escapeHtml(ch.avatarFallbackSrc || '')}" alt="" />`;
  }

  bindAvatarFallbacks(container) {
    container.querySelectorAll('img.st-sbm-avatar').forEach((img) => {
      img.addEventListener('error', () => {
        const fallback = img.dataset.fallback;
        if (fallback) {
          img.dataset.fallback = '';
          img.src = fallback;
        } else {
          img.classList.add('is-missing');
          img.removeAttribute('src');
        }
      });
    });
  }

  /** 仅切换侧栏选中类，不重建角色列表与懒加载头像 DOM */
  updateSidebarSelection() {
    const listEl = this.role('sidebar-list');
    if (!listEl) return false;
    const items = listEl.querySelectorAll('[data-library]');
    if (!items || items.length === 0) return false;
    let matched = false;
    items.forEach((btn) => {
      const isSelected =
        btn.dataset.library === 'starred'
          ? this.library === 'starred'
          : this.library === 'character' && btn.dataset.avatar === this.currentCharacter?.avatar;
      btn.classList.toggle('is-selected', isSelected);
      if (isSelected) matched = true;
    });
    return matched || this.library === 'starred' || !this.currentCharacter;
  }

  renderSidebar() {
    const listEl = this.role('sidebar-list');
    const starredTotal = this.overviewList.reduce((sum, ch) => sum + (ch.starredCount || 0), 0);
    const characters = this.overviewList.filter((ch) => this.matchesSearch(ch));

    const starredHtml =
      starredTotal > 0 || this.library === 'starred'
        ? `<button type="button" class="st-sbm-side-item is-starred ${this.library === 'starred' ? 'is-selected' : ''}" data-library="starred">
             <span class="st-sbm-side-glyph">${ICONS.starFill}</span>
             <span class="st-sbm-side-name">星标</span>
             <span class="st-sbm-side-count">${starredTotal || ''}</span>
           </button>`
        : '';

    const charactersHtml = characters
      .map((ch) => {
        const isSelected = this.library === 'character' && this.currentCharacter?.avatar === ch.avatar;
        return `
          <button type="button" class="st-sbm-side-item ${isSelected ? 'is-selected' : ''}" data-library="character" data-avatar="${escapeHtml(ch.avatar)}" title="${escapeHtml(ch.name)}">
            ${this.avatarHtml(ch)}
            <span class="st-sbm-side-name">${escapeHtml(ch.name)}</span>
            <span class="st-sbm-side-count">${ch.saveCount || ''}</span>
          </button>`;
      })
      .join('');

    listEl.innerHTML = starredHtml + (charactersHtml || (this.searchQuery ? emptyHtml('无结果') : ''));
    this.bindAvatarFallbacks(listEl);
  }

  /* ---------------------------------------------------------------------- *
   * 渲染：故事线
   * ---------------------------------------------------------------------- */

  async retryCurrentCharacter() {
    const ch = this.currentCharacter;
    if (!ch) {
      await this.refreshAll(true);
      return;
    }

    this.flushPendingNoteSaves(null, { skipCenterRender: true, preserveDom: true });
    const targetAvatar = ch.avatar;
    const fallbackChatId = this.selectedChatId;
    const requestId = ++this.selectRequestSeq;

    try {
      const summaries = await this.adapter.getCharacterChatSummaries(ch, true);
      if (requestId !== this.selectRequestSeq || this.currentCharacter?.avatar !== targetAvatar) return;

      const allMeta = this.adapter.getAllMetadata?.() ?? null;
      let starredCount = 0;
      let notedCount = 0;
      let latestTime = 0;
      ch.saves = summaries.map((s) => {
        const meta = this.adapter.getSaveMeta(targetAvatar, s.chatId, allMeta);
        if (meta.starred) starredCount += 1;
        if (meta.note || meta.tags.length > 0) notedCount += 1;
        const ts = parseSillyTavernTimestamp(s.lastModified) || 0;
        if (ts > latestTime) latestTime = ts;
        return { ...s, meta };
      });
      ch.saveCount = ch.saves.length;
      ch.starredCount = starredCount;
      ch.notedCount = notedCount;
      ch.latestTimestamp = latestTime;
      ch.summaryError = '';

      // 在列表请求返回后再读取最新选中项，避免重试在途期间切换存档被旧选择回退
      const latestSelectedChatId = this.selectedChatId || fallbackChatId;
      this.renderSidebar();
      await this.selectCharacter(targetAvatar, latestSelectedChatId, true, { skipSidebarSync: true });
    } catch (err) {
      if (requestId !== this.selectRequestSeq || this.currentCharacter?.avatar !== targetAvatar) return;
      ch.summaryError = err?.message || String(err || '获取存档列表失败');
      this.renderSaves();
      this.renderInspector();
      this.showToast(`重试失败：${ch.summaryError}`);
    }
  }

  renderSaves() {
    const stage = this.role('stage');
    this.role('saves-title').textContent = this.library === 'starred' ? '星标' : this.currentCharacter?.name || '';

    if (this.library === 'starred') {
      this.renderStarred(stage);
      return;
    }
    const summaryError = this.currentCharacter?.summaryError || '';
    const summaryBannerHtml = summaryError
      ? `<div class="st-sbm-summary-error" data-role="summary-error"><span>${escapeHtml(summaryError)}</span><button type="button" class="st-sbm-link" data-action="retry-character">重试</button></div>`
      : '';
    const graph = this.activeGraph;
    if (!graph) {
      stage.innerHTML = summaryBannerHtml + (this.currentCharacter ? spinnerHtml : emptyHtml('无存档'));
      return;
    }
    if (graph.nodes.length === 0) {
      stage.innerHTML = summaryBannerHtml || emptyHtml('无存档');
      return;
    }
    this.renderStoryline(stage, graph, summaryBannerHtml);
  }

  renderStarred(stage) {
    const items = this.starredItems();
    if (items.length === 0) {
      stage.innerHTML = emptyHtml(this.searchQuery ? '无结果' : '无星标');
      return;
    }
    const allMeta = this.adapter.getAllMetadata?.() ?? null;
    stage.innerHTML = items
      .map(({ ch, save }) => {
        const isSelected = this.currentCharacter?.avatar === ch.avatar && this.selectedChatId === save.chatId;
        return `
          <div class="st-sbm-row is-starred-row" role="option" aria-selected="${isSelected}" data-save-avatar="${escapeHtml(ch.avatar)}" data-save-id="${escapeHtml(save.chatId)}">
            ${this.avatarHtml(ch)}
            <div class="st-sbm-row-text">
              <div class="st-sbm-row-top">
                <span class="st-sbm-row-title" data-role="row-title">${escapeHtml(this.saveTitle(ch.avatar, save.chatId, allMeta))}</span>
                <span class="st-sbm-row-time">${escapeHtml(formatRelativeTime(save.lastModified))}</span>
              </div>
              <div class="st-sbm-row-sub">${escapeHtml(ch.name)}</div>
            </div>
          </div>`;
      })
      .join('');
    this.bindAvatarFallbacks(stage);
  }

  renderStoryline(stage, graph, summaryBannerHtml = '') {
    const owner = this.currentCharacter;
    const order = graph.order || graph.nodes.filter((n) => !n.isUnavailable);
    const unavailableNodes = graph.unavailableNodes || graph.nodes.filter((n) => n.isUnavailable);
    const byId = new Map(order.map((n) => [n.chatId, n]));
    const allMeta = this.adapter.getAllMetadata?.() ?? null;

    // 轨道再多也各占一条：放不下时收窄间距，绝不把不同的线叠在一起
    const lanes = graph.laneCount || 1;
    const laneWidth = Math.min(RAIL.laneWidth, RAIL.maxSpread / Math.max(1, lanes - 1));

    const pos = new Map();
    let top = 0;
    order.forEach((node, index) => {
      // 树与树之间留白；连续的独立单存档保持紧凑
      const prev = order[index - 1];
      if (prev && !node.parentId && (prev.parentId || node.childrenIds.length > 0)) top += RAIL.treeGap;
      pos.set(node.chatId, {
        x: RAIL.inset + (node.lane || 0) * laneWidth,
        top,
        y: top + RAIL.rowHeight / 2,
      });
      top += RAIL.rowHeight;
    });
    const height = top;
    const hasRail = order.some((n) => n.parentId); // 没有任何分叉时无需轨道
    const railWidth = hasRail ? RAIL.inset + (lanes - 1) * laneWidth + RAIL.gutter : 16;

    const segment = (node, moveTo = true) => {
      const from = pos.get(node.parentId);
      const to = pos.get(node.chatId);
      if (!from) return '';
      const bend = Math.min(22, to.y - from.y);
      const line =
        from.x === to.x
          ? `V${to.y}`
          : `V${to.y - bend}C${from.x} ${to.y - 4} ${to.x - (to.x - from.x) / 3} ${to.y} ${to.x} ${to.y}`;
      return (moveTo ? `M${from.x} ${from.y}` : '') + line;
    };

    // 取消上一个布局遗留的轨道动画
    if (this.railLayout?.activeAnims?.length) {
      for (const anim of this.railLayout.activeAnims) anim.cancel?.();
    }
    this.railLayout = {
      order,
      byId,
      pos,
      segment,
      dotById: new Map(),
      highlightedIds: new Set(),
      activeAnims: [],
      mounted: false,
    };

    const rowsHtml = order
      .map((node) => {
        const meta = this.adapter.getSaveMeta(owner.avatar, node.chatId, allMeta);
        const isDimmed = this.searchQuery && !this.matchesSearch(owner, { ...node, meta, previewText: node.lastFloorSnippet });
        const bm = node.branchMoment;
        // 标题讲从哪里开始，副行讲现在走到哪里
        const snippet = bm?.isCheckpointSnapshot
          ? '检查点'
          : bm?.isExactCopy
          ? '副本'
          : this.gist(node.lastFloorSnippet);
        const range = !bm ? '' : bm.isCheckpointSnapshot || bm.isExactCopy ? `#${bm.branchFloor}` : `${bm.branchFloor} → ${node.floorCount}`;
        return `
          <div class="st-sbm-row ${isDimmed ? 'is-dimmed' : ''}" role="option" aria-selected="${node.chatId === this.selectedChatId}" style="top:${pos.get(node.chatId).top}px;padding-left:${railWidth}px" data-save-avatar="${escapeHtml(owner.avatar)}" data-save-id="${escapeHtml(node.chatId)}">
            <div class="st-sbm-row-text">
              <div class="st-sbm-row-top">
                <span class="st-sbm-row-title" data-role="row-title">${escapeHtml(this.saveTitle(owner.avatar, node.chatId, allMeta))}</span>
                ${meta.starred ? `<span class="st-sbm-row-star">${ICONS.starFill}</span>` : ''}
                ${
                  node.isActive
                    ? '<span class="st-sbm-row-time is-current">当前</span>'
                    : `<span class="st-sbm-row-time">${escapeHtml(formatRelativeTime(node.lastModified))}</span>`
                }
              </div>
              <div class="st-sbm-row-sub">${range ? `<b>${range}</b>` : ''}${escapeHtml(snippet)}</div>
            </div>
          </div>`;
      })
      .join('');

    const unavailableHtml = unavailableNodes.length
      ? `
      <div class="st-sbm-unavailable" data-role="unavailable-list">
        <div class="st-sbm-unavailable-head">无法读取的存档（未计入分支谱系）</div>
        ${unavailableNodes
          .map((node) => {
            const meta = this.adapter.getSaveMeta(owner.avatar, node.chatId, allMeta);
            const isDimmed =
              this.searchQuery && !this.matchesSearch(owner, { ...node, meta, previewText: node.lastFloorSnippet });
            const badge = node.digestStatus === 'missing' ? '文件缺失' : '无法读取';
            return `
              <div class="st-sbm-row is-unavailable ${isDimmed ? 'is-dimmed' : ''}" role="option" aria-selected="${node.chatId === this.selectedChatId}" data-save-avatar="${escapeHtml(owner.avatar)}" data-save-id="${escapeHtml(node.chatId)}" data-digest-status="${escapeHtml(node.digestStatus)}">
                <div class="st-sbm-row-text">
                  <div class="st-sbm-row-top">
                    <span class="st-sbm-row-title" data-role="row-title">${escapeHtml(this.saveTitle(owner.avatar, node.chatId, allMeta))}</span>
                    <span class="st-sbm-row-badge is-error">${badge}</span>
                  </div>
                  <div class="st-sbm-row-sub">${escapeHtml(node.digestError || node.lastFloorSnippet)}</div>
                </div>
              </div>`;
          })
          .join('')}
      </div>`
      : '';

    const staticRailSvg = hasRail
      ? `<svg class="st-sbm-rail" data-role="rail" width="${railWidth}" height="${height}" aria-hidden="true">
           ${order.map((n) => `<path d="${segment(n)}"/>`).join('')}
           <path class="is-path" data-line="old" d=""/>
           <path class="is-path" data-line="new" d=""/>
           ${order
             .map((node) => {
               const { x, y } = pos.get(node.chatId);
               const cpCls = node.branchMoment?.isCheckpointSnapshot ? 'is-checkpoint' : '';
               return `<circle data-dot-id="${escapeHtml(node.chatId)}" class="${cpCls}" cx="${x}" cy="${y}" r="4.5"/>`;
             })
             .join('')}
         </svg>`
      : '';

    stage.innerHTML = `
      ${summaryBannerHtml}
      ${
        order.length
          ? `<div class="st-sbm-storyline" style="height:${height}px">
               ${rowsHtml}
               ${staticRailSvg}
             </div>`
          : ''
      }
      ${unavailableHtml}`;
    if (hasRail) {
      const rail = this.role('rail');
      if (rail) {
        rail.querySelectorAll?.('circle[data-dot-id]').forEach((circle) => {
          const id = circle.getAttribute?.('data-dot-id') ?? circle.dataset?.dotId;
          if (id) this.railLayout.dotById.set(id, circle);
        });
        this.railLayout.mounted = true;
      }
      this.renderRail();
    }
  }

  /** 原地更新轨道高亮路径与受影响圆点，不重写静态底轨 SVG；给出 prevId 时播放收回/伸出过渡 */
  renderRail(prevId = null) {
    const rail = this.role('rail');
    if (!rail || !this.railLayout) return;
    const { byId, pos, segment, dotById, highlightedIds, activeAnims } = this.railLayout;

    // 取消快速切档时残留的旧动画，防止相互覆盖
    for (const anim of activeAnims) anim.cancel?.();
    activeAnims.length = 0;

    const pathTo = (id) => {
      const nodes = [];
      for (let cur = byId.get(id); cur; cur = byId.get(cur.parentId)) nodes.push(cur);
      nodes.reverse();
      return nodes;
    };
    const toD = (nodes) => nodes.map((n, i) => (i === 0 ? `M${pos.get(n.chatId).x} ${pos.get(n.chatId).y}` : segment(n, false))).join('');

    const path = pathTo(this.selectedChatId);
    const onPath = new Set(path.map((n) => n.chatId));
    const prevPath = prevId ? pathTo(prevId) : [];
    let sharedCount = 0;
    while (sharedCount < path.length && path[sharedCount] === prevPath[sharedCount]) sharedCount += 1;
    const shared = path.slice(0, sharedCount);

    // 仅更新受影响的圆点（上次高亮集合 ∪ 本次高亮集合），避免全量重绘 SVG
    const affectedIds = new Set([...highlightedIds, ...onPath]);
    if (prevId) affectedIds.add(prevId);
    if (this.selectedChatId) affectedIds.add(this.selectedChatId);
    for (const id of affectedIds) {
      const circle = dotById.get(id);
      const node = byId.get(id);
      if (!circle || !node) continue;
      const isSelected = id === this.selectedChatId;
      const cls = [
        onPath.has(id) ? 'is-path' : '',
        isSelected ? 'is-selected' : '',
        node.branchMoment?.isCheckpointSnapshot ? 'is-checkpoint' : '',
      ]
        .filter(Boolean)
        .join(' ');
      circle.setAttribute?.('class', cls);
      circle.setAttribute?.('r', isSelected ? '6' : '4.5');
    }
    this.railLayout.highlightedIds = onPath;

    const oldLine = rail.querySelector?.('[data-line="old"]');
    const newLine = rail.querySelector?.('[data-line="new"]');
    if (!oldLine || !newLine) return;

    const newD = toD(path);
    newLine.setAttribute?.('d', newD);
    if (newLine.style) newLine.style.strokeDasharray = '';

    if (!prevPath.length || prefersReducedMotion() || typeof oldLine.getTotalLength !== 'function') {
      oldLine.setAttribute?.('d', '');
      if (oldLine.style) oldLine.style.strokeDasharray = '';
      return;
    }

    oldLine.setAttribute?.('d', toD(prevPath));
    const measure = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    measure.setAttribute('d', toD(shared));
    const sharedLength = shared.length > 1 ? measure.getTotalLength() : 0;
    const timing = { duration: 380, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' };
    const slide = (line, from, to) => {
      const total = line.getTotalLength();
      line.style.strokeDasharray = `${total} ${total}`;
      const anim = line.animate(
        [{ strokeDashoffset: total - from(total) }, { strokeDashoffset: total - to(total) }],
        timing
      );
      if (anim) activeAnims.push(anim);
      return anim;
    };
    const oldAnim = slide(oldLine, (total) => total, () => sharedLength);
    if (oldAnim) {
      oldAnim.onfinish = () => {
        oldLine.setAttribute('d', '');
        oldLine.style.strokeDasharray = '';
      };
    }
    const newAnim = slide(newLine, () => sharedLength, (total) => total);
    if (newAnim) {
      newAnim.onfinish = () => {
        newLine.style.strokeDasharray = '';
      };
    }
    const selectedDot = dotById.get(this.selectedChatId);
    const dotAnim = selectedDot?.animate?.([{ r: '3px', opacity: 0 }, { r: '6px', opacity: 1 }], {
      ...timing,
      duration: 260,
      delay: 140,
    });
    if (dotAnim) activeAnims.push(dotAnim);
  }

  /* ---------------------------------------------------------------------- *
   * 渲染：阅读页
   * ---------------------------------------------------------------------- */

  forkHtml(node, parent, avatar, allMeta = null) {
    const bm = node.branchMoment;
    const metaSnapshot = allMeta || this.adapter.getAllMetadata?.() || null;
    const paths = [];
    if (bm.childNextSnippet) paths.push({ isSelf: true, node, text: bm.childNextSnippet });
    if (bm.parentNextSnippet) paths.push({ node: parent, text: bm.parentNextSnippet });
    for (const sib of this.currentGraph.nodes) {
      if (paths.length >= 4) break;
      if (sib === node || sib.parentId !== node.parentId) continue;
      if (sib.branchMoment?.branchFloor !== bm.branchFloor || !sib.branchMoment.childNextSnippet) continue;
      paths.push({ node: sib, text: sib.branchMoment.childNextSnippet });
    }
    trimSharedOpening(paths.map((p) => this.gist(p.text))).forEach((text, i) => {
      paths[i].text = text;
    });

    const self = paths.find((p) => p.isSelf);
    const others = paths.filter((p) => !p.isSelf);
    const columns = [self, others.length ? others : null].filter(Boolean);

    const lines = columns
      .map((col, i) => ({ isSelf: col === self, x: ((i + 0.5) / columns.length) * 100 }))
      .reverse()
      .map(({ isSelf, x }) => `<path class="${isSelf ? 'is-path' : ''}" d="M50 0C50 22 ${x} 10 ${x} 32"/>`)
      .join('');

    const otherCard = (p) => {
      // 标题取自正文首句时不再重复一遍，只在存档有名字时显示
      const isNamed = !p.node.isAutoNamed || this.adapter.getSaveMeta(avatar, p.node.chatId, metaSnapshot).customTitle;
      const title = isNamed ? `<span class="st-sbm-fork-title">${escapeHtml(this.saveTitle(avatar, p.node.chatId, metaSnapshot))}</span>` : '';
      return `<button type="button" class="st-sbm-fork-card" data-select-save="${escapeHtml(p.node.chatId)}">${title}<span class="st-sbm-fork-text">${escapeHtml(p.text)}</span></button>`;
    };

    // 源存档已作为另一条走向列出时，不再重复给出链接
    const parentLink = others.some((p) => p.node === parent)
      ? ''
      : `<button type="button" class="st-sbm-link" data-select-save="${escapeHtml(parent.chatId)}"><span>${escapeHtml(this.saveTitle(avatar, parent.chatId, metaSnapshot))}</span>${ICONS.chevron}</button>`;

    const heading = bm.isExactCopy ? '副本' : bm.isCheckpointSnapshot ? '检查点' : '分歧';
    return `
      <section class="st-sbm-section">
        <header><h3>${heading} <em>#${bm.branchFloor}</em></h3>${parentLink}</header>
        <div class="st-sbm-fork">
          <div class="st-sbm-fork-anchor"><span>${escapeHtml(this.gist(bm.anchorSnippet) || '—')}</span></div>
          ${
            columns.length
              ? `<svg class="st-sbm-fork-lines" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
                 <div class="st-sbm-fork-cards">
                   ${self ? `<div class="st-sbm-fork-card is-self"><span class="st-sbm-fork-text">${escapeHtml(self.text)}</span></div>` : ''}
                   ${others.length ? `<div class="st-sbm-fork-others">${others.map(otherCard).join('')}</div>` : ''}
                 </div>`
              : ''
          }
        </div>
      </section>`;
  }

  bubblesHtml(floors) {
    return `<div class="st-sbm-chat">${floors
      .map((f) => `<div class="st-sbm-bubble ${f.isUser ? 'is-user' : ''}"><span>${escapeHtml(this.gist(f.snippet))}</span></div>`)
      .join('')}</div>`;
  }

  tagsHtml(meta) {
    const selected = meta.tags || [];
    if (!this.tagEditorOpen) {
      return `
        ${selected.map((tag) => `<span class="st-sbm-tag">${escapeHtml(tag)}</span>`).join('')}
        <button type="button" class="st-sbm-tag is-add" data-role="tag-editor-btn" aria-label="编辑标签" title="标签">${selected.length ? ICONS.plus : `${ICONS.plus}标签`}</button>`;
    }
    const all = Array.from(new Set([...PRESET_TAGS, ...selected]));
    return `
      ${all
        .map(
          (tag) =>
            `<button type="button" class="st-sbm-tag is-option" aria-pressed="${selected.includes(tag)}" data-toggle-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
        )
        .join('')}
      <input type="text" class="st-sbm-tag-input" data-role="new-tag-input" placeholder="新标签" aria-label="新标签" />
      <button type="button" class="st-sbm-tag is-add is-done" data-role="tag-editor-btn" aria-label="完成" title="完成">${ICONS.check}</button>`;
  }

  /** 页头角色图：缩略图只取颜色作氛围光，原图到位后在右侧淡入；切换角色时交叉淡化 */
  renderArt() {
    const art = this.role('art');
    const ch = this.currentCharacter;
    const key = ch?.avatar || '';
    if (!art || this.artKey === key) return;
    this.artKey = key;

    art.querySelectorAll('.st-sbm-art-layer').forEach((layer) => {
      layer.classList.add('is-leaving');
      setTimeout(() => layer.remove(), 500);
    });
    if (!ch?.avatarSrc) return;

    const layer = document.createElement('div');
    layer.className = 'st-sbm-art-layer';
    for (const [className, src, fallbackSrc] of [
      ['is-glow', ch.avatarSrc, ch.avatarFallbackSrc || ''],
      ['is-portrait', ch.avatarFallbackSrc || ch.avatarSrc, ch.avatarSrc || ''],
    ]) {
      const img = document.createElement('img');
      img.className = className;
      img.alt = '';
      let retried = false;
      img.addEventListener('load', () => img.classList.add('is-loaded'));
      img.addEventListener('error', () => {
        if (!retried && fallbackSrc && fallbackSrc !== src) {
          retried = true;
          img.src = fallbackSrc;
          return;
        }
        img.remove();
      });
      img.src = src;
      layer.appendChild(img);
    }
    art.appendChild(layer);
  }

  renderInspector() {
    const insp = this.role('inspector');
    this.renderArt();
    const graph = this.activeGraph;
    const node = graph && this.selectedChatId ? graph.nodes.find((n) => n.chatId === this.selectedChatId) : null;
    if (!node) {
      this.inspectorKey = null;
      insp.innerHTML = '';
      return;
    }

    const ownerCharacter = this.currentCharacter;
    const avatar = ownerCharacter.avatar;
    const noteSaveKey = `${avatar}::${stripJsonl(node.chatId)}`;
    const isSameSave = this.inspectorKey === noteSaveKey;
    const prevScroll = isSameSave ? insp.scrollTop : 0;
    if (!isSameSave) this.tagEditorOpen = false;
    this.inspectorKey = noteSaveKey;

    const allMeta = this.adapter.getAllMetadata?.() ?? null;
    const meta = this.adapter.getSaveMeta(avatar, node.chatId, allMeta);
    const parent = node.parentId ? graph.nodes.find((n) => n.chatId === node.parentId) : null;
    const hasFork = Boolean(node.branchMoment && parent);

    const timeText = formatFullTime(node.lastModified);
    const metaBits = node.isUnavailable
      ? [node.digestStatus === 'missing' ? '文件缺失' : '无法读取']
      : [`${node.floorCount} 楼`];
    if (timeText) metaBits.push(timeText);
    if (this.library === 'starred') metaBits.unshift(ownerCharacter.name);

    const originHtml = node.isUnavailable
      ? `<div class="st-sbm-unavailable-banner" data-role="unavailable-banner"><div>${escapeHtml(node.digestError || '无法读取该存档内容，因此未参与分支谱系推断。')}</div><button type="button" class="st-sbm-link" data-action="retry-character">重新扫描</button></div>`
      : hasFork
      ? this.forkHtml(node, parent, avatar, allMeta)
      : node.floors[0]
      ? `<section class="st-sbm-section"><header><h3>开场</h3></header>${this.bubblesHtml([node.floors[0]])}</section>`
      : '';

    // 已在「分歧 / 开场」中出现过的楼层不再重复
    const shownUntil = hasFork ? node.branchMoment.branchFloor + 1 : 1;
    const latest = node.isUnavailable ? [] : node.floors.filter((f) => f.floor > shownUntil).slice(-2);

    insp.innerHTML = `
      <article class="st-sbm-page ${isSameSave ? '' : 'is-entering'}">
        <header class="st-sbm-hero">
          <textarea class="st-sbm-title" data-role="custom-title" rows="1" spellcheck="false" aria-label="名称" placeholder="${escapeHtml(this.autoTitles.get(noteSaveKey) || this.summaryTitle(avatar, stripJsonl(node.chatId)))}">${escapeHtml(meta.customTitle)}</textarea>
          <p class="st-sbm-meta" title="${escapeHtml(node.chatId)}.jsonl">${node.isActive ? '<b>当前</b>' : ''}${metaBits.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</p>
          <div class="st-sbm-actions">
            <button type="button" class="st-sbm-primary" data-role="jump-btn" ${node.isUnavailable ? 'disabled' : ''}>继续</button>
            <button type="button" class="st-sbm-round st-sbm-star ${meta.starred ? 'is-on' : ''}" data-role="insp-star-btn" aria-label="星标" aria-pressed="${Boolean(meta.starred)}" title="星标">${meta.starred ? ICONS.starFill : ICONS.star}</button>
          </div>
        </header>

        <div class="st-sbm-annot ${!meta.note && !meta.tags.length && !this.tagEditorOpen ? 'is-empty' : ''}">
          <textarea class="st-sbm-note" data-role="note-input" rows="1" aria-label="备注" placeholder="备注">${escapeHtml(meta.note)}</textarea>
          <div class="st-sbm-tags">${this.tagsHtml(meta)}</div>
        </div>

        ${originHtml}
        ${latest.length ? `<section class="st-sbm-section"><header><h3>最新</h3></header>${this.bubblesHtml(latest)}</section>` : ''}
      </article>
    `;

    this.bindInspector(insp, { node, avatar, ownerCharacter, noteSaveKey });
    insp.scrollTop = prevScroll;
  }

  bindInspector(insp, { node, avatar, ownerCharacter, noteSaveKey }) {
    const titleInput = insp.querySelector('[data-role="custom-title"]');
    const noteInput = insp.querySelector('[data-role="note-input"]');
    fitTextarea(titleInput);
    fitTextarea(noteInput);

    const queueTitle = () => {
      this.pendingTitleSave = { avatar, chatId: node.chatId, value: titleInput.value.replace(/\s*\n\s*/g, ' ').trim() };
    };
    titleInput.addEventListener('input', () => {
      fitTextarea(titleInput);
      queueTitle();
    });
    titleInput.addEventListener('change', () => {
      queueTitle();
      this.flushPendingNoteSaves(noteSaveKey, { skipCenterRender: true, preserveDom: true });
      this.flushPendingTitleSave({ preserveDom: true });
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      queueTitle();
      this.flushPendingTitleSave({ preserveDom: true });
      titleInput.blur?.();
    });

    noteInput.addEventListener('input', () => {
      fitTextarea(noteInput);
      clearTimeout(this.pendingNoteSaves.get(noteSaveKey)?.timer);
      this.pendingNoteSaves.set(noteSaveKey, {
        avatar,
        chatId: node.chatId,
        value: noteInput.value.trim(),
        timer: setTimeout(() => this.flushPendingNoteSaves(noteSaveKey), 320),
      });
    });
    noteInput.addEventListener('blur', () => {
      this.flushPendingNoteSaves(noteSaveKey, { preserveDom: true });
    });

    const updateMeta = (patch) => {
      this.flushPendingNoteSaves(null, { skipCenterRender: true });
      this.adapter.updateSaveMeta(avatar, node.chatId, patch(this.adapter.getSaveMeta(avatar, node.chatId)));
      this.syncOverviewMetaCounts(avatar);
      this.renderSaves();
      this.renderInspector();
    };

    insp.querySelector('[data-role="insp-star-btn"]').addEventListener('click', () => {
      updateMeta((cur) => ({ starred: !cur.starred }));
    });
    insp.querySelector('[data-role="jump-btn"]').addEventListener('click', () => {
      this.handleJump(node.chatId, ownerCharacter);
    });
    insp.querySelectorAll('[data-select-save]').forEach((btn) => {
      btn.addEventListener('click', () => this.selectSave(avatar, btn.dataset.selectSave));
    });

    const tagInput = insp.querySelector('[data-role="new-tag-input"]');
    const commitNewTag = () => {
      const tag = tagInput?.value.trim().replace(/^#/, '');
      if (!tag) return false;
      updateMeta((cur) => ({ tags: Array.from(new Set([...cur.tags, tag])) }));
      return true;
    };
    insp.querySelector('[data-role="tag-editor-btn"]').addEventListener('click', () => {
      const closing = this.tagEditorOpen;
      this.tagEditorOpen = !closing;
      if (closing && commitNewTag()) return;
      this.flushPendingNoteSaves(null, { skipCenterRender: true });
      this.renderInspector();
      if (!closing) this.role('new-tag-input')?.focus();
    });
    tagInput?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (commitNewTag()) this.role('new-tag-input')?.focus();
    });
    insp.querySelectorAll('[data-toggle-tag]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.toggleTag;
        updateMeta((cur) => ({
          tags: cur.tags.includes(tag) ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag],
        }));
      });
    });
  }

  /* ---------------------------------------------------------------------- *
   * 跳转
   * ---------------------------------------------------------------------- */

  async handleJump(chatId, characterOverride = null) {
    const targetCharacter = characterOverride || this.currentCharacter;
    const cleanChatId = stripJsonl(chatId);
    if (!targetCharacter || !cleanChatId) return;
    if (
      !this.currentGraph ||
      (this.currentGraph.characterAvatar && this.currentGraph.characterAvatar !== targetCharacter.avatar)
    ) {
      return;
    }
    const targetNode = this.currentGraph.nodes.find((n) => n.chatId === cleanChatId);
    if (!targetNode) return;
    if (targetNode.isUnavailable) {
      this.showToast(targetNode.digestError || '该存档缺失或损坏，无法打开');
      return;
    }
    if (this.isJumping) return;

    this.flushPendingNoteSaves(null, { skipCenterRender: true, preserveDom: true });
    this.isJumping = true;
    const jumpSessionId = this.openSessionSeq;
    const jumpBtn = this.role('jump-btn');
    jumpBtn?.classList.add('is-busy');
    try {
      await this.adapter.jumpToSave(targetCharacter, cleanChatId);
      if (jumpSessionId === this.openSessionSeq && this.backdropEl && !this.backdropEl.hidden) {
        this.close();
      }
      this.showToast(this.saveTitle(targetCharacter.avatar, cleanChatId));
    } catch (err) {
      this.showToast(`切换失败：${err.message}`);
    } finally {
      this.isJumping = false;
      jumpBtn?.classList.remove('is-busy');
      this.role('jump-btn')?.classList.remove('is-busy');
    }
  }
}
