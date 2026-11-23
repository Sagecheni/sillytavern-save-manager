/**
 * SillyTavern 扩展主入口 (index.js)
 * 挂载入口：
 * 1. 聊天输入框左侧魔法棒扩展菜单 (#extensionsMenu) -> "全局存档与分支大厅"
 * 2. 右上角扩展管理面板 (#extensions_settings2 / #extensions_settings)
 * 3. 斜杠命令 /saves 与 /branches
 */

import { SaveManagerAdapter } from './src/adapter.js';
import { SaveBranchManagerModal } from './src/ui.js';

const adapter = new SaveManagerAdapter();
const modal = new SaveBranchManagerModal(adapter);

function mountExtensionMenuButton() {
  if (document.getElementById('st_sbm_wand_btn')) return;

  const extensionsMenu = document.getElementById('extensionsMenu');
  if (extensionsMenu) {
    const item = document.createElement('div');
    item.id = 'st_sbm_wand_btn';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = '打开全局存档与分支大厅 (/saves)';
    item.innerHTML = `
      <div class="fa-solid fa-code-branch extensionsMenuExtensionButton"></div>
      <span>全局存档与分支大厅</span>
    `;
    item.addEventListener('click', () => modal.open());
    extensionsMenu.appendChild(item);
  }
}

function mountSettingsPanel() {
  if (document.getElementById('st_sbm_settings_block')) return;

  const container =
    document.getElementById('extensions_settings2') ||
    document.getElementById('extensions_settings');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'st_sbm_settings_block';
  wrapper.className = 'inline-drawer';
  wrapper.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🌿 全局存档与分支管理器</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="display:none; padding:8px 4px;">
      <p style="font-size:12.5px; opacity:0.85; margin:4px 0 10px;">
        跨角色卡汇总所有聊天存档、自动识别分叉楼层并绘制剧情分支树。你也可以在聊天框输入 <code>/saves</code> 快速呼出。
      </p>
      <div class="flex-container flexGap10">
        <div id="st_sbm_open_hall_btn" class="menu_button menu_button_icon interactable">
          <i class="fa-solid fa-sitemap"></i>
          <span>打开全局存档大厅</span>
        </div>
        <div id="st_sbm_clear_cache_btn" class="menu_button menu_button_icon interactable">
          <i class="fa-solid fa-broom"></i>
          <span>重建本地索引缓存</span>
        </div>
      </div>
    </div>
  `;

  container.appendChild(wrapper);

  wrapper.querySelector('#st_sbm_open_hall_btn')?.addEventListener('click', () => modal.open());
  wrapper.querySelector('#st_sbm_clear_cache_btn')?.addEventListener('click', async () => {
    await adapter.clearDigestCache();
    modal.showToast('已清空本地存档摘要缓存，下次打开将重新扫描');
  });
}

let slashRegistered = false;

function registerSlashCommands() {
  if (slashRegistered) return;
  const ctx = adapter.getContext();
  if (!ctx) return;

  if (ctx.SlashCommandParser?.addCommandObject && ctx.SlashCommand?.fromProps) {
    if (!ctx.SlashCommandParser.commands?.saves) {
      ctx.SlashCommandParser.addCommandObject(
        ctx.SlashCommand.fromProps({
          name: 'saves',
          aliases: ['branches'],
          callback: () => {
            modal.open();
            return '';
          },
          helpString: '打开全局存档与分支大厅',
        })
      );
    }
    slashRegistered = true;
    return;
  }

  if (typeof ctx.registerSlashCommand === 'function') {
    ctx.registerSlashCommand('saves', () => modal.open(), ['branches'], '打开全局存档与分支大厅', true, true);
    slashRegistered = true;
  }
}

function mountAllIntegrations() {
  mountExtensionMenuButton();
  mountSettingsPanel();
  registerSlashCommands();
}

function initExtension() {
  modal.mount();
  mountAllIntegrations();

  // 兼容酒馆异步初始化：在 APP_READY 时补挂载一次，防止远程/慢速网络下菜单容器晚于扩展渲染
  const ctx = adapter.getContext();
  if (ctx?.eventSource && ctx?.event_types?.APP_READY) {
    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
      mountAllIntegrations();
    });
  }

  // 暴露全局句柄便于调试与外部脚本联动
  window.STSaveBranchManager = {
    adapter,
    modal,
    open: () => modal.open(),
    close: () => modal.close(),
  };
}

if (typeof window !== 'undefined') {
  if (window.jQuery) {
    window.jQuery(() => initExtension());
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension);
  } else {
    initExtension();
  }
}

export { adapter, modal, initExtension };
