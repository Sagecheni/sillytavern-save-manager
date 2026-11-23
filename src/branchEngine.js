/**
 * 分支时刻检测与剧情树布局引擎 (Branch Engine)
 *
 * 核心职责：
 * 1. 解析同一角色下的多个聊天存档摘要，结合官方 main_chat 元数据与逐楼层最长公共前缀 (LCP) 哈希比对，推导父子分支树。
 * 2. 提取每次分叉的精确“分支时刻”：分叉楼层、共同锚点剧情、原主线走向 vs 新分支走向。
 * 3. 将分支森林编排为自上而下的「故事线」：延续剧情直行，分叉剧情向右开出新轨道。
 */

import { stripJsonl, parseSillyTavernTimestamp } from './adapter.js';

/**
 * 从元数据或酒馆默认文件名（如 2026-11-19@21h00m12s）解析创建时间戳，用于同级分支先后排序
 */
export function parseSaveCreatedTime(digest) {
  const headerDate = digest?.header?.create_date;
  if (headerDate) {
    const parsed = parseSillyTavernTimestamp(headerDate);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const fromId = parseSillyTavernTimestamp(digest?.chatId || '');
  if (!Number.isNaN(fromId)) return fromId;

  const mod = parseSillyTavernTimestamp(digest?.lastModified || '');
  return Number.isNaN(mod) ? Number.MAX_SAFE_INTEGER : mod;
}

/**
 * 计算两个存档的公共前缀楼层数 (Longest Common Prefix)
 */
export function computeLcpFloors(floorsA = [], floorsB = []) {
  const limit = Math.min(floorsA.length, floorsB.length);
  let lcp = 0;
  while (lcp < limit && floorsA[lcp].hash === floorsB[lcp].hash) {
    lcp += 1;
  }
  return lcp;
}

/**
 * 判断两个存档间是否存在显式父子指向（优先 SillyTavern 原生 main_chat，其次楼层 bookmark_link）
 * 返回值：1 表示 candidateParent 显式为 child 的父节点；-1 表示反向；0 表示无明确或冲突指向
 */
function getExplicitParentRelation(candidateParent, child) {
  const childMain = stripJsonl(child.header?.chat_metadata?.main_chat || '');
  const parentMain = stripJsonl(candidateParent.header?.chat_metadata?.main_chat || '');
  const childPointsToParent = Boolean(childMain && childMain === candidateParent.chatId);
  const parentPointsToChild = Boolean(parentMain && parentMain === child.chatId);

  if (childPointsToParent && !parentPointsToChild) return 1;
  if (parentPointsToChild && !childPointsToParent) return -1;

  // 仅当双方均未声明 main_chat 时，回退使用楼层上的 bookmark_link（防止子分支继承主线的旧书签链接造成歧义）
  if (!childMain && !parentMain) {
    const parentBookmarksChild = candidateParent.floors.some((f) => f.bookmarkLink === child.chatId);
    const childBookmarksParent = child.floors.some((f) => f.bookmarkLink === candidateParent.chatId);
    if (parentBookmarksChild && !childBookmarksParent) return 1;
    if (childBookmarksParent && !parentBookmarksChild) return -1;
  }

  return 0;
}

/**
 * 判断 candidateParent 在历史演化上是否位于 child 的上游
 */
function isUpstreamCandidate(candidateParent, child, lcp) {
  // 情况1：优先尊重酒馆原生 main_chat（以及无 main_chat 时的 bookmark_link）指向
  // 这样主线推进超过检查点楼层后，原生检查点仍作为主线的子节点，而不会被反转成主线的父节点
  const explicitRel = getExplicitParentRelation(candidateParent, child);
  if (explicitRel === 1) return true;
  if (explicitRel === -1) return false;

  const lenP = candidateParent.floors.length;
  const lenC = child.floors.length;

  // 情况2：无显式指向时，若一方恰好停在分叉楼层、另一方继续往后推进，短方视为阶段检查点/上游
  if (lenP === lcp && lenC > lcp) return true;
  if (lenC === lcp && lenP > lcp) return false;

  // 情况3：按创建时间先后决定谁是主干、谁是派生分支
  const timeP = candidateParent._createdTime;
  const timeC = child._createdTime;
  if (timeP !== timeC) {
    return timeP < timeC;
  }

  return candidateParent.chatId.localeCompare(child.chatId) < 0;
}

/**
 * 判断若将 childId 挂载到 parentId 之下是否会形成环路
 */
function wouldCreateCycle(childId, parentId, nodeById) {
  let cursorId = parentId;
  const visited = new Set([childId]);
  while (cursorId) {
    if (visited.has(cursorId)) return true;
    visited.add(cursorId);
    cursorId = nodeById.get(cursorId)?.parentId || null;
  }
  return false;
}

function isBetterParentCandidate(candidate, lcp, isExplicit, bestParent, bestLcp, bestIsExplicit) {
  if (!bestParent) return true;
  if (lcp !== bestLcp) return lcp > bestLcp;
  if (isExplicit !== bestIsExplicit) return isExplicit && !bestIsExplicit;
  if (candidate._createdTime !== bestParent._createdTime) {
    return candidate._createdTime < bestParent._createdTime;
  }
  return candidate.chatId.localeCompare(bestParent.chatId) < 0;
}

/**
 * 将每个存档上移到真正拥有其分叉楼层的祖先之下
 */
function settleForkOwners(orderedNodes, nodeById) {
  const settled = new Set();

  const settle = (node) => {
    if (settled.has(node.chatId)) return;
    settled.add(node.chatId);
    const parent = nodeById.get(node.parentId);
    if (!parent) return;
    settle(parent); // 先定好父存档自身的位置，再判断子存档

    for (let owner = parent; owner.parentId; owner = nodeById.get(owner.parentId)) {
      const lcp = node._lcpWithParent;
      if (lcp > owner._lcpWithParent) break;
      // 父存档整份都是本存档的前缀：确实是从它的末尾接着写，保留原关系
      if (owner.floors.length === lcp && node.floors.length > lcp) break;

      const upper = nodeById.get(owner.parentId);
      node.parentId = upper.chatId;
      node._lcpWithParent = computeLcpFloors(upper.floors, node.floors);
    }
  };

  orderedNodes.forEach(settle);
}

/**
 * 为某个角色的所有存档构建分支森林与节点详情
 */
export function buildCharacterBranchGraph(character, rawDigests = []) {
  const nodes = rawDigests.map((d) => {
    const chatId = stripJsonl(d.chatId || d.fileName);
    const floors = Array.isArray(d.floors) ? d.floors : [];
    const lastFloor = floors[floors.length - 1] || null;
    return {
      ...d,
      chatId,
      floors,
      floorCount: floors.length || d.messageCount || 0,
      isActive: Boolean(character?.isCurrentCharacter && stripJsonl(character?.activeChatId) === chatId),
      isCharacterLastChat: stripJsonl(character?.activeChatId) === chatId,
      lastFloorSnippet: lastFloor?.snippet || d.previewText || '暂无聊天消息',
      _createdTime: parseSaveCreatedTime(d),
      parentId: null,
      childrenIds: [],
      branchMoment: null,
      row: 0,
      lane: 0,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.chatId, n]));
  // 按创建时间与 chatId 稳定排序，确保无论后端返回顺序如何，推导出的树结构完全一致
  const orderedNodes = [...nodes].sort((a, b) => {
    if (a._createdTime !== b._createdTime) return a._createdTime - b._createdTime;
    return a.chatId.localeCompare(b.chatId);
  });

  // 第一步（阶段 A）：优先建立所有酒馆原生显式父子关系（main_chat / bookmark_link），防止后续推断产生环路时误删原生关系
  for (const child of orderedNodes) {
    if (child.floors.length === 0) continue;

    let bestParent = null;
    let bestLcp = 0;

    for (const candidate of orderedNodes) {
      if (candidate.chatId === child.chatId || candidate.floors.length === 0) continue;
      if (getExplicitParentRelation(candidate, child) !== 1) continue;

      const lcp = computeLcpFloors(candidate.floors, child.floors);
      if (lcp < 1) continue;
      if (wouldCreateCycle(child.chatId, candidate.chatId, nodeById)) continue;

      if (isBetterParentCandidate(candidate, lcp, true, bestParent, bestLcp, true)) {
        bestParent = candidate;
        bestLcp = lcp;
      }
    }

    if (bestParent && bestLcp >= 1) {
      child.parentId = bestParent.chatId;
      child._lcpWithParent = bestLcp;
    }
  }

  // 第一步（阶段 B）：为尚未确立显式父节点的存档补充不会成环的 LCP 推断关系
  for (const child of orderedNodes) {
    if (child.parentId || child.floors.length === 0) continue;

    let bestParent = null;
    let bestLcp = 0;

    for (const candidate of orderedNodes) {
      if (candidate.chatId === child.chatId || candidate.floors.length === 0) continue;

      const lcp = computeLcpFloors(candidate.floors, child.floors);
      // 同一张角色卡的独立新聊天默认共用第 1 楼开场白；无显式 main_chat / bookmark_link 时要求至少共享 2 楼才视为分叉
      if (lcp < 2) continue;
      if (!isUpstreamCandidate(candidate, child, lcp)) continue;
      // 嵌套检查点（主线 -> 外层检查点 -> 内层检查点）下，禁止将主线反向挂到后代检查点之下成环
      if (wouldCreateCycle(child.chatId, candidate.chatId, nodeById)) continue;

      if (isBetterParentCandidate(candidate, lcp, false, bestParent, bestLcp, false)) {
        bestParent = candidate;
        bestLcp = lcp;
      }
    }

    if (bestParent && bestLcp >= 2) {
      child.parentId = bestParent.chatId;
      child._lcpWithParent = bestLcp;
    }
  }

  // 第二步：兜底环路安全防护（正常情况下阶段 A/B 已保证无环）
  for (const node of orderedNodes) {
    const visited = new Set([node.chatId]);
    let cursor = node;
    while (cursor.parentId) {
      if (visited.has(cursor.parentId)) {
        cursor.parentId = null;
        cursor._lcpWithParent = 0;
        break;
      }
      visited.add(cursor.parentId);
      cursor = nodeById.get(cursor.parentId) || { parentId: null };
    }
  }

  // 第二步（补）：main_chat 记录的是「点分支按钮时所在的文件」，不是剧情真正岔开的位置。
  // 从某分支倒回更早的楼层再开分支时，共同剧情其实属于更上游的存档，需上移到那里，
  // 从而保证沿任意一条线往下，分叉楼层只增不减。
  settleForkOwners(orderedNodes, nodeById);

  // 第三步：填充 childrenIds 与详尽的 branchMoment（分叉时刻对比信息）
  for (const node of nodes) {
    if (!node.parentId) continue;
    const parent = nodeById.get(node.parentId);
    if (!parent) {
      node.parentId = null;
      continue;
    }
    parent.childrenIds.push(node.chatId);

    const lcp = node._lcpWithParent || 0;
    const anchorFloor = parent.floors[lcp - 1] || node.floors[lcp - 1] || null;
    const parentNextFloor = parent.floors[lcp] || null;
    const childNextFloor = node.floors[lcp] || null;
    const isExactCopy = lcp === node.floors.length && lcp === parent.floors.length;

    node.branchMoment = {
      branchFloor: lcp,
      isExactCopy,
      isCheckpointContinuation: parent.floors.length === lcp && node.floors.length > lcp,
      isCheckpointSnapshot: node.floors.length === lcp && parent.floors.length > lcp,
      explicitLinked: getExplicitParentRelation(parent, node) === 1,
      anchorSpeaker: anchorFloor?.name || '',
      anchorSnippet: anchorFloor?.snippet || '',
      parentNextSpeaker: parentNextFloor?.name || '',
      parentNextSnippet: parentNextFloor?.snippet || '',
      childNextSpeaker: childNextFloor?.name || '',
      childNextSnippet: childNextFloor?.snippet || '',
    };
  }

  // 对每个父节点的子分支按分叉楼层升序、创建时间升序排列，保证视觉从上到下符合剧情顺序
  for (const node of nodes) {
    node.childrenIds.sort((idA, idB) => {
      const a = nodeById.get(idA);
      const b = nodeById.get(idB);
      const floorDiff = (a.branchMoment?.branchFloor || 0) - (b.branchMoment?.branchFloor || 0);
      if (floorDiff !== 0) return floorDiff;
      return a._createdTime - b._createdTime;
    });
  }

  // 第四步：找出所有根节点（独立开场白 / 主干起点），按最近活跃或创建时间排列
  const roots = nodes
    .filter((n) => !n.parentId)
    .sort((a, b) => a._createdTime - b._createdTime);

  // 第五步：编排故事线
  const { order, laneCount } = layoutStoryline(roots, nodeById);

  return {
    nodes,
    roots,
    order,
    laneCount,
    branchCount: nodes.filter((n) => Boolean(n.parentId)).length,
    rootCount: roots.length,
  };
}

/**
 * 故事线布局：每个存档占一行 (row) 与一条轨道 (lane)
 * - 走得最远的那条线视为主干，沿同一轨道直行；其余向右开出新轨道
 * - 支线排在主干的下一站之前，因此轨道之间永不交叉
 */
function layoutStoryline(roots, nodeById) {
  const order = [];
  let laneCount = 0;

  const latestTime = new Map(); // 子树中最近的游玩时间
  const furthest = new Map(); // 子树中走到的最远楼层
  const measure = (node) => {
    let latest = parseSillyTavernTimestamp(node.lastModified) || 0;
    let floors = node.floors.length;
    for (const id of node.childrenIds) {
      const child = nodeById.get(id);
      measure(child);
      latest = Math.max(latest, latestTime.get(id));
      floors = Math.max(floors, furthest.get(id));
    }
    latestTime.set(node.chatId, latest);
    furthest.set(node.chatId, floors);
  };
  const isBetterTrunk = (a, b) =>
    furthest.get(a.chatId) - furthest.get(b.chatId) || latestTime.get(a.chatId) - latestTime.get(b.chatId);

  const place = (node, lane) => {
    node.row = order.length;
    node.lane = lane;
    order.push(node);
    laneCount = Math.max(laneCount, lane + 1);

    const children = node.childrenIds.map((id) => nodeById.get(id));
    // 子线走得比本存档更远，才算主干的下一站；否则本存档自己就是这条线的终点
    const trunk = children
      .filter((c) => furthest.get(c.chatId) > node.floors.length)
      .reduce((best, c) => (!best || isBetterTrunk(c, best) > 0 ? c : best), null);

    for (const child of children) {
      if (child !== trunk) place(child, lane + 1);
    }
    if (trunk) place(trunk, lane);
  };

  // 最近游玩过的剧情树排在最前
  roots.forEach(measure);
  [...roots]
    .sort((a, b) => latestTime.get(b.chatId) - latestTime.get(a.chatId))
    .forEach((root) => place(root, 0));

  return { order, laneCount };
}
