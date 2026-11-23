/**
 * 模拟数据集 (Mock Data)
 * 用于在未连接 SillyTavern 后端时，在 preview.html 中完整演示多角色、多层嵌套分支、书签与状态切换。
 */

function svgAvatar(bg1, bg2, emoji, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bg1}"/>
        <stop offset="100%" stop-color="${bg2}"/>
      </linearGradient>
    </defs>
    <rect width="160" height="160" rx="28" fill="url(#g)"/>
    <circle cx="80" cy="64" r="34" fill="rgba(255,255,255,0.14)"/>
    <text x="80" y="76" font-size="38" text-anchor="middle">${emoji}</text>
    <text x="80" y="132" font-size="16" font-family="system-ui, sans-serif" font-weight="600" fill="rgba(255,255,255,0.92)" text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function msg(name, isUser, text, sendDate, extra = {}) {
  return {
    name,
    is_user: isUser,
    is_system: false,
    send_date: sendDate,
    mes: text,
    extra,
  };
}

// 构造伊蕾娜的公共主干剧情 (1~6楼)
const elainaTrunk1to6 = [
  msg('伊蕾娜', false, '微风拂过金色麦田，头戴三角帽的灰发少女停下扫帚，回头打量着站在岔路口的你。“嗯？前面就是被称为‘永夜钟塔’的边境城镇了哦，旅人先生也要去那里吗？”', '2026-11-18 20:10:00'),
  msg('旅行者', true, '“没错，听说钟塔顶层藏着能倒流时间的星砂。路途危险，不如结伴同行？”', '2026-11-18 20:12:00'),
  msg('伊蕾娜', false, '她微微挑眉，手指轻轻摩挲着胸前的星形胸针，露出一抹狡黠的微笑：“结伴可以呀，不过向导费可是每天三枚银币，外加城里最好吃的奶油烤面包一份，不接受讲价哦。”', '2026-11-18 20:14:00'),
  msg('旅行者', true, '爽快地抛给她三枚银币，两人一起穿过薄雾笼罩的城门，在钟塔脚下的白鸽酒馆落脚。', '2026-11-18 20:18:00'),
  msg('伊蕾娜', false, '酒馆老板压低声音提醒你们，今晚午夜钟声敲响第十二下时，守塔骑士会巡视长廊；而地下酒窖似乎有一条通往钟塔内层的暗道。伊蕾娜托着腮看向你：“那么，雇主大人打算怎么行动呢？”', '2026-11-18 20:22:00'),
  msg('旅行者', true, '看了眼窗外渐沉的暮色，桌上摊开刚画好的钟塔草图，到了决定今夜潜入方案的时刻。', '2026-11-18 20:25:00'),
];

// 伊蕾娜 A线公共中段 (7~10楼：走地下暗道)
const elainaUnderground7to10 = [
  msg('旅行者', true, '“正面硬闯太蠢了，我们借口买陈年麦酒，悄悄摸进地下酒窖的暗道。”', '2026-11-19 21:00:00'),
  msg('伊蕾娜', false, '“明智的选择呢，我还以为你会热血上头拔剑冲上去。”伊蕾娜轻巧地打了个响指，杖尖亮起柔和的萤光，照亮了酒窖深处刻满古代符文的石门。', '2026-11-19 21:05:00'),
  msg('旅行者', true, '伸手按向符文凹槽，石门缓缓开启，里面是一座悬浮着无数记忆水晶的镜面回廊。', '2026-11-19 21:10:00'),
  msg('伊蕾娜', false, '回廊中央的祭坛上漂浮着沙漏状的星砂瓶，但一旦取下就会触发时间坍缩结界。伊蕾娜神色认真起来：“听好了，是要直接带走星砂，还是只用魔法拓印它的铭文？”', '2026-11-19 21:15:00'),
];

// 赛博侦探·零 公共主干 (1~4楼)
const zeroTrunk1to4 = [
  msg('零 (Zero)', false, '霓虹雨水顺着全息广告牌滑落，新京都第七区的暗巷里弥漫着臭氧与铁锈味。银发少女义眼闪过一道幽蓝的数据流：“死者脑机接口在断电前 0.3 秒曾向荒坂旧塔发送过一段加密脉冲。”', '2026-11-20 22:00:00'),
  msg('调查员', true, '蹲下身检查义体插槽：“能逆向追踪接收端的神经签名吗？”', '2026-11-20 22:03:00'),
  msg('零 (Zero)', false, '她将接入仓的数据线抛给你，声音冷静如冰：“防火墙是军用级黑冰，硬破会烧毁我的副脑，但现场还留着一枚带血的贵宾芯片，指向地下黑市‘夜莺酒吧’。”', '2026-11-20 22:06:00'),
  msg('调查员', true, '雨势渐大，警用浮空车的警笛声正在从三个街区外逼近。', '2026-11-20 22:09:00'),
];

// 林夏 公共主干 (1~4楼)
const linxiaTrunk1to4 = [
  msg('林夏', false, '盛夏傍晚的蝉鸣穿过教学楼走廊，林夏抱紧怀里的速写本，耳尖微红地站在天台门口：“喂，笨蛋，高考志愿表最后十分钟就要截止提交了……你真的填了北方的学校吗？”', '2026-11-15 17:30:00'),
  msg('陆鸣', true, '转过身看着被晚风吹起马尾的她：“那你呢？美术集训的时候不是一直说想去江南美院？”', '2026-11-15 17:33:00'),
  msg('林夏', false, '她咬了咬嘴唇，把揉皱又抚平的志愿草稿藏到身后：“我……我还没点确认键。只要你说一句话，我也可以改的。”', '2026-11-15 17:36:00'),
  msg('陆鸣', true, '夕阳把两人的影子拉得很长，手机屏幕上的倒计时还剩最后五分钟。', '2026-11-15 17:38:00'),
];

export const MOCK_CHARACTERS = [
  {
    id: 0,
    name: '伊蕾娜 · 灰之魔女',
    avatar: 'elaina_witch.png',
    avatarSrc: svgAvatar('#5b4b8a', '#2e294e', '🧙‍♀️', '伊蕾娜'),
    description: '漫游诸国的灰之魔女，贪财却温柔的旅途搭档',
    chat: '2026-11-23@18h20m_星砂拓印真结局',
  },
  {
    id: 1,
    name: '零 · 赛博黑客',
    avatar: 'zero_netrunner.png',
    avatarSrc: svgAvatar('#0f4c75', '#1b262c', '⚡', 'Zero'),
    description: '新京都第七区潜行黑客，义眼搭载军用级破译矩阵',
    chat: '2026-11-22@23h40m_夜莺酒吧潜入线',
  },
  {
    id: 2,
    name: '林夏 · 盛夏天台',
    avatar: 'linxia_summer.png',
    avatarSrc: svgAvatar('#d96b43', '#8c3b4a', '🌻', '林夏'),
    description: '相伴十年的青梅竹马，藏在速写本最后一页的心事',
    chat: '2026-11-21@19h15m_同城约定线',
  },
  {
    id: 3,
    name: '塞西莉亚 · 深渊圣女',
    avatar: 'cecilia_saint.png',
    avatarSrc: svgAvatar('#3a3d5c', '#191a29', '🕯️', '塞西莉亚'),
    description: '镇守裂隙大圣堂的盲眼圣女，手握银白荆棘戒律',
    chat: '2026-11-17@15h00m_初遇礼拜堂',
  },
];

export const MOCK_CHATS_BY_AVATAR = {
  'elaina_witch.png': [
    {
      file_name: '2026-11-18@20h10m_初入钟塔主干.jsonl',
      file_size: '14.2 KB',
      last_mes: '2026-11-18T20:25:00+08:00',
      lines: [
        { user_name: '旅行者', character_name: '伊蕾娜', create_date: '2026-11-18 20:10:00', chat_metadata: {} },
        ...elainaTrunk1to6,
      ],
    },
    {
      file_name: '2026-11-19@21h00m_酒窖暗道探索.jsonl',
      file_size: '28.6 KB',
      last_mes: '2026-11-19T21:15:00+08:00',
      lines: [
        {
          user_name: '旅行者',
          character_name: '伊蕾娜',
          create_date: '2026-11-19 21:00:00',
          chat_metadata: { main_chat: '2026-11-18@20h10m_初入钟塔主干' },
        },
        ...elainaTrunk1to6,
        ...elainaUnderground7to10,
      ],
    },
    {
      file_name: '2026-11-23@18h20m_星砂拓印真结局.jsonl',
      file_size: '46.8 KB',
      last_mes: '2026-11-23T18:20:00+08:00',
      lines: [
        {
          user_name: '旅行者',
          character_name: '伊蕾娜',
          create_date: '2026-11-23 18:00:00',
          chat_metadata: { main_chat: '2026-11-19@21h00m_酒窖暗道探索' },
        },
        ...elainaTrunk1to6,
        ...elainaUnderground7to10,
        msg('旅行者', true, '“贪婪会毁掉整座城镇的时间线。我们只拓印星砂铭文，让钟塔继续守护这里的居民吧。”', '2026-11-23 18:05:00'),
        msg('伊蕾娜', false, '灰发少女怔了一瞬，随即弯起眉眼，帽檐下的紫眸映出点点星辉：“真是个温柔的决定呢。作为奖励，明天的奶油烤面包我请客好啦。”', '2026-11-23 18:12:00'),
        msg('旅行者', true, '黎明破晓时分，两人骑上扫帚掠过苏醒的钟塔尖顶，向下一座国度飞去。', '2026-11-23 18:20:00'),
      ],
    },
    {
      file_name: '2026-11-20@23h50m_强夺星砂时间循环线.jsonl',
      file_size: '39.4 KB',
      last_mes: '2026-11-20T23:50:00+08:00',
      lines: [
        {
          user_name: '旅行者',
          character_name: '伊蕾娜',
          create_date: '2026-11-20 23:30:00',
          chat_metadata: { main_chat: '2026-11-19@21h00m_酒窖暗道探索' },
        },
        ...elainaTrunk1to6,
        ...elainaUnderground7to10,
        msg('旅行者', true, '一把抓起祭坛中央的星砂沙漏：“管不了那么多了，先拿到手再说！”', '2026-11-20 23:35:00'),
        msg('伊蕾娜', false, '“笨蛋，快松手——！”刺目的银光瞬间吞没了镜面回廊，耳畔再次传来熟悉的风声与麦浪声，时间被重置回了进城前的黄昏。', '2026-11-20 23:50:00'),
      ],
    },
    {
      file_name: '2026-11-19@22h40m_午夜正面硬闯钟塔线.jsonl',
      file_size: '31.1 KB',
      last_mes: '2026-11-19T22:40:00+08:00',
      lines: [
        {
          user_name: '旅行者',
          character_name: '伊蕾娜',
          create_date: '2026-11-19 22:15:00',
          chat_metadata: { main_chat: '2026-11-18@20h10m_初入钟塔主干' },
        },
        ...elainaTrunk1to6,
        msg('旅行者', true, '“既然守塔骑士午夜换岗，我们就趁钟声敲响时直接骑扫帚从高空破窗飞进顶层！”', '2026-11-19 22:20:00'),
        msg('伊蕾娜', false, '“哇哦，真够乱来的！高空风险补贴要加收五枚金币哦！”狂风呼啸间，无数防空魔导箭矢划破夜空，两人在钟摆齿轮间惊险穿梭。', '2026-11-19 22:40:00'),
      ],
    },
    {
      file_name: '2026-11-21@14h00m_平行开局_王都学院偶遇.jsonl',
      file_size: '19.5 KB',
      last_mes: '2026-11-21T14:15:00+08:00',
      lines: [
        { user_name: '旅行者', character_name: '伊蕾娜', create_date: '2026-11-21 14:00:00', chat_metadata: {} },
        msg('伊蕾娜', false, '王都魔导图书馆的顶层书架旁，灰之魔女正踮着脚尖够一本《古代星辰史》，帽子不小心滑落到了你的怀里。“啊，失礼了，能把魔女小姐最重要的帽子还给我吗？”', '2026-11-21 14:00:00'),
        msg('旅行者', true, '微笑着帮她拍掉帽檐上的灰尘递过去：“你也在查星辰魔法的古籍？”', '2026-11-21 14:08:00'),
        msg('伊蕾娜', false, '她接过帽子重新戴好，眼睛一亮：“看来遇到同行了呢，要不要一起拼桌喝杯红茶交流一下情报？”', '2026-11-21 14:15:00'),
      ],
    },
  ],

  'zero_netrunner.png': [
    {
      file_name: '2026-11-20@22h00m_暗巷案发现场.jsonl',
      file_size: '11.8 KB',
      last_mes: '2026-11-20T22:09:00+08:00',
      lines: [
        { user_name: '调查员', character_name: '零 (Zero)', create_date: '2026-11-20 22:00:00', chat_metadata: {} },
        ...zeroTrunk1to4,
      ],
    },
    {
      file_name: '2026-11-22@23h40m_夜莺酒吧潜入线.jsonl',
      file_size: '34.5 KB',
      last_mes: '2026-11-22T23:40:00+08:00',
      lines: [
        {
          user_name: '调查员',
          character_name: '零 (Zero)',
          create_date: '2026-11-22 23:10:00',
          chat_metadata: { main_chat: '2026-11-20@22h00m_暗巷案发现场' },
        },
        ...zeroTrunk1to4,
        msg('调查员', true, '拔下数据线收好贵宾芯片：“别拿你的副脑冒险，我们先撤去夜莺酒吧顺藤摸瓜。”', '2026-11-22 23:15:00'),
        msg('零 (Zero)', false, '零微微一怔，嘴角勾起极淡的弧度：“算你还有点人性。跟紧我，我知道一条避开NCPD无人机的排污通道。”', '2026-11-22 23:40:00'),
      ],
    },
    {
      file_name: '2026-11-21@01h20m_强行深潜黑冰线.jsonl',
      file_size: '27.9 KB',
      last_mes: '2026-11-21T01:20:00+08:00',
      lines: [
        {
          user_name: '调查员',
          character_name: '零 (Zero)',
          create_date: '2026-11-21 01:00:00',
          chat_metadata: { main_chat: '2026-11-20@22h00m_暗巷案发现场' },
        },
        ...zeroTrunk1to4,
        msg('调查员', true, '将自己的冷却回路并联到她的神经接口上：“我帮你分担算力负荷，现在直接黑进荒坂旧塔！”', '2026-11-21 01:05:00'),
        msg('零 (Zero)', false, '“疯子……抓稳意识锚点，深潜倒计时三秒！”猩红的数字矩阵瞬间淹没视野，旧塔深处的AI幽灵睁开了眼睛。', '2026-11-21 01:20:00'),
      ],
    },
  ],

  'linxia_summer.png': [
    {
      file_name: '2026-11-21@19h15m_同城约定线.jsonl',
      file_size: '25.2 KB',
      last_mes: '2026-11-21T19:15:00+08:00',
      lines: [
        { user_name: '陆鸣', character_name: '林夏', create_date: '2026-11-15 17:30:00', chat_metadata: {} },
        ...linxiaTrunk1to4,
        msg('陆鸣', true, '亮出手机屏幕递到她面前：“傻瓜，你看清楚第一志愿——我早就改成江南理工了，就在你们美院隔壁一条街。”', '2026-11-21 19:05:00'),
        msg('林夏', false, '林夏呆呆地看着屏幕，眼眶一下子红了，速写本啪嗒掉在地上，扑过来紧紧攥住你的校服袖口：“骗子……明明说好不许骗我的！”', '2026-11-21 19:15:00'),
      ],
    },
    {
      file_name: '2026-11-16@20h30m_异地四年重逢线.jsonl',
      file_size: '30.8 KB',
      last_mes: '2026-11-16T20:30:00+08:00',
      lines: [
        { user_name: '陆鸣', character_name: '林夏', create_date: '2026-11-16 20:00:00', chat_metadata: {} },
        ...linxiaTrunk1to4,
        msg('陆鸣', true, '轻轻揉了揉她的头发：“别为了我放弃你准备了三年的江南美院。一南一北不过四小时高铁，寒暑假我都去找你。”', '2026-11-16 20:10:00'),
        msg('林夏', false, '她吸了吸鼻子，用力点点头按下确认键，翻开速写本最后一页撕下来塞进你手心——上面画满了过去三年你上课打瞌睡的侧脸：“那这张画先押在你这，四年后我要连本带利收回来。”', '2026-11-16 20:30:00'),
      ],
    },
  ],

  'cecilia_saint.png': [
    {
      file_name: '2026-11-17@15h00m_初遇礼拜堂.jsonl',
      file_size: '16.0 KB',
      last_mes: '2026-11-17T15:10:00+08:00',
      lines: [
        { user_name: '灰烬骑士', character_name: '塞西莉亚', create_date: '2026-11-17 15:00:00', chat_metadata: {} },
        msg('塞西莉亚', false, '破碎的彩绘玻璃漏下苍白月光，蒙着白绸的圣女跪坐在祭坛前，耳畔微动：“您的铠甲上沾着深渊第三层的灰烬气息……是来请求净化，还是来取走封印钥匙的呢？”', '2026-11-17 15:00:00'),
        msg('灰烬骑士', true, '单膝跪在石阶下，将裂开的圣剑横于身前：“圣女殿下，边境防线还能撑三天，我需要借圣堂底层的古火重铸剑锋。”', '2026-11-17 15:10:00'),
      ],
    },
  ],
};

export const MOCK_DEFAULT_METADATA = {
  'elaina_witch.png::2026-11-23@18h20m_星砂拓印真结局': {
    starred: true,
    customTitle: '星砂拓印 · 温柔真结局',
    tags: ['主线', '高甜', 'HE'],
    note: '选择不强夺星砂只拓印铭文，好感度拉满，准备开启下一卷异国篇。',
    updatedAt: '2026-11-23T18:22:00+08:00',
  },
  'elaina_witch.png::2026-11-20@23h50m_强夺星砂时间循环线': {
    starred: false,
    customTitle: '强夺星砂 · 轮回BadEnd',
    tags: ['IF线', '时间循环'],
    note: '第10楼分叉强拿星砂触发了回档结界，适合用来刷隐藏对话。',
    updatedAt: '2026-11-20T23:55:00+08:00',
  },
  'elaina_witch.png::2026-11-19@22h40m_午夜正面硬闯钟塔线': {
    starred: true,
    customTitle: '空战强袭线 (待填坑)',
    tags: ['燃向', '待填坑'],
    note: '从第6楼直接骑扫帚破窗，打斗演出很精彩，周末接着往下推。',
    updatedAt: '2026-11-19T22:45:00+08:00',
  },
  'zero_netrunner.png::2026-11-22@23h40m_夜莺酒吧潜入线': {
    starred: true,
    customTitle: '夜莺酒吧稳健调查线',
    tags: ['主线', '赛博侦探'],
    note: '保住了零的副脑，信任度上升，刚进入地下排污通道。',
    updatedAt: '2026-11-22T23:45:00+08:00',
  },
  'linxia_summer.png::2026-11-21@19h15m_同城约定线': {
    starred: true,
    customTitle: '偷偷改志愿 · 同城纯爱线',
    tags: ['高甜', '纯爱'],
    note: '天台告白名场面存档！',
    updatedAt: '2026-11-21T19:20:00+08:00',
  },
};
