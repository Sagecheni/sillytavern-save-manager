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

console.log('✅ 所有分支检测、三方对比、树布局及回归测试全部通过！');
