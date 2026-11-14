import * as API from '../bindings/app-runner/launcherservice';
import {profileOf, validation, suggestedAppName, categoryOf, statusOf} from './state';
import type {App, Profile, NewAppInfo, Link} from './state';
import {$ , escape, icons, tile, statusName} from './ui';

export type Theme = 'light' | 'dark';
export interface SettingsInfo {hotkey: string; hotkeyError: string; library: string}
export interface SheetContext {
 apps(): App[];
 categories(): string[];
 newCategory(): Promise<string | undefined>;
 library(): string;
 settings(): Promise<SettingsInfo>;
 theme(): Theme;
 setTheme(value: Theme): void;
 autohide(): boolean;
 setAutohide(value: boolean): void;
 busy(value: boolean, text?: string): void;
 isBusy(): boolean;
 changed(app: App): void;
 created(app: App): void;
 toast(message: string): void;
 closed(): void;
 openUpdate(id: string): void;
}

type SheetName = 'edit' | 'create' | 'settings';
type EditTab = 'basic' | 'links' | 'update';
let open: SheetName | null = null;
let editingId = '';
let draft: Profile | null = null;
let baseline = '';
let tab: EditTab = 'basic';
let createStep = 1;
let createKind = 'directory';
let createSource = '';
let createName = '';
let createNameEdited = false;
let pendingNew: NewAppInfo | null = null;
let newEntryValid = false;
let entryRequest = 0;
let entryTimer = 0;
let settingsInfo: SettingsInfo | null = null;

export const isOpen = (): boolean => open !== null;
const current = (ctx: SheetContext): App | undefined => ctx.apps().find(app => app.uuid === editingId);
const dirty = (): boolean => !!draft && JSON.stringify(draft) !== baseline;

const newCategoryOption = '__new-category__';
function categorySelect(id: string, value: string, ctx: SheetContext): string {
 const names = ctx.categories();
 const options = names.map(name => '<option value="' + escape(name) + '"' + (name === value ? ' selected' : '') + '>' + escape(name) + '</option>');
 if (value && !names.includes(value)) options.push('<option value="' + escape(value) + '" selected>' + escape(value) + '</option>');
 return '<select id="' + id + '"><option value=""' + (value ? '' : ' selected') + '>未分类</option>' + options.join('') + '<option value="' + newCategoryOption + '">＋ 新建分类…</option></select>';
}
/** 选择已有分类，或通过“新建分类…”创建后就地选中；取消时回到原分类。 */
async function chooseCategory(select: HTMLSelectElement, ctx: SheetContext, previous: string): Promise<string> {
 if (select.value !== newCategoryOption) return select.value;
 const name = await ctx.newCategory();
 if (!name) {select.value = previous;return previous;}
 if (!Array.from(select.options).some(option => option.value === name)) {
  select.insertBefore(new Option(name, name), select.querySelector('option[value="' + newCategoryOption + '"]'));
 }
 select.value = name;
 return name;
}
function layer(openit: boolean): void {
 const layer = $('#sheet-layer');
 layer.classList.toggle('open', openit);
 layer.setAttribute('aria-hidden', openit ? 'false' : 'true');
}
function head(title: string, sub: string, wide = false): void {
 $('#sheet-title').textContent = title;
 $('#sheet-sub').textContent = sub;
 $('#sheet').className = 'sheet' + (wide ? ' wide' : '');
}

/* ---------- edit ---------- */
export function openEdit(ctx: SheetContext, id: string): void {
 const app = ctx.apps().find(item => item.uuid === id);
 if (!app) return;
 open = 'edit';editingId = id;draft = profileOf(app);baseline = JSON.stringify(draft);tab = 'basic';newEntryValid = true;
 layer(true);render(ctx);
 setTimeout(() => {const field = document.getElementById('edit-title');field?.focus({preventScroll: true});if (field instanceof HTMLInputElement) field.select();}, 60);
}

function renderEdit(ctx: SheetContext): void {
 const app = current(ctx);if (!app || !draft) return;
 head('编辑应用', app.title);
 const status = statusName(statusOf(app));
 const body = '<div class="sheet-app">' + tile(app) + '<div><strong>' + escape(app.title) + '</strong><span>' + escape(categoryOf(app) || '未分类') + ' · ' + escape(app.type === 'GUI' ? '图形应用' : app.type === 'CLI' ? '命令行应用' : '待配置') + '</span></div><span class="chip ' + status.tone + '">' + status.label + '</span></div>'
  + '<div class="tabs" role="tablist">'
  + '<button type="button" class="tab' + (tab === 'basic' ? ' active' : '') + '" data-tab="basic" role="tab" aria-selected="' + (tab === 'basic') + '">基本信息</button>'
  + '<button type="button" class="tab' + (tab === 'links' ? ' active' : '') + '" data-tab="links" role="tab" aria-selected="' + (tab === 'links') + '">相关链接</button>'
  + '<button type="button" class="tab' + (tab === 'update' ? ' active' : '') + '" data-tab="update" role="tab" aria-selected="' + (tab === 'update') + '">更新方式</button></div>'
  + '<div id="sheet-tab">' + (tab === 'basic' ? basicHTML(ctx) : tab === 'links' ? linksHTML() : updateHTML(ctx)) + '</div>';
 $('#sheet-body').innerHTML = body;
 $('#sheet-foot').innerHTML = '<span class="sheet-state" id="sheet-state"></span><div class="sheet-actions"><button type="button" class="btn" id="sheet-cancel">取消</button><button type="button" class="btn primary" id="sheet-save">保存</button></div>';
 wireTabs(ctx);
 if (tab === 'basic') wireBasic(ctx);else if (tab === 'links') wireLinks(ctx);else wireUpdate(ctx);
 $('#sheet-cancel').onclick = () => void requestClose(ctx);
 $('#sheet-save').onclick = () => void save(ctx);
 updateEditStatus();
 if (tab === 'basic') scheduleEntryCheck(ctx);
}

function basicHTML(ctx: SheetContext): string {
 const data = draft!;
 return '<div class="field"><label for="edit-title">应用名称</label><input id="edit-title" value="' + escape(data.title) + '" autocomplete="off"></div>'
  + '<div class="field"><label for="edit-category">分类</label>' + categorySelect('edit-category', data.category, ctx) + '</div>'
  + '<div class="field"><label for="edit-type">应用类型</label><select id="edit-type"><option value="">请选择类型</option><option value="GUI"' + (data.type === 'GUI' ? ' selected' : '') + '>图形应用</option><option value="CLI"' + (data.type === 'CLI' ? ' selected' : '') + '>命令行应用</option></select></div>'
  + '<div class="field"><label for="edit-entry">启动入口</label><input id="edit-entry" value="' + escape(data.entry) + '" placeholder="app.exe 或 re:正则表达式" autocomplete="off" spellcheck="false"><small id="edit-entry-hint"></small></div>'
  + '<div class="field"><label for="edit-description">备注</label><textarea id="edit-description" rows="3" placeholder="自由备注、使用提示或待办事项">' + escape(data.description) + '</textarea></div>'
  + '<label class="check"><input type="checkbox" id="edit-admin"' + (data.runAsAdmin ? ' checked' : '') + '><span>以管理员身份运行</span></label>'
  + '<div class="sheet-links"><button type="button" class="btn small" id="edit-open-dir">' + icons.folder + '打开应用目录</button><button type="button" class="btn small" id="edit-profile">' + icons.external + '编辑 app.toml</button></div>';
}
function linkCard(link: Link, index: number): string {
 return '<div class="link-card"><div class="link-fields">'
  + '<input class="link-title" data-link="' + index + '" data-key="title" value="' + escape(link.title) + '" placeholder="链接名称" aria-label="链接名称 ' + (index + 1) + '" autocomplete="off" spellcheck="false">'
  + '<input class="link-url" data-link="' + index + '" data-key="url" value="' + escape(link.url) + '" placeholder="https://" aria-label="链接地址 ' + (index + 1) + '" autocomplete="off" spellcheck="false">'
  + '</div><div class="link-actions">'
  + '<button type="button" class="link-act" data-open-link="' + index + '" title="打开链接" aria-label="打开链接 ' + (index + 1) + '"' + (link.url.trim() ? '' : ' disabled') + '>' + icons.external + '</button>'
  + '<button type="button" class="link-act delete" data-remove-link="' + index + '" title="删除链接" aria-label="删除链接 ' + (index + 1) + '">' + icons.close + '</button>'
  + '</div></div>';
}
function linksHTML(): string {
 const links = draft!.relatedLinks;
 if (!links.length) {
  return '<button type="button" class="list-add wide" id="add-link">' + icons.plus + '<b>添加相关链接</b><span>官网、下载页或使用文档等地址</span></button>';
 }
 return '<p class="link-hint">官网、下载页或使用文档等外部地址。</p>'
  + '<div class="link-list">' + links.map(linkCard).join('') + '</div>'
  + '<button type="button" class="list-add" id="add-link">' + icons.plus + '添加链接</button>';
}
function updateHTML(ctx: SheetContext): string {
 const updaters = draft!.updater;
 const hint = '<p class="hint">操作按顺序执行；每次安装前自动完整备份至 content.bak。<br>固定文件/目录：清空时保留指定相对路径；清空目录：删除未固定的内容；解包安装包：把 ZIP / 7z 或目录内容安装到 content。</p>';
 if (!updaters.length) {
  return '<button type="button" class="list-add wide" id="add-updater">' + icons.plus + '<b>添加更新操作</b><span>安装更新包时按顺序执行</span></button>' + hint;
 }
 return '<div class="rows">' + updaters.map((command, index) => {
  const colon = command.indexOf(':'), action = colon < 0 ? command.trim() : command.slice(0, colon).trim(), parameter = colon < 0 ? '' : command.slice(colon + 1);
  const known = ['PIN','RMC','UNPKG'].includes(action);
  return '<div class="row-item" data-row="' + index + '"><span class="step">' + (index + 1) + '</span><select aria-label="更新操作 ' + (index + 1) + '" data-action="' + index + '">' + (known ? '' : '<option value="' + escape(action) + '">' + escape(action || '请选择') + '</option>') + '<option value="PIN"' + (action === 'PIN' ? ' selected' : '') + '>固定文件/目录</option><option value="RMC"' + (action === 'RMC' ? ' selected' : '') + '>清空目录</option><option value="UNPKG"' + (action === 'UNPKG' ? ' selected' : '') + '>解包安装包</option></select><input aria-label="更新参数 ' + (index + 1) + '" data-param="' + index + '" value="' + escape(parameter) + '" placeholder="' + (action === 'PIN' ? '相对于 content 的路径' : '无需参数') + '"' + (action === 'PIN' ? '' : ' disabled') + '><button type="button" class="row-btn delete" data-remove-action="' + index + '" title="删除操作" aria-label="删除操作 ' + (index + 1) + '">' + icons.close + '</button></div>';
  }).join('') + '</div>'
  + '<button type="button" class="list-add" id="add-updater">' + icons.plus + '添加操作</button>'
  + hint
  + '<div class="sheet-footer-note"><button type="button" class="btn" id="sheet-update"' + ((ctx.apps().find(app => app.uuid === editingId)?.updater.length) ? '' : ' disabled') + '>安装更新…</button></div>';
}

function wireTabs(ctx: SheetContext): void {
 for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#sheet-body [data-tab]'))) {
  button.onclick = () => {tab = button.dataset.tab as EditTab;renderEdit(ctx);};
 }
}
function wireBasic(ctx: SheetContext): void {
 const title = $<HTMLInputElement>('#edit-title'), category = $<HTMLSelectElement>('#edit-category'), type = $<HTMLSelectElement>('#edit-type');
 const entry = $<HTMLInputElement>('#edit-entry'), description = $<HTMLTextAreaElement>('#edit-description'), admin = $<HTMLInputElement>('#edit-admin');
 title.oninput = () => {draft!.title = title.value;updateEditStatus();};
 category.onchange = async () => {draft!.category = await chooseCategory(category, ctx, draft!.category);updateEditStatus();};
 type.onchange = () => {draft!.type = type.value;updateEditStatus();};
 entry.oninput = () => {draft!.entry = entry.value;updateEditStatus();scheduleEntryCheck(ctx);};
 description.oninput = () => {draft!.description = description.value;updateEditStatus();};
 admin.onchange = () => {draft!.runAsAdmin = admin.checked;updateEditStatus();};
 $('#edit-open-dir').onclick = () => void API.OpenDirectory(editingId).catch(error => ctx.toast(String(error instanceof Error ? error.message : error)));
 $('#edit-profile').onclick = () => void API.EditProfile(editingId).catch(error => ctx.toast(String(error instanceof Error ? error.message : error)));
}
function wireLinks(ctx: SheetContext): void {
 $('#add-link').onclick = () => {
  draft!.relatedLinks.push({title:'', url:''});
  renderEdit(ctx);
  document.querySelector<HTMLInputElement>('#sheet-body [data-link="' + (draft!.relatedLinks.length - 1) + '"][data-key="title"]')?.focus();
 };
 for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('#sheet-body [data-link]'))) {
  input.oninput = () => {const link = draft!.relatedLinks[Number(input.dataset.link)];link[input.dataset.key as 'title' | 'url'] = input.value;updateEditStatus();};
  /* 地址只写域名时补齐协议，和 OpenLink 的容错保持一致 */
  if (input.dataset.key === 'url') input.onchange = () => {
   const value = input.value.trim(), normalized = value && !value.includes('://') ? 'https://' + value : value;
   if (normalized !== input.value) input.value = normalized;
   draft!.relatedLinks[Number(input.dataset.link)].url = normalized;
   const open = document.querySelector<HTMLButtonElement>('#sheet-body [data-open-link="' + input.dataset.link + '"]');
   if (open) open.disabled = !normalized;
   updateEditStatus();
  };
 }
 for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#sheet-body [data-open-link]'))) {
  button.onclick = () => {const link = draft!.relatedLinks[Number(button.dataset.openLink)];void API.OpenLink(link.url).catch(error => ctx.toast(String(error instanceof Error ? error.message : error)));};
 }
 for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#sheet-body [data-remove-link]'))) {
  button.onclick = () => {draft!.relatedLinks.splice(Number(button.dataset.removeLink), 1);renderEdit(ctx);};
 }
 for (const card of Array.from(document.querySelectorAll<HTMLElement>('#sheet-body .link-card'))) {
  card.onclick = event => {
   if ((event.target as HTMLElement).closest('input,button')) return;
   card.querySelector<HTMLInputElement>('.link-title')?.focus();
  };
 }
}
function wireUpdate(ctx: SheetContext): void {
 $('#add-updater').onclick = () => {draft!.updater.push('RMC');renderEdit(ctx);};
 const update = document.getElementById('sheet-update');
 if (update) {
  const id = editingId;
  update.onclick = () => {void requestClose(ctx).then(closed => {if (closed) ctx.openUpdate(id);});};
 }
 for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>('#sheet-body [data-action]'))) {
  select.onchange = () => {draft!.updater[Number(select.dataset.action)] = select.value + (select.value === 'PIN' ? ':' : '');renderEdit(ctx);};
 }
 for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('#sheet-body [data-param]'))) {
  input.oninput = () => {draft!.updater[Number(input.dataset.param)] = 'PIN:' + input.value;updateEditStatus();};
 }
 for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#sheet-body [data-remove-action]'))) {
  button.onclick = () => {draft!.updater.splice(Number(button.dataset.removeAction), 1);renderEdit(ctx);};
 }
}

function updateEditStatus(): void {
 const state = document.getElementById('sheet-state'), save = document.getElementById('sheet-save');
 if (!state || !save) return;
 const error = draft ? validation(draft) : '';
 const changed = dirty();
 state.textContent = error || (changed ? '有未保存的更改' : '所有更改已保存');
 state.classList.toggle('dirty', !error && changed);
 state.classList.toggle('error', !!error);
 (save as HTMLButtonElement).disabled = !changed || !!error;
}
function scheduleEntryCheck(ctx: SheetContext): void {
 clearTimeout(entryTimer);
 entryTimer = window.setTimeout(() => void checkEntry(ctx), 200);
}
async function checkEntry(ctx: SheetContext): Promise<void> {
 clearTimeout(entryTimer);
 const field = document.getElementById('edit-entry') as HTMLInputElement | null;
 const hint = document.getElementById('edit-entry-hint');
 if (!field || !hint || !draft) return;
 const request = ++entryRequest, value = draft.entry;
 if (!value.trim()) {field.classList.remove('invalid');hint.textContent = '入口相对于 content 目录；支持 re: 正则匹配文件名';return;}
 const valid = await API.CheckEntry(editingId, value).catch(() => false);
 if (request !== entryRequest) return;
 field.classList.toggle('invalid', !valid);
 hint.textContent = valid ? '入口有效：相对于 content 目录，支持 re: 正则匹配文件名' : '未找到入口文件。可以先保存配置，文件就绪后按 F5 刷新。';
}
async function save(ctx: SheetContext): Promise<void> {
 if (ctx.isBusy() || !draft || !dirty() || validation(draft)) return;
 /* 没有地址的链接无法打开，不落盘；首尾空格顺手清掉 */
 draft.relatedLinks = draft.relatedLinks.map(link => ({title: link.title.trim(), url: link.url.trim()})).filter(link => link.url);
 ctx.busy(true, '正在保存配置…');
 let failure = '';
 try {
  const saved = await API.Save(editingId, draft) as App;
  ctx.changed(saved);open = null;layer(false);ctx.busy(false);ctx.closed();ctx.toast('已保存 ' + saved.title);
 } catch (error) {
  failure = error instanceof Error ? error.message : String(error);
 } finally {
  ctx.busy(false);
  if (failure) {const state = document.getElementById('sheet-state');if (state) {state.textContent = failure;state.classList.add('error');}}
 }
}

/* ---------- create ---------- */
export function openCreate(ctx: SheetContext): void {
 open = 'create';createStep = 1;createKind = 'directory';createSource = '';createName = '';createNameEdited = false;pendingNew = null;newEntryValid = false;
 layer(true);render(ctx);
 setTimeout(() => document.getElementById('create-source')?.focus({preventScroll: true}), 60);
}
function renderCreate(ctx: SheetContext): void {
 if (createStep === 1) {
  head('新建应用', '第 1 步 · 选择来源', true);
  $('#sheet-body').innerHTML = '<div class="step-line"><span class="step-dot">1</span><b>来源</b><span>→</span><span>2 填写详情</span></div>'
   + '<div class="dropzone">' + icons.folder + '<strong>选择软件目录或压缩包</strong><span>支持目录、ZIP、7z；也可以直接粘贴完整路径</span></div>'
   + '<div class="field"><label for="create-kind">来源类型</label><select id="create-kind"><option value="directory"' + (createKind === 'directory' ? ' selected' : '') + '>目录</option><option value="archive"' + (createKind === 'archive' ? ' selected' : '') + '>压缩包（ZIP / 7z）</option></select></div>'
   + '<div class="field"><label for="create-source">来源路径</label><div class="input-row"><input id="create-source" value="' + escape(createSource) + '" placeholder="例如 D:\\Downloads\\my-app.zip" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="create-browse">选择…</button></div></div>'
   + '<div class="field"><label for="create-name">应用目录名</label><input id="create-name" value="' + escape(createName) + '" placeholder="如：my-app" autocomplete="off"><small>将部署到应用库中的同名目录；已有目录不会被覆盖。</small></div>'
   + '<p class="sheet-error" id="create-error" role="alert"></p>';
  $('#sheet-foot').innerHTML = '<span class="sheet-state">先确认来源，再填写应用信息</span><div class="sheet-actions"><button type="button" class="btn" id="create-cancel">取消</button><button type="button" class="btn primary" id="create-next">识别并继续</button></div>';
  const source = $<HTMLInputElement>('#create-source'), name = $<HTMLInputElement>('#create-name');
  source.oninput = () => {createSource = source.value;if (!createNameEdited) {name.value = suggestedAppName(source.value || ' ');createName = name.value;}};
  name.oninput = () => {createNameEdited = true;createName = name.value;};
  $('#create-kind').onchange = () => {createKind = $<HTMLSelectElement>('#create-kind').value;};
  $('#create-browse').onclick = async () => {
   const button = $<HTMLButtonElement>('#create-browse');button.disabled = true;
   try {
    const picked = await API.PickSource(createKind);
    if (picked) {source.value = picked;source.dispatchEvent(new Event('input'));}
   } catch (error) {showCreateError(error);}
   finally {button.disabled = false;}
  };
  $('#create-cancel').onclick = () => void requestClose(ctx);
  $('#create-next').onclick = () => void prepare(ctx);
 } else {
  const app = pendingNew!;
  head('新建应用', '第 2 步 · 填写详情', true);
  $('#sheet-body').innerHTML = '<div class="step-line"><span class="step-dot ok">1</span><span>来源</span><span>→</span><span class="step-dot">2</span><b>填写详情</b></div>'
   + '<div class="notice">文件已准备到 <strong>' + escape(app.target) + '</strong>，填写应用信息后才会写入配置。</div>'
   + '<div class="field"><label for="create-title">应用名称</label><input id="create-title" value="' + escape(draft!.title) + '" autocomplete="off"></div>'
   + '<div class="field"><label for="create-category">分类</label>' + categorySelect('create-category', draft!.category, ctx) + '</div>'
   + '<div class="field"><label for="create-type">应用类型</label><select id="create-type"><option value="">请选择类型</option><option value="GUI"' + (draft!.type === 'GUI' ? ' selected' : '') + '>图形应用</option><option value="CLI"' + (draft!.type === 'CLI' ? ' selected' : '') + '>命令行应用</option></select></div>'
   + '<div class="field"><label for="create-entry">启动入口</label><input id="create-entry" list="create-entries" value="' + escape(draft!.entry) + '" placeholder="app.exe 或 re:正则表达式" autocomplete="off" spellcheck="false"><datalist id="create-entries">' + (app.entries || []).map(entry => '<option value="' + escape(entry) + '"></option>').join('') + '</datalist><small id="create-entry-hint"></small></div>'
   + '<div class="field"><label for="create-description">备注</label><textarea id="create-description" rows="3" placeholder="自由备注、使用提示或待办事项">' + escape(draft!.description) + '</textarea></div>'
   + '<label class="check"><input type="checkbox" id="create-admin"' + (draft!.runAsAdmin ? ' checked' : '') + '><span>以管理员身份运行</span></label>'
   + '<p class="sheet-error" id="create-error" role="alert"></p>';
  $('#sheet-foot').innerHTML = '<span class="sheet-state" id="sheet-state"></span><div class="sheet-actions"><button type="button" class="btn" id="create-back">上一步</button><button type="button" class="btn primary" id="create-submit">创建应用</button></div>';
  const title = $<HTMLInputElement>('#create-title'), category = $<HTMLSelectElement>('#create-category'), type = $<HTMLSelectElement>('#create-type');
  const entry = $<HTMLInputElement>('#create-entry'), description = $<HTMLTextAreaElement>('#create-description'), admin = $<HTMLInputElement>('#create-admin');
  title.oninput = () => {draft!.title = title.value;updateCreateStatus();};
  category.onchange = async () => {draft!.category = await chooseCategory(category, ctx, draft!.category);updateCreateStatus();};
  type.onchange = () => {draft!.type = type.value;updateCreateStatus();};
  description.oninput = () => {draft!.description = description.value;updateCreateStatus();};
  admin.onchange = () => {draft!.runAsAdmin = admin.checked;updateCreateStatus();};
  entry.oninput = () => {draft!.entry = entry.value;updateCreateStatus();scheduleNewEntryCheck(ctx);};
  $('#create-back').onclick = () => {createStep = 1;renderCreate(ctx);};
  $('#create-submit').onclick = () => void submitCreate(ctx);
  updateCreateStatus();void checkNewEntry(ctx);
 }
}
function showCreateError(error: unknown): void {
 const target = document.getElementById('create-error');
 if (target) target.textContent = error instanceof Error ? error.message : String(error);
}
function updateCreateStatus(): void {
 const state = document.getElementById('sheet-state'), submit = document.getElementById('create-submit');
 if (!state || !submit || !draft) return;
 const error = validation(draft) || (draft.entry && !newEntryValid ? '请选择来源中的有效启动入口' : '');
 state.textContent = error || '确认后会写入应用配置';
 state.classList.toggle('error', !!error);
 (submit as HTMLButtonElement).disabled = !!error;
}
function scheduleNewEntryCheck(ctx: SheetContext): void {
 clearTimeout(entryTimer);
 entryTimer = window.setTimeout(() => void checkNewEntry(ctx), 200);
}
async function checkNewEntry(ctx: SheetContext): Promise<void> {
 clearTimeout(entryTimer);
 const entry = document.getElementById('create-entry') as HTMLInputElement | null;
 const hint = document.getElementById('create-entry-hint');
 if (!entry || !hint || !draft || !pendingNew) return;
 const request = ++entryRequest, value = draft.entry;
 if (!value.trim()) {entry.classList.remove('invalid');hint.textContent = '从来源中选择入口；支持 re: 正则匹配文件名';return;}
 const valid = await API.CheckNewEntry(pendingNew.token, value).catch(() => false);
 if (request !== entryRequest || pendingNew === null) return;
 newEntryValid = valid;
 entry.classList.toggle('invalid', !valid);
 hint.textContent = valid ? '入口有效' : '来源中没有匹配的入口';
 updateCreateStatus();
}
async function prepare(ctx: SheetContext): Promise<void> {
 if (ctx.isBusy()) return;
 if (!createSource.trim() || !createName.trim()) {showCreateError('请选择来源并确认应用目录名');return;}
 ctx.busy(true, '正在准备应用文件…');
 const button = document.getElementById('create-next') as HTMLButtonElement | null;
 if (button) button.disabled = true;
 let prepared: NewAppInfo | null = null;
 try {
  prepared = await API.PrepareNewApp(createSource.trim(), createName.trim()) as NewAppInfo;
  if (pendingNew) await API.DiscardNewApp(pendingNew.token);
  pendingNew = prepared;
  const name = prepared.name || createName.trim();
  draft = {uuid: prepared.token, title: name, type: 'GUI', entry: (prepared.entries || [])[0] || '', category: '', description: '', runAsAdmin: false, relatedLinks: [], updater: []};
  newEntryValid = false;createStep = 2;
  ctx.busy(false);renderCreate(ctx);
 } catch (error) {
  if (prepared) await API.DiscardNewApp(prepared.token).catch(console.error);
  showCreateError(error);
 } finally {ctx.busy(false);if (button) button.disabled = false;if (createStep === 1) updateCreateStatus();}
}
async function submitCreate(ctx: SheetContext): Promise<void> {
 if (ctx.isBusy() || !draft || !pendingNew) return;
 const error = validation(draft) || (!newEntryValid && draft.entry ? '请选择有效启动入口' : '');
 if (error) {showCreateError(error);return;}
 const token = pendingNew.token;
 ctx.busy(true, '正在部署新应用…');
 try {
  const saved = await API.CommitNewApp(token, draft) as App;
  pendingNew = null;open = null;layer(false);
  ctx.busy(false);ctx.created(saved);ctx.toast('已创建 ' + saved.title);
 } catch (failure) {
  showCreateError(failure);
 } finally {ctx.busy(false);}
}

/* ---------- settings ---------- */
export function openSettings(ctx: SheetContext): void {
 open = 'settings';layer(true);render(ctx);
 void ctx.settings().then(info => {if (open === 'settings') {settingsInfo = info;render(ctx);}}).catch(console.error);
}
function renderSettings(ctx: SheetContext): void {
 head('设置', '热键、启动与外观');
 const info = settingsInfo;
 const hotkey = info?.hotkey || 'Ctrl+Alt+Space';
 const warning = info?.hotkeyError ? '<p class="sheet-error">全局热键注册失败：' + escape(info.hotkeyError) + '（可能已被其他程序占用）</p>' : '';
 $('#sheet-body').innerHTML = '<div class="setting-row"><div class="setting-copy"><b>全局热键</b><span>窗口隐藏后，随时唤回命令中心</span></div><span class="hotkey-pill" id="hotkey-pill">' + escape(hotkey.split('+').join(' ')) + '</span></div>'
  + '<div class="setting-row"><div class="setting-copy"><b>关闭时隐藏到托盘</b><span>关闭按钮只收起窗口，右键托盘图标可退出</span></div><span class="chip ok">始终启用</span></div>'
  + '<div class="setting-row"><div class="setting-copy"><b>运行后隐藏窗口</b><span>启动应用后自动收起，按热键再次唤起</span></div><button type="button" class="switch' + (ctx.autohide() ? ' on' : '') + '" id="toggle-autohide" role="switch" aria-checked="' + ctx.autohide() + '" aria-label="运行后隐藏窗口"></button></div>'
  + '<div class="setting-row"><div class="setting-copy"><b>深色主题</b><span>切换界面配色，立即生效</span></div><button type="button" class="switch' + (ctx.theme() === 'dark' ? ' on' : '') + '" id="toggle-theme" role="switch" aria-checked="' + (ctx.theme() === 'dark') + '" aria-label="深色主题"></button></div>'
  + '<div class="setting-row"><div class="setting-copy"><b>应用库</b><span class="mono">' + escape(ctx.library() || info?.library || '未知') + '</span></div><button type="button" class="btn small" id="settings-open-library">打开目录</button></div>'
  + warning
  + '<div class="setting-row"><div class="setting-copy"><b>退出 App Runner</b><span>退出后热键与托盘图标都会消失</span></div><button type="button" class="btn small danger" id="settings-quit">退出</button></div>';
  $('#sheet-foot').innerHTML = '<span class="sheet-state">设置会立即生效</span><div class="sheet-actions"><button type="button" class="btn primary" id="settings-done">完成</button></div>';
  $('#toggle-autohide').onclick = () => {ctx.setAutohide(!ctx.autohide());renderSettings(ctx);};
  $('#toggle-theme').onclick = () => {ctx.setTheme(ctx.theme() === 'dark' ? 'light' : 'dark');renderSettings(ctx);};
  $('#settings-open-library').onclick = () => void API.OpenLibrary().catch(error => ctx.toast(String(error instanceof Error ? error.message : error)));
  $('#settings-quit').onclick = async () => {
   if (!await API.Confirm('确定退出 App Runner 吗？退出后需要重新启动程序。')) return;
   await API.QuitApp().catch(error => ctx.toast(String(error instanceof Error ? error.message : error)));
  };
  $('#settings-done').onclick = () => void requestClose(ctx);
}

/* ---------- shared ---------- */
function render(ctx: SheetContext): void {
 if (open === 'edit') renderEdit(ctx);
 else if (open === 'create') renderCreate(ctx);
 else if (open === 'settings') renderSettings(ctx);
}
export async function requestClose(ctx: SheetContext): Promise<boolean> {
 if (!open) return true;
 if (ctx.isBusy()) return false;

 if (open === 'edit' && dirty()) {
  if (!await API.Confirm('当前详情有未保存的更改，确定放弃吗？')) return false;
 }
 if (open === 'create' && pendingNew) {
  if (!await API.Confirm('新建应用还没有保存，确定放弃吗？')) return false;
  const token = pendingNew.token;
  pendingNew = null;
  await API.DiscardNewApp(token).catch(console.error);
 }
 open = null;editingId = '';draft = null;baseline = '';createStep = 1;
 layer(false);ctx.closed();
 return true;
}
export function handleKey(ctx: SheetContext, event: KeyboardEvent): boolean {
 if (!open) return false;
 if (event.key === 'Escape') {
  if (event.isComposing) return false;
  event.preventDefault();void requestClose(ctx);return true;
 }
 if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
  if (open === 'edit') {event.preventDefault();void save(ctx);return true;}
  if (open === 'create' && createStep === 2) {event.preventDefault();void submitCreate(ctx);return true;}
 }
 return false;
}
