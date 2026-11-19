const host = 'com.youdub2bi.youtube_sync';
const alarm = 'youtube-sync';
const domains = new Set(['youtube.com', '.youtube.com', 'www.youtube.com', '.www.youtube.com']);
const login = new Set(['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', 'SID', '__Secure-1PSID', '__Secure-3PSID']);
let pending;

async function badge(text, title) {
  await chrome.action.setBadgeText({text});
  await chrome.action.setTitle({title: `You2Bi：${title}（点击启用或暂停）`});
}

async function sync() {
  if (pending) return pending;
  pending = (async () => {
    try {
      if (!(await chrome.storage.local.get('enabled')).enabled) return;
      const stores = await chrome.cookies.getAllCookieStores();
      const store = stores.find(({id}) => id === '0');
      const cookies = store ? (await chrome.cookies.getAll({domain: 'youtube.com', storeId: store.id}))
        .filter(c => domains.has(c.domain) && !c.partitionKey) : [];
      if (!cookies.some(c => login.has(c.name) && c.value)) {
        await badge('登录', '请在此 Edge 配置中登录 YouTube');
        return;
      }
      const lines = cookies.map(c => [c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path, c.secure ? 'TRUE' : 'FALSE', Math.floor(c.expirationDate || 0), c.name, c.value].join('\t')).sort();
      if (!(await chrome.storage.local.get('enabled')).enabled) return;
      const result = await chrome.runtime.sendNativeMessage(host, {
        cookies: '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n',
      });
      if ((await chrome.storage.local.get('enabled')).enabled) {
        await badge(result?.ok ? 'OK' : '!', result?.ok ? '已同步' : '本机同步失败');
      }
    } catch {
      if ((await chrome.storage.local.get('enabled')).enabled) await badge('!', '无法连接本机同步程序');
    }
  })().finally(() => { pending = undefined; });
  return pending;
}

async function start() {
  if (!(await chrome.storage.local.get('enabled')).enabled) return;
  await chrome.alarms.create(alarm, {periodInMinutes: 5});
  await sync();
}

chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
chrome.action.onClicked.addListener(async () => {
  const enabled = !(await chrome.storage.local.get('enabled')).enabled;
  await chrome.storage.local.set({enabled});
  if (enabled) await start();
  else {
    await chrome.alarms.clear(alarm);
    await badge('', '同步已暂停');
  }
});
chrome.alarms.onAlarm.addListener(({name}) => {
  if (name === alarm) sync();
});
chrome.cookies.onChanged.addListener(({cookie}) => {
  if (domains.has(cookie.domain) && !cookie.partitionKey && cookie.storeId === '0') sync();
});
