import assert from 'node:assert/strict';
import { SaveManagerAdapter, compactChatLines, parseChatResponsePayload } from '../src/adapter.js';
import { buildCharacterBranchGraph } from '../src/branchEngine.js';

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

console.log('✅ 所有分支检测、三方对比与树布局测试通过！');
