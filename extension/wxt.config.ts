import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // WXT 0.21 默认 srcDir 是项目根目录；显式指向 src/ 使 @ 别名解析到源码目录。
  srcDir: 'src',
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // 页面读取是产品核心功能（打开面板即读当前网页），故声明全部 http(s) 网站的主机权限，
    // 用户打开扩展即可用，无需逐站授权；上架时在权限理由中说明。
    // 模型服务端点权限仍在用户添加服务商时按 origin 单独申请（optional_host_permissions）。
    // alarms=定时任务唤醒；notifications=定时检查结果的本地系统通知。
    permissions: ['sidePanel', 'storage', 'scripting', 'downloads', 'alarms', 'notifications'],
    host_permissions: ['http://*/*', 'https://*/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        96: 'icon/96.png',
        128: 'icon/128.png',
      },
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
