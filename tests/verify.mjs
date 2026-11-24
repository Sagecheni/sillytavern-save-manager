import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SaveManagerAdapter,
  compactChatLines,
  formatFileSize,
  parseChatResponsePayload,
  parseSillyTavernTimestamp,
  parseTauriChatPayload,
} from '../src/adapter.js';
import { buildCharacterBranchGraph } from '../src/branchEngine.js';
import { SaveBranchManagerModal } from '../src/ui.js';

function createMemDigestCache(initialStore = new Map()) {
  const store = initialStore;
  return {
    store,
    async get(key, fp, maxAgeMs = 0) {
      const rec = store.get(key);
      if (!rec || rec.fp !== fp) return null;
      if (maxAgeMs > 0 && typeof rec.savedAt === 'number' && Date.now() - rec.savedAt >= maxAgeMs) return null;
      return rec.digest;
    },
    async getMany(entries, maxAgeMs = 0) {
      const hits = new Map();
      for (const { cacheKey, fingerprint } of entries) {
        const hit = await this.get(cacheKey, fingerprint, maxAgeMs);
        if (hit) hits.set(cacheKey, hit);
      }
      return hits;
    },
    async set(key, fp, digest) {
      store.set(key, { fp, digest, savedAt: Date.now() });
      return true;
    },
    async delete(key) {
      store.delete(key);
    },
    async clearAll() {
      store.clear();
    },
  };
}

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

// 1B. 故事线布局：延续直行、分叉右移、父存档永远在子存档之前
{
  const at = (key) => elainaGraph.nodes.find((n) => n.chatId.includes(key));
  assert.equal(elainaGraph.order.length, 6, '故事线应包含全部存档');
  assert.equal(elainaGraph.laneCount, 2, '伊蕾娜故事线应只占 2 条轨道');
  assert.deepEqual(
    ['初入钟塔主干', '酒窖暗道探索', '星砂拓印真结局'].map((k) => at(k).lane),
    [0, 0, 0],
    '正在游玩的剧情应沿同一轨道直行'
  );
  assert.equal(at('强夺星砂').lane, 1, '分叉剧情应开出新轨道');
  assert.equal(at('午夜正面硬闯').lane, 1, '分叉剧情应开出新轨道');
  for (const n of elainaGraph.nodes) {
    assert.equal(elainaGraph.order[n.row], n, 'row 应与故事线顺序一致');
    if (n.parentId) assert.ok(elainaGraph.nodes.find((p) => p.chatId === n.parentId).row < n.row, '父存档应排在子存档之前');
  }
}

// 1B-2. 反复「倒回某楼再开分支」：main_chat 指向点按钮时所在的文件，不得据此串成长链
{
  let uid = 0;
  const story = (from, count) => [...from, ...Array.from({ length: count }, (_, i) => ({ floor: from.length + i + 1, name: '', isUser: false, hash: `c${++uid}`, snippet: '' }))];
  const save = (chatId, floors, mainChat = '', hour = 0) => ({
    chatId,
    floors,
    lastModified: `2026-10-0${1 + Math.floor(hour / 24)}T${String(hour % 24).padStart(2, '0')}:00:00Z`,
    header: { create_date: `2026-10-0${1 + Math.floor(hour / 24)}T${String(hour % 24).padStart(2, '0')}:00:00Z`, chat_metadata: mainChat ? { main_chat: mainChat } : {} },
  });
  const a = story([], 20);
  const b = story(a.slice(0, 10), 30); // 从 a 的 10 楼分出，走到 40
  const c = story(b.slice(0, 30), 2); // 从 b 的 30 楼分出，失败
  const d = story(c.slice(0, 30), 3); // 在 c 里回到 30 楼重来，又失败
  const e = story(d.slice(0, 30), 20); // 在 d 里回到 30 楼重来，走到 50
  const f = story(e.slice(0, 5), 3); // 在 e 里一路翻回 5 楼另开一条
  const g = story(e.slice(0, 25), 40); // 在 e 里翻回 25 楼，走到 65
  const graph = buildCharacterBranchGraph({ avatar: 'retry' }, [
    save('a', a, '', 0), save('b', b, 'a', 1), save('c', c, 'b', 2), save('d', d, 'c', 3),
    save('e', e, 'd', 4), save('f', f, 'e', 5), save('g', g, 'e', 6),
  ]);
  const by = new Map(graph.nodes.map((n) => [n.chatId, n]));
  assert.deepEqual(['b', 'c', 'd', 'e', 'f', 'g'].map((id) => by.get(id).parentId), ['a', 'b', 'b', 'b', 'a', 'b'], '应归到真正拥有分叉楼层的存档');
  assert.deepEqual(['c', 'd', 'e', 'f', 'g'].map((id) => by.get(id).branchMoment.branchFloor), [30, 30, 30, 5, 25]);
  for (const n of graph.nodes) {
    const parent = by.get(n.parentId);
    if (parent?.branchMoment) assert.ok(n.branchMoment.branchFloor > parent.branchMoment.branchFloor, '沿任意一条线，分叉楼层只增不减');
  }
  assert.deepEqual(['a', 'b', 'g'].map((id) => by.get(id).lane), [0, 0, 0], '走得最远的一条应直行');
  assert.deepEqual(['c', 'd', 'e', 'f'].map((id) => by.get(id).lane), [1, 1, 1, 1], '其余支线只右移一格，不得逐级右移');
}

// 1C. 未命名存档的标题：剥除酒馆自动文件名，取这条线独有的开头；用户起的名字优先
{
  const floor = (i, snippet, hash = snippet) => ({ floor: i, name: '', isUser: i % 2 === 0, hash, snippet });
  const trunk = [floor(1, '开场白'), floor(2, '“等等。”你握住她的手腕，没有松开。')];
  const main = 'Seraphina - 2026-11-01@10h00m00s';
  const digest = (chatId, floors, mainChat = '') => ({
    chatId,
    floors,
    header: { chat_metadata: mainChat ? { main_chat: mainChat } : {} },
  });
  const ch = { avatar: 's.png', name: 'Seraphina' };
  const graph = buildCharacterBranchGraph(ch, [
    digest(main, [...trunk, floor(3, '主线')]),
    digest('Branch #1 - 2026-11-02@10h00m00s204ms', [...trunk, floor(3, '*你转身推开了那扇门*，风灌进来')], main),
    digest('2026-11-03@10h00m00s_雨夜驿站', [floor(1, '开场白'), floor(2, '别的')]),
  ]);
  const titleModal = new SaveBranchManagerModal(new SaveManagerAdapter());
  titleModal.indexAutoTitles(ch, graph);
  assert.equal(titleModal.saveTitle('s.png', main), '等等。你握住她的手腕');
  assert.equal(titleModal.saveTitle('s.png', 'Branch #1 - 2026-11-02@10h00m00s204ms'), '你转身推开了那扇门');
  assert.equal(titleModal.saveTitle('s.png', '2026-11-03@10h00m00s_雨夜驿站'), '雨夜驿站');

  // 预设包裹的固定开头与空回复不得成为标题
  const acts = ['推门走进大宅', '把密信烧掉', '先去找掌柜', '穿过回廊', '绕到后院', '沿河往下游走'];
  const wrapped = acts.map((act, i) => floor(i + 2, `以下是用户的本轮输入： ${act}，然后离开`));
  const base = [floor(1, '开场白'), ...wrapped.slice(0, 5)];
  const wrappedGraph = buildCharacterBranchGraph({ avatar: 'w.png', name: 'W' }, [
    digest('W - 2026-11-01@10h00m00s', base),
    digest('Branch #1 - 2026-11-02@10h00m00s', [...base.slice(0, 4), floor(5, '[The message is empty]'), wrapped[5]], 'W - 2026-11-01@10h00m00s'),
  ]);
  titleModal.indexAutoTitles({ avatar: 'w.png', name: 'W' }, wrappedGraph);
  assert.equal(titleModal.saveTitle('w.png', 'W - 2026-11-01@10h00m00s'), '推门走进大宅');
  assert.equal(titleModal.saveTitle('w.png', 'Branch #1 - 2026-11-02@10h00m00s'), '沿河往下游走');
}

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
    liveAdapter.digestCache = createMemDigestCache();
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
    const cache = createMemDigestCache();
    const memStore = cache.store;
    liveAdapter.digestCache = cache;
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

// 13. [复查 P1 #1] 并发重叠跳转必须严格串行化，旧请求绝不能在错误角色下打开存档
{
  const prevWindow = globalThis.window;
  let releaseSelectA;
  const openEvents = [];
  const mockCtx = {
    characterId: '0',
    chatId: 'init_chat',
    groupId: null,
    characters: [
      { name: 'CharA', avatar: 'a.png', chat: 'a_init' },
      { name: 'CharB', avatar: 'b.png', chat: 'b_init' },
    ],
    getRequestHeaders: () => ({}),
    selectCharacterById: async (id) => {
      if (id === '0') {
        await new Promise((r) => {
          releaseSelectA = r;
        });
      }
      mockCtx.characterId = String(id);
      mockCtx.chatId = mockCtx.characters[Number(id)].chat;
    },
    openCharacterChat: async (chatId) => {
      const activeIdx = Number(mockCtx.characterId);
      openEvents.push({ charId: activeIdx, chatId });
      mockCtx.characters[activeIdx].chat = chatId;
      mockCtx.chatId = chatId;
    },
  };
  // 初始在角色 1，让跳到角色 0（A）必须经过 selectCharacterById
  mockCtx.characterId = '1';
  globalThis.window = { SillyTavern: { getContext: () => mockCtx } };

  try {
    const liveAdapter = new SaveManagerAdapter({ switchVerifyTimeoutMs: 100, switchPollIntervalMs: 15 });
    const jumpA = liveAdapter.jumpToSave({ id: 0, name: 'CharA', avatar: 'a.png' }, 'a_target');
    await new Promise((r) => setTimeout(r, 15));
    // A 尚在 selectCharacterById 等待时，立刻发起跳向 B 的请求
    const jumpB = liveAdapter.jumpToSave({ id: 1, name: 'CharB', avatar: 'b.png' }, 'b_target');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(openEvents.length, 0, 'A 未完成前 B 不应抢先写入会话');

    releaseSelectA();
    await Promise.all([jumpA, jumpB]);

    assert.deepEqual(
      openEvents,
      [
        { charId: 0, chatId: 'a_target' },
        { charId: 1, chatId: 'b_target' },
      ],
      '并发跳转应严格串行执行，每次 openCharacterChat 都落在对应角色下'
    );
    assert.equal(mockCtx.characters[0].chat, 'a_target');
    assert.equal(mockCtx.characters[1].chat, 'b_target');
  } finally {
    globalThis.window = prevWindow;
  }
}

// 14. [复查 P1 #2] 嵌套检查点（5楼主线 -> 4楼外层检查点 -> 2楼内层检查点）在任意输入顺序下都不能反转主线
{
  const makeMsg = (i, text) => ({ name: i % 2 ? 'C' : 'U', is_user: i % 2 === 0, mes: text });
  const mainDigest = {
    chatId: 'main_5f',
    ...compactChatLines([
      { create_date: '2026-11-20 10:00:00', chat_metadata: {} },
      makeMsg(1, '开场'),
      makeMsg(2, '二楼'),
      makeMsg(3, '三楼'),
      makeMsg(4, '四楼'),
      makeMsg(5, '五楼主线'),
    ]),
  };
  const outerCp = {
    chatId: 'outer_cp_4f',
    ...compactChatLines([
      { create_date: '2026-11-20 10:10:00', chat_metadata: { main_chat: 'main_5f' } },
      makeMsg(1, '开场'),
      makeMsg(2, '二楼'),
      makeMsg(3, '三楼'),
      makeMsg(4, '四楼'),
    ]),
  };
  const innerCp = {
    chatId: 'inner_cp_2f',
    ...compactChatLines([
      { create_date: '2026-11-20 10:20:00', chat_metadata: { main_chat: 'outer_cp_4f' } },
      makeMsg(1, '开场'),
      makeMsg(2, '二楼'),
    ]),
  };

  const permutations = [
    [mainDigest, outerCp, innerCp],
    [mainDigest, innerCp, outerCp],
    [outerCp, mainDigest, innerCp],
    [outerCp, innerCp, mainDigest],
    [innerCp, mainDigest, outerCp],
    [innerCp, outerCp, mainDigest],
  ];

  for (const perm of permutations) {
    const graph = buildCharacterBranchGraph({ avatar: 'c.png', activeChatId: 'main_5f' }, perm);
    const m = graph.nodes.find((n) => n.chatId === 'main_5f');
    const o = graph.nodes.find((n) => n.chatId === 'outer_cp_4f');
    const i = graph.nodes.find((n) => n.chatId === 'inner_cp_2f');
    assert.equal(m.parentId, null, '任意顺序下主线都必须是根节点');
    assert.equal(o.parentId, 'main_5f', '外层检查点必须挂在主线下');
    // 外层检查点在 4 楼才离开主线，内层的前 2 楼属于主线本身，应上移到主线，保证分叉楼层只增不减
    assert.equal(i.parentId, 'main_5f', '内层检查点必须挂在真正拥有第 2 楼的主线下');
  }
}

// 15. [复查 P1 #3] IndexedDB 升级触发 onblocked 时应立即降级绕过缓存，不阻塞加载
{
  const prevIndexedDB = globalThis.indexedDB;
  let openCalls = 0;
  let closedByVersionChange = false;
  globalThis.indexedDB = {
    open() {
      openCalls += 1;
      const req = {};
      if (openCalls === 1) {
        setTimeout(() => req.onblocked?.(), 5);
      } else {
        const fakeDb = {
          close() {
            closedByVersionChange = true;
          },
        };
        setTimeout(() => {
          req.result = fakeDb;
          req.onsuccess?.();
        }, 5);
      }
      return req;
    },
  };

  try {
    const idbAdapter = new SaveManagerAdapter({ idbOpenTimeoutMs: 200 });
    const db1 = await idbAdapter.digestCache.open();
    assert.equal(db1, null, 'onblocked 触发后应立刻返回 null 绕过本地缓存');
    // 解除阻塞后应能重新建立连接，并在收到 versionchange 时主动关闭连接
    const db2 = await idbAdapter.digestCache.open();
    assert.ok(db2, '旧标签页关闭后下一次应可正常打开新版 IndexedDB');
    db2.onversionchange?.();
    assert.equal(closedByVersionChange, true, '收到 onversionchange 时应主动关闭连接避免阻塞后续升级');
  } finally {
    globalThis.indexedDB = prevIndexedDB;
  }
}

// 16. [复查 P2 #4] 强制刷新与并发请求竞态：旧响应返回后不得覆盖新缓存（楼层缓存 & 列表缓存）
{
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  let resolveSlowSummary;
  let resolveSlowDigest;
  let summaryCall = 0;
  let digestCall = 0;

  const mockCtx = {
    characterId: '0',
    chatId: 'other_active',
    groupId: null,
    characters: [{ name: 'CharA', avatar: 'a.png', chat: 'other_active' }],
    getRequestHeaders: () => ({}),
  };
  globalThis.window = { SillyTavern: { getContext: () => mockCtx } };
  globalThis.fetch = async (url) => {
    if (url === 'api/characters/chats') {
      summaryCall += 1;
      if (summaryCall === 1) {
        return new Promise((resolve) => {
          resolveSlowSummary = () =>
            resolve({
              ok: true,
              json: async () => [{ file_name: 'old_only.jsonl', file_size: '1KB', chat_items: 1, last_mes: '2026-11-20', mes: 'old' }],
            });
        });
      }
      return {
        ok: true,
        json: async () => [
          { file_name: 'old_only.jsonl', file_size: '1KB', chat_items: 1, last_mes: '2026-11-20', mes: 'old' },
          { file_name: 'new_save.jsonl', file_size: '2KB', chat_items: 2, last_mes: '2026-11-23', mes: 'new' },
        ],
      };
    }
    if (url === 'api/chats/get') {
      digestCall += 1;
      if (digestCall === 1) {
        return new Promise((resolve) => {
          resolveSlowDigest = () =>
            resolve({
              ok: true,
              text: async () => JSON.stringify([{ chat_metadata: {} }, { name: 'C', is_user: false, mes: '旧楼层内容_OLD' }]),
            });
        });
      }
      return {
        ok: true,
        text: async () => JSON.stringify([{ chat_metadata: {} }, { name: 'C', is_user: false, mes: '新楼层内容_NEW' }]),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const liveAdapter = new SaveManagerAdapter({ summaryCacheTtlMs: 60_000, digestCacheTtlMs: 60_000 });
    liveAdapter.digestCache = createMemDigestCache();

    const charA = { id: 0, name: 'CharA', avatar: 'a.png', activeChatId: 'other_active' };

    // 16A. 存档列表并发：慢请求先发、强制刷新后发先返，慢请求后返不得覆盖缓存
    const pSumOld = liveAdapter.getCharacterChatSummaries(charA, false);
    await new Promise((r) => setTimeout(r, 10));
    const sumNew = await liveAdapter.getCharacterChatSummaries(charA, true);
    assert.equal(sumNew.length, 2);
    resolveSlowSummary();
    await pSumOld;
    const sumCached = await liveAdapter.getCharacterChatSummaries(charA, false);
    assert.equal(sumCached.length, 2, '较早返回的旧存档列表不得覆盖较新的列表缓存');

    // 16B. 楼层摘要并发：普通请求先发、强制刷新后发先返，旧请求后返不得覆盖新缓存
    const targetSummary = {
      chatId: 'save_x',
      fileName: 'save_x.jsonl',
      fileSize: '1KB',
      messageCount: 1,
      lastModified: '2026-11-23T10:00:00Z',
      previewText: 'same',
    };
    const pDigOld = liveAdapter.getCharacterChatDigests(charA, [targetSummary], false);
    await new Promise((r) => setTimeout(r, 10));
    await liveAdapter.clearDigestCache();
    const digNew = await liveAdapter.getCharacterChatDigests(charA, [targetSummary], true);
    assert.ok(digNew[0].floors[0].snippet.includes('NEW'));
    resolveSlowDigest();
    await pDigOld;

    const digNext = await liveAdapter.getCharacterChatDigests(charA, [targetSummary], false);
    assert.ok(digNext[0].floors[0].snippet.includes('NEW'), '强制刷新后旧请求晚返回不得把楼层缓存回写为旧数据');
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

// 17 & 18. [复查 P2 #5 & #6] 重开大厅扫描期间禁止误点旧存档 + 备注失焦/别名提交不销毁侧栏和画布交互节点
{
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevRAF = globalThis.requestAnimationFrame;

  class TrackingElement {
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
      this.innerHTMLWriteCount = 0;
      this.listeners = new Map();
      this.classList = { toggle() {}, add() {}, remove() {} };
      this.childrenByRole = new Map();
    }
    set innerHTML(val) {
      this.innerHTMLWriteCount += 1;
      this._innerHTML = String(val);
      for (const child of this.childrenByRole.values()) child.isConnected = false;
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
        if (!this.childrenByRole.has(key)) this.childrenByRole.set(key, new TrackingElement(key));
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
    createElement: () => new TrackingElement(),
    body: { appendChild() {} },
    addEventListener() {},
  };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = (cb) => cb();

  try {
    // 17. [P2 #5] 重开大厅扫描期间，旧检查器与旧画布应被立即清空，且 handleJump 拒绝跳转旧存档
    let resolveOverview;
    let jumpCalls = 0;
    const reopenAdapter = new SaveManagerAdapter();
    reopenAdapter.loadGlobalOverview = async () =>
      new Promise((resolve) => {
        resolveOverview = resolve;
      });
    reopenAdapter.jumpToSave = async () => {
      jumpCalls += 1;
    };

    const modal = new SaveBranchManagerModal(reopenAdapter);
    modal.backdropEl = new TrackingElement('backdrop');
    modal.currentCharacter = { id: 0, name: 'CharA', avatar: 'a.png', saves: [] };
    modal.currentGraph = {
      characterAvatar: 'a.png',
      nodes: [{ chatId: 'deleted_save', floorCount: 1, floors: [], childrenIds: [], parentId: null, branchMoment: null, x: 0, y: 0 }],
      edges: [],
      roots: [],
      canvasWidth: 300,
      canvasHeight: 200,
    };
    modal.selectedChatId = 'deleted_save';

    const openPromise = modal.open();
    assert.equal(modal.currentGraph, null, '重开大厅扫描开始时必须立即清空旧分支图');
    assert.equal(modal.selectedChatId, null, '重开大厅扫描开始时必须立即清空旧选中存档');
    await modal.handleJump('deleted_save', modal.currentCharacter);
    assert.equal(jumpCalls, 0, '扫描期间不得允许跳向已删除的旧存档');

    resolveOverview([]);
    await openPromise;

    // 18. [P2 #6] 备注失焦和别名提交时不得重建侧栏和画布 DOM（避免吞掉第一次 click）
    const savedMeta = new Map();
    const uiAdapter = new SaveManagerAdapter();
    uiAdapter.getSaveMeta = (av, cid) => savedMeta.get(`${av}::${cid}`) || { starred: false, customTitle: '', tags: [], note: '', updatedAt: '' };
    uiAdapter.updateSaveMeta = (av, cid, patch) => {
      const next = { ...uiAdapter.getSaveMeta(av, cid), ...patch };
      savedMeta.set(`${av}::${cid}`, next);
      return next;
    };

    const editModal = new SaveBranchManagerModal(uiAdapter);
    editModal.backdropEl = new TrackingElement('backdrop');
    editModal.overviewList = [
      {
        id: 0,
        name: 'CharA',
        avatar: 'a.png',
        saves: [{ chatId: 'save_1', messageCount: 2 }],
        saveCount: 1,
        starredCount: 0,
        notedCount: 0,
        latestTimestamp: 1,
      },
    ];
    editModal.currentCharacter = editModal.overviewList[0];
    editModal.currentGraph = {
      characterAvatar: 'a.png',
      nodes: [{ chatId: 'save_1', floorCount: 2, floors: [{ floor: 1, name: 'A', snippet: 'hi' }], childrenIds: [], parentId: null, branchMoment: null, x: 0, y: 0 }],
      edges: [],
      roots: [],
      canvasWidth: 400,
      canvasHeight: 300,
    };
    editModal.selectedChatId = 'save_1';
    editModal.renderSidebar();
    editModal.renderSaves();
    editModal.renderInspector();

    const sidebarEl = editModal.backdropEl.querySelector('[data-role="sidebar-list"]');
    const stageEl = editModal.backdropEl.querySelector('[data-role="stage"]');
    const inspEl = editModal.backdropEl.querySelector('[data-role="inspector"]');
    const sidebarWritesBefore = sidebarEl.innerHTMLWriteCount;
    const stageWritesBefore = stageEl.innerHTMLWriteCount;

    const noteInput = inspEl.querySelector('[data-role="note-input"]');
    noteInput.value = '刚输入的备注';
    noteInput.dispatch('input');
    noteInput.dispatch('blur');

    assert.equal(uiAdapter.getSaveMeta('a.png', 'save_1').note, '刚输入的备注', '备注失焦时应已保存');
    assert.equal(sidebarEl.innerHTMLWriteCount, sidebarWritesBefore, '备注失焦保存不得重写侧栏 DOM');
    assert.equal(stageEl.innerHTMLWriteCount, stageWritesBefore, '备注失焦保存不得重写画布 DOM');

    const titleInput = inspEl.querySelector('[data-role="custom-title"]');
    titleInput.value = '新别名';
    titleInput.dispatch('change');

    assert.equal(uiAdapter.getSaveMeta('a.png', 'save_1').customTitle, '新别名', '别名提交时应已保存');
    assert.equal(sidebarEl.innerHTMLWriteCount, sidebarWritesBefore, '别名提交不得重写侧栏 DOM');
    assert.equal(stageEl.innerHTMLWriteCount, stageWritesBefore, '别名提交不得重写画布 DOM');

    // 19. 验证重开大厅不再全量重扫所有角色卡：仅增量刷新当前活跃/变动过的角色，手动刷新才全量重扫
    const prevFetch19 = globalThis.fetch;
    const listeners19 = new Map();
    const fetchedAvatars = [];
    const mockCtx19 = {
      characterId: '0',
      chatId: 'a1',
      groupId: null,
      characters: [
        { name: 'CharA', avatar: 'a.png', chat: 'a1' },
        { name: 'CharB', avatar: 'b.png', chat: 'b1' },
        { name: 'CharC', avatar: 'c.png', chat: 'c1' },
      ],
      getRequestHeaders: () => ({}),
      event_types: {
        CHAT_CREATED: 'chat_created',
        CHAT_CHANGED: 'chat_changed',
      },
      eventSource: {
        on(evt, fn) {
          if (!listeners19.has(evt)) listeners19.set(evt, []);
          listeners19.get(evt).push(fn);
        },
        emit(evt) {
          for (const fn of listeners19.get(evt) || []) fn();
        },
      },
    };
    globalThis.window = {
      addEventListener() {},
      SillyTavern: { getContext: () => mockCtx19 },
    };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init?.body || '{}');
      if (url === 'api/characters/chats') {
        fetchedAvatars.push(body.avatar_url);
        return {
          ok: true,
          json: async () => [
            {
              file_name: `${body.avatar_url.replace('.png', '')}1.jsonl`,
              file_size: '2KB',
              chat_items: 1,
              last_mes: '2026-11-23T10:00:00Z',
              mes: 'hi',
            },
          ],
        };
      }
      if (url === 'api/chats/get') {
        return {
          ok: true,
          text: async () => JSON.stringify([{ chat_metadata: {} }, { name: 'C', is_user: false, mes: 'hi' }]),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const incAdapter = new SaveManagerAdapter({ summaryCacheTtlMs: 300_000, digestCacheTtlMs: 300_000 });
      const incModal = new SaveBranchManagerModal(incAdapter);
      incModal.backdropEl = new TrackingElement('backdrop');

      // 首次打开：扫描全部 3 个角色
      await incModal.open();
      assert.deepEqual([...fetchedAvatars].sort(), ['a.png', 'b.png', 'c.png'], '首次打开应扫描全部 3 个角色');

      // 再次重开：未变动角色 B/C 命中缓存，仅增量刷新当前活跃角色 A
      fetchedAvatars.length = 0;
      await incModal.open();
      assert.deepEqual(fetchedAvatars, ['a.png'], '重开大厅应仅增量刷新活跃角色 A，不重扫 B/C');

      // 若期间切到 B 并新建存档触发事件，再切回 A 后重开，应仅刷新 A 和 B，C 仍命中缓存
      mockCtx19.characterId = '1';
      mockCtx19.chatId = 'b2';
      mockCtx19.characters[1].chat = 'b2';
      mockCtx19.eventSource.emit('chat_created');
      mockCtx19.characterId = '0';
      mockCtx19.chatId = 'a1';
      fetchedAvatars.length = 0;
      await incModal.open();
      assert.deepEqual([...fetchedAvatars].sort(), ['a.png', 'b.png'], '有变动事件的角色 B 与活跃角色 A 同步刷新，未变动角色 C 不重扫');

      // 手动点击“刷新扫描”（refreshAll(true)）：才强制全量重扫全部角色
      fetchedAvatars.length = 0;
      await incModal.refreshAll(true);
      assert.deepEqual([...fetchedAvatars].sort(), ['a.png', 'b.png', 'c.png'], '手动刷新扫描应全量重扫全部角色');
    } finally {
      globalThis.fetch = prevFetch19;
    }
  } finally {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
    globalThis.requestAnimationFrame = prevRAF;
  }
}

// 20. [TauriTavern 适配] 宿主检测、waitForHostReady、根路径 API、头像契约、严格解码、缺失/损坏存档隔离与不写脏缓存
{
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  let readyResolved = false;
  let resolveReady;
  const readyPromise = new Promise((r) => {
    resolveReady = () => {
      readyResolved = true;
      r();
    };
  });
  const fetchCalls = [];
  const mockCtx = {
    characterId: '0',
    groupId: null,
    characters: [
      {
        name: 'Frieren',
        avatar: 'frieren card.png',
        chat: 'chat_main',
        data: { description: '从 data.description 回退读取的简介' },
      },
    ],
    getCurrentChatId: () => 'chat_live_from_fn',
    getRequestHeaders: () => ({ 'X-TT': '1' }),
    getThumbnailUrl: () => '/should-not-win-over-tt-assets',
  };

  globalThis.window = {
    __TAURITAVERN__: {
      abiVersion: 2,
      ready: readyPromise,
      assets: {
        thumbnailUrl: (type, file) => `/tt-thumb/${type}/${encodeURIComponent(file)}`,
      },
    },
    __TAURITAVERN_HOST__: { platform: 'android', kind: 'mobile' },
    SillyTavern: { getContext: () => mockCtx },
  };

  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    fetchCalls.push({ url, body });
    if (url === '/api/characters/chats') {
      return {
        ok: true,
        json: async () => [
          {
            file_id: 'chat_1',
            file_name: 'chat_1.jsonl',
            file_size: 2048,
            message_count: 2,
            last_message: '最后一句 via last_message',
            last_message_date: 1763893200, // 10 位 Unix 秒级数字时间戳
          },
          {
            file_id: 'chat_empty_valid',
            file_name: 'chat_empty_valid.jsonl',
            file_size: 2,
            message_count: 0,
            last_message: '',
            last_message_date: 1763893100,
          },
          {
            file_id: 'chat_truncated_empty',
            file_name: 'chat_truncated_empty.jsonl',
            file_size: 0,
            message_count: 5,
            last_message: '清空前的预览',
            last_message_date: 1763893150,
          },
          {
            file_id: 'chat_missing_http',
            file_name: 'chat_missing_http.jsonl',
            file_size: 512,
            chat_items: 3,
            mes: '已删除的存档',
            last_mes: 1763893200000,
          },
          {
            file_id: 'chat_corrupt_stream',
            file_name: 'chat_corrupt_stream.jsonl',
            file_size: 1024,
            chat_items: 4,
            mes: '损坏的流式存档',
            last_mes: 1763893200000,
          },
          {
            file_id: 'chat_missing_zero',
            file_name: 'chat_missing_zero.jsonl',
            file_size: 0,
            chat_items: 0,
            mes: '',
            last_mes: 1763893000000,
          },
        ],
      };
    }
    if (url === '/api/chats/get') {
      assert.equal(body.allow_not_found, undefined, 'TauriTavern 不应传 allow_not_found: true 以区分缺失与合法空存档');
      if (body.file_name === 'chat_missing_http' || body.file_name === 'chat_missing_zero') {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: 'Failed to load chat', details: 'Chat not found' }),
        };
      }
      if (body.file_name === 'chat_corrupt_stream') {
        // 模拟 TT HTTP 200 但消费流时因损坏 JSONL 抛错
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new Error('Invalid JSONL at line 2');
          },
        };
      }
      if (body.file_name === 'chat_empty_valid') {
        return { ok: true, text: async () => '[{}]' };
      }
      if (body.file_name === 'chat_truncated_empty') {
        return { ok: true, text: async () => '[]' };
      }
      return {
        ok: true,
        text: async () =>
          '\uFEFF' +
          JSON.stringify([
            { mes: 'extra_header_field', chat_metadata: {} }, // 按位置为 header，允许附加字段
            { name: 'Frieren', is_user: false, mes: '第一楼内容' },
          ]),
      };
    }
    throw new Error(`Unexpected TT fetch URL: ${url}`);
  };

  try {
    const ttAdapter = new SaveManagerAdapter();
    assert.equal(ttAdapter.isTauriTavern(), true, '应识别 TauriTavern 宿主');
    assert.equal(ttAdapter.isMobileHost(), true, '应识别 TauriTavern 移动端宿主');
    assert.equal(ttAdapter.getHostLabel(), 'TauriTavern 移动端');
    assert.equal(ttAdapter.resolveApiUrl('api/chats/get'), '/api/chats/get', 'TT 环境应使用根路径 /api/...');
    assert.equal(formatFileSize(2048), '2.0 KB');
    assert.equal(formatFileSize(512), '512 B');
    assert.equal(parseSillyTavernTimestamp(1763893200), 1763893200000, '应将 10 位数字 Unix 秒转为毫秒');

    // 验证严格 JSON 数组解码器拒绝非数组与非对象记录，同时按位置允许带额外字段的合法 header 与零记录空数组 []
    assert.throws(() => parseTauriChatPayload('{"a":1}\n{"mes":"hi"}'), /解析失败|不是有效的 JSON 数组/);
    assert.throws(() => parseTauriChatPayload('[123]'), /不是有效的 JSON 对象/);
    assert.deepEqual(parseTauriChatPayload('[]'), []);
    const headerWithExtraMes = parseTauriChatPayload('[{"mes":"header_extra","chat_metadata":{}}]');
    assert.equal(compactChatLines(headerWithExtraMes, { strictHeader: true }).floors.length, 0, '首条按位置作为 header，不应被误判为消息楼层');

    const waitTask = ttAdapter.waitForHostReady();
    assert.equal(readyResolved, false);
    resolveReady();
    await waitTask;
    assert.equal(readyResolved, true, 'waitForHostReady 应等待 __TAURITAVERN__.ready 完成');

    const chars = ttAdapter.getCharacters();
    assert.equal(chars[0].avatarSrc, '/tt-thumb/avatar/frieren%20card.png', 'TT 应优先使用 __TAURITAVERN__.assets.thumbnailUrl');
    assert.equal(chars[0].avatarFallbackSrc, '/characters/frieren%20card.png', 'TT 原图回退应使用根路径 /characters/...');
    assert.equal(chars[0].activeChatId, 'chat_live_from_fn', '当前活跃角色应优先取 getCurrentChatId()');
    assert.ok(chars[0].description.includes('data.description'));

    const summaries = await ttAdapter.getCharacterChatSummaries(chars[0]);
    assert.equal(fetchCalls[0].url, '/api/characters/chats');
    assert.equal(fetchCalls[0].body.avatar_url, 'frieren card.png');
    assert.equal(fetchCalls[0].body.ch_name, 'Frieren');
    assert.equal(summaries[0].fileSize, '2.0 KB');
    assert.equal(summaries[0].rawFileSize, '2048');
    assert.equal(summaries[0].messageCount, 2);
    assert.equal(summaries[0].previewText, '最后一句 via last_message');

    const memStore = new Map();
    ttAdapter.digestCache = {
      async get(k, fp) {
        const rec = memStore.get(k);
        return rec && rec.fp === fp ? rec.digest : null;
      },
      async set(k, fp, digest) {
        memStore.set(k, { fp, digest });
      },
      async delete(k) {
        memStore.delete(k);
      },
      async clearAll() {
        memStore.clear();
      },
    };
    const digests = await ttAdapter.getCharacterChatDigests(chars[0], summaries);
    const byId = new Map(digests.map((d) => [d.chatId, d]));

    assert.equal(byId.get('chat_1').digestStatus, 'ok');
    assert.equal(byId.get('chat_1').floors.length, 1, '带 BOM 与附加字段 header 的存档不应多出幽灵楼层');
    assert.equal(byId.get('chat_1').floors[0].snippet, '第一楼内容');
    assert.equal(byId.get('chat_empty_valid').digestStatus, 'ok');
    assert.equal(byId.get('chat_empty_valid').floors.length, 0);
    assert.equal(byId.get('chat_truncated_empty').digestStatus, 'ok', 'TT 严格路由返回 HTTP 200 [] 为合法零记录空存档，不得误标 missing');
    assert.equal(byId.get('chat_truncated_empty').floors.length, 0);
    assert.equal(byId.get('chat_truncated_empty').messageCount, 0);

    assert.equal(byId.get('chat_missing_http').digestStatus, 'missing', '缺失存档应标为 missing');
    assert.equal(byId.get('chat_missing_zero').digestStatus, 'missing', '零消息缺失存档应标为 missing 且不写缓存');
    assert.equal(byId.get('chat_corrupt_stream').digestStatus, 'unreadable', '流式消费报错应标为 unreadable');

    assert.equal(memStore.has('frieren card.png::chat_1'), true, '有效存档应写入缓存');
    assert.equal(memStore.has('frieren card.png::chat_empty_valid'), true, '合法空存档应写入缓存');
    assert.equal(memStore.has('frieren card.png::chat_truncated_empty'), true, '合法零记录空存档应写入缓存');
    assert.equal(memStore.has('frieren card.png::chat_missing_http'), false, '缺失存档不得写入缓存');
    assert.equal(memStore.has('frieren card.png::chat_missing_zero'), false, '零消息缺失存档不得写入缓存');
    assert.equal(memStore.has('frieren card.png::chat_corrupt_stream'), false, '损坏存档不得写入缓存');

    // 验证缺失与损坏存档不进入谱系根节点，而是归入 unavailableNodes
    const graph = buildCharacterBranchGraph(chars[0], digests);
    assert.equal(graph.rootCount, 3, '仅 3 份可读存档应计入有效根节点，缺失/损坏存档不得充当独立根');
    assert.equal(graph.order.length, 3, '故事线轨道仅包含可读存档');
    assert.equal(graph.unavailableNodes.length, 3, '3 份缺失/损坏存档应单独归入 unavailableNodes');
    assert.ok(graph.unavailableNodes.every((n) => n.isUnavailable && n.parentId === null));
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

// 21. [TauriTavern 适配] 一等工具消息（tool_call_id 关联、参数原始空白保留）、v3 缓存升级淘汰旧 v2、TOOL_CALLS_PERFORMED 失效
{
  const makeToolSave = ({ args, toolCallId }) =>
    compactChatLines([
      { chat_metadata: {} },
      { name: 'AI', is_user: false, mes: '欢迎来到星砂图书馆' },
      { name: 'User', is_user: true, mes: '帮我查一下资料' },
      {
        name: 'AI',
        is_user: false,
        mes: '',
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'search_lore', arguments: args } }],
      },
      { name: 'Tool', is_user: false, is_system: true, role: 'tool', tool_call_id: toolCallId, mes: '相同工具返回正文' },
    ]);

  const branchA = makeToolSave({ args: '{"q":"a  b"}', toolCallId: 'call_1' });
  const branchB = makeToolSave({ args: '{"q":"a b"}', toolCallId: 'call_1' });
  const branchSwappedId = makeToolSave({ args: '{"q":"a  b"}', toolCallId: 'call_2' });

  assert.equal(branchA.floors[2].snippet, '[工具调用: search_lore]');
  assert.notEqual(branchA.floors[2].hash, branchB.floors[2].hash, '工具参数中的有效空白差异不得被归一化抹平');
  assert.notEqual(
    branchA.floors[3].hash,
    branchSwappedId.floors[3].hash,
    '正文相同但 tool_call_id 关联不同的工具返回必须产生不同楼层哈希'
  );
  assert.equal(
    compactChatLines([{ chat_metadata: {} }, { name: 'Tool', is_user: false, is_system: true, role: 'tool', mes: '' }]).floors[0].snippet,
    '[工具返回]'
  );

  const graphSwapped = buildCharacterBranchGraph({ avatar: 'tool.png', activeChatId: '' }, [
    { chatId: 'tool_a', ...branchA },
    { chatId: 'tool_swapped', ...branchSwappedId },
  ]);
  assert.equal(graphSwapped.branchCount, 1, '仅 tool_call_id 不同的工具结果应触发分叉检测');
  assert.equal(graphSwapped.nodes.find((n) => n.chatId === 'tool_swapped').branchMoment?.branchFloor, 3);

  // 验证旧版 synthetic tool floor (extra.tool_invocations) 在可见正文相同时仍能按参数/结果区分分叉
  const legacyA = compactChatLines([
    { chat_metadata: {} },
    { name: 'AI', is_user: false, mes: '开场白' },
    { name: 'User', is_user: true, mes: '查天气' },
    {
      name: 'AI',
      is_user: false,
      mes: '好的，已经查到了。',
      extra: { tool_invocations: [{ name: 'weather', parameters: { city: 'Tokyo' }, result: '晴 22C' }] },
    },
  ]);
  const legacyB = compactChatLines([
    { chat_metadata: {} },
    { name: 'AI', is_user: false, mes: '开场白' },
    { name: 'User', is_user: true, mes: '查天气' },
    {
      name: 'AI',
      is_user: false,
      mes: '好的，已经查到了。',
      extra: { tool_invocations: [{ name: 'weather', parameters: { city: 'Kyoto' }, result: '雨 16C' }] },
    },
  ]);
  const legacyASameKeysReordered = compactChatLines([
    { chat_metadata: {} },
    { name: 'AI', is_user: false, mes: '开场白' },
    { name: 'User', is_user: true, mes: '查天气' },
    {
      name: 'AI',
      is_user: false,
      mes: '好的，已经查到了。',
      extra: { tool_invocations: [{ result: '晴 22C', name: 'weather', parameters: { city: 'Tokyo' } }] },
    },
  ]);
  assert.notEqual(legacyA.floors[2].hash, legacyB.floors[2].hash, 'extra.tool_invocations 不同时即使正文相同也必须哈希不同');
  assert.equal(legacyA.floors[2].hash, legacyASameKeysReordered.floors[2].hash, '同构对象键顺序不同不应导致假分叉');
  // 含 __proto__ 键的 JSON 对象不得在规范化过程中被吞掉
  const legacyProto1 = compactChatLines([
    { chat_metadata: {} },
    { name: 'AI', is_user: false, mes: '开场白' },
    { name: 'User', is_user: true, mes: '调用' },
    {
      name: 'AI',
      is_user: false,
      mes: '完成',
      extra: { tool_invocations: [{ name: 'op', parameters: JSON.parse('{"__proto__":"one"}') }] },
    },
  ]);
  const legacyProto2 = compactChatLines([
    { chat_metadata: {} },
    { name: 'AI', is_user: false, mes: '开场白' },
    { name: 'User', is_user: true, mes: '调用' },
    {
      name: 'AI',
      is_user: false,
      mes: '完成',
      extra: { tool_invocations: [{ name: 'op', parameters: JSON.parse('{"__proto__":"two"}') }] },
    },
  ]);
  assert.notEqual(
    legacyProto1.floors[2].hash,
    legacyProto2.floors[2].hash,
    'extra.tool_invocations 中不同的 __proto__ 键值不得产生相同哈希'
  );
  const legacyGraph = buildCharacterBranchGraph({ avatar: 'legacy.png', activeChatId: '' }, [
    { chatId: 'legacy_a', ...legacyA },
    { chatId: 'legacy_b', ...legacyB },
  ]);
  assert.equal(legacyGraph.branchCount, 1);
  assert.equal(legacyGraph.nodes.find((n) => n.chatId === 'legacy_b').branchMoment?.branchFloor, 2);

  // 验证旧 v4 缓存指纹与新版 v5 不会混用，必须自动淘汰旧缓存并重新拉取
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  let fetchedInactiveCount = 0;
  const listeners = new Map();
  const mockCtx = {
    characterId: '0',
    chatId: 'active_tool',
    groupId: null,
    characters: [{ name: 'T', avatar: 't.png', chat: 'active_tool' }],
    getRequestHeaders: () => ({}),
    eventTypes: { TOOL_CALLS_PERFORMED: 'tool_calls_performed' },
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
    __TAURITAVERN__: { abiVersion: 2 },
    SillyTavern: { getContext: () => mockCtx },
  };
  const sharedRawLines = [
    { chat_metadata: {} },
    { name: 'AI', is_user: false, mes: '开场' },
    { name: 'User', is_user: true, mes: '提问' },
    { name: 'Tool', is_user: false, is_system: true, role: 'tool', tool_call_id: 'call_1', mes: '结果' },
  ];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (url === '/api/chats/get') {
      if (body.file_name === 'inactive_tool') fetchedInactiveCount += 1;
      const tail = body.file_name === 'active_tool' ? '主线结局' : '分支结局';
      return {
        ok: true,
        text: async () => JSON.stringify([...sharedRawLines, { name: 'AI', is_user: false, mes: tail }]),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const adapterV3 = new SaveManagerAdapter();
    const memStore = new Map();
    // 预埋一条 v4 旧格式缓存（旧 canonicalize 可能丢弃 __proto__ 键）
    memStore.set('t.png::inactive_tool', {
      fp: 'v4|2026-11-23|100|4|stale_sig|',
      digest: { header: {}, floors: [{ floor: 1, hash: 'legacy_v4_hash', snippet: '旧缓存' }] },
    });
    adapterV3.digestCache = {
      async get(k, fp) {
        const rec = memStore.get(k);
        return rec && rec.fp === fp ? rec.digest : null;
      },
      async set(k, fp, digest) {
        memStore.set(k, { fp, digest });
      },
      async delete(k) {
        memStore.delete(k);
      },
      async clearAll() {
        memStore.clear();
      },
    };
    adapterV3.bindSillyTavernEvents();

    const digests = await adapterV3.getCharacterChatDigests(
      { id: 0, name: 'T', avatar: 't.png', activeChatId: 'active_tool', isCurrentCharacter: true },
      [
        { chatId: 'active_tool', fileName: 'active_tool.jsonl', rawFileSize: '100', messageCount: 4, lastModified: '2026-11-23', previewText: '主线结局' },
        { chatId: 'inactive_tool', fileName: 'inactive_tool.jsonl', rawFileSize: '100', messageCount: 4, lastModified: '2026-11-23', previewText: '分支结局' },
      ]
    );
    assert.equal(fetchedInactiveCount, 1, 'v2 旧缓存因 schema 升级到 v3 必须失效重拉，不得与新拉取兄弟存档产生假分叉');
    const graphV3 = buildCharacterBranchGraph({ avatar: 't.png', activeChatId: 'active_tool' }, digests);
    assert.equal(graphV3.branchCount, 1);
    assert.equal(graphV3.nodes.find((n) => n.chatId === 'inactive_tool').branchMoment?.branchFloor, 3);

    // 验证 TOOL_CALLS_PERFORMED 事件能正确失效活跃存档缓存
    assert.equal(adapterV3.dirtyDigestKeys.has('t.png::active_tool'), false);
    mockCtx.eventSource.emit('tool_calls_performed');
    assert.equal(adapterV3.dirtyDigestKeys.has('t.png::active_tool'), true, 'TOOL_CALLS_PERFORMED 应标记活跃存档失效');
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

// 22. [TauriTavern 适配] 原子跳转：跨角色/同角色、群聊退出、欢迎页浅层卡、删卡/重排竞态防护、失败后状态保留再续跳
{
  const prevWindow = globalThis.window;
  const selectArgs = [];
  let openChatCount = 0;
  let releaseSlowJump = null;
  const existingChatsByAvatar = new Map([
    ['a.png', new Set(['a_chat_1', 'shared_name'])],
    ['b.png', new Set(['b_chat_1', 'b_chat_2', 'shared_name'])],
    ['c.png', new Set(['c_chat_1'])],
  ]);

  const mockCtx = {
    characterId: undefined,
    chatId: 'group_chat_1',
    groupId: 'grp-1',
    characters: [
      { name: 'CharA', avatar: 'a.png', chat: 'a_chat_1', shallow: true },
      { name: 'CharB', avatar: 'b.png', chat: 'b_chat_1', shallow: true },
      { name: 'CharC', avatar: 'c.png', chat: 'c_chat_1', shallow: true },
    ],
    getCurrentChatId: () => mockCtx.chatId,
    getRequestHeaders: () => ({}),
    selectCharacterById: async (id, opts) => {
      const idx = Number(id);
      const targetChar = mockCtx.characters[idx];
      selectArgs.push({ id, avatar: targetChar?.avatar, opts });
      if (opts?.chatFile === 'slow_chat') {
        await new Promise((r) => {
          releaseSlowJump = r;
        });
      }
      const validSet = existingChatsByAvatar.get(targetChar?.avatar);
      if (opts?.chatFile && opts.chatFile !== 'slow_chat' && (!validSet || !validSet.has(opts.chatFile))) {
        // 模拟 TT 找不到目标存档时不切换角色、不退出当前会话、不写回 characters[idx].chat
        return;
      }
      mockCtx.groupId = null;
      mockCtx.characterId = String(idx);
      targetChar.shallow = false;
      mockCtx.chatId = opts?.chatFile || targetChar.chat;
      targetChar.chat = mockCtx.chatId;
    },
    openCharacterChat: async () => {
      openChatCount += 1;
    },
  };

  globalThis.window = {
    __TAURITAVERN__: { abiVersion: 2 },
    SillyTavern: { getContext: () => mockCtx },
  };

  try {
    const ttAdapter = new SaveManagerAdapter({ switchVerifyTimeoutMs: 60, switchPollIntervalMs: 15 });

    // 22A. 从活跃群聊跳转到角色存档
    await ttAdapter.jumpToSave({ id: 1, name: 'CharB', avatar: 'b.png' }, 'b_chat_2');
    assert.equal(mockCtx.groupId, null, '从群聊跳转到角色存档后应退出群聊');
    assert.equal(mockCtx.characterId, '1');
    assert.equal(mockCtx.chatId, 'b_chat_2');
    assert.equal(openChatCount, 0);

    // 22B. 从欢迎页（characterId: undefined）跳向 shallow 浅层角色卡
    mockCtx.characterId = undefined;
    mockCtx.chatId = '';
    await ttAdapter.jumpToSave({ id: 0, name: 'CharA', avatar: 'a.png' }, 'a_chat_1');
    assert.equal(mockCtx.characterId, '0');
    assert.equal(mockCtx.chatId, 'a_chat_1');
    assert.equal(mockCtx.characters[0].shallow, false);

    // 22C. 失败的原子跳转必须保留先前宿主状态，且不阻断后续排队跳转
    const failP = ttAdapter.jumpToSave({ id: 1, name: 'CharB', avatar: 'b.png' }, 'deleted_chat');
    const nextP = ttAdapter.jumpToSave({ id: 1, name: 'CharB', avatar: 'b.png' }, 'b_chat_1');
    await assert.rejects(() => failP, /未能切换到角色|未能打开存档/);
    await nextP;
    assert.equal(mockCtx.characterId, '1', '失败后紧随排队的合法跳转仍应正常完成');
    assert.equal(mockCtx.chatId, 'b_chat_1');
    assert.equal(openChatCount, 0);

    // 22D. 排队期间目标角色被删除且同索引被另一角色顶替（即使对方也有同名存档 shared_name），必须拒绝且不调用 selectCharacterById
    const callsBeforeQueue = selectArgs.length;
    const pSlow = ttAdapter.jumpToSave({ id: 0, name: 'CharA', avatar: 'a.png' }, 'slow_chat');
    await new Promise((r) => setTimeout(r, 15));
    // 排队两个后续跳转：1) 跳向即将被删除的 CharB (原 idx=1) 的 shared_name；2) 跳向即将被重排到新索引的 CharC (原 idx=2 -> 新 idx=1)
    const pDeleted = ttAdapter.jumpToSave({ id: 1, name: 'CharB', avatar: 'b.png' }, 'shared_name');
    const pReordered = ttAdapter.jumpToSave({ id: 2, name: 'CharC', avatar: 'c.png' }, 'c_chat_1');

    // 在 pSlow 未结束前删除 CharB（CharC 顶替到索引 1，且给 CharC 也加入 shared_name 模拟最危险碰撞）
    existingChatsByAvatar.get('c.png').add('shared_name');
    mockCtx.characters.splice(1, 1);

    releaseSlowJump();
    await pSlow;
    await assert.rejects(() => pDeleted, /已不存在或已被移除/, '已删除角色的排队跳转必须被中止，绝不能误跳到顶替同索引的角色');
    await pReordered;

    const dispatchedAfterSlow = selectArgs.slice(callsBeforeQueue + 1);
    assert.equal(dispatchedAfterSlow.length, 1, '已删除角色不得触发任何 selectCharacterById 调用');
    assert.deepEqual(dispatchedAfterSlow[0], {
      id: '1',
      avatar: 'c.png',
      opts: { chatFile: 'c_chat_1' },
    }, '重排后的 CharC 应按最新索引 1 解析并成功打开');
    assert.equal(mockCtx.characterId, '1');
    assert.equal(mockCtx.chatId, 'c_chat_1');

    // 22E. 缺少稳定 avatar 的过期数字索引目标必须直接拒绝，且不得触发任何宿主导航调用
    const callsBeforeAvatarless = selectArgs.length;
    await assert.rejects(
      () => ttAdapter.jumpToSave({ id: 1, name: 'CharB' }, 'shared_name'),
      /缺少稳定的角色头像标识/
    );
    assert.equal(selectArgs.length, callsBeforeAvatarless, '缺少 avatar 时不得调用 selectCharacterById');
    assert.equal(openChatCount, 0, '缺少 avatar 时不得调用 openCharacterChat');
  } finally {
    globalThis.window = prevWindow;
  }
}

// 23. [TauriTavern 适配] ready 拒绝传播（index.js 真实入口）、单宿主 Back 桥接（多实例/外部包装/Escape vs Back）、api.layout 订阅清理
{
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevRAF = globalThis.requestAnimationFrame;

  const listeners = new Map();
  const docListeners = new Map();
  let hostBackCalls = 0;
  let extBBackCalls = 0;
  let extBOpen = false;
  let layoutUnsubCalls = 0;
  let layoutCallback = null;
  let layoutResolveUnsub = null;

  class MiniEl {
    constructor(role = '', tagName = 'DIV') {
      this.role = role;
      this.tagName = tagName;
      this.id = '';
      this.hidden = false;
      this.textContent = '';
      this.value = '';
      this.dataset = {};
      this.style = {};
      this.scrollHeight = 40;
      this.blurred = false;
      this.children = [];
      this.childrenByRole = new Map();
      this.listeners = new Map();
    }
    set innerHTML(v) {
      this._html = String(v);
      this.childrenByRole.clear();
    }
    get innerHTML() {
      return this._html || '';
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatchEvent(evt) {
      for (const fn of this.listeners.get(evt.type) || []) fn(evt);
    }
    matches(sel) {
      return sel.includes('input') && (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA');
    }
    blur() {
      this.blurred = true;
      if (globalThis.document.activeElement === this) {
        globalThis.document.activeElement = null;
      }
    }
    querySelector(sel) {
      const m = sel.match(/\[data-role="([^"]+)"\]/);
      if (m) {
        if (!this.childrenByRole.has(m[1])) {
          const tag = m[1] === 'search-input' ? 'INPUT' : m[1].includes('input') ? 'TEXTAREA' : 'DIV';
          this.childrenByRole.set(m[1], new MiniEl(m[1], tag));
        }
        return this.childrenByRole.get(m[1]);
      }
      return null;
    }
    querySelectorAll() {
      return [];
    }
    contains(el) {
      if (el === this) return true;
      for (const c of this.childrenByRole.values()) {
        if (c === el) return true;
      }
      return false;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    setAttribute(name, value) {
      this.attrs = this.attrs || {};
      this.attrs[name] = value;
    }
    remove() {}
  }

  const domById = new Map();
  const extMenu = new MiniEl('extMenu');
  extMenu.id = 'extensionsMenu';
  const extSettings = new MiniEl('extSettings');
  extSettings.id = 'extensions_settings2';
  domById.set('extensionsMenu', extMenu);
  domById.set('extensions_settings2', extSettings);

  let slashAdded = 0;
  const mockCtx = {
    characterId: '0',
    chatId: 'c1',
    groupId: null,
    characters: [{ name: 'A', avatar: 'a.png', chat: 'c1' }],
    eventTypes: {
      APP_READY: 'app_ready',
      EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
      MESSAGE_EDITED: 'message_edited',
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
    SlashCommand: { fromProps: (p) => p },
    SlashCommandParser: {
      commands: {},
      addCommandObject(cmd) {
        slashAdded += 1;
        this.commands[cmd.name] = cmd;
      },
    },
  };

  globalThis.document = {
    readyState: 'complete',
    createElement: (tag = 'div') => new MiniEl('', String(tag).toUpperCase()),
    getElementById: (id) => {
      if (domById.has(id)) return domById.get(id);
      for (const container of [extMenu, extSettings]) {
        const found = container.children.find((c) => c.id === id);
        if (found) return found;
      }
      return null;
    },
    body: { appendChild() {} },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    activeElement: null,
  };
  globalThis.requestAnimationFrame = (cb) => cb();

  const baseHostBack = () => {
    hostBackCalls += 1;
    return true;
  };

  globalThis.window = {
    innerWidth: 390,
    addEventListener() {},
    SillyTavern: { getContext: () => mockCtx },
    __TAURITAVERN_HANDLE_BACK__: baseHostBack,
    __TAURITAVERN__: {
      abiVersion: 2,
      ready: Promise.reject(new Error('host boot failed')),
      api: {
        layout: {
          subscribe(cb) {
            layoutCallback = cb;
            return new Promise((resolve) => {
              layoutResolveUnsub = () =>
                resolve(() => {
                  layoutUnsubCalls += 1;
                });
            });
          },
        },
      },
    },
    __TAURITAVERN_HOST__: { platform: 'android', kind: 'mobile' },
  };
  // 防止未处理拒绝告警
  globalThis.window.__TAURITAVERN__.ready.catch(() => {});

  try {
    // 23A. 自动启动时 ready 拒绝不挂载任何入口；恢复 ready 后仅靠宿主补发 APP_READY 即可自动恢复挂载（无需手动调 initExtension）
    const entryMod = await import('../index.js?tt-test=1');
    await Promise.resolve();
    await Promise.resolve();
    await assert.rejects(() => entryMod.initExtension(), /host boot failed/, 'ready 拒绝必须传播给入口调用方');
    assert.equal(globalThis.document.getElementById('st_sbm_wand_btn'), null, 'ready 失败时不得挂载魔法棒按钮');
    assert.equal(globalThis.document.getElementById('st_sbm_settings_block'), null, 'ready 失败时不得挂载设置面板');
    assert.equal(slashAdded, 0, 'ready 失败时不得注册斜杠命令');
    assert.equal(globalThis.window.STSaveBranchManager, undefined, 'ready 失败时不得暴露全局句柄');

    // 替换 ready 为已就绪，仅触发宿主 APP_READY，验证自动恢复挂载
    globalThis.window.__TAURITAVERN__.ready = Promise.resolve();
    mockCtx.eventSource.emit('app_ready');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(globalThis.document.getElementById('st_sbm_wand_btn'), '宿主补发 APP_READY 后应自动恢复挂载入口');
    assert.ok(globalThis.window.STSaveBranchManager, '自动恢复后应暴露全局句柄');
    assert.equal(slashAdded, 1);
    mockCtx.eventSource.emit('app_ready');
    assert.equal(slashAdded, 1, '重复 APP_READY 不应重复注册斜杠命令');
    entryMod.modal.uninstallTauriBackHandler();

    // 23B. 单宿主 Back 桥接：多实例、第三方扩展后置包装不得被重开覆盖、Escape 与原生 Back 语义区分
    const ttAdapter = new SaveManagerAdapter();
    assert.equal(ttAdapter.bindSillyTavernEvents(), true, '应兼容仅提供 ctx.eventTypes 的事件绑定');
    mockCtx.eventSource.emit('message_edited');
    assert.equal(ttAdapter.dirtyDigestKeys.has('a.png::c1'), true, '驼峰 eventTypes 触发事件应正确失效缓存');

    ttAdapter.loadGlobalOverview = async () => [];
    const modal1 = new SaveBranchManagerModal(ttAdapter);
    modal1.backdropEl = new MiniEl('backdrop');
    modal1.backdropEl.hidden = true;
    modal1.bindEvents();
    modal1.installTauriBackHandler();

    // 弹窗隐藏时透传给宿主返回处理器
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(hostBackCalls, 1, '弹窗隐藏时应交还宿主默认返回逻辑');

    // 打开 modal1 并验证 layout.subscribe
    let fitCount = 0;
    const origFit = modal1.fitInspectorFields.bind(modal1);
    modal1.fitInspectorFields = () => {
      fitCount += 1;
      origFit();
    };
    await modal1.open();
    assert.equal(modal1.backdropEl.dataset.host, 'tauritavern', 'TauriTavern 宿主应标记 data-host="tauritavern"');
    modal1.setPane('detail');

    // 仅高度变化（软键盘弹出）不触发宽度重排；宽度变化（旋转屏幕）触发 fitInspectorFields
    const fitBefore = fitCount;
    layoutCallback?.({ viewport: { width: 390, height: 420 } });
    assert.equal(fitCount, fitBefore, '仅视口高度变化不应误触发宽度重排');
    layoutCallback?.({ viewport: { width: 844, height: 390 } });
    assert.equal(fitCount, fitBefore + 1, '视口宽度变化应触发 fitInspectorFields');

    // Escape 编辑态行为：搜索框聚焦且有文本时先清空不关闭；聚焦输入无文本时先失焦不关闭
    const searchEl = modal1.backdropEl.querySelector('[data-role="search-input"]');
    searchEl.value = '关键词';
    globalThis.document.activeElement = searchEl;
    for (const fn of docListeners.get('keydown') || []) {
      fn({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} });
    }
    assert.equal(searchEl.value, '', 'Escape 在非空搜索框中应先清空内容');
    assert.equal(modal1.backdropEl.hidden, false, 'Escape 清空搜索框时不应关闭弹窗');
    for (const fn of docListeners.get('keydown') || []) {
      fn({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} });
    }
    assert.equal(searchEl.blurred, true, 'Escape 在空输入框中应先失焦');
    assert.equal(modal1.backdropEl.hidden, false, 'Escape 失焦时不应关闭弹窗');

    // 窄屏原生返回键逐级回退：detail -> saves -> characters -> close
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modal1.backdropEl.dataset.pane, 'saves');
    assert.equal(modal1.backdropEl.hidden, false);

    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modal1.backdropEl.dataset.pane, 'characters');
    assert.equal(modal1.backdropEl.hidden, false);

    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modal1.backdropEl.hidden, true, 'characters 层再按返回应关闭弹窗');
    assert.equal(hostBackCalls, 1, '弹窗消费的返回键不得穿透到宿主');

    // 异步 subscribe 在 close() 之后才 resolve，必须立即自动退订避免泄漏
    layoutResolveUnsub();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(layoutUnsubCalls, 1, '晚于 close() 返回的 layout subscribe 必须立即自动退订');

    // 另一个协作扩展在之后包装了 __TAURITAVERN_HANDLE_BACK__ 并声明链元数据；重开大厅不得反包跑到新扩展前面
    const prevChain = globalThis.window.__TAURITAVERN_HANDLE_BACK__;
    const extBWrapper = () => {
      if (extBOpen) {
        extBBackCalls += 1;
        extBOpen = false;
        return true;
      }
      return prevChain();
    };
    extBWrapper.__prevHandler = prevChain;
    globalThis.window.__TAURITAVERN_HANDLE_BACK__ = extBWrapper;

    await modal1.open();
    assert.equal(
      globalThis.window.__TAURITAVERN_HANDLE_BACK__,
      extBWrapper,
      '重开大厅不得再次包装覆盖后挂载的协作式第三方扩展 Back 链'
    );
    extBOpen = true;
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(extBBackCalls, 1, '更晚打开的第三方扩展覆盖层应先消费返回键');
    assert.equal(modal1.backdropEl.hidden, false, '第三方扩展消费后大厅仍保持打开');

    // 第二个模态框实例共享同一个单宿主桥接，按 LIFO 分发给顶层打开的实例
    const modal2 = new SaveBranchManagerModal(ttAdapter);
    modal2.backdropEl = new MiniEl('backdrop2');
    modal2.backdropEl.hidden = true;
    globalThis.window.innerWidth = 1280;
    await modal2.open();
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modal2.backdropEl.hidden, true, '后打开的第二个实例应优先响应返回并关闭');
    assert.equal(modal1.backdropEl.hidden, false, '第一个实例暂未关闭');
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modal1.backdropEl.hidden, true, '宽屏下按返回应直接关闭第一个实例');

    // 23C. 当外部扩展仍持有本扩展包装器引用时卸载并重装：不得切断宿主 Back 链，也不得形成递归环
    const hostCallsBeforeUninstall = hostBackCalls;
    modal1.uninstallTauriBackHandler();
    modal2.uninstallTauriBackHandler();
    // 此时 extBWrapper 仍为链顶且已关闭，按返回必须穿透到宿主 baseHostBack
    extBOpen = false;
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(hostBackCalls, hostCallsBeforeUninstall + 1, '卸载后外部包装器仍委派旧包装器时，不得切断宿主返回链');

    // 重装新实例也不得再包到 extBWrapper 之上，不得产生循环调用
    const modal3 = new SaveBranchManagerModal(ttAdapter);
    modal3.backdropEl = new MiniEl('backdrop3');
    modal3.backdropEl.hidden = true;
    await modal3.open();
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__, extBWrapper, '重装时应复用链中桥接节点，不覆写外层扩展');
    extBOpen = true;
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(extBBackCalls, 2, '外层扩展打开时仍应优先响应');
    assert.equal(modal3.backdropEl.hidden, false);
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modal3.backdropEl.hidden, true, '外层扩展关闭后重装的 modal3 应正常响应返回');
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(hostBackCalls, hostCallsBeforeUninstall + 2, '全部关闭后仍应正常到达宿主');

    // 在无外部覆盖时彻底卸载应恢复宿主原 handler
    globalThis.window.__TAURITAVERN_HANDLE_BACK__ = prevChain;
    modal3.uninstallTauriBackHandler();
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__, baseHostBack, '全部实例卸载且无外层包装时应恢复宿主原返回处理器');

    // 23C-2. 当全局 __TAURITAVERN_HANDLE_BACK__ 被独立函数直接替换（非链式包装）时，重开/重装必须重新挂接而不被搁浅
    const modalReplaced = new SaveBranchManagerModal(ttAdapter);
    modalReplaced.backdropEl = new MiniEl('backdrop-replaced');
    modalReplaced.backdropEl.hidden = true;
    modalReplaced.installTauriBackHandler();
    let standaloneCalls = 0;
    const standaloneReplacement = () => {
      standaloneCalls += 1;
      return true;
    };
    globalThis.window.__TAURITAVERN_HANDLE_BACK__ = standaloneReplacement;
    await modalReplaced.open();
    assert.notEqual(
      globalThis.window.__TAURITAVERN_HANDLE_BACK__,
      standaloneReplacement,
      '独立替换全局回调后重开大厅应重新接管返回链，避免弹窗搁浅'
    );
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(modalReplaced.backdropEl.hidden, true, '重挂接后按返回应关闭弹窗');
    assert.equal(standaloneCalls, 0);
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(standaloneCalls, 1, '弹窗关闭后应正常委派给替换后的全局回调');
    modalReplaced.uninstallTauriBackHandler();
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__, standaloneReplacement);

    // 23C-3. 若宿主提供托管返回栈 API（api.back.pushHandler），应优先注册且不覆写全局回调，卸载时调用 disposer
    const hostBackStack = [];
    let hostDisposed = 0;
    const managedWin = {
      innerWidth: 1280,
      addEventListener() {},
      __TAURITAVERN_HANDLE_BACK__: baseHostBack,
      __TAURITAVERN__: {
        abiVersion: 2,
        ready: Promise.resolve(),
        api: {
          back: {
            pushHandler(fn) {
              hostBackStack.push(fn);
              return () => {
                hostDisposed += 1;
                const idx = hostBackStack.lastIndexOf(fn);
                if (idx >= 0) hostBackStack.splice(idx, 1);
              };
            },
          },
        },
      },
    };
    const savedWin = globalThis.window;
    globalThis.window = managedWin;
    try {
      const managedModal = new SaveBranchManagerModal(ttAdapter);
      managedModal.backdropEl = new MiniEl('managed-backdrop');
      managedModal.backdropEl.hidden = true;
      await managedModal.open();
      assert.equal(managedWin.__TAURITAVERN_HANDLE_BACK__, baseHostBack, '存在宿主托管返回栈时不应篡改全局回调');
      assert.equal(hostBackStack.length, 1);
      assert.equal(hostBackStack[0](), true);
      assert.equal(managedModal.backdropEl.hidden, true);
      managedModal.uninstallTauriBackHandler();
      assert.equal(hostDisposed, 1, '卸载后应调用宿主返回的 disposer');
      assert.equal(hostBackStack.length, 0);
    } finally {
      globalThis.window = savedWin;
    }

    // 23D. 不可读存档点击重试且列表接口瞬态 500：保留先前存档与选中项，并露出重试按钮不落成“无存档”
    const retryAdapter = new SaveManagerAdapter();
    retryAdapter.getCharacterChatSummaries = async () => {
      throw new Error('获取角色存档列表失败 (500)');
    };
    const retryModal = new SaveBranchManagerModal(retryAdapter);
    retryModal.backdropEl = new MiniEl('retry-backdrop');
    const brokenChar = {
      id: 0,
      name: 'CharA',
      avatar: 'a.png',
      saves: [{ chatId: 'broken_save', fileName: 'broken_save.jsonl', lastModified: '2026-11-23' }],
      saveCount: 1,
      starredCount: 0,
      notedCount: 0,
      latestTimestamp: 1,
    };
    retryModal.overviewList = [brokenChar];
    retryModal.currentCharacter = brokenChar;
    retryModal.currentGraph = buildCharacterBranchGraph(brokenChar, [
      { chatId: 'broken_save', digestStatus: 'unreadable', digestError: '存档损坏', floors: [], header: {} },
    ]);
    retryModal.currentGraph.characterAvatar = 'a.png';
    retryModal.selectedChatId = 'broken_save';
    await retryModal.retryCurrentCharacter();
    assert.equal(brokenChar.saves.length, 1, '列表接口瞬态 500 时必须保留先前存档列表');
    assert.equal(retryModal.selectedChatId, 'broken_save', '瞬态失败不应清空当前选中的不可读存档');
    assert.ok(retryModal.role('stage').innerHTML.includes('data-action="retry-character"'), '列表瞬态失败后必须保留可见的重试控件');
    assert.ok(retryModal.role('stage').innerHTML.includes('broken_save'), '原有不可读存档行必须保留在列表中');
    assert.ok(retryModal.role('inspector').innerHTML.includes('data-action="retry-character"'), '阅读页重试横幅必须保留');

    // 23D-2. 慢重试在途期间用户切选了同一角色的另一份存档 save_b，重试完成后不得把选中项回退到旧的 save_a
    let resolveDeferredSummaries;
    const raceRetryAdapter = new SaveManagerAdapter();
    raceRetryAdapter.getCharacterChatSummaries = async () =>
      new Promise((resolve) => {
        resolveDeferredSummaries = resolve;
      });
    raceRetryAdapter.getCharacterChatDigests = async (_ch, saves) =>
      saves.map((s) => ({
        ...s,
        digestStatus: 'ok',
        digestError: '',
        header: {},
        floors: [{ floor: 1, name: 'A', isUser: false, hash: `h_${s.chatId}`, snippet: `正文_${s.chatId}` }],
      }));
    const raceRetryModal = new SaveBranchManagerModal(raceRetryAdapter);
    raceRetryModal.backdropEl = new MiniEl('race-retry-backdrop');
    const raceChar = {
      id: 0,
      name: 'CharA',
      avatar: 'a.png',
      saves: [
        { chatId: 'save_a', fileName: 'save_a.jsonl', lastModified: '2026-11-23' },
        { chatId: 'save_b', fileName: 'save_b.jsonl', lastModified: '2026-11-24' },
      ],
      saveCount: 2,
      starredCount: 0,
      notedCount: 0,
      latestTimestamp: 2,
    };
    raceRetryModal.overviewList = [raceChar];
    raceRetryModal.currentCharacter = raceChar;
    raceRetryModal.currentGraph = buildCharacterBranchGraph(raceChar, [
      { chatId: 'save_a', header: {}, floors: [{ floor: 1, name: 'A', isUser: false, hash: 'h_a', snippet: 'A' }] },
      { chatId: 'save_b', header: {}, floors: [{ floor: 1, name: 'A', isUser: false, hash: 'h_b', snippet: 'B' }] },
    ]);
    raceRetryModal.currentGraph.characterAvatar = 'a.png';
    raceRetryModal.selectedChatId = 'save_a';

    const retryTask = raceRetryModal.retryCurrentCharacter();
    await raceRetryModal.selectSave('a.png', 'save_b');
    assert.equal(raceRetryModal.selectedChatId, 'save_b');
    resolveDeferredSummaries([
      { chatId: 'save_a', fileName: 'save_a.jsonl', lastModified: '2026-11-23' },
      { chatId: 'save_b', fileName: 'save_b.jsonl', lastModified: '2026-11-24' },
    ]);
    await retryTask;
    assert.equal(raceRetryModal.selectedChatId, 'save_b', '慢重试完成后应保留用户在途新选中的 save_b，不得回退到旧 save_a');

    // 23E. 样式安全区布局契约检查：浏览器 Toast 须同时遵守左/右/上安全区，TT 宿主复位为常规内容视口
    const cssText = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const toastBlock = cssText.match(/(?:^|\n)\.st-sbm-toast\s*\{[^}]*position:\s*fixed[^}]*\}/)?.[0] || '';
    const ttToastBlock = cssText.match(/\.st-sbm-toast\[data-host="tauritavern"\]\s*\{[^}]*\}/)?.[0] || '';
    assert.ok(toastBlock.includes('env(safe-area-inset-left'), '浏览器 Toast 须考虑左侧安全区');
    assert.ok(toastBlock.includes('env(safe-area-inset-right'), '浏览器 Toast 须考虑右侧安全区');
    assert.ok(toastBlock.includes('env(safe-area-inset-top'), '浏览器 Toast 须考虑顶部安全区');
    assert.ok(ttToastBlock.includes('left: 0') && ttToastBlock.includes('right: 0') && ttToastBlock.includes('top: 24px'), 'TauriTavern Toast 应采用常规内容视口边界');
  } finally {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
    globalThis.requestAnimationFrame = prevRAF;
  }
}

// 24. [Round 4 回归] 顶层原生 dialog 返回键优先、挂起跳转不误关重开大厅、安全字面量切档、IndexedDB tx.onabort 不挂死
{
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevIndexedDB = globalThis.indexedDB;
  const prevRAF = globalThis.requestAnimationFrame;

  class Round4El {
    constructor(role = '') {
      this.role = role;
      this.hidden = false;
      this.textContent = '';
      this.value = '';
      this.dataset = {};
      this.style = {};
      this.scrollHeight = 40;
      this.childrenByRole = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set innerHTML(v) {
      this._html = String(v);
      this.childrenByRole.clear();
    }
    get innerHTML() {
      return this._html || '';
    }
    addEventListener() {}
    setAttribute() {}
    querySelector(sel) {
      const m = sel.match(/\[data-role="([^"]+)"\]/);
      if (m) {
        if (!this.childrenByRole.has(m[1])) this.childrenByRole.set(m[1], new Round4El(m[1]));
        return this.childrenByRole.get(m[1]);
      }
      return null;
    }
    querySelectorAll() {
      return [];
    }
    contains() {
      return false;
    }
    appendChild() {}
    remove() {}
  }

  let openNativeDialogs = [];
  let hostFallbackCalls = 0;
  const r4DocListeners = new Map();

  // 模拟 TauriTavern back-navigation.js 的真实分发顺序：先关闭顶层 dialog[open]:not([closing])，再走宿主后续关闭逻辑
  function handleBackNavigation() {
    if (openNativeDialogs.length > 0) {
      openNativeDialogs.pop().closed = true;
      return true;
    }
    hostFallbackCalls += 1;
    return true;
  }

  globalThis.document = {
    createElement: () => new Round4El(),
    body: { appendChild() {} },
    addEventListener(type, fn) {
      if (!r4DocListeners.has(type)) r4DocListeners.set(type, []);
      r4DocListeners.get(type).push(fn);
    },
    querySelectorAll: (sel) => (sel === 'dialog[open]:not([closing])' ? [...openNativeDialogs] : []),
    activeElement: null,
  };
  globalThis.requestAnimationFrame = (cb) => cb();
  globalThis.window = {
    innerWidth: 390,
    addEventListener() {},
    __TAURITAVERN__: { abiVersion: 2, ready: Promise.resolve() },
    __TAURITAVERN_HOST__: { platform: 'android', kind: 'mobile' },
    __TAURITAVERN_HANDLE_BACK__: handleBackNavigation,
  };

  try {
    // 24A. 大厅打开期间若宿主弹出顶层 <dialog open>，返回键与键盘 Escape/Enter 均须让给宿主 dialog，不得关闭大厅或触发跳转
    let accidentalJumpCalls = 0;
    const backAdapter = new SaveManagerAdapter();
    backAdapter.loadGlobalOverview = async () => [];
    backAdapter.jumpToSave = async () => {
      accidentalJumpCalls += 1;
    };
    const backModal = new SaveBranchManagerModal(backAdapter);
    backModal.backdropEl = new Round4El('backdrop');
    backModal.backdropEl.hidden = true;
    backModal.bindEvents();
    await backModal.open();
    backModal.currentCharacter = { id: 0, name: 'CharA', avatar: 'a.png', saves: [] };
    backModal.currentGraph = {
      characterAvatar: 'a.png',
      nodes: [{ chatId: 'save_selected', isUnavailable: false, floors: [], childrenIds: [] }],
    };
    backModal.selectedChatId = 'save_selected';
    backModal.setPane('detail');

    const hostDialog = { closed: false };
    openNativeDialogs = [hostDialog];
    globalThis.document.activeElement = { tagName: 'INPUT', matches: () => true };

    let keyConsumed = 0;
    for (const key of ['Escape', 'Enter']) {
      for (const fn of r4DocListeners.get('keydown') || []) {
        fn({
          key,
          isComposing: false,
          preventDefault() {
            keyConsumed += 1;
          },
          stopPropagation() {
            keyConsumed += 1;
          },
        });
      }
    }
    assert.equal(keyConsumed, 0, '顶层存在宿主原生 <dialog open> 时，大厅不得拦截 Escape/Enter 键盘事件');
    assert.equal(backModal.backdropEl.hidden, false, '在宿主 dialog 内按 Escape 不得关闭背后的大厅');
    assert.equal(accidentalJumpCalls, 0, '在宿主 dialog 内按 Enter 不得触发大厅存档跳转');

    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(hostDialog.closed, true, '存在顶层宿主 <dialog open> 时，首次返回必须优先关闭宿主弹窗');
    assert.equal(backModal.backdropEl.hidden, false, '宿主弹窗关闭时大厅不得被误关');
    assert.equal(backModal.backdropEl.dataset.pane, 'detail', '宿主弹窗关闭时大厅层级不得被误退');

    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(backModal.backdropEl.dataset.pane, 'saves', '宿主弹窗关闭后下一次返回才由大厅逐级回退');
    backModal.close();
    assert.equal(globalThis.window.__TAURITAVERN_HANDLE_BACK__(), true);
    assert.equal(hostFallbackCalls, 1, '大厅关闭后返回键正常穿透给宿主');
    backModal.uninstallTauriBackHandler();

    // 24B. 挂起中的跳转在用户关闭并重开大厅后才完成，不得把新打开的大厅关掉，且应正常释放跳转锁
    let resolveSlowJump;
    const jumpRaceAdapter = new SaveManagerAdapter();
    jumpRaceAdapter.loadGlobalOverview = async () => [];
    jumpRaceAdapter.jumpToSave = async () =>
      new Promise((resolve) => {
        resolveSlowJump = resolve;
      });
    const jumpModal = new SaveBranchManagerModal(jumpRaceAdapter);
    jumpModal.backdropEl = new Round4El('jump-backdrop');
    jumpModal.backdropEl.hidden = true;
    await jumpModal.open();
    const charObj = { id: 0, name: 'CharA', avatar: 'a.png', saves: [] };
    jumpModal.currentCharacter = charObj;
    jumpModal.currentGraph = {
      characterAvatar: 'a.png',
      nodes: [{ chatId: 'save_1', isUnavailable: false, floors: [], childrenIds: [] }],
    };

    const pendingJump = jumpModal.handleJump('save_1', charObj);
    assert.equal(jumpModal.isJumping, true);
    jumpModal.close();
    assert.equal(jumpModal.backdropEl.hidden, true);
    await jumpModal.open();
    assert.equal(jumpModal.backdropEl.hidden, false);

    resolveSlowJump(true);
    await pendingJump;
    assert.equal(jumpModal.backdropEl.hidden, false, '旧会话发起的跳转完成后绝不能关闭重新打开的新大厅');
    assert.equal(jumpModal.isJumping, false, '跳转完成后应释放导航锁');
    jumpModal.uninstallTauriBackHandler();

    // 24C. 标准 SillyTavern 缺失 openCharacterChat 时：禁止向斜杠解析器拼接不可信文件名；支持字面量 callback，缺失时明确拒绝
    let rawSlashExecCalls = 0;
    const directCallbackArgs = [];
    const trickyName = 'save | /echo injected {{user}}';
    const stCtx = {
      characterId: '0',
      chatId: 'old_chat',
      groupId: null,
      characters: [{ name: 'CharA', avatar: 'a.png', chat: 'old_chat' }],
      getRequestHeaders: () => ({}),
      executeSlashCommandsWithOptions: async () => {
        rawSlashExecCalls += 1;
      },
      SlashCommandParser: {
        commands: {
          'open-chat': {
            callback: async (namedArgs, unnamedArg) => {
              directCallbackArgs.push({ namedArgs, unnamedArg });
              stCtx.chatId = unnamedArg;
              stCtx.characters[0].chat = unnamedArg;
            },
          },
        },
      },
    };
    globalThis.window = {
      addEventListener() {},
      SillyTavern: { getContext: () => stCtx },
    };
    const stAdapter = new SaveManagerAdapter();
    await stAdapter.jumpToSave({ id: 0, name: 'CharA', avatar: 'a.png' }, trickyName);
    assert.equal(rawSlashExecCalls, 0, '绝不能将文件名拼接进 executeSlashCommandsWithOptions 执行');
    assert.deepEqual(directCallbackArgs, [{ namedArgs: {}, unnamedArg: trickyName }], '应以字面量参数直接调用 open-chat 回调');

    delete stCtx.SlashCommandParser.commands['open-chat'].callback;
    stCtx.chatId = 'old_chat';
    stCtx.characters[0].chat = 'old_chat';
    await assert.rejects(
      () => stAdapter.jumpToSave({ id: 0, name: 'CharA', avatar: 'a.png' }, trickyName),
      /未找到 SillyTavern 的 openCharacterChat 方法/
    );
    assert.equal(rawSlashExecCalls, 0);

    // 24D. IndexedDB 删除/写入事务触发 onabort 时不得挂起，且保留脏标记使二次普通读取不会误复用残存旧缓存
    const idbRecords = new Map();
    let abortWrites = false;
    let remoteMesText = '旧缓存版本_V1';
    let abortFetchCalls = 0;

    globalThis.indexedDB = {
      open() {
        const req = {};
        const fakeDb = {
          transaction() {
            const tx = {
              objectStore() {
                return {
                  get(key) {
                    const getReq = {};
                    setTimeout(() => {
                      getReq.result = idbRecords.get(key);
                      getReq.onsuccess?.();
                    }, 5);
                    return getReq;
                  },
                  put(record) {
                    setTimeout(() => {
                      if (abortWrites) {
                        tx.onabort?.();
                      } else {
                        idbRecords.set(record.cacheKey, record);
                        tx.oncomplete?.();
                      }
                    }, 5);
                  },
                  delete(key) {
                    setTimeout(() => {
                      if (abortWrites) {
                        tx.onabort?.();
                      } else {
                        idbRecords.delete(key);
                        tx.oncomplete?.();
                      }
                    }, 5);
                  },
                  clear() {
                    setTimeout(() => {
                      if (abortWrites) {
                        tx.onabort?.();
                      } else {
                        idbRecords.clear();
                        tx.oncomplete?.();
                      }
                    }, 5);
                  },
                };
              },
            };
            return tx;
          },
        };
        setTimeout(() => {
          req.result = fakeDb;
          req.onsuccess?.();
        }, 5);
        return req;
      },
    };
    globalThis.fetch = async (url) => {
      if (url === 'api/chats/get') {
        abortFetchCalls += 1;
        return {
          ok: true,
          text: async () => JSON.stringify([{ chat_metadata: {} }, { name: 'C', is_user: false, mes: remoteMesText }]),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const abortAdapter = new SaveManagerAdapter({ idbOpenTimeoutMs: 200 });
    const abortChar = { id: 0, name: 'CharA', avatar: 'a.png', activeChatId: 'other_chat' };
    const abortSummary = {
      chatId: 'save_abort',
      fileName: 'save_abort.jsonl',
      fileSize: '1KB',
      messageCount: 1,
      lastModified: '2026-11-23',
      previewText: 'same_preview',
    };

    // 1) 预热一条旧缓存记录写入 IndexedDB
    const initialDigests = await abortAdapter.getCharacterChatDigests(abortChar, [abortSummary]);
    assert.equal(initialDigests[0].floors[0].snippet, '旧缓存版本_V1');
    assert.equal(idbRecords.has('a.png::save_abort'), true);

    // 2) 等长编辑早期消息并失效，但此时 IDB delete 与替换 put 均触发 onabort
    remoteMesText = '编辑后新版_V2';
    abortWrites = true;
    abortAdapter.invalidateChatCache('a.png', 'save_abort');
    await new Promise((r) => setTimeout(r, 15));

    const firstAfterAbort = await Promise.race([
      abortAdapter.getCharacterChatDigests(abortChar, [abortSummary]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB onabort 导致永久挂起')), 500)),
    ]);
    assert.equal(firstAfterAbort[0].digestStatus, 'ok');
    assert.equal(firstAfterAbort[0].floors[0].snippet, '编辑后新版_V2', '事务 abort 后首次读取仍应顺利返回最新摘要');
    assert.equal(
      abortAdapter.dirtyDigestKeys.has('a.png::save_abort'),
      true,
      '写入事务 abort 时必须保留脏标记，防止旧记录在下次被误复用'
    );

    // 3) 第二次普通读取不得复用残存在 IDB 中的旧缓存，必须回源拿到新版，并在提交成功后清除脏标记
    abortWrites = false;
    const secondAfterAbort = await abortAdapter.getCharacterChatDigests(abortChar, [abortSummary]);
    assert.equal(secondAfterAbort[0].floors[0].snippet, '编辑后新版_V2', '二次普通读取不得回退到残存旧缓存');
    assert.equal(abortFetchCalls, 3, '二次读取应回源而非误命中旧缓存');
    assert.equal(abortAdapter.dirtyDigestKeys.has('a.png::save_abort'), false, '新写入提交成功后应清除脏标记');
  } finally {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
    globalThis.indexedDB = prevIndexedDB;
    globalThis.requestAnimationFrame = prevRAF;
  }
}

// 25. [性能优化与简化回归] 首屏优先渲染、在途列表去重、批量元数据/IDB读事务、侧栏与静态轨道 DOM 复用、移动端并发与 rAF 合帧
{
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevIndexedDB = globalThis.indexedDB;
  const prevLocalStorage = globalThis.localStorage;
  const prevRAF = globalThis.requestAnimationFrame;
  const prevCancelRAF = globalThis.cancelAnimationFrame;

  // 25A. 首屏优先渲染 + 同代次在途摘要请求去重（强刷/失效开启新代次）
  {
    let resolveSlowB;
    const summaryFetchCounts = new Map();
    const mockCtx = {
      characterId: '0',
      chatId: 'a1',
      groupId: null,
      characters: [
        { name: 'CharA', avatar: 'a.png', chat: 'a1' },
        { name: 'CharB', avatar: 'b.png', chat: 'b1' },
      ],
      getRequestHeaders: () => ({}),
    };
    globalThis.window = {
      innerWidth: 1280,
      addEventListener() {},
      SillyTavern: { getContext: () => mockCtx },
    };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init?.body || '{}');
      if (url === 'api/characters/chats') {
        const av = body.avatar_url;
        summaryFetchCounts.set(av, (summaryFetchCounts.get(av) || 0) + 1);
        if (av === 'b.png' && summaryFetchCounts.get(av) === 1) {
          return new Promise((resolve) => {
            resolveSlowB = () =>
              resolve({
                ok: true,
                json: async () => [{ file_name: 'b1.jsonl', file_size: '1KB', chat_items: 1, last_mes: '2026-11-23', mes: 'B' }],
              });
          });
        }
        return {
          ok: true,
          json: async () => [{ file_name: `${av.replace('.png', '')}1.jsonl`, file_size: '1KB', chat_items: 1, last_mes: '2026-11-24', mes: av }],
        };
      }
      if (url === 'api/chats/get') {
        return {
          ok: true,
          text: async () => JSON.stringify([{ chat_metadata: {} }, { name: 'A', is_user: false, mes: '优先渲染的剧情正文' }]),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    class PerfEl {
      constructor(role = '') {
        this.role = role;
        this.hidden = false;
        this.textContent = '';
        this.value = '';
        this.dataset = {};
        this.style = {};
        this.scrollHeight = 40;
        this._html = '';
        this.innerHTMLWriteCount = 0;
        this.childrenByRole = new Map();
        this.sideItems = [];
        this.attrs = {};
        this.classes = new Set();
        this.classList = {
          add: (c) => this.classes.add(c),
          remove: (c) => this.classes.delete(c),
          toggle: (c, force) => {
            const on = force === undefined ? !this.classes.has(c) : Boolean(force);
            if (on) this.classes.add(c);
            else this.classes.delete(c);
          },
          contains: (c) => this.classes.has(c),
        };
      }
      set innerHTML(v) {
        this.innerHTMLWriteCount += 1;
        this._html = String(v);
        this.childrenByRole.clear();
        if (this.role === 'sidebar-list') {
          this.sideItems = [];
          const re = /data-library="([^"]+)"(?:\s+data-avatar="([^"]+)")?/g;
          let m;
          while ((m = re.exec(this._html))) {
            const btn = new PerfEl('side-item');
            btn.dataset.library = m[1];
            if (m[2]) btn.dataset.avatar = m[2];
            this.sideItems.push(btn);
          }
        }
      }
      get innerHTML() {
        return this._html;
      }
      addEventListener() {}
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      }
      getAttribute(k) {
        return this.attrs[k];
      }
      querySelector(sel) {
        const roleM = sel.match(/\[data-role="([^"]+)"\]/);
        if (roleM) {
          if (!this.childrenByRole.has(roleM[1])) this.childrenByRole.set(roleM[1], new PerfEl(roleM[1]));
          return this.childrenByRole.get(roleM[1]);
        }
        const lineM = sel.match(/\[data-line="([^"]+)"\]/);
        if (lineM) {
          const key = `line:${lineM[1]}`;
          if (!this.childrenByRole.has(key)) this.childrenByRole.set(key, new PerfEl(key));
          return this.childrenByRole.get(key);
        }
        return null;
      }
      querySelectorAll(sel) {
        if (sel === '[data-library]') return this.sideItems;
        return [];
      }
      contains() {
        return false;
      }
      appendChild() {}
      remove() {}
    }

    globalThis.document = {
      createElement: () => new PerfEl(),
      body: { appendChild() {} },
      addEventListener() {},
      querySelectorAll: () => [],
      activeElement: null,
    };
    const rafQueue = [];
    globalThis.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
      const perfAdapter = new SaveManagerAdapter({ summaryCacheTtlMs: 60_000 });
      const perfModal = new SaveBranchManagerModal(perfAdapter);
      perfModal.backdropEl = new PerfEl('backdrop');
      perfModal.backdropEl.hidden = true;

      // 发起 open()：B 卡住，A 立即返回并率先完成故事线渲染
      const openTask = perfModal.open();
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(perfModal.currentCharacter?.avatar, 'a.png', '慢角色 B 未返回前，优先角色 A 应已进入当前视图');
      assert.equal(perfModal.selectedChatId, 'a1', '慢角色 B 未返回前，优先角色 A 的故事线应已完成渲染并可选中');

      // B 在途期间再次并发调用 getCharacterChatSummaries(B, false) 应复用同一请求，不重复发 fetch
      const dedupP = perfAdapter.getCharacterChatSummaries({ name: 'CharB', avatar: 'b.png' }, false);
      assert.equal(summaryFetchCounts.get('b.png'), 1, '同代次重叠调用应复用在途摘要请求');

      // 强制刷新则必须开启新请求代次，不复用旧在途请求
      const forcedB = await perfAdapter.getCharacterChatSummaries({ name: 'CharB', avatar: 'b.png' }, true);
      assert.equal(summaryFetchCounts.get('b.png'), 2, 'forceRefresh 应开启新代次请求');
      assert.equal(forcedB.length, 1);

      resolveSlowB();
      await Promise.all([openTask, dedupP]);

      // 25D. 侧栏与静态轨道 DOM 复用：切换角色只改 .is-selected 不重写 sidebar-list.innerHTML；切档不重写 rail.innerHTML
      const sidebarEl = perfModal.role('sidebar-list');
      const sidebarWritesBefore = sidebarEl.innerHTMLWriteCount;
      await perfModal.selectCharacter('b.png');
      assert.equal(sidebarEl.innerHTMLWriteCount, sidebarWritesBefore, '切换角色时应就地更新 .is-selected，不重建侧栏 DOM');
      assert.equal(sidebarEl.sideItems.find((x) => x.dataset.avatar === 'b.png')?.classes.has('is-selected'), true);

      // 25D-2. rAF 合帧：同一帧内多次布局宽度变化只触发一次 fitInspectorFields
      let fitCalls = 0;
      perfModal.fitInspectorFields = () => {
        fitCalls += 1;
      };
      perfModal.scheduleFitInspectorFields();
      perfModal.scheduleFitInspectorFields();
      perfModal.scheduleFitInspectorFields();
      assert.equal(fitCalls, 0);
      while (rafQueue.length) rafQueue.shift()();
      assert.equal(fitCalls, 1, '同一帧内多次视口重测应合并为一次 rAF 回调');

      // 25D-3. 静态轨道 SVG 复用：切档时仅更新高亮线与受影响圆点，不重写 rail.innerHTML
      const railEl = perfModal.role('rail');
      const dotA = new PerfEl('dot-a');
      const dotB = new PerfEl('dot-b');
      perfModal.railLayout = {
        order: [
          { chatId: 'n1', parentId: null, branchMoment: null },
          { chatId: 'n2', parentId: 'n1', branchMoment: { branchFloor: 2 } },
        ],
        byId: new Map([
          ['n1', { chatId: 'n1', parentId: null, branchMoment: null }],
          ['n2', { chatId: 'n2', parentId: 'n1', branchMoment: { branchFloor: 2 } }],
        ]),
        pos: new Map([
          ['n1', { x: 20, y: 32 }],
          ['n2', { x: 38, y: 96 }],
        ]),
        segment: (n) => (n.parentId ? 'V74C20 92 32 96 38 96' : ''),
        dotById: new Map([
          ['n1', dotA],
          ['n2', dotB],
        ]),
        highlightedIds: new Set(['n1']),
        activeAnims: [],
        mounted: true,
      };
      const railWritesBefore = railEl.innerHTMLWriteCount;
      perfModal.selectedChatId = 'n2';
      perfModal.renderRail('n1');
      assert.equal(railEl.innerHTMLWriteCount, railWritesBefore, '切档更新高亮路径时不得重写 rail.innerHTML');
      assert.equal(dotB.getAttribute('r'), '6', '新选中圆点半径应更新为 6');
      assert.ok(dotB.getAttribute('class')?.includes('is-selected'));
    } finally {
      globalThis.document = prevDocument;
      globalThis.window = prevWindow;
      globalThis.fetch = prevFetch;
      globalThis.requestAnimationFrame = prevRAF;
      globalThis.cancelAnimationFrame = prevCancelRAF;
    }
  }

  // 25B. IndexedDB 温热批量读取共享单次 readonly 事务 + 读在途失效不命中旧缓存 + 移动端自适应并发上限为 2
  {
    let readonlyTxCount = 0;
    let inFlightFetches = 0;
    let peakFetches = 0;
    const idbStore = new Map();
    const mockCtx = {
      characterId: '0',
      chatId: 'active_only',
      groupId: null,
      characters: [{ name: 'M', avatar: 'm.png', chat: 'active_only' }],
      getRequestHeaders: () => ({}),
    };
    globalThis.window = {
      __TAURITAVERN__: { abiVersion: 2 },
      __TAURITAVERN_HOST__: { platform: 'android', kind: 'mobile' },
      SillyTavern: { getContext: () => mockCtx },
    };
    globalThis.indexedDB = {
      open() {
        const req = {};
        const fakeDb = {
          transaction(_store, mode) {
            if (mode === 'readonly') readonlyTxCount += 1;
            const tx = {
              objectStore() {
                return {
                  get(key) {
                    const getReq = {};
                    setTimeout(() => {
                      getReq.result = idbStore.get(key);
                      getReq.onsuccess?.();
                    }, 5);
                    return getReq;
                  },
                  put(record) {
                    setTimeout(() => {
                      idbStore.set(record.cacheKey, record);
                      tx.oncomplete?.();
                    }, 5);
                  },
                  delete(key) {
                    setTimeout(() => {
                      idbStore.delete(key);
                      tx.oncomplete?.();
                    }, 5);
                  },
                  clear() {
                    setTimeout(() => {
                      idbStore.clear();
                      tx.oncomplete?.();
                    }, 5);
                  },
                };
              },
            };
            return tx;
          },
        };
        setTimeout(() => {
          req.result = fakeDb;
          req.onsuccess?.();
        }, 5);
        return req;
      },
    };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init?.body || '{}');
      if (url === '/api/chats/get') {
        inFlightFetches += 1;
        peakFetches = Math.max(peakFetches, inFlightFetches);
        await new Promise((r) => setTimeout(r, 15));
        inFlightFetches -= 1;
        return {
          ok: true,
          text: async () => JSON.stringify([{}, { name: 'M', is_user: false, mes: `正文_${body.file_name}` }]),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    try {
      const batchAdapter = new SaveManagerAdapter({ digestCacheTtlMs: 60_000 });
      const ch = { id: 0, name: 'M', avatar: 'm.png', activeChatId: 'active_only' };
      const sums = Array.from({ length: 5 }, (_, i) => ({
        chatId: `s_${i}`,
        fileName: `s_${i}.jsonl`,
        rawFileSize: '100',
        messageCount: 1,
        lastModified: '2026-11-24',
        previewText: `p_${i}`,
      }));

      // 首次冷拉：移动端并发应被限制在 <= 2
      await batchAdapter.getCharacterChatDigests(ch, sums);
      assert.ok(peakFetches <= 2, `移动端冷拉并发应限制在 2 以内，实际峰值: ${peakFetches}`);
      assert.equal(idbStore.size, 5);

      // 第二次温热读取：5 条非活跃缓存记录应在 1 次共享 readonly 事务中批量读出，不再发任何 fetch
      readonlyTxCount = 0;
      peakFetches = 0;
      const warmDigests = await batchAdapter.getCharacterChatDigests(ch, sums);
      assert.equal(readonlyTxCount, 1, '5 条温热记录应在单次共享 readonly 事务内读完');
      assert.equal(peakFetches, 0, '温热命中缓存时不应再发网络请求');
      assert.equal(warmDigests.length, 5);

      // 批量读在途期间触发 invalidateChatCache，命中结果必须被丢弃并回源拉取
      const batchPromise = batchAdapter.getCharacterChatDigests(ch, sums);
      batchAdapter.invalidateChatCache('m.png', 's_2');
      await batchPromise;
      assert.ok(peakFetches >= 1, '批量读在途期间被失效的条目必须回源重拉，不得使用过期命中');
    } finally {
      globalThis.window = prevWindow;
      globalThis.fetch = prevFetch;
      globalThis.indexedDB = prevIndexedDB;
    }
  }

  // 25C. 批量元数据读取：preview/localStorage 模式下装配整批存档只解析一次 localStorage，写入只读一次
  {
    let lsGetCount = 0;
    const lsMap = new Map();
    globalThis.window = undefined;
    globalThis.localStorage = {
      getItem(k) {
        lsGetCount += 1;
        return lsMap.get(k) ?? null;
      },
      setItem(k, v) {
        lsMap.set(k, String(v));
      },
    };
    try {
      const localAdapter = new SaveManagerAdapter();
      lsGetCount = 0;
      localAdapter.updateSaveMeta('elaina_witch.png', 'chat_1', { starred: true });
      assert.equal(lsGetCount, 1, 'updateSaveMeta 在 localStorage 模式下应仅解析一次存储');

      lsGetCount = 0;
      const ch = localAdapter.getCharacters()[0];
      const sums = await localAdapter.getCharacterChatSummaries(ch);
      assert.ok(sums.length >= 4);
      await localAdapter.getCharacterChatDigests(ch, sums);
      assert.equal(lsGetCount, 1, 'getCharacterChatDigests 批量装配多个存档时应仅解析一次 localStorage');
    } finally {
      globalThis.window = prevWindow;
      globalThis.localStorage = prevLocalStorage;
    }
  }
}

console.log('✅ 所有分支检测、三方对比、树布局及回归测试全部通过！');
