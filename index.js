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
    item.title = '存档与分支 (/saves)';
    item.innerHTML = `
      <div class="fa-solid fa-code-branch extensionsMenuExtensionButton"></div>
      <span>存档与分支</span>
    `;
    item.addEventListener('click', () => modal.open());
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        modal.open();
      }
    });
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
      <b>存档与分支</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content" style="display:none; padding:8px 4px;">
      <div class="flex-container flexGap10">
        <div id="st_sbm_open_hall_btn" class="menu_button menu_button_icon interactable">
          <i class="fa-solid fa-code-branch"></i>
          <span>打开存档管理</span>
        </div>
        <div id="st_sbm_rescan_btn" class="menu_button menu_button_icon interactable">
          <i class="fa-solid fa-rotate-right"></i>
          <span>重新扫描</span>
        </div>
      </div>
    </div>
  `;

  container.appendChild(wrapper);

  wrapper.querySelector('#st_sbm_open_hall_btn')?.addEventListener('click', () => modal.open());
  wrapper.querySelector('#st_sbm_rescan_btn')?.addEventListener('click', () => modal.open({ rescan: true }));
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

let extensionInitialized = false;
let initInFlight = null;
let lifecycleListenersBound = false;

function attachHostLifecycleListeners() {
  if (lifecycleListenersBound) return;
  const ctx = adapter.getContext();
  const eventTypes = ctx?.eventTypes || ctx?.event_types;
  if (!ctx?.eventSource || typeof ctx.eventSource.on !== 'function' || !eventTypes) return;

  const onHostReadyEvent = () => {
    if (!extensionInitialized) {
      void initExtension().catch((err) => {
        console.error('[SaveManager] 宿主事件恢复初始化失败:', err);
      });
      return;
    }
    mountAllIntegrations();
    adapter.bindSillyTavernEvents();
    modal.installTauriBackHandler?.();
  };

  const readyEvents = Array.from(new Set([eventTypes.APP_READY, eventTypes.EXTENSION_SETTINGS_LOADED].filter(Boolean)));
  for (const evt of readyEvents) {
    ctx.eventSource.on(evt, onHostReadyEvent);
  }
  if (readyEvents.length > 0) {
    lifecycleListenersBound = true;
  }
}

function initExtension() {
  // 独立于首次启动成功与否预先挂载生命周期恢复监听，以便首次 ready 拒绝后宿主补发 APP_READY 时可自动恢复
  attachHostLifecycleListeners();
  if (extensionInitialized) return Promise.resolve();
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    // 在 TauriTavern 环境中等待宿主内核与拦截路由就绪；若宿主就绪失败则向上传播，不挂载半残入口
    await adapter.waitForHostReady();

    modal.mount();
    mountAllIntegrations();
    adapter.bindSillyTavernEvents();
    attachHostLifecycleListeners();

    // 暴露全局句柄便于调试与外部脚本联动
    window.STSaveBranchManager = {
      adapter,
      modal,
      open: () => modal.open(),
      close: () => modal.close(),
    };

    extensionInitialized = true;
  })().finally(() => {
    initInFlight = null;
  });

  return initInFlight;
}

if (typeof window !== 'undefined') {
  const start = () => {
    void initExtension().catch((err) => {
      console.error('[SaveManager] 初始化失败:', err);
    });
  };
  if (window.jQuery) {
    window.jQuery(start);
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

export { adapter, modal, initExtension };
