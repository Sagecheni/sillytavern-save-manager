# 🌿 SillyTavern 全局存档与分支管理器 (Save & Branch Manager)

一个零编译依赖的 **SillyTavern（酒馆）纯前端扩展插件**，用于跨所有角色卡统一管理多个聊天存档、自动识别分叉楼层并绘制可交互的剧情故事线。

---

## ✨ 核心功能 (v0.1.0)

1. **全角色存档总览与检索**：一屏查看所有角色卡的存档数、星标数与最近游玩时间，支持按关键词检索角色名、分支别名、标签、备注与对话摘要。
2. **自动分叉时刻识别（混合算法）**：
   - 同时兼容酒馆官方 `Branch / Checkpoint`（`main_chat` 元数据）与手动复制存档（逐楼层最长公共前缀 `LCP` 哈希比对）。
   - 精准定位**分叉楼层（`#N 楼分叉`）**，并在阅读页展示**分叉前的共同剧情、本分支走向与同一楼层的其他走向**，点击即可切过去。
3. **故事线**：每个存档一行，走得最远的一条直行，其余分叉向右开出新轨道，选中存档回溯到开局的路径高亮显示。支持 ↑ ↓ 选择、Enter 继续、⌘/Ctrl K 搜索；明暗外观跟随酒馆主题，手机上自动变为逐级导航。
4. **分支备注、标签与全局星标库**：
   - 支持给难认的时间戳存档设置**自定义标题**、勾选快捷标签（`#主线`、`#高甜`、`#IF线`、`#待填坑` 等）与编写进度备注。
   - 数据自动写入酒馆后端的 `extensionSettings`，在 NAS / 远程酒馆上跨手机、电脑浏览器共享，不会丢失。
5. **跨角色一键跳转**：单击查看详情，双击存档或点击「继续」即可自动切换角色卡并加载对应存档。
6. **NAS / 大卡库友好性能**：采用并发限流 + 浏览器 `IndexedDB` 增量缓存楼层摘要，只有新增或变动过的 `.jsonl` 才会重新拉取解析。每次打开自动增量同步；需要全量重扫时，在扩展设置面板点「重新扫描」。

---

## 🖥️ 本地离线调试预览（无需连接酒馆）

由于你的酒馆运行在远程服务器 / NAS 上，本项目内置了完整的模拟数据与预览工作台 `preview.html`：

```bash
cd sillytavern-save-manager
npm run preview
```

然后在浏览器访问 **`http://localhost:8123/preview.html`** 即可直接体验完整交互！

运行分支算法单元测试：

```bash
npm test
```

---

## 🚀 安装到远程服务器 / NAS 上的 SillyTavern

### 方式一：通过 Git 仓库一键安装（最推荐，方便后续更新）
1. 将本项目推送到你的 GitHub / Gitee / 自建 Git 仓库。
2. 打开远程 SillyTavern 网页 ➔ 点击右上角 **扩展（Extensions，积木图标）** ➔ **安装扩展（Install Extension）**。
3. 填入你的 Git 仓库地址并点击安装，刷新网页即可。

### 方式二：直接上传文件夹到 NAS / Docker 酒馆目录
如果不走 Git 仓库，也可以直接通过 SMB / SFTP / 飞牛 / 群晖文件管理器将整个 `sillytavern-save-manager` 文件夹放入以下任一位置：

- **单用户安装（推荐，挂载在酒馆 `data` 持久化卷内，升级容器不丢失）**：
  ```text
  SillyTavern/data/<你的用户名，未开多用户时默认为 default-user>/extensions/sillytavern-save-manager/
  ```
- **全局所有用户可用**：
  ```text
  SillyTavern/public/scripts/extensions/third-party/sillytavern-save-manager/
  ```

刷新 SillyTavern 页面后，可通过以下任意入口呼出：
- 聊天输入框左侧 **🪄 魔法棒菜单** ➔ **「存档与分支」**
- 聊天输入框直接发送斜杠指令：**`/saves`** 或 **`/branches`**
- 右上角 **扩展管理面板** ➔ **「存档与分支」**

---

## 📂 目录结构

```text
sillytavern-save-manager/
├── manifest.json       # SillyTavern 扩展清单
├── index.js            # 酒馆入口挂载（魔法棒菜单、设置面板、/saves 指令）
├── style.css           # 独立命名空间 (.st-sbm-*) 样式，明暗跟随酒馆
├── preview.html        # 本地离线模拟酒馆预览调试台
├── src/
│   ├── adapter.js      # 酒馆 API / IndexedDB 缓存 / extensionSettings 同步适配层
│   ├── branchEngine.js # LCP 公共前缀分支检测与故事线布局引擎
│   ├── ui.js           # 角色 · 故事线 · 阅读页 三栏界面
│   └── mockData.js     # 多角色多层嵌套分支测试数据
└── tests/
    └── verify.mjs      # 分支树推导与防环测试脚本
```
