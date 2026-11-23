/**
 * 分支时刻检测与剧情树布局引擎 (Branch Engine)
 *
 * 核心职责：
 * 1. 解析同一角色下的多个聊天存档摘要，结合官方 main_chat 元数据与逐楼层最长公共前缀 (LCP) 哈希比对，推导父子分支树。
 * 2. 提取每次分叉的精确“分支时刻”：分叉楼层、共同锚点剧情、原主线走向 vs 新分支走向。
 * 3. 计算从左到右的整洁树状图坐标（Reingold-Tilford 风格层次居中排版），无需依赖外部大型图形库。
 */

import { stripJsonl } from './adapter.js';

export const LAYOUT_CONFIG = {
  nodeWidth: 280,
  nodeHeight: 132,
  horizontalGap: 124,
  verticalGap: 28,
  treeGap: 52,
  paddingX: 48,
  paddingY: 48,
};

/**
 * 从元数据或酒馆默认文件名（如 2026-11-19@21h00m12s）解析创建时间戳，用于同级分支先后排序
 */
export function parseSaveCreatedTime(digest) {
  const headerDate = digest?.header?.create_date;
  if (headerDate) {
    const parsed = Date.parse(headerDate.replace('@', ' '));
    if (!Number.isNaN(parsed)) return parsed;
  }

  const id = String(digest?.chatId || '');
  const m = id.match(/(\d{4}-\d{2}-\d{2})[@_](\d{2})h(\d{2})m(?:(\d{2})s)?/i);
  if (m) {
    const [, datePart, hh, mm, ss = '00'] = m;
    const parsed = Date.parse(`${datePart}T${hh}:${mm}:${ss}`);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const mod = Date.parse(digest?.lastModified || '');
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
 * 判断 candidateParent 在历史演化上是否位于 child 的上游
 */
function isUpstreamCandidate(candidateParent, child, lcp) {
  const lenP = candidateParent.floors.length;
  const lenC = child.floors.length;

  // 情况1：父存档恰好停在分叉楼层（检查点或主干阶段存档），子存档继续往后推进
  if (lenP === lcp && lenC > lcp) return true;
  if (lenC === lcp && lenP > lcp) return false;

  // 情况2：双方都在分叉点后继续聊天（或完全同长副本），优先尊重酒馆原生 main_chat 指向
  const childMain = stripJsonl(child.header?.chat_metadata?.main_chat || '');
  const parentMain = stripJsonl(candidateParent.header?.chat_metadata?.main_chat || '');
  if (childMain === candidateParent.chatId && parentMain !== child.chatId) {
    return true;
  }
  if (parentMain === child.chatId && childMain !== candidateParent.chatId) {
    return false;
  }

  // 情况3：按创建时间先后决定谁是主干、谁是派生分支
  const timeP = candidateParent._createdTime;
  const timeC = child._createdTime;
  if (timeP !== timeC) {
    return timeP < timeC;
  }

  return candidateParent.chatId.localeCompare(child.chatId) < 0;
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
      depth: 0,
      x: 0,
      y: 0,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.chatId, n]));

  // 第一步：为每个存档寻找最优上游父节点（LCP 最大，若并列优先官方 main_chat，再按更早创建时间）
  for (const child of nodes) {
    if (child.floors.length === 0) continue;

    const explicitMainId = stripJsonl(child.header?.chat_metadata?.main_chat || '');
    let bestParent = null;
    let bestLcp = 0;
    let bestIsExplicit = false;

    for (const candidate of nodes) {
      if (candidate.chatId === child.chatId || candidate.floors.length === 0) continue;

      const lcp = computeLcpFloors(candidate.floors, child.floors);
      if (lcp < 1) continue;
      if (!isUpstreamCandidate(candidate, child, lcp)) continue;

      const isExplicit = explicitMainId === candidate.chatId;
      const isBetter =
        lcp > bestLcp ||
        (lcp === bestLcp && isExplicit && !bestIsExplicit) ||
        (lcp === bestLcp && isExplicit === bestIsExplicit && bestParent && candidate._createdTime < bestParent._createdTime);

      if (isBetter || !bestParent) {
        bestParent = candidate;
        bestLcp = lcp;
        bestIsExplicit = isExplicit;
      }
    }

    if (bestParent && bestLcp >= 1) {
      child.parentId = bestParent.chatId;
      child._lcpWithParent = bestLcp;
    }
  }

  // 第二步：环路安全防护（防止极端手动篡改 metadata 造成循环指向）
  for (const node of nodes) {
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
      explicitLinked: stripJsonl(node.header?.chat_metadata?.main_chat || '') === parent.chatId,
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

  // 第五步：计算树状图二维坐标与连接线
  const layout = layoutForest(roots, nodeById);

  return {
    nodes,
    roots,
    edges: layout.edges,
    canvasWidth: layout.width,
    canvasHeight: layout.height,
    branchCount: nodes.filter((n) => Boolean(n.parentId)).length,
    rootCount: roots.length,
  };
}

/**
 * 整洁层次树布局：父节点在所有子节点的垂直中心，多棵独立开局树自上而下排列
 */
function layoutForest(roots, nodeById, cfg = LAYOUT_CONFIG) {
  let currentLeafY = cfg.paddingY;
  let maxRightX = cfg.paddingX + cfg.nodeWidth;
  let maxBottomY = cfg.paddingY + cfg.nodeHeight;
  const edges = [];

  function layoutSubtree(node, depth) {
    node.depth = depth;
    node.x = cfg.paddingX + depth * (cfg.nodeWidth + cfg.horizontalGap);
    maxRightX = Math.max(maxRightX, node.x + cfg.nodeWidth);

    const children = node.childrenIds.map((id) => nodeById.get(id)).filter(Boolean);
    if (children.length === 0) {
      node.y = currentLeafY;
      currentLeafY += cfg.nodeHeight + cfg.verticalGap;
      maxBottomY = Math.max(maxBottomY, node.y + cfg.nodeHeight);
      return node.y;
    }

    const childYs = [];
    for (const child of children) {
      childYs.push(layoutSubtree(child, depth + 1));
    }

    // 父节点垂直居中于首尾子节点之间
    node.y = Math.round((childYs[0] + childYs[childYs.length - 1]) / 2);
    maxBottomY = Math.max(maxBottomY, node.y + cfg.nodeHeight);

    for (const child of children) {
      const startX = node.x + cfg.nodeWidth;
      const startY = node.y + Math.round(cfg.nodeHeight / 2);
      const endX = child.x;
      const endY = child.y + Math.round(cfg.nodeHeight / 2);
      const midX = Math.round((startX + endX) / 2);

      edges.push({
        id: `${node.chatId}->${child.chatId}`,
        fromId: node.chatId,
        toId: child.chatId,
        branchFloor: child.branchMoment?.branchFloor || 1,
        isExactCopy: Boolean(child.branchMoment?.isExactCopy),
        path: `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`,
        badgeX: midX,
        badgeY: Math.round((startY + endY) / 2),
      });
    }

    return node.y;
  }

  roots.forEach((root, idx) => {
    if (idx > 0) {
      currentLeafY += cfg.treeGap - cfg.verticalGap;
    }
    layoutSubtree(root, 0);
  });

  return {
    edges,
    width: maxRightX + cfg.paddingX + 40,
    height: maxBottomY + cfg.paddingY + 40,
  };
}
