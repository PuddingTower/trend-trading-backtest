/** 双工作台入口：注入共享 shell，应用市场配置，再启动复盘应用。 */
import { MARKET_PROFILES, applyMarketProfile } from './marketProfiles.js';

const profile = MARKET_PROFILES[document.body.dataset.market];
const root = document.getElementById('app-root');

function fail(message) {
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'boot-error';
  box.textContent = message;
  root.appendChild(box);
}

if (!profile) {
  fail(`未知的工作台入口：${document.body.dataset.market || '(空)'}`);
  throw new Error(`unknown market: ${document.body.dataset.market}`);
}

try {
  const res = await fetch(new URL('./shell.html', import.meta.url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`shell.html 返回 ${res.status}`);
  root.innerHTML = await res.text();
  applyMarketProfile(profile);
  document.documentElement.dataset.market = profile.id;
  const { bootReplayApp } = await import('./replayApp.js');
  bootReplayApp(profile);
} catch (err) {
  fail(`工作台载入失败：${err && err.message ? err.message : err}`);
  throw err;
}
