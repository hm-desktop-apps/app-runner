import './style.css';
import {Events} from '@wailsio/runtime';
import * as API from '../bindings/app-runner/launcherservice';
import {visibleApps, rankApps, recentApps, filterLibrary, filterKey, parseFilter, groupApps, categoryOf, relativeTime, statusOf} from './state';
import type {App, LibraryFilter, SortMode} from './state';
import {$, $$, escape, icons, tile, statusName, iconFailed} from './ui';
import * as detail from './detail';
import type {SettingsInfo, Theme} from './detail';

type Mode = 'command' | 'library';
interface Command {id: string; name: string; sub: string; note: string; key: string; icon: string; run: () => void}
interface AppItem {kind: 'app'; key: string; app: App}
interface CommandItem {kind: 'command'; key: string; command: Command}
type Item = AppItem | CommandItem;

let apps: App[] = [];
let libraryPath = '';
let mode: Mode = 'command';
let commandQuery = '';
let libraryQuery = '';
let sort: SortMode = 'recent';
let filter: LibraryFilter = {kind: 'all'};
let commandSelected = '';
let librarySelected = '';
let theme: Theme = 'light';
let autohide = false;
let busy = false;
let loading = false;
let libraryKey = '';
let toastTimer = 0;
let updateID = '';
const extraCategories = new Set<string>();

/* ---------- preferences ---------- */
function loadPreferences(): void {
 try {
  if (localStorage.getItem('app-runner-autohide') === '1') autohide = true;
  if (localStorage.getItem('app-runner-theme') === 'dark') theme = 'dark';
 } catch {}
 document.documentElement.dataset.theme = theme;
}
function saveTheme(value: Theme): void {try {localStorage.setItem('app-runner-theme', value);} catch {}}
function saveAutohide(value: boolean): void {try {localStorage.setItem('app-runner-autohide', value ? '1' : '0');} catch {}}
function loadLibraryPreferences(path: string): void {
 if (path === libraryKey) return;
 libraryKey = path;extraCategories.clear();
 try {
  const saved = JSON.parse(localStorage.getItem('app-runner-categories:' + path) || '{}');
  for (const name of saved.categories || []) if (typeof name === 'string' && name.trim() && name.trim() !== '未分类') extraCategories.add(name.trim());
 } catch {}
}
function saveCategories(): void {
 try {localStorage.setItem('app-runner-categories:' + libraryKey, JSON.stringify({categories: [...extraCategories]}));} catch {}
}
function categoryNames(): string[] {
 return groupApps(apps, '', 'name', extraCategories).map(group => group.category).filter(Boolean) as string[];
}
function updatable(): number {return apps.filter(app => (app.updater || []).length > 0).length;}
function currentApp(id = librarySelected): App | undefined {return apps.find(app => app.uuid === id);}

/* ---------- chrome ---------- */
function setTheme(value: Theme): void {
 theme = value;
 document.documentElement.dataset.theme = value;
 saveTheme(value);
 void API.SetTheme(value === 'dark').catch(console.error);
}
function setMode(next: Mode): void {
 mode = next;
 $('#cmd-view').classList.toggle('is-active', next === 'command');
 $('#lib-view').classList.toggle('is-active', next === 'library');
 if (next === 'library') renderLibrary();else {clearTimeout(tableTimer);tableTimer = 0;renderCommand();}
 setTimeout(focusSearch, 30);
}
function focusSearch(): void {
 if (detail.isOpen()) return;
 const input = (mode === 'command' ? $('#cmd-search') : $('#lib-search')) as HTMLInputElement;
 input.focus();input.select();
}
/** 窗口重新激活时清空命令中心的搜索，避免上次的输入残留；应用库保持原查询。 */
function clearSearch(): void {
 if (mode !== 'command' || !commandQuery) return;
 commandQuery = '';
 $<HTMLInputElement>('#cmd-search').value = '';
 renderCommand();
}
function setBusy(value: boolean, text = ''): void {
 busy = value;
 const activity = $('#activity');
 $('#activity-text').textContent = text;
 /* 顶部提示放在顶层：模态对话框的遮罩盖不住它，进度始终可读 */
 if (value && !activity.matches(':popover-open')) activity.showPopover();
 else if (!value && activity.matches(':popover-open')) activity.hidePopover();
 setDialogBusy(value);
 $<HTMLButtonElement>('#new-app').disabled = value || loading;
}
/** 忙碌期间把打开中的对话框控件设为禁用，结束后恢复它们原来的状态。 */
function setDialogBusy(value: boolean): void {
 for (const dialog of Array.from(document.querySelectorAll<HTMLDialogElement>(value ? 'dialog[open]' : 'dialog'))) {
  for (const control of Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea, button'))) {
   if (value) {
    if (!control.disabled) {control.dataset.busyDisabled = '1';control.disabled = true;}
   } else if (control.dataset.busyDisabled) {
    delete control.dataset.busyDisabled;
    control.disabled = false;
   }
  }
 }
}
/* 忙碌时不允许用 Esc 关闭对话框，进度和结果都要留在可见的位置 */
for (const dialog of Array.from(document.querySelectorAll<HTMLDialogElement>('dialog'))) {
 dialog.addEventListener('cancel', event => {if (busy) event.preventDefault();});
}
function showToast(message: string): void {
 const toast = $('#toast');
 toast.innerHTML = icons.check + '<span>' + escape(message) + '</span>';
 toast.classList.add('show');
 clearTimeout(toastTimer);
 toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2100);
}
async function perform<T>(action: () => PromiseLike<T>): Promise<T | undefined> {
 try {return await action();} catch (error) {await API.ShowError(error instanceof Error ? error.message : String(error)).catch(console.error);return undefined;}
}

/* ---------- command view ---------- */
const commands: Command[] = [
 {id: 'new', name: '新建应用…', sub: '从目录或压缩包导入', note: '分两步：先选来源，再确认名称与分类。导入后应用复制进库中，可随时编辑。', key: 'N', icon: icons.plus, run: () => detail.openCreate(sheetCtx)},
 {id: 'library', name: '打开应用库', sub: '浏览、搜索与管理所有应用', note: '分类筛选、状态过滤、批量操作与拖拽整理都在这边；按 Esc 或左上角箭头返回命令中心。', key: 'L', icon: icons.grid, run: () => setMode('library')},
 {id: 'refresh', name: '刷新应用库', sub: '重新扫描本地应用目录', note: '只读扫描，不会修改应用文件；重新读取每个 app.toml 并同步源与本地文件的变化。', key: 'F5', icon: icons.refresh, run: () => void refresh()},
 {id: 'settings', name: '设置', sub: '热键、启动与外观', note: '改动立即生效并写入配置，不需要重启应用。', key: ',', icon: icons.settings, run: () => detail.openSettings(sheetCtx)},
];
function commandItems(): Item[] {
 let query = commandQuery.trim();
 const commandsOnly = query.startsWith('>');
 if (commandsOnly) query = query.slice(1).trim();
 const needle = query.toLocaleLowerCase();
 const recent = recentApps(apps, 5);
 const appList = commandsOnly ? [] : (query ? rankApps(apps, query) : (recent.length ? recent : visibleApps(apps, '', 'name').slice(0, 5)));
 const commandList = commands.filter(command => !needle || (command.name + ' ' + command.sub).toLocaleLowerCase().includes(needle));
 const items: Item[] = [
  ...appList.map((app): AppItem => ({kind: 'app', key: 'app:' + app.uuid, app})),
  ...commandList.map((command): CommandItem => ({kind: 'command', key: 'command:' + command.id, command})),
 ];
 if (!items.some(item => item.key === commandSelected)) commandSelected = items[0]?.key || '';
 return items;
}
function resultRow(item: Item, selected: boolean): string {
 const active = selected ? ' selected' : '';
 if (item.kind === 'command') {
  return '<button type="button" class="result' + active + '" data-key="' + escape(item.key) + '" role="option" aria-selected="' + selected + '"><span class="cmd-icon">' + item.command.icon + '</span><span class="result-main"><span class="result-name">' + escape(item.command.name) + '</span><span class="result-sub">' + escape(item.command.sub) + '</span></span><span class="result-key">' + escape(item.command.key) + '</span></button>';
 }
 const app = item.app;
 const status = statusName(statusOf(app));
 return '<button type="button" class="result' + active + '" data-key="' + escape(item.key) + '" role="option" aria-selected="' + selected + '">' + tile(app) + '<span class="result-main"><span class="result-name">' + escape(app.title) + '</span><span class="result-sub">' + escape(categoryOf(app) || '未分类') + ' · ' + escape(app.type === 'GUI' ? '图形应用' : app.type === 'CLI' ? '命令行应用' : '待配置') + (status.tone === 'ok' ? '' : ' · ' + status.label) + '</span></span><span class="result-time">' + escape(relativeTime(app.lastUsed)) + '</span><span class="result-enter">↵</span></button>';
}
function renderCommand(): void {
 const items = commandItems();
 const query = commandQuery.trim(), commandsOnly = query.startsWith('>');
 const appItems = items.filter((item): item is AppItem => item.kind === 'app');
 const commandList = items.filter((item): item is CommandItem => item.kind === 'command');
 let html = '';
 if (appItems.length) {
  html += '<div class="cmd-group">' + (query ? '应用' : (recentApps(apps, 1).length ? '最近使用' : '全部应用')) + '</div>';
  html += appItems.map(item => resultRow(item, item.key === commandSelected)).join('');
 }
 if (commandList.length) {
  html += '<div class="cmd-group">命令</div>';
  html += commandList.map(item => resultRow(item, item.key === commandSelected)).join('');
 }
 if (!items.length) html = '<div class="cmd-empty">没有匹配“' + escape(commandsOnly ? query.slice(1).trim() : query) + '”<br>试试应用名称、分类、备注、入口，或用 > 前缀只搜命令。</div>';
 $('#cmd-results').innerHTML = html;
 renderPeek(items);
 $('#cmd-stats').innerHTML = '<b>' + apps.length + ' 个应用</b><span>·</span><span>' + updatable() + ' 个可更新</span>';
}
function syncCommandSelection(): void {
 for (const row of $$<HTMLElement>('#cmd-results .result')) {
  const active = row.dataset.key === commandSelected;
  row.classList.toggle('selected', active);
  row.setAttribute('aria-selected', String(active));
 }
 renderPeek(commandItems());
}
function renderPeek(items: Item[] = commandItems()): void {
 const box = $('#cmd-peek');
 const item = items.find(candidate => candidate.key === commandSelected);
 if (!item) {box.innerHTML = '<div class="cmd-empty">输入关键词开始搜索</div>';return;}
 if (item.kind === 'command') {
  box.innerHTML = '<div class="peek-command"><span class="cmd-icon">' + item.command.icon + '</span><h2>' + escape(item.command.name) + '</h2><p>' + escape(item.command.sub) + '</p><div class="peek-note"><span class="peek-note-title">说明</span>' + escape(item.command.note) + '</div></div><div class="peek-actions"><button type="button" class="btn primary" data-exec="' + escape(item.key) + '">执行</button></div>';
  bindPeekActions();
  return;
 }
 const app = item.app, status = statusName(statusOf(app));
 const runnable = app.entryValid && ['GUI','CLI'].includes(app.type);
 const chips = '<span class="chip">' + escape(categoryOf(app) || '未分类') + '</span><span class="chip ' + status.tone + '">' + status.label + '</span>' + (app.updater.length ? '<span class="chip update">可更新</span>' : '') + (app.runAsAdmin ? '<span class="chip">管理员</span>' : '');
 const update = app.updater.length ? '<button type="button" class="update-box" data-update="' + escape(app.uuid) + '">' + icons.update + '<b>已配置更新方式</b><span>安装更新 ›</span></button>' : '';
 const links = app.relatedLinks.filter(link => link.url.trim()).map(link => '<button type="button" class="peek-link" data-open-url="' + escape(link.url) + '"><span>' + escape(link.title || link.url) + '</span>' + icons.external + '</button>').join('');
 const linksBlock = links ? '<div class="peek-links"><span class="peek-note-title">相关链接</span>' + links + '</div>' : '';
 box.innerHTML = '<div class="peek-head">' + tile(app, 'large') + '<div class="peek-title"><h2>' + escape(app.title) + '</h2><div class="chips">' + chips + '</div></div></div>'
  + '<p class="peek-desc">' + (app.description ? escape(app.description) : '<span class="faint">还没有备注</span>') + '</p>'
  + linksBlock
  + update
  + '<div class="peek-meta"><div class="peek-row"><span>启动入口</span><span class="mono">' + escape(app.entry || '未填写') + '</span></div><div class="peek-row"><span>上次使用</span><span>' + escape(relativeTime(app.lastUsed)) + '</span></div><div class="peek-row"><span>更新时间</span><span>' + escape(app.modified ? new Date(app.modified).toLocaleDateString('zh-CN') : '未知') + '</span></div><div class="peek-row"><span>所在目录</span><span class="mono" title="' + escape(app.directory) + '">' + escape(app.directory.split(/[\\/]/).pop() || '') + '</span></div></div>'
  + '<div class="peek-actions"><button type="button" class="btn primary" data-run="' + escape(app.uuid) + '"' + (runnable ? '' : ' disabled') + '>' + icons.play + '运行</button><div class="btn-row"><button type="button" class="btn" data-edit="' + escape(app.uuid) + '">' + icons.edit + '编辑</button><button type="button" class="btn" data-dir="' + escape(app.uuid) + '">' + icons.folder + '目录</button></div></div>'
  + '<div class="peek-hint">↵ 运行 · E 编辑 · Esc 清空搜索</div>';
 bindPeekActions();
}
function bindPeekActions(): void {
 const box = $('#cmd-peek');
 box.querySelectorAll<HTMLElement>('[data-exec]').forEach(element => {
  element.onclick = () => execute(element.dataset.exec!);
 });
 box.querySelectorAll<HTMLElement>('[data-run]').forEach(element => {
  element.onclick = () => void launch(element.dataset.run!);
 });
 box.querySelectorAll<HTMLElement>('[data-edit]').forEach(element => {
  element.onclick = () => detail.openEdit(sheetCtx, element.dataset.edit!);
 });
 box.querySelectorAll<HTMLElement>('[data-dir]').forEach(element => {
  element.onclick = () => void perform(() => API.OpenDirectory(element.dataset.dir!));
 });
 box.querySelectorAll<HTMLElement>('[data-update]').forEach(element => {
  element.onclick = () => openUpdateDialog(element.dataset.update!);
 });
 box.querySelectorAll<HTMLElement>('[data-open-url]').forEach(element => {
  element.onclick = () => void perform(() => API.OpenLink(element.dataset.openUrl!));
 });
}
function moveCommandSelection(step: number): void {
 const items = commandItems();
 if (!items.length) return;
 const index = items.findIndex(item => item.key === commandSelected);
 const next = Math.max(0, Math.min(items.length - 1, index + step));
 commandSelected = items[next].key;
 syncCommandSelection();
 $$<HTMLElement>('#cmd-results .result.selected')[0]?.scrollIntoView({block: 'nearest'});
}
function execute(key: string): void {
 const item = commandItems().find(candidate => candidate.key === key);
 if (!item) return;
 if (item.kind === 'command') item.command.run();else void launch(item.app.uuid);
}

/* ---------- library view ---------- */
function filterItem(key: string, label: string, icon: string, count: number, current: boolean, category = false): string {
 return '<button type="button" class="filter-item' + (current ? ' active' : '') + '" data-filter="' + escape(key) + '" aria-pressed="' + current + '"' + (category ? ' draggable="false"' : '') + '>' + (category ? '<i class="fdot" style="--c:' + categoryTone(label) + '"></i>' : icon) + '<span>' + escape(label) + '</span><span class="count">' + count + '</span></button>';
}
function categoryTone(name: string): string {
 let hash = 0;
 for (const character of name) hash = (hash * 37 + character.codePointAt(0)!) % 360;
 return 'hsl(' + hash + ' 26% 52%)';
}
function renderFilters(): void {
 const active = filterKey(filter);
 const browsing = '<div class="filter-group"><div class="filter-title">浏览</div>'
  + filterItem('all', '全部应用', icons.grid, apps.length, active === 'all')
  + filterItem('recent', '最近使用', icons.clock, filterLibrary(apps, {kind: 'recent'}, '', 'name').length, active === 'recent')
  + filterItem('updatable', '可更新', icons.update, filterLibrary(apps, {kind: 'updatable'}, '', 'name').length, active === 'updatable')
  + '</div>';
 const names = categoryNames();
 const categories = '<div class="filter-group"><div class="filter-title">分类</div>'
  + names.map(name => filterItem('category:' + name, name, '', filterLibrary(apps, {kind: 'category', name}, '', 'name').length, active === 'category:' + name, true)).join('')
  + '<button type="button" class="filter-add" id="new-category">' + icons.plus + '新建分类</button></div>';
 $('#lib-filters').innerHTML = browsing + categories;
 for (const button of $$<HTMLElement>('#lib-filters [data-filter]')) {
  button.onclick = () => {filter = parseFilter(button.dataset.filter!);renderLibrary();};
  if (button.dataset.filter!.startsWith('category:')) {
   const name = button.dataset.filter!.slice('category:'.length);
   button.title = '右键编辑或删除分类';
   button.oncontextmenu = event => {event.preventDefault();openGroupEditor(name);};
   button.ondragover = event => {if (draggedID) {event.preventDefault();button.classList.add('drop-target');}};
   button.ondragleave = () => button.classList.remove('drop-target');
   button.ondrop = event => {
    event.preventDefault();
    button.classList.remove('drop-target');
    const id = draggedID || event.dataTransfer?.getData('text/plain') || '';
    if (id) void changeCategory(id, name);
   };
  }
 }
 const newCategory = $<HTMLButtonElement>('#new-category');
 newCategory.onclick = () => openCategoryDialog();
 newCategory.ondragover = event => {if (draggedID) {event.preventDefault();newCategory.classList.add('drop-target');}};
 newCategory.ondragleave = () => newCategory.classList.remove('drop-target');
 newCategory.ondrop = event => {
  event.preventDefault();
  newCategory.classList.remove('drop-target');
  const id = draggedID || event.dataTransfer?.getData('text/plain') || '';
  if (id) openCategoryDialog(id);
 };
}
let tableTimer = 0;
interface TableRow {node: HTMLTableRowElement; signature: string}
const tableRows = new Map<string, TableRow>();
function appRowHTML(app: App): string {
 const status = statusName(statusOf(app));
 return '<td><div class="cell-app">' + tile(app, '', true) + '<div class="cell-main"><span class="cell-name">' + escape(app.title) + '</span><span class="cell-type">' + escape(app.type === 'GUI' ? '图形应用' : app.type === 'CLI' ? '命令行应用' : '待配置') + (app.version ? ' · ' + escape(app.version) : '') + '</span></div></div></td>'
  + '<td><span class="cell-cat">' + escape(categoryOf(app) || '未分类') + '</span></td>'
  + '<td><span class="cell-time">' + escape(relativeTime(app.lastUsed)) + '</span></td>'
  + '<td><span class="status"><i class="dot ' + status.tone + '"></i>' + status.label + '</span></td>'
  + '<td><div class="row-actions"><button type="button" data-act="run" data-id="' + escape(app.uuid) + '" title="运行" aria-label="运行 ' + escape(app.title) + '">' + icons.play + '</button><button type="button" data-act="edit" data-id="' + escape(app.uuid) + '" title="编辑" aria-label="编辑 ' + escape(app.title) + '">' + icons.edit + '</button></div></td>';
}
function appRowSignature(app: App): string {
 const status = statusName(statusOf(app));
 return [app.title, categoryOf(app), app.type, app.version, app.iconURL || '', relativeTime(app.lastUsed), status.tone, status.label].join('|');
}
function renderTable(): void {
 clearTimeout(tableTimer);
 tableTimer = 0;
 const rows = filterLibrary(apps, filter, libraryQuery, sort);
 if (librarySelected && !rows.some(app => app.uuid === librarySelected)) librarySelected = '';
 $('#lib-count').textContent = rows.length + ' 个应用' + (libraryQuery.trim() ? ' · “' + libraryQuery.trim() + '”' : '');
 const body = $('#lib-table');
 const visible = new Set(rows.map(app => app.uuid));
 const known = new Set(apps.map(app => app.uuid));
 for (const [id, entry] of tableRows) {
  if (!known.has(id)) {entry.node.remove();tableRows.delete(id);continue;}
  if (!visible.has(id)) entry.node.remove();
 }
 body.querySelector('.table-empty')?.remove();
 if (!rows.length) {
  body.insertAdjacentHTML('beforeend', '<tr class="table-empty"><td colspan="5">没有匹配的应用<br>试试其他关键词或筛选条件。</td></tr>');
  syncTableSelection();
  return;
 }
 let cursor = body.firstElementChild;
 for (const app of rows) {
  let entry = tableRows.get(app.uuid);
  if (!entry) {
   const node = document.createElement('tr');
   node.dataset.id = app.uuid;
   node.draggable = true;
   entry = {node, signature: ''};
   tableRows.set(app.uuid, entry);
  }
  const signature = appRowSignature(app);
  if (entry.signature !== signature) {
   entry.node.innerHTML = appRowHTML(app);
   entry.signature = signature;
  }
  if (entry.node !== cursor) body.insertBefore(entry.node, cursor);
  cursor = entry.node.nextElementSibling;
 }
 syncTableSelection();
}
function scheduleTable(): void {
 clearTimeout(tableTimer);
 tableTimer = window.setTimeout(() => {tableTimer = 0;if (mode === 'library') renderTable();}, 150);
}
function syncTableSelection(): void {
 for (const row of $$<HTMLElement>('#lib-table tr[data-id]')) row.classList.toggle('selected', row.dataset.id === librarySelected);
 renderSelection();
}
function renderSelection(): void {
 const box = $('#lib-selection');
 const app = currentApp();
 box.classList.toggle('has', !!app);
 if (!app) {
  box.innerHTML = '<div class="sel-summary"><b>' + apps.length + ' 个应用</b><span>·</span><span>' + updatable() + ' 个可更新</span></div><div class="sel-hints"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 运行</span><span><kbd>E</kbd> 编辑</span><span><kbd>Esc</kbd> 返回</span></div>';
  return;
 }
 const status = statusName(statusOf(app));
 const runnable = app.entryValid && ['GUI','CLI'].includes(app.type);
 box.innerHTML = '<div class="sel-app">' + tile(app) + '<div class="sel-main"><span class="sel-kicker">已选择</span><span class="sel-name">' + escape(app.title) + '</span><span class="sel-meta">' + escape(categoryOf(app) || '未分类') + ' · ' + status.label + ' · ' + escape(relativeTime(app.lastUsed)) + '</span></div></div>'
  + '<div class="sel-actions">'
  + (app.updater.length ? '<button type="button" class="btn update" data-sel="update">' + icons.update + '更新</button>' : '')
  + '<button type="button" class="btn primary" data-sel="run"' + (runnable ? '' : ' disabled') + '>' + icons.play + '运行</button>'
  + '<button type="button" class="btn" data-sel="edit">' + icons.edit + '编辑</button>'
  + '<button type="button" class="btn" data-sel="dir">' + icons.folder + '目录</button></div>';
 for (const button of $$<HTMLElement>('#lib-selection [data-sel]')) {
  button.onclick = () => {
   switch (button.dataset.sel) {
    case 'run': void launch(app.uuid);break;
    case 'edit': detail.openEdit(sheetCtx, app.uuid);break;
    case 'dir': void perform(() => API.OpenDirectory(app.uuid));break;
    case 'update': openUpdateDialog(app.uuid);break;
   }
  };
 }
}
/** 应用库只在可见时渲染；命令视图期间的数据变更不重建隐藏的表格，进入库时按当前数据整表生成。 */
function renderLibrary(): void {
 if (mode !== 'library') return;
 renderFilters();
 renderTable();
}
function moveLibrarySelection(step: number): void {
 const rows = filterLibrary(apps, filter, libraryQuery, sort);
 if (!rows.length) return;
 const index = rows.findIndex(app => app.uuid === librarySelected);
 const next = rows[Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + step))];
 librarySelected = next.uuid;
 syncTableSelection();
 $$<HTMLElement>('#lib-table tr.selected')[0]?.scrollIntoView({block: 'nearest'});
}

/* ---------- data ---------- */
function replaceApp(saved: App): void {
 const index = apps.findIndex(app => app.uuid === saved.uuid);
 if (index >= 0) apps[index] = saved;else apps.push(saved);
}
async function refresh(): Promise<void> {
 if (busy || loading) return;
 loading = true;
 $<HTMLButtonElement>('#new-app').disabled = true;
 const data = await perform(() => API.Scan());
 if (data) {
  apps = (data.apps || []) as App[];
  libraryPath = data.library || '';
  loadLibraryPreferences(libraryPath);
  if (librarySelected && !currentApp()) librarySelected = '';
  renderCommand();renderLibrary();
  if (data.warnings?.length) await API.ShowError('应用库已加载，以下配置需要检查：\n' + data.warnings.join('\n'));
 }
 loading = false;
 $<HTMLButtonElement>('#new-app').disabled = false;
}
async function launch(id: string): Promise<void> {
 const app = currentApp(id);
 if (!app || busy || loading || !app.entryValid || !['GUI','CLI'].includes(app.type)) return;
 setBusy(true, '正在启动应用…');
 const started = await perform(() => API.Launch(id)) as App | undefined;
 if (started) {
  replaceApp(started);
  if (mode === 'command') renderCommand();else renderLibrary();
 }
 setBusy(false);
 if (started && autohide) await API.HideWindow().catch(console.error);
}
async function changeCategory(id: string, category: string): Promise<boolean> {
 if (busy || loading) return false;
 const app = currentApp(id);
 if (!app) return false;
 category = category.trim() === '未分类' ? '' : category.trim();
 if (categoryOf(app) === category) return true;
 setBusy(true, '正在保存分类…');
 const saved = await perform(() => API.SetCategory(id, category)) as App | undefined;
 if (saved) {
  replaceApp(saved);
  if (category) extraCategories.add(category);
  saveCategories();
  renderCommand();renderLibrary();
 }
 setBusy(false);
 return !!saved;
}

/* ---------- category dialogs ---------- */
let pendingCategoryApp = '';
let categoryCreated: ((name?: string) => void) | null = null;
function openCategoryDialog(id = '', onCreated?: (name?: string) => void): void {
 if (busy) {onCreated?.(undefined);return;}
 pendingCategoryApp = id;
 categoryCreated = onCreated || null;
 $('#category-dialog-message').textContent = id ? '将“' + (currentApp(id)?.title || '') + '”移入新分类' : '创建后可以在编辑面板里给应用指定分类';
 $('#category-dialog-error').textContent = '';
 $<HTMLInputElement>('#category-name').value = '';
 $<HTMLDialogElement>('#category-dialog').showModal();
 $('#category-name').focus();
}
$('#category-cancel').onclick = () => $<HTMLDialogElement>('#category-dialog').close();
$<HTMLDialogElement>('#category-dialog').addEventListener('close', () => {const created = categoryCreated;categoryCreated = null;created?.();});
$('#category-form').onsubmit = async event => {
 event.preventDefault();
 const name = $<HTMLInputElement>('#category-name').value.trim();
 if (!name || name === '未分类' || /[\r\n\0]/.test(name)) {$('#category-dialog-error').textContent = '请输入有效的分类名称；留空分类的应用会归入“未分类”';return;}
 const button = $<HTMLButtonElement>('#category-create');
 button.disabled = true;
 try {
  if (pendingCategoryApp && !await changeCategory(pendingCategoryApp, name)) {$('#category-dialog-error').textContent = '分类保存失败，请检查应用配置是否可写';return;}
  extraCategories.add(name);
  saveCategories();
  renderLibrary();
  const created = categoryCreated;categoryCreated = null;created?.(name);
  $<HTMLDialogElement>('#category-dialog').close();
 } finally {button.disabled = false;}
};
let editingCategory = '';
function openGroupEditor(name: string): void {
 if (!name || busy) return;
 editingCategory = name;
 $<HTMLInputElement>('#group-edit-name').value = name;
 $('#group-edit-summary').textContent = '“' + name + '”包含 ' + apps.filter(app => categoryOf(app) === name).length + ' 个应用';
 $('#group-edit-error').textContent = '';
 $<HTMLDialogElement>('#group-edit-dialog').showModal();
 const input = $<HTMLInputElement>('#group-edit-name');
 input.focus();input.select();
}
async function updateGroup(remove: boolean): Promise<void> {
 if (busy || !editingCategory) return;
 const oldName = editingCategory, name = $<HTMLInputElement>('#group-edit-name').value.trim();
 if (!remove) {
  if (!name || name === '未分类' || /[\r\n\0]/.test(name)) {$('#group-edit-error').textContent = '请输入有效的分类名称';return;}
  if (name === oldName) {$<HTMLDialogElement>('#group-edit-dialog').close();return;}
  if (categoryNames().includes(name)) {$('#group-edit-error').textContent = '分类名称已存在，请使用其他名称';return;}
 }
 setBusy(true, remove ? '正在删除分类…' : '正在重命名分类…');
 try {
  const changed = (remove ? await API.DeleteCategory(oldName) : await API.RenameCategory(oldName, name)) as App[];
  for (const app of changed || []) replaceApp(app);
  extraCategories.delete(oldName);
  if (!remove) extraCategories.add(name);
  if (filter.kind === 'category' && filter.name === oldName) filter = remove ? {kind: 'all'} : {kind: 'category', name};
  saveCategories();
  renderCommand();renderLibrary();
  $<HTMLDialogElement>('#group-edit-dialog').close();
 } catch (error) {
  $('#group-edit-error').textContent = error instanceof Error ? error.message : String(error);
 } finally {
  setBusy(false);
 }
}
$('#group-edit-form').onsubmit = event => {event.preventDefault();void updateGroup(false);};
$('#group-delete').onclick = () => void updateGroup(true);
$('#group-edit-cancel').onclick = () => $<HTMLDialogElement>('#group-edit-dialog').close();

/* ---------- update flow ---------- */
function openUpdateDialog(id: string): void {
 const app = currentApp(id);
 if (!app || busy || !app.updater.length) return;
 updateID = id;
 $<HTMLSelectElement>('#update-kind').value = 'archive';
 $<HTMLInputElement>('#update-source').value = '';
 $('#update-source-title').textContent = '更新“' + app.title + '”';
 $('#update-source-error').textContent = '';
 $('#update-source-fields').hidden = false;
 $('#update-source-actions').hidden = false;
 $('#update-result-actions').hidden = true;
 $<HTMLDialogElement>('#update-source-dialog').showModal();
}
$('#update-browse').onclick = async () => {
 const button = $<HTMLButtonElement>('#update-browse');
 button.disabled = true;
 try {
  const picked = await API.PickSource($<HTMLSelectElement>('#update-kind').value);
  if (picked) $<HTMLInputElement>('#update-source').value = picked;
 } catch (error) {$('#update-source-error').textContent = error instanceof Error ? error.message : String(error);}
 finally {button.disabled = false;}
};
$('#update-source-cancel').onclick = () => $<HTMLDialogElement>('#update-source-dialog').close();
$('#update-keep-backup').onclick = () => $<HTMLDialogElement>('#update-source-dialog').close();
$('#update-source-form').onsubmit = async event => {
 event.preventDefault();
 if (busy || loading) return;
 const source = $<HTMLInputElement>('#update-source').value.trim();
 if (!source) {$('#update-source-error').textContent = '请选择更新目录或压缩包';return;}
 $('#update-source-error').textContent = '';
 setBusy(true, '正在安装更新，请稍候…');
 try {
  const result = await API.Update(updateID, source);
  if (result) {
   replaceApp(result.app as App);
   renderCommand();renderLibrary();
   $('#update-source-title').textContent = '更新完成。备份保存在：' + result.backup;
   $('#update-source-fields').hidden = true;
   $('#update-source-actions').hidden = true;
   $('#update-result-actions').hidden = false;
  }
 } catch (error) {$('#update-source-error').textContent = error instanceof Error ? error.message : String(error);}
 finally {setBusy(false);}
};
$('#update-delete-backup').onclick = async () => {
 if (busy) return;
 setBusy(true, '正在删除备份…');
 try {
  await API.DeleteBackup(updateID);
  $<HTMLDialogElement>('#update-source-dialog').close();
 } catch (error) {$('#update-source-error').textContent = error instanceof Error ? error.message : String(error);}
 finally {setBusy(false);}
};

/* ---------- drag and drop ---------- */
let draggedID = '';
$('#lib-table').onmousedown = event => {
 const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
 draggedID = row && !(event.target as HTMLElement).closest('.row-actions') ? row.dataset.id! : '';
};
$('#lib-table').ondragstart = event => {
 const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
 if (!row) {event.preventDefault();return;}
 draggedID = row.dataset.id!;
 event.dataTransfer?.setData('text/plain', draggedID);
 if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
};
document.addEventListener('dragend', () => {draggedID = '';$$<HTMLElement>('.drop-target').forEach(element => element.classList.remove('drop-target'));});
document.addEventListener('dragover', event => {
 if (!draggedID) return;
 const target = (event.target as HTMLElement).closest<HTMLElement>('[data-filter^="category:"]');
 if (target) event.preventDefault();
});

/* ---------- sheet context ---------- */
const sheetCtx: detail.SheetContext = {
 apps: () => apps,
 categories: () => categoryNames(),
 newCategory: () => new Promise<string | undefined>(resolve => openCategoryDialog('', resolve)),
 library: () => libraryPath,
 settings: async () => await API.Settings() as unknown as SettingsInfo,
 theme: () => theme,
 setTheme: value => setTheme(value),
 autohide: () => autohide,
 setAutohide: value => {autohide = value;saveAutohide(value);},
 busy: (value, text) => setBusy(value, text),
 changed: saved => {replaceApp(saved);librarySelected = saved.uuid;renderCommand();renderLibrary();},
 created: created => {
  apps.push(created);
  if (categoryOf(created)) extraCategories.add(categoryOf(created));
  saveCategories();
  librarySelected = created.uuid;
  filter = {kind: 'all'};
  libraryQuery = '';
  $<HTMLInputElement>('#lib-search').value = '';
  setMode('library');
  renderCommand();renderLibrary();
 },
 isBusy: () => busy,
 toast: showToast,
 closed: () => focusSearch(),
 openUpdate: id => openUpdateDialog(id),
};

/* ---------- events ---------- */
const hideWindow = (): void => {void API.HideWindow().catch(console.error);};
$<HTMLButtonElement>('#cmd-close').onclick = hideWindow;
$<HTMLButtonElement>('#lib-close').onclick = hideWindow;

/* 失焦收起：只在命令中心生效；库视图、编辑面板、忙状态和弹窗期间保持窗口打开 */
let blurTimer = 0;
function scheduleAutoHide(): void {
 window.clearTimeout(blurTimer);
 blurTimer = window.setTimeout(() => {
  if (busy || detail.isOpen() || mode !== 'command') return;
  if (document.querySelector('dialog[open]')) return;
  hideWindow();
 }, 180);
}
window.addEventListener('blur', scheduleAutoHide);
window.addEventListener('focus', () => window.clearTimeout(blurTimer));
/* WebView2 的 DOM blur 偶尔会和原生激活状态失步，Go 侧在窗口失去激活时补发这条事件 */
Events.On('app-runner:window-lost-focus', scheduleAutoHide);

$('#new-app').onclick = () => detail.openCreate(sheetCtx);
$('#lib-back').onclick = () => {commandQuery = '';$<HTMLInputElement>('#cmd-search').value = '';setMode('command');};
$('#sheet-scrim').onclick = () => void detail.requestClose(sheetCtx);
$('#sheet-close').onclick = () => void detail.requestClose(sheetCtx);

$<HTMLInputElement>('#cmd-search').oninput = event => {
 commandQuery = (event.target as HTMLInputElement).value;
 renderCommand();
};
$<HTMLInputElement>('#cmd-search').onkeydown = event => {
 if (event.key === 'Enter' && !event.isComposing) {
  event.preventDefault();
  if (commandSelected) execute(commandSelected);
 }
};
$('#cmd-results').onclick = event => {
 const row = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
 if (!row) return;
 const key = row.dataset.key!;
 /* 命令项点击即执行，不再先选中再点“执行”；双击时只取第一次点击 */
 if (key.startsWith('command:')) {if (event.detail === 1) execute(key);return;}
 commandSelected = key;
 syncCommandSelection();
 $<HTMLInputElement>('#cmd-search').focus();
};
$('#cmd-results').ondblclick = event => {
 const row = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
 if (row && !row.dataset.key!.startsWith('command:')) execute(row.dataset.key!);
};
$<HTMLInputElement>('#lib-search').oninput = event => {
 libraryQuery = (event.target as HTMLInputElement).value;
 scheduleTable();
};
$<HTMLInputElement>('#lib-search').onkeydown = event => {
 if (event.key === 'Enter' && !event.isComposing) {
  event.preventDefault();
  if (tableTimer) renderTable();
  if (librarySelected) void launch(librarySelected);
 }
};
$<HTMLSelectElement>('#lib-sort').onchange = event => {
 sort = (event.target as HTMLSelectElement).value as SortMode;
 renderTable();
};
$('#lib-table').onclick = event => {
 const action = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
 if (action) {
  if (action.dataset.act === 'run') void launch(action.dataset.id!);else detail.openEdit(sheetCtx, action.dataset.id!);
  return;
 }
 const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
 if (row) {librarySelected = row.dataset.id!;syncTableSelection();}
};
$('#lib-table').ondblclick = event => {
 const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
 if (row) {librarySelected = row.dataset.id!;syncTableSelection();void launch(librarySelected);}
};

document.addEventListener('keydown', event => {
 const target = event.target as HTMLElement;
 if (document.querySelector('dialog[open]')) return;
 if (detail.handleKey(sheetCtx, event)) return;
 if (detail.isOpen() || busy) return;
 if (event.isComposing) return;
 const typing = target.matches('input,textarea,select') || target.isContentEditable;
 const modifier = event.ctrlKey || event.metaKey;
 if (modifier && event.key.toLowerCase() === 'k') {event.preventDefault();focusSearch();return;}
 if (modifier && event.key.toLowerCase() === 'f') {event.preventDefault();focusSearch();return;}
 if (event.key === 'F5') {event.preventDefault();void refresh();return;}
 if (event.key === 'Escape') {
  if (mode === 'command' && commandQuery) {commandQuery = '';$<HTMLInputElement>('#cmd-search').value = '';renderCommand();return;}
  if (mode === 'library' && libraryQuery) {libraryQuery = '';$<HTMLInputElement>('#lib-search').value = '';scheduleTable();return;}
  if (mode === 'library') {setMode('command');return;}
  void API.HideWindow().catch(console.error);
  return;
 }
 if (mode === 'command') {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
   if (typing && target.id !== 'cmd-search') return;
   event.preventDefault();moveCommandSelection(event.key === 'ArrowDown' ? 1 : -1);return;
  }
  if (event.key === 'Enter') {
   if (target.tagName === 'BUTTON') return;
   if (commandSelected && !typing) {event.preventDefault();execute(commandSelected);}
   return;
  }
  if (!typing && event.key.toLowerCase() === 'e') {
   const item = commandItems().find(candidate => candidate.key === commandSelected);
   if (item?.kind === 'app') {event.preventDefault();detail.openEdit(sheetCtx, item.app.uuid);}
   return;
  }
 } else {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
   if (typing && target.id !== 'lib-search') return;
   event.preventDefault();moveLibrarySelection(event.key === 'ArrowDown' ? 1 : -1);return;
  }
  if (event.key === 'Enter' && !typing && target.tagName !== 'BUTTON' && librarySelected) {event.preventDefault();void launch(librarySelected);return;}
  if (!typing && event.key.toLowerCase() === 'e' && librarySelected) {event.preventDefault();detail.openEdit(sheetCtx, librarySelected);return;}
 }
 if (!typing && !modifier && !event.altKey && event.key.length === 1) {
  const input = (mode === 'command' ? $('#cmd-search') : $('#lib-search')) as HTMLInputElement;
  input.focus();
  input.value += event.key;
  input.dispatchEvent(new Event('input'));
  event.preventDefault();
 }
});
window.addEventListener('focus', () => {
 if (detail.isOpen() || document.querySelector('dialog[open]')) return;
 clearSearch();
 focusSearch();
});

document.addEventListener('load', event => {
 const image = event.target;
 if (image instanceof HTMLImageElement && image.classList.contains('tile-icon')) image.parentElement?.classList.add('loaded');
}, true);
document.addEventListener('error', event => {
 const image = event.target;
 if (image instanceof HTMLImageElement && image.classList.contains('tile-icon')) {iconFailed(image.getAttribute('src') || '');image.hidden = true;image.parentElement?.classList.remove('loaded');}
}, true);

/* ---------- init ---------- */
loadPreferences();
setTheme(theme);
renderCommand();
void refresh().then(() => focusSearch());