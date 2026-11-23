import assert from 'node:assert/strict';
import {
  SaveManagerAdapter,
  compactChatLines,
  parseChatResponsePayload,
  parseSillyTavernTimestamp,
} from '../src/adapter.js';
import { buildCharacterBranchGraph } from '../src/branchEngine.js';
import { SaveBranchManagerModal } from '../src/ui.js';

const adapter = new SaveManagerAdapter();
const overview = await adapter.loadGlobalOverview();

assert.equal(overview.length, 4, '应加载 4 张模拟角色卡');

// 1. 验证伊蕾娜多层嵌套分支 + 独立开局树
const elaina = overview.find((c) => c.avatar === 'elaina_witch.png');
const elainaDigests = await adapter.getCharacterChatDigests(elaina, elaina.saves);
const elainaGraph = buildCharacterBranchGraph(elaina, elainaDigests);

assert.equal(elainaGraph.nodes.length, 6, '伊蕾娜应有 6 个存档节点');
assert.equal(elainaGraph.rootCount, 2, '伊蕾娜应识别出 2 棵独立开局主干树');
assert.equal(elainaGraph.branchCount, 4, '伊蕾娜应识别出 4 处剧情分叉');

const trueEnd = elainaGraph.nodes.find((n) => n.chatId.includes('星砂拓印真结局'));
assert.ok(trueEnd, '应找到星砂拓印真结局节点');
assert.ok(trueEnd.parentId?.includes('酒窖暗道探索'), '真结局的父分支应为酒窖暗道探索');
assert.equal(trueEnd.branchMoment?.branchFloor, 10, '真结局应在第 10 楼处分叉');

// 2. 验证林夏“无独立检查点、两份同长存档中途分道扬镳”识别
const linxia = overview.find((c) => c.avatar === 'linxia_summer.png');
const linxiaDigests = await adapter.getCharacterChatDigests(linxia, linxia.saves);
const linxiaGraph = buildCharacterBranchGraph(linxia, linxiaDigests);

assert.equal(linxiaGraph.rootCount, 1, '林夏同源存档应归入 1 棵树');
assert.equal(linxiaGraph.branchCount, 1, '林夏应识别出 1 处分叉');
const longDistBranch = linxiaGraph.nodes.find((n) => n.chatId.includes('异地四年重逢线'));
assert.equal(longDistBranch.branchMoment?.branchFloor, 4, '林夏两条线应精准识别在第 4 楼分叉');
assert.ok(longDistBranch.branchMoment?.parentNextSnippet.includes('江南理工'), '应提取原主线第 5 楼走向');
assert.ok(longDistBranch.branchMoment?.childNextSnippet.includes('江南美院'), '应提取新分支第 5 楼走向');

// 3. 验证恶意循环 main_chat 元数据不会产生死循环
const cyclicA = {
  chatId: 'cyclic_a',
  floors: compactChatLines([
    { chat_metadata: { main_chat: 'cyclic_b' } },
    { name: 'A', is_user: false, mes: 'hello' },
  ]).floors,
  header: { chat_metadata: { main_chat: 'cyclic_b' } },
};
const cyclicB = {
  chatId: 'cyclic_b',
  floors: compactChatLines([
    { chat_metadata: { main_chat: 'cyclic_a' } },
    { name: 'A', is_user: false, mes: 'hello' },
  ]).floors,
  header: { chat_metadata: { main_chat: 'cyclic_a' } },
};
const cyclicGraph = buildCharacterBranchGraph({ avatar: 'test.png', activeChatId: '' }, [cyclicA, cyclicB]);
assert.ok(cyclicGraph.rootCount >= 1, '循环引用防护后至少保留 1 个根节点');

// 4. 验证 JSON 数组与原生 JSONL 响应解析兼容
const jsonArrParsed = parseChatResponsePayload(JSON.stringify([{ user_name: 'u' }, { name: 'A', mes: 'hi' }]));
assert.equal(jsonArrParsed.length, 2, '应兼容标准 JSON 数组格式');
const jsonlParsed = parseChatResponsePayload('{"user_name":"u"}\n{"name":"A","mes":"hi"}\n');
assert.equal(jsonlParsed.length, 2, '应兼容逐行 JSONL 文本格式');

// 5. [P1 #3] 验证原生检查点不会被反转为主线的父节点
{
  const mainLines = [
    { user_name: 'U', character_name: 'C', create_date: '2026-11-20 10:00:00', chat_metadata: {} },
    { name: 'C', is_user: false, mes: '开场白' },
    { name: 'U', is_user: true, mes: '第二楼选择' },
    { name: 'C', is_user: false, mes: '第三楼主线继续推进' },
  ];
  const checkpointLines = [
    { user_name: 'U', character_name: 'C', create_date: '2026-11-20 10:05:00', chat_metadata: { main_chat: 'main_story' } },
    { name: 'C', is_user: false, mes: '开场白' },
    { name: 'U', is_user: true, mes: '第二楼选择' },
  ];
  const mainDigest = { chatId: 'main_story', ...compactChatLines(mainLines) };
  const cpDigest = { chatId: 'checkpoint_f2', ...compactChatLines(checkpointLines) };
  const graph = buildCharacterBranchGraph({ avatar: 'c.png', activeChatId: 'main_story' }, [mainDigest, cpDigest]);

  const mainNode = graph.nodes.find((n) => n.chatId === 'main_story');
  const cpNode = graph.nodes.find((n) => n.chatId === 'checkpoint_f2');
  assert.equal(mainNode.parentId, null, '主线推进后仍应为根节点');
  assert.equal(cpNode.parentId, 'main_story', '原生检查点应作为主线的子节点');
  assert.equal(cpNode.branchMoment?.branchFloor, 2, '检查点应挂在第 2 楼');
  assert.equal(cpNode.branchMoment?.isCheckpointSnapshot, true, '应标记为检查点快照');
}

// 6. [P2 #4] 同一角色卡共用默认开场白的两次独立新聊天不应误判为分支
{
  const chat1 = {
    chatId: 'independent_1',
    ...compactChatLines([
      { create_date: '2026-11-20 10:00:00', chat_metadata: {} },
      { name: 'C', is_user: false, mes: '欢迎来到默认开场白！' },
      { name: 'U', is_user: true, mes: '第一次开局的回复' },
    ]),
  };
  const chat2 = {
    chatId: 'independent_2',
    ...compactChatLines([
      { create_date: '2026-11-21 10:00:00', chat_metadata: {} },
      { name: 'C', is_user: false, mes: '欢迎来到默认开场白！' },
      { name: 'U', is_user: true, mes: '第二次完全独立的新开局' },
    ]),
  };
  const graph = buildCharacterBranchGraph({ avatar: 'c.png', activeChatId: '' }, [chat1, chat2]);
  assert.equal(graph.rootCount, 2, '仅共享第 1 楼默认开场白的独立聊天应为 2 棵独立根');
  assert.equal(graph.branchCount, 0, '独立新聊天不应被误判为第 1 楼分叉');

  // 但显式 main_chat 标记的第 1 楼检查点仍应正确关联
  const explicitAtFloor1 = {
    chatId: 'explicit_f1_cp',
    ...compactChatLines([
      { create_date: '2026-11-20 10:01:00', chat_metadata: { main_chat: 'independent_1' } },
      { name: 'C', is_user: false, mes: '欢迎来到默认开场白！' },
    ]),
  };
  const graphWithExplicit = buildCharacterBranchGraph({ avatar: 'c.png', activeChatId: '' }, [chat1, chat2, explicitAtFloor1]);
  assert.equal(graphWithExplicit.rootCount, 2, '显式第 1 楼检查点应归属原主线，其余独立开局仍独立');
  assert.equal(
    graphWithExplicit.nodes.find((n) => n.chatId === 'explicit_f1_cp')?.parentId,
    'independent_1',
    '显式 main_chat 的第 1 楼检查点应挂到主线'
  );
}

// 7. [P2 #5] 长消息超过 240 字后分叉必须被精准检测，不能误判为完整副本
{
  const prefix300 = '星光洒落在古老的钟塔石阶上，微风卷起泛黄的羊皮纸页。'.repeat(15);
  assert.ok(prefix300.length > 300);
  const saveA = {
    chatId: 'long_a',
    ...compactChatLines([
      { create_date: '2026-11-20 10:00:00', chat_metadata: {} },
      { name: 'C', is_user: false, mes: '开场白' },
      { name: 'U', is_user: true, mes: '共同第二楼' },
      { name: 'C', is_user: false, mes: `${prefix300} 走向A：她轻轻合上魔导书。` },
    ]),
  };
  const saveB = {
    chatId: 'long_b',
    ...compactChatLines([
      { create_date: '2026-11-20 10:10:00', chat_metadata: {} },
      { name: 'C', is_user: false, mes: '开场白' },
      { name: 'U', is_user: true, mes: '共同第二楼' },
      { name: 'C', is_user: false, mes: `${prefix300} 走向B：她突然撕碎了契约。` },
    ]),
  };
  assert.notEqual(saveA.floors[2].hash, saveB.floors[2].hash, '240 字符之后存在差异的长消息哈希必须不同');
  const graph = buildCharacterBranchGraph({ avatar: 'c.png', activeChatId: '' }, [saveA, saveB]);
  const nodeB = graph.nodes.find((n) => n.chatId === 'long_b');
  assert.equal(nodeB.parentId, 'long_a');
  assert.equal(nodeB.branchMoment?.branchFloor, 2, '第 3 楼后半段不同时，分叉点应为第 2 楼而非第 3 楼');
  assert.equal(nodeB.branchMoment?.isExactCopy, false, '长消息后半段不同时绝不能标为完整副本');
}

// 8. [P1 #1] 角色切换失败时，绝不能在原角色下打开目标存档
{
  const prevWindow = globalThis.window;
  let openChatCalls = [];
  let selectCalls = [];
  const mockCtx = {
    characterId: '0',
    groupId: null,
    characters: [
      { name: 'CharA', avatar: 'a.png', chat: 'a_chat_1' },
      { name: 'CharB', avatar: 'b.png', chat: 'b_chat_1' },
    ],
    getRequestHeaders: () => ({}),
    // 模拟酒馆正在生成回复/保存聊天时直接跳过角色切换（不修改 characterId）
    selectCharacterById: async (id) => {
      selectCalls.push(id);
    },
    openCharacterChat: async (chatId) => {
      openChatCalls.push({ charId: mockCtx.characterId, chatId });
      mockCtx.characters[Number(mockCtx.characterId)].chat = chatId;
    },
  };

  globalThis.window = {
    SillyTavern: { getContext: () => mockCtx },
  };

  try {
    const liveAdapter = new SaveManagerAdapter({ switchVerifyTimeoutMs: 60, switchPollIntervalMs: 15 });
    await assert.rejects(
      () => liveAdapter.jumpToSave({ id: 1, name: 'CharB', avatar: 'b.png' }, 'b_chat_target'),
      /未能切换到角色/,
      '角色切换失败时必须抛出明确错误'
    );
    assert.deepEqual(selectCalls, ['1'], '应尝试切换至目标角色');
    assert.equal(openChatCalls.length, 0, '角色未切换成功时绝不能调用 openCharacterChat');
    assert.equal(mockCtx.characters[0].chat, 'a_chat_1', '原角色当前存档不应被篡改');

    // 验证 characterId 为 null 时跳到 0 号角色不会被 Number(null)===0 误判为无需切换
    mockCtx.characterId = null;
    selectCalls = [];
    mockCtx.selectCharacterById = async (id) => {
      selectCalls.push(id);
      mockCtx.characterId = String(id);
    };
    await liveAdapter.jumpToSave({ id: 0, name: 'CharA', avatar: 'a.png' }, 'a_chat_2');
    assert.deepEqual(selectCalls, ['0'], 'characterId 为 null 时跳到 0 号角色仍应执行角色切换');
    assert.deepEqual(openChatCalls, [{ charId: '0', chatId: 'a_chat_2' }], '角色切换成功后才打开目标存档');
  } finally {
    globalThis.window = prevWindow;
  }
}

// 9. [P2 #6] 验证存档列表 TTL / 重开大厅刷新 + 等长编辑早期消息后楼层摘要不读旧缓存
{
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const listeners = new Map();
  let chatListVersion = 1;
  let floor1Mes = '原始第一楼内容AAAA';
  let getChatCalls = 0;

  const mockCtx = {
    characterId: '0',
    chatId: 'chat_active',
    groupId: null,
    characters: [{ name: 'CharA', avatar: 'a.png', chat: 'chat_active' }],
    getRequestHeaders: () => ({}),
    event_types: {
      MESSAGE_EDITED: 'message_edited',
      CHAT_CHANGED: 'chat_changed',
    },
    eventSource: {
      on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      emit(evt) {
        for (const fn of listeners.get(evt) || []) fn();
      },
    },
  };

  globalThis.window = {
    SillyTavern: { getContext: () => mockCtx },
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === 'api/characters/chats') {
      const items = [
        { file_name: 'chat_active.jsonl', file_size: '10.00KB', chat_items: 2, last_mes: '2026-11-20T10:00:00Z', mes: '最后一句不变' },
        { file_name: 'chat_other.jsonl', file_size: '10.00KB', chat_items: 2, last_mes: '2026-11-19T10:00:00Z', mes: '其他存档尾句' },
      ];
      if (chatListVersion >= 2) {
        items.push({ file_name: 'chat_new.jsonl', file_size: '5.00KB', chat_items: 1, last_mes: '2026-11-23T10:00:00Z', mes: '新建存档' });
      }
      return { ok: true, json: async () => items };
    }
    if (url === 'api/chats/get') {
      getChatCalls += 1;
      const lines =
        body.file_name === 'chat_active'
          ? [{ chat_metadata: {} }, { name: 'C', is_user: false, mes: floor1Mes }, { name: 'U', is_user: true, mes: '最后一句不变' }]
          : [{ chat_metadata: {} }, { name: 'C', is_user: false, mes: floor1Mes }, { name: 'U', is_user: true, mes: '其他存档尾句' }];
      return { ok: true, text: async () => JSON.stringify(lines) };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const liveAdapter = new SaveManagerAdapter({ summaryCacheTtlMs: 30, digestCacheTtlMs: 60_000 });
    // 用内存实现替换 digestCache，模拟真实 IndexedDB 命中路径
    const memStore = new Map();
    liveAdapter.digestCache = {
      async get(key, fp, maxAgeMs) {
        const rec = memStore.get(key);
        if (!rec || rec.fp !== fp) return null;
        if (maxAgeMs > 0 && Date.now() - rec.savedAt >= maxAgeMs) return null;
        return rec.digest;
      },
      async set(key, fp, digest) {
        memStore.set(key, { fp, digest, savedAt: Date.now() });
      },
      async delete(key) {
        memStore.delete(key);
      },
      async clearAll() {
        memStore.clear();
      },
    };
    liveAdapter.bindSillyTavernEvents();

    const charA = liveAdapter.getCharacters()[0];
    const s1 = await liveAdapter.getCharacterChatSummaries(charA);
    assert.equal(s1.length, 2);

    // 新建存档后，等待 TTL 过期应自动拿到最新列表
    chatListVersion = 2;
    await new Promise((r) => setTimeout(r, 45));
    const s2 = await liveAdapter.getCharacterChatSummaries(charA);
    assert.equal(s2.length, 3, 'summaryCache TTL 过期后应能看到新建存档');

    // 首次读取 digests 并写入缓存
    const d1 = await liveAdapter.getCharacterChatDigests(charA, s1);
    assert.ok(d1[0].floors[0].snippet.includes('AAAA'));
    assert.equal(getChatCalls, 2);

    // 等长编辑早期消息（last_mes / file_size / chat_items / previewText 全部不变）
    floor1Mes = '原始第一楼内容BBBB';

    // 1) 活跃存档即使未发事件也绕过缓存拿到新内容
    const d2 = await liveAdapter.getCharacterChatDigests(charA, s1);
    assert.ok(d2[0].floors[0].snippet.includes('BBBB'), '活跃存档等长编辑早期消息后应读到最新摘要');

    // 2) 非活跃存档在收到 MESSAGE_EDITED 事件后被立即失效并重新拉取
    mockCtx.chatId = 'chat_other';
    mockCtx.characters[0].chat = 'chat_other';
    mockCtx.eventSource.emit('message_edited');
    mockCtx.chatId = 'chat_active';
    mockCtx.characters[0].chat = 'chat_active';
    const d3 = await liveAdapter.getCharacterChatDigests(charA, s1);
    assert.ok(d3[1].floors[0].snippet.includes('BBBB'), '收到编辑事件后的存档切走后也应读到最新摘要');
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

// 10. [P1 #2 & P2 #7] UI 级测试：快速切换角色防竞态 + 连续编辑两份存档备注不丢失
{
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevRAF = globalThis.requestAnimationFrame;

  class FakeElement {
    constructor(role = '') {
      this.role = role;
      this.hidden = false;
      this.textContent = '';
      this.value = '';
      this.dataset = {};
      this.style = {};
      this.isConnected = true;
      this.clientWidth = 800;
      this.clientHeight = 600;
      this._innerHTML = '';
      this.listeners = new Map();
      this.classList = {
        toggle() {},
        add() {},
        remove() {},
      };
      this.childrenByRole = new Map();
    }
    set innerHTML(val) {
      this._innerHTML = String(val);
      // 模拟 DOM 替换时旧子节点失活
      for (const child of this.childrenByRole.values()) {
        child.isConnected = false;
      }
      this.childrenByRole.clear();
    }
    get innerHTML() {
      return this._innerHTML;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatch(type, extra = {}) {
      for (const fn of this.listeners.get(type) || []) {
        fn({ preventDefault() {}, stopPropagation() {}, ...extra });
      }
    }
    querySelector(sel) {
      const m = sel.match(/\[data-role="([^"]+)"\]/);
      if (m) {
        const key = m[1];
        if (!this.childrenByRole.has(key)) {
          this.childrenByRole.set(key, new FakeElement(key));
        }
        return this.childrenByRole.get(key);
      }
      return null;
    }
    querySelectorAll() {
      return [];
    }
    appendChild() {}
    remove() {}
  }

  globalThis.document = {
    createElement: () => new FakeElement(),
    body: { appendChild() {} },
    addEventListener() {},
  };
  globalThis.window = {
    addEventListener() {},
  };
  globalThis.requestAnimationFrame = (cb) => cb();

  try {
    // 10A. [P1 #2] 快速切换角色：先选 A（慢返回），再选 B（快返回），A 后返回时不能覆盖 B 的存档树
    const deferred = {};
    const mkDeferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    deferred.A = mkDeferred();
    deferred.B = mkDeferred();

    const raceAdapter = new SaveManagerAdapter();
    raceAdapter.getCharacterChatDigests = async (ch) => deferred[ch.avatar].promise;

    const modal = new SaveBranchManagerModal(raceAdapter);
    modal.backdropEl = new FakeElement('backdrop');
    modal.overviewList = [
      { id: 0, name: '角色A', avatar: 'A', saves: [{ chatId: 'a_save_1' }], saveCount: 1, starredCount: 0, notedCount: 0, latestTimestamp: 1 },
      { id: 1, name: '角色B', avatar: 'B', saves: [{ chatId: 'b_save_1' }], saveCount: 1, starredCount: 0, notedCount: 0, latestTimestamp: 2 },
    ];

    const pA = modal.selectCharacter('A');
    const pB = modal.selectCharacter('B');

    deferred.B.resolve([
      { chatId: 'b_save_1', header: {}, floors: [{ floor: 1, name: 'B', isUser: false, hash: 'hb1', snippet: 'B内容' }], messageCount: 1 },
    ]);
    await pB;
    assert.equal(modal.currentCharacter.avatar, 'B');
    assert.equal(modal.currentGraph.characterAvatar, 'B');
    assert.equal(modal.selectedChatId, 'b_save_1');

    // 现在过期的 A 请求返回
    deferred.A.resolve([
      { chatId: 'a_save_1', header: {}, floors: [{ floor: 1, name: 'A', isUser: false, hash: 'ha1', snippet: 'A内容' }], messageCount: 1 },
    ]);
    await pA;

    assert.equal(modal.currentCharacter.avatar, 'B', '过期响应返回后当前角色仍应为 B');
    assert.equal(modal.currentGraph.characterAvatar, 'B', '过期响应不能覆盖当前分支图');
    assert.equal(modal.currentGraph.nodes[0].chatId, 'b_save_1', '画布节点应仍属于角色 B');
    assert.equal(modal.selectedChatId, 'b_save_1', '选中存档不能被角色 A 的存档覆盖');

    // 10B. [P2 #7] 连续编辑两份存档的备注（间隔 < 320ms），第一条备注不能被取消丢弃
    const savedMeta = new Map();
    const noteAdapter = new SaveManagerAdapter();
    noteAdapter.getSaveMeta = (av, cid) => savedMeta.get(`${av}::${cid}`) || { starred: false, customTitle: '', tags: [], note: '', updatedAt: '' };
    noteAdapter.updateSaveMeta = (av, cid, patch) => {
      const next = { ...noteAdapter.getSaveMeta(av, cid), ...patch };
      savedMeta.set(`${av}::${cid}`, next);
      return next;
    };

    const noteModal = new SaveBranchManagerModal(noteAdapter);
    noteModal.backdropEl = new FakeElement('backdrop');
    noteModal.overviewList = [
      {
        id: 0,
        name: '角色A',
        avatar: 'A',
        saves: [{ chatId: 'save_1' }, { chatId: 'save_2' }],
        saveCount: 2,
        starredCount: 0,
        notedCount: 0,
        latestTimestamp: 1,
      },
    ];
    noteModal.currentCharacter = noteModal.overviewList[0];
    noteModal.currentGraph = {
      characterAvatar: 'A',
      nodes: [
        { chatId: 'save_1', floorCount: 2, floors: [{ floor: 1, name: 'A', snippet: '1' }], childrenIds: [], parentId: null, branchMoment: null, x: 0, y: 0 },
        { chatId: 'save_2', floorCount: 2, floors: [{ floor: 1, name: 'A', snippet: '2' }], childrenIds: [], parentId: null, branchMoment: null, x: 0, y: 0 },
      ],
      edges: [],
      roots: [],
      canvasWidth: 400,
      canvasHeight: 300,
    };

    // 编辑 save_1 备注
    noteModal.selectedChatId = 'save_1';
    noteModal.renderInspector();
    const insp = noteModal.backdropEl.querySelector('[data-role="inspector"]');
    const input1 = insp.querySelector('[data-role="note-input"]');
    input1.value = '第一份存档的重要备注';
    input1.dispatch('input');

    // 320ms 内直接切换到 save_2 并开始输入第二份备注（不触发 blur，模拟最快切换）
    noteModal.selectedChatId = 'save_2';
    noteModal.renderInspector();
    const input2 = insp.querySelector('[data-role="note-input"]');
    input2.value = '第二份存档的备注';
    input2.dispatch('input');

    // 等待防抖计时器完成
    await new Promise((r) => setTimeout(r, 380));
    assert.equal(noteAdapter.getSaveMeta('A', 'save_1').note, '第一份存档的重要备注', '第一份存档备注不能被第二份编辑取消');
    assert.equal(noteAdapter.getSaveMeta('A', 'save_2').note, '第二份存档的备注', '第二份存档备注应正确保存');

    // 10C. 自定义标题输入后直接按 Esc/close 也不丢失
    const titleInput = insp.querySelector('[data-role="custom-title"]');
    titleInput.value = '直接关闭前的别名';
    titleInput.dispatch('input');
    noteModal.close();
    assert.equal(noteAdapter.getSaveMeta('A', 'save_2').customTitle, '直接关闭前的别名', '关闭弹窗时应落盘未失焦的自定义标题');
  } finally {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
    globalThis.requestAnimationFrame = prevRAF;
  }
}

// 11. 验证 SillyTavern 各类原生时间格式解析（修复 Date.parse 返回 NaN 导致的排序与时间展示失效）
{
  const ts1 = parseSillyTavernTimestamp('2026-11-23@18h20m12s');
  const ts2 = parseSillyTavernTimestamp('2026-11-23 @18h 20m 12s 345ms');
  const ts3 = parseSillyTavernTimestamp('November 23, 2026 6:20pm');
  const ts4 = parseSillyTavernTimestamp('2026年11月23日 18:20');
  assert.ok(Number.isFinite(ts1) && ts1 > 0, '应解析 2026-11-23@18h20m12s');
  assert.ok(Number.isFinite(ts2) && ts2 === ts1 + 345, '应解析带空格与毫秒的酒馆时间戳');
  assert.ok(Number.isFinite(ts3) && ts3 > 0, '应解析无空格 am/pm 的 moment.js 时间格式');
  assert.ok(Number.isFinite(ts4) && ts4 > 0, '应解析中文日期时间格式');
}

// 12. 验证请求在途期间收到 MESSAGE_EDITED 失效事件，旧响应不会覆写脏标记并污染缓存
{
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const listeners = new Map();
  let resolveSlowFetch;
  let fetchCount = 0;

  const mockCtx = {
    characterId: '0',
    chatId: 'other_chat',
    groupId: null,
    characters: [{ name: 'CharA', avatar: 'a.png', chat: 'other_chat' }],
    getRequestHeaders: () => ({}),
    event_types: { MESSAGE_EDITED: 'message_edited' },
    eventSource: {
      on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      emit(evt) {
        for (const fn of listeners.get(evt) || []) fn();
      },
    },
  };

  globalThis.window = { SillyTavern: { getContext: () => mockCtx } };
  globalThis.fetch = async (url) => {
    if (url !== 'api/chats/get') throw new Error(`Unexpected URL: ${url}`);
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Promise((resolve) => {
        resolveSlowFetch = () =>
          resolve({
            ok: true,
            text: async () =>
              JSON.stringify([{ chat_metadata: {} }, { name: 'C', is_user: false, mes: '旧内容_111' }]),
          });
      });
    }
    return {
      ok: true,
      text: async () => JSON.stringify([{ chat_metadata: {} }, { name: 'C', is_user: false, mes: '新内容_222' }]),
    };
  };

  try {
    const liveAdapter = new SaveManagerAdapter();
    const memStore = new Map();
    liveAdapter.digestCache = {
      async get(key, fp) {
        const rec = memStore.get(key);
        return rec && rec.fp === fp ? rec.digest : null;
      },
      async set(key, fp, digest) {
        memStore.set(key, { fp, digest });
      },
      async delete(key) {
        memStore.delete(key);
      },
      async clearAll() {
        memStore.clear();
      },
    };
    liveAdapter.bindSillyTavernEvents();

    const charA = { id: 0, name: 'CharA', avatar: 'a.png', activeChatId: 'other_chat' };
    const summary = {
      chatId: 'target_chat',
      fileName: 'target_chat.jsonl',
      fileSize: '1.00KB',
      messageCount: 1,
      lastModified: '2026-11-23T10:00:00Z',
      previewText: '旧内容_111',
    };

    const p1 = liveAdapter.getCharacterChatDigests(charA, [summary]);
    // 等待 fetch 真正发出后再模拟编辑失效
    await new Promise((r) => setTimeout(r, 10));
    liveAdapter.invalidateChatCache('a.png', 'target_chat');
    resolveSlowFetch();
    await p1;

    assert.equal(memStore.has('a.png::target_chat'), false, '在途请求期间失效后，旧响应不得写入缓存');
    const d2 = await liveAdapter.getCharacterChatDigests(charA, [summary]);
    assert.ok(d2[0].floors[0].snippet.includes('新内容_222'), '下一次读取应重新拉取到最新内容');
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

console.log('✅ 所有分支检测、三方对比、树布局及回归测试全部通过！');
