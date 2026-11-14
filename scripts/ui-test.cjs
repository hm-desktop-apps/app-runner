// Tests the real Go service through Wails' server transport using an isolated library.
// Requires Playwright (npm install --no-save playwright) and Chromium/Edge.
const {chromium} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'selfcheck');
const port = Number(process.env.UI_TEST_PORT || 9391);

async function fixture(library,name,title,{updater=false,category='',description='测试备注'}={}) {
 const dir = path.join(library,name);
 await fs.mkdir(path.join(dir,'content'),{recursive:true});
 await fs.writeFile(path.join(dir,'content','app.exe'),'test-only entry');
 const lines = ['title = "' + title + '"','type = "GUI"','entry = "app.exe"','description = "' + description + '"'];
 if (category) lines.push('category = "' + category + '"');
 lines.push('updater = ' + (updater ? '["PIN:settings", "RMC"]' : '[]'));
 lines.push('[[related_links]]','title = "官网"','url = "https://example.com"');
 await fs.writeFile(path.join(dir,'app.toml'),lines.join('\n') + '\n');
 return dir;
}
const text = file => fs.readFile(file,'utf8');

async function main() {
 await fs.mkdir(output,{recursive:true});
 const library = await fs.mkdtemp(path.join(output,'ui-library-'));
 const alpha = await fixture(library,'alpha','Alpha Editor',{updater:true,category:'开发工具'});
 await fs.copyFile(path.join(root,'build','windows','icon.ico'),path.join(alpha,'app.ico'));
 const beta = await fixture(library,'beta','Beta Terminal',{category:'工具'});
 await fs.writeFile(path.join(beta,'app.ico'),'invalid icon bytes for fallback test');
 for (let index = 1; index <= 20; index++) await fixture(library,'list-' + index,'Z List ' + String(index).padStart(2,'0'),{category:'其他'});
 const binary = path.join(output,'test-bin','app-runner-ui-test.exe');
 const cache = path.join(library,'.test-cache');
 const server = spawn(binary,['--app-dir',library],{cwd:root,windowsHide:true,env:{...process.env,LOCALAPPDATA:cache,XDG_CACHE_HOME:cache,WAILS_SERVER_HOST:'127.0.0.1',WAILS_SERVER_PORT:String(port)}});
 let serverOutput = '';
 server.stdout.on('data',chunk => serverOutput += chunk);
 server.stderr.on('data',chunk => serverOutput += chunk);
 let browser;
 try {
  for (let i = 0; i < 120; i++) {
   try {const response = await fetch('http://127.0.0.1:' + port);if (response.ok) break;} catch {}
   if (server.exitCode !== null) throw new Error(serverOutput);
   await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({headless:true,...(process.platform === 'win32' ? {channel:'msedge'} : {})});
  const page = await browser.newPage({viewport:{width:920,height:640}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
  const missing = [];
  page.on('response',response => {if (response.status() === 404) missing.push(response.url());});
  await page.goto('http://127.0.0.1:' + port);

  const row = title => page.locator('#lib-table tr[data-id]').filter({hasText:title});
  const filterItem = key => page.locator('#lib-filters [data-filter="' + key + '"]');
  const inCommand = async () => await page.evaluate(() => document.querySelector('#cmd-view').classList.contains('is-active'));
  const runCommand = async name => {
   if (!await inCommand()) await page.locator('#lib-back').click();
   await page.locator('#cmd-view.is-active').waitFor();
   await page.locator('#cmd-search').fill(name);
   /* command rows run on a single click; only app rows wait for a double click */
   await page.locator('.result').filter({hasText:name}).first().click();
  };
  const openLibrary = async () => {
   await runCommand('打开应用库');
   await page.locator('#lib-view.is-active').waitFor();
   await page.locator('#lib-table tr[data-id]').first().waitFor();
  };
  const openCommand = async () => {
   await page.locator('#lib-back').click();
   await page.locator('#cmd-view.is-active').waitFor();
  };
  /* Playwright's synthetic drag is occasionally lost under load; retrying keeps a real
     handler regression failing while tolerating a dropped browser drag event. */
  const dragUntil = async (source,target,done) => {
   for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {await page.waitForTimeout(250);console.log('retrying a dropped drag');}
    await source.dragTo(target,{steps:5});
    for (let i = 0; i < 20; i++) {if (await done()) return true;await new Promise(resolve => setTimeout(resolve, 100));}
   }
   return false;
  };
  const openSettings = async () => {
   await runCommand('设置');
   await page.locator('#sheet-layer.open').waitFor();
   await page.waitForFunction(() => document.querySelector('#hotkey-pill'));
  };

  /* command view boots first and owns the keyboard */
  await page.locator('#cmd-results .result').first().waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'cmd-search',undefined,{timeout:5000}).catch(async () => {throw new Error('startup did not focus the command search: ' + await page.evaluate(() => document.activeElement?.id + ' ' + document.activeElement?.tagName));});
  assert.equal(await page.locator('#cmd-view').evaluate(view => view.classList.contains('is-active')),true);
  const fills = await page.evaluate(() => {const body = document.querySelector('.window-body').getBoundingClientRect(), view = document.querySelector('#cmd-view').getBoundingClientRect(); return {body:Math.round(body.height),view:Math.round(view.height),top:Math.round(view.top - body.top)};});
  assert.deepEqual(fills,{body:fills.body,view:fills.body,top:0},'the command view does not fill the window body');
  const dragRegions = await page.evaluate(() => ({bar:getComputedStyle(document.querySelector('.cmd-search')).getPropertyValue('--wails-draggable').trim(),input:getComputedStyle(document.querySelector('#cmd-search')).getPropertyValue('--wails-draggable').trim()}));
  assert.equal(dragRegions.bar,'drag','the search row is not a native drag region');
  assert.equal(dragRegions.input,'no-drag','the search input can drag the window');
  assert.equal(await page.locator('.cmd-group').first().textContent(),'全部应用','empty history should fall back to all apps');
  assert.equal(await page.locator('#cmd-close').count(),1,'the command view has no close button');
  assert.equal(await page.evaluate(() => document.fonts.check('13px Harmony')),true,'the HarmonyOS font did not load');
  await page.locator('#cmd-search').fill('alpha');
  await page.locator('.result').filter({hasText:'Alpha Editor'}).waitFor();
  await page.evaluate(() => {document.querySelector('#lib-sort').focus();window.dispatchEvent(new Event('focus'));});
  assert.equal(await page.locator('#cmd-search').inputValue(),'','window activation did not clear the command search');
  assert.equal(await page.evaluate(() => document.activeElement?.id),'cmd-search','window activation did not focus the command search');

  /* searching, keyboard selection and command-only mode */
  await page.locator('#cmd-search').fill('alpha');
  await page.locator('.result').filter({hasText:'Alpha Editor'}).waitFor();
  assert.equal(await page.locator('.result').filter({hasText:'Beta Terminal'}).count(),0);
  assert.equal(await page.locator('#cmd-peek h2').textContent(),'Alpha Editor');
  assert.equal(await page.locator('#cmd-peek .peek-row').first().textContent().then(value => value.includes('app.exe')),true);
  assert.equal(await page.locator('#cmd-peek .peek-link').count(),1,'the peek panel hides configured links');
  assert.equal(await page.locator('#cmd-peek .peek-link span').textContent(),'官网');
  /* opening the sheet must not scroll or shift the panel underneath (focus must not move layout) */
  await page.locator('#cmd-peek [data-edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => document.querySelector('.window-body').scrollLeft),0,'opening the sheet scrolled the window body sideways');
  assert.equal(await page.evaluate(() => Math.round(document.querySelector('.cmd-body').getBoundingClientRect().x)),0,'opening the sheet shifted the command panel');
  await page.keyboard.press('Escape');
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  await page.locator('#cmd-search').fill('list');
  await page.locator('.result').filter({hasText:'Z List 01'}).waitFor();
  const selectedBefore = await page.locator('#cmd-results .result.selected').getAttribute('data-key');
  await page.locator('#cmd-search').press('ArrowDown');
  const selectedAfter = await page.locator('#cmd-results .result.selected').getAttribute('data-key');
  assert.notEqual(selectedBefore,selectedAfter,'arrow keys did not move the command selection');
  assert.equal(await page.locator('#cmd-results .result.selected').count(),1);
  await page.locator('#cmd-search').fill('>');
  assert.deepEqual(await page.locator('.cmd-group').allTextContents(),['命令'],'> prefix still listed applications');
  assert.equal(await page.locator('.result .tile').count(),0,'> prefix still rendered app tiles');
  await page.locator('#cmd-search').press('Escape');
  assert.equal(await page.locator('#cmd-search').inputValue(),'','Escape did not clear the query');
  assert.equal(await page.locator('.result .tile').count() > 0,true);
  /* pinyin initials and full pinyin also match Chinese categories */
  await page.locator('#cmd-search').fill('kfgj');
  await page.locator('.result').filter({hasText:'Alpha Editor'}).waitFor();
  assert.equal(await page.locator('.result').filter({hasText:'Beta Terminal'}).count(),0,'initials matched an unrelated app');
  await page.locator('#cmd-search').fill('kaifa');
  assert.equal(await page.locator('.result').filter({hasText:'Alpha Editor'}).count(),1,'full pinyin did not match a category');
  await page.locator('#cmd-search').fill('');

  /* the hidden library is neither rendered nor fetched at startup */
  const startupTable = await page.evaluate(() => ({rows:document.querySelectorAll('#lib-table tr[data-id]').length,icons:performance.getEntriesByType('resource').filter(entry => entry.name.includes('/app-icons/')).length}));
  assert.equal(startupTable.rows,0,'the hidden library was rendered at startup');
  assert.ok(startupTable.icons <= 8,'startup fetched icons for the hidden library: ' + startupTable.icons);

  /* library table, filters and selection */
  await openLibrary();
  assert.equal(await page.locator('#lib-close').count(),1,'the library has no close button');
  assert.equal(await page.locator('#lib-table tr[data-id]').count(),22);
  assert.equal(await page.locator('.filter-item[data-filter="all"] .count').textContent(),'22');
  assert.equal(await page.locator('.filter-item[data-filter="updatable"] .count').textContent(),'1');
  await page.locator('.filter-item[data-filter="updatable"]').click();
  assert.equal(await page.locator('#lib-table tr[data-id]').count(),1);
  assert.equal(await page.locator('#lib-table tr[data-id]').first().textContent().then(value => value.includes('Alpha Editor')),true);
  await filterItem('all').click();
  assert.equal(await page.locator('#lib-table tr[data-id]').count(),22);
  await page.evaluate(() => {globalThis.__rowNodes = Array.from(document.querySelectorAll('#lib-table tr[data-id]'));});
  await filterItem('updatable').click();
  await filterItem('all').click();
  assert.equal(await page.evaluate(() => globalThis.__rowNodes.every(node => document.querySelector('#lib-table').contains(node))),true,'filtering rebuilt unchanged rows');

  const scrollPane = page.locator('.table-scroll');
  const gutter = await scrollPane.evaluate(element => element.offsetWidth - element.clientWidth);
  assert.ok(gutter > 0,'table is not scrollable in this fixture');
  const debounceRows = await page.evaluate(() => {
   const input = document.querySelector('#lib-search');
   input.value = 'list-1';
   input.dispatchEvent(new Event('input'));
   return document.querySelectorAll('#lib-table tr[data-id]').length;
  });
  assert.equal(debounceRows,22,'library search filtered without the 150 ms debounce');
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]').length < 22);
  assert.equal(await scrollPane.evaluate(element => element.offsetWidth - element.clientWidth),gutter,'scrollbar appearance changed the table width');
  await page.locator('#lib-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]').length === 22);

  const alphaRow = row('Alpha Editor');
  await alphaRow.click();
  await page.waitForFunction(() => document.querySelector('#lib-selection').classList.contains('has'));
  assert.equal(await page.locator('.sel-name').textContent(),'Alpha Editor');
  await page.locator('#lib-sort').selectOption('name');
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]')[0]?.textContent.includes('Alpha Editor'));
  await page.evaluate(() => {globalThis.__rowBefore = document.querySelectorAll('#lib-table tr[data-id]')[0];});
  await page.locator('#lib-table tr[data-id]').nth(3).click();
  assert.equal(await page.evaluate(() => document.querySelectorAll('#lib-table tr[data-id]')[0] === globalThis.__rowBefore),true,'selection rebuilt table rows');
  assert.equal(await page.locator('.sel-name').textContent(),'Z List 02');
  await page.locator('#lib-sort').selectOption('recent');

  /* tiles decode real icons and fall back to monograms */
  await alphaRow.click();
  await page.locator('#lib-table .tile.loaded').first().waitFor();
  assert.equal(await alphaRow.locator('.tile-icon').evaluate(image => image.naturalWidth > 0),true,'ICO did not decode');
  await row('Beta Terminal').click();
  await page.waitForFunction(() => document.querySelectorAll('#lib-table .tile.loaded').length === 1,undefined,'broken icon was not hidden');

  /* edit sheet saves to disk and keeps the table in sync */
  await alphaRow.click();
  await row('Alpha Editor').locator('[data-act=edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  assert.equal(await page.locator('#sheet-title').textContent(),'编辑应用');
  await page.locator('#edit-title').fill('Alpha Changed');
  assert.equal(await page.locator('#sheet-state').textContent(),'有未保存的更改');
  assert.equal(await page.locator('#sheet-save').isEnabled(),true);
  await page.locator('#sheet-save').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  assert.match(await text(path.join(alpha,'app.toml')),/title = 'Alpha Changed'/);
  assert.equal(await row('Alpha Changed').count(),1);
  assert.equal(await page.locator('.toast').textContent().then(value => value.includes('已保存 Alpha Changed')),true);

  /* links and updater tabs edit structured profile data */
  await row('Alpha Changed').locator('[data-act=edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.locator('[data-tab=links]').click();
  assert.equal(await page.locator('#sheet-body [data-link]').count(),2);
  assert.equal(await page.locator('#sheet-body [data-open-link]').first().isEnabled(),true,'a configured link is not openable');
  await page.locator('#add-link').click();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key')),'title','adding a link did not focus its name');
  assert.equal(await page.locator('#sheet-body [data-open-link]').nth(1).isDisabled(),true,'a blank link is openable');
  await page.locator('#sheet-body [data-link="1"][data-key=title]').fill('文档');
  await page.locator('#sheet-body [data-link="1"][data-key=url]').fill('docs.example.com');
  await page.locator('#sheet-body [data-link="1"][data-key=url]').blur();
  assert.equal(await page.locator('#sheet-body [data-link="1"][data-key=url]').inputValue(),'https://docs.example.com','a bare domain was not expanded');
  await page.locator('#add-link').click(); /* an untouched row must not reach the profile */
  await page.locator('[data-tab=update]').click();
  await page.locator('#add-updater').click();
  await page.locator('[data-action="2"]').selectOption('PIN');
  await page.locator('[data-param="2"]').fill('data');
  await page.locator('#sheet-save').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  let disk = await text(path.join(alpha,'app.toml'));
  assert.match(disk,/title = '文档'/);
  assert.match(disk,/url = 'https:\/\/docs\.example\.com'/);
  assert.equal((disk.match(/\[\[related_links\]\]/g) || []).length,2,'blank link rows were saved');
  assert.match(disk,/PIN:data/);

  /* a link without an address is not saved and legacy entries are skipped in the peek panel */
  await row('Alpha Changed').locator('[data-act=edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.locator('[data-tab=links]').click();
  await page.locator('#add-link').click();
  await page.locator('#sheet-body [data-link="2"][data-key=title]').fill('只有名字');
  await page.locator('#sheet-save').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  disk = await text(path.join(alpha,'app.toml'));
  assert.equal((disk.match(/\[\[related_links\]\]/g) || []).length,2,'a link without a URL was saved');
  /* legacy profiles may still contain a link without an address */
  await fs.writeFile(path.join(alpha,'app.toml'),disk.trimEnd() + '\n\n[[related_links]]\ntitle = \'旧数据\'\nurl = \'\'\n');
  const scanned = page.waitForResponse(response => response.request().method() === 'POST');
  await page.keyboard.press('F5');
  await scanned;
  await page.waitForTimeout(200);
  await openCommand();
  await page.locator('#cmd-search').fill('Alpha Changed');
  await page.waitForFunction(() => document.querySelector('#cmd-peek h2')?.textContent === 'Alpha Changed');
  assert.equal(await page.locator('#cmd-peek .peek-link').count(),2,'the peek panel dropped configured links');
  assert.equal(await page.locator('#cmd-peek .peek-link[data-open-url=""]').count(),0,'a link without a URL is clickable');
  await openLibrary();

  /* a double click on 保存 must not issue two concurrent saves */
  let saveCalls = 0;
  await page.route('**/*',async route => {
   const request = route.request();
   if (request.method() === 'POST' && (request.postData() || '').includes('"relatedLinks"')) {saveCalls++;await new Promise(resolve => setTimeout(resolve,700));}
   await route.continue();
  });
  await row('Alpha Changed').locator('[data-act=edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.locator('#edit-description').fill('double save guard');
  await page.locator('#sheet-save').dblclick();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sheet-layer.open').count(),1,'Escape closed the sheet while saving');
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  assert.equal(saveCalls,1,'a double click on save issued ' + saveCalls + ' saves');
  await page.unroute('**/*');
  assert.match(await text(path.join(alpha,'app.toml')),/double save guard/);

  /* installing an update disables the dialog controls until it finishes */
  const updateSource = await fs.mkdtemp(path.join(output,'ui-update-'));
  await fs.mkdir(path.join(updateSource,'data'),{recursive:true});
  await fs.writeFile(path.join(updateSource,'data','seed.txt'),'update fixture');
  await row('Alpha Changed').locator('[data-act=edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.locator('[data-tab=update]').click();
  await page.locator('#sheet-update').click();
  await page.locator('#update-source-dialog[open]').waitFor();
  assert.equal(await page.locator('#update-source').isEnabled(),true,'the source field does not start enabled');
  await page.locator('#update-kind').selectOption('directory');
  await page.locator('#update-source').fill(updateSource);
  /* hold the call so the busy state is observable */
  await page.route('**/*',async route => {if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve,1200));await route.continue();});
  await page.locator('#update-install').click();
  await page.waitForFunction(() => document.querySelector('#activity').matches(':popover-open'));
  assert.equal(await page.locator('#update-install').isDisabled(),true,'the install button is enabled while installing');
  assert.equal(await page.locator('#update-source').isDisabled(),true,'the source field is enabled while installing');
  assert.equal(await page.locator('#update-source-cancel').isDisabled(),true,'cancel is enabled while installing');
  await page.waitForFunction(() => !document.querySelector('#activity').matches(':popover-open'),undefined,{timeout:20000});
  await page.unroute('**/*');
  assert.equal(await page.locator('#update-install').isDisabled(),false,'the install button was not re-enabled');
  await page.locator('#update-keep-backup').click();
  await page.locator('#update-source-dialog[open]').waitFor({state:'hidden'});
  /* the fixture's update rules drop the entry, so restore it for the checks below */
  await fs.writeFile(path.join(alpha,'content','app.exe'),'test-only entry');

  /* entry validation flags a missing executable */
  await row('Alpha Changed').locator('[data-act=edit]').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.locator('#edit-entry').fill('missing.exe');
  await page.locator('#edit-entry.invalid').waitFor();
  await page.locator('#edit-entry').fill('app.exe');
  await page.waitForFunction(() => !document.querySelector('#edit-entry').classList.contains('invalid'));
  await page.locator('#sheet-close').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});

  /* creating an application walks through both steps */
  const source = await fs.mkdtemp(path.join(output,'ui-source-'));
  await fs.mkdir(path.join(source,'bin'),{recursive:true});
  await fs.writeFile(path.join(source,'bin','app.exe'),'created directory application');
  await fs.mkdir(path.join(source,'resources','app'),{recursive:true});
  await fs.writeFile(path.join(source,'resources','app','helper.exe'),'nested helper');
  await page.locator('#new-app').click();
  await page.locator('#sheet-layer.open').waitFor();
  await page.locator('#create-kind').selectOption('directory');
  await page.locator('#create-source').fill(source);
  await page.locator('#create-name').fill('gamma');
  await page.locator('#create-next').click();
  await page.locator('#create-title').waitFor();
  assert.equal(await page.locator('#create-entry').inputValue(),'bin/app.exe','the default entry ignored the content root / bin scan');
  assert.deepEqual(await page.locator('#create-entries option').evaluateAll(options => options.map(option => option.value)),['bin/app.exe'],'a nested helper binary leaked into the entry suggestions');
  await page.locator('#create-title').fill('Gamma Browser');
  /* the category field offers the shared dropdown and can create a category in place */
  await page.locator('#create-category').selectOption('__new-category__');
  await page.locator('#category-dialog[open]').waitFor();
  await page.locator('#category-name').fill('导入分类');
  await page.locator('#category-create').click();
  await page.waitForFunction(() => !document.querySelector('#category-dialog').open);
  assert.equal(await page.locator('#create-category').inputValue(),'导入分类','the created category was not selected');
  await page.locator('#create-submit:not([disabled])').waitFor();
  await page.locator('#create-submit').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]').length === 23);
  assert.match(await text(path.join(library,'gamma','app.toml')),/title = 'Gamma Browser'/);
  assert.match(await text(path.join(library,'gamma','app.toml')),/category = '导入分类'/);
  assert.equal(await page.locator('#lib-view').evaluate(view => view.classList.contains('is-active')),true,'creating did not switch to the library');
  assert.equal(await page.locator('#lib-search').inputValue(),'');

  /* category lifecycle: create, drop a row in, rename, delete */
  await page.locator('#new-category').click();
  await page.locator('#category-dialog[open]').waitFor();
  await page.locator('#category-name').fill('图形工具');
  await page.locator('#category-create').click();
  await page.waitForFunction(() => !document.querySelector('#category-dialog').open);
  await filterItem('category:图形工具').waitFor();
  await page.locator('#lib-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]').length === 23);
  await page.waitForTimeout(200);
  assert.ok(await dragUntil(row('Alpha Changed'),filterItem('category:图形工具'),async () => /category = '图形工具'/.test(await text(path.join(alpha,'app.toml')))),'dragging a row onto a category filter did not move it');
  assert.match(await text(path.join(alpha,'app.toml')),/category = '图形工具'/);
  await filterItem('category:图形工具').click();
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]').length === 1);
  assert.equal(await page.locator('#lib-table tr[data-id]').first().textContent().then(value => value.includes('Alpha Changed')),true);

  await filterItem('category:图形工具').click({button:'right'});
  await page.locator('#group-edit-dialog[open]').waitFor();
  await page.locator('#group-edit-name').fill('工具');
  await page.locator('#group-rename').click();
  assert.match(await page.locator('#group-edit-error').textContent(),/已存在/);
  await page.locator('#group-edit-name').fill('设计工具');
  await page.locator('#group-rename').click();
  await page.waitForFunction(() => !document.querySelector('#group-edit-dialog').open);
  await filterItem('category:设计工具').waitFor();
  assert.match(await text(path.join(alpha,'app.toml')),/category = '设计工具'/);
  assert.equal(await filterItem('category:图形工具').count(),0);

  await filterItem('category:设计工具').click({button:'right'});
  await page.locator('#group-edit-dialog[open]').waitFor();
  await page.locator('#group-delete').click();
  await page.waitForFunction(() => !document.querySelector('#group-edit-dialog').open);
  assert.match(await text(path.join(alpha,'app.toml')),/category = ''/);
  assert.equal(await filterItem('category:设计工具').count(),0);

  /* dragging a row onto 新建分类 creates the category and moves the row */
  await filterItem('all').click();
  await page.waitForTimeout(200);
  assert.ok(await dragUntil(row('Alpha Changed'),page.locator('#new-category'),() => page.evaluate(() => !!document.querySelector('#category-dialog[open]'))),'dropping a row on 新建分类 did not open the dialog');
  assert.equal(await page.locator('#category-dialog-message').textContent(),'将“Alpha Changed”移入新分类');
  await page.locator('#category-name').fill('拖入分类');
  await page.locator('#category-create').click();
  await page.waitForFunction(() => !document.querySelector('#category-dialog').open);
  for (let i = 0; i < 50; i++) {if (/category = '拖入分类'/.test(await text(path.join(alpha,'app.toml')))) break;await new Promise(resolve => setTimeout(resolve, 100));}
  assert.match(await text(path.join(alpha,'app.toml')),/category = '拖入分类'/);
  await filterItem('category:拖入分类').waitFor();

  /* refresh keeps the current selection and the table */
  await filterItem('all').click();
  await row('Alpha Changed').click();
  await page.keyboard.press('F5');
  await page.waitForFunction(() => !document.querySelector('#activity').matches(':popover-open') && document.querySelectorAll('#lib-table tr[data-id]').length === 23);
  await page.waitForFunction(() => document.querySelectorAll('#lib-table tr[data-id]').length === 23);
  assert.equal(await page.locator('.sel-name').textContent(),'Alpha Changed','refresh dropped the selection');

  /* settings sheet reflects service state and owns the theme toggle */
  await openSettings();
  assert.equal(await page.locator('#hotkey-pill').textContent(),'Ctrl Alt Space');
  assert.equal(await page.locator('#toggle-autohide').getAttribute('aria-checked'),'false');
  await page.locator('#toggle-autohide').click();
  assert.equal(await page.locator('#toggle-autohide').getAttribute('aria-checked'),'true');
  assert.equal(await page.locator('#toggle-theme').getAttribute('aria-checked'),'false');
  await page.locator('#toggle-theme').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme),'dark');
  await page.locator('#settings-done').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  await page.reload();
  await page.locator('#cmd-results .result').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme),'dark','theme did not persist');
  await page.evaluate(() => localStorage.setItem('app-runner-autohide','0'));
  await openSettings();
  await page.locator('#toggle-theme').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme),'light');
  await page.locator('#settings-done').click();
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});

  /* keyboard entry points and the library round trip */
  await openLibrary();
  await page.locator('body').click({position:{x:600,y:400}});
  await page.keyboard.press('Control+k');
  assert.equal(await page.evaluate(() => document.activeElement?.id),'lib-search','Ctrl K did not focus the search');
  await page.locator('#lib-search').fill('alpha');
  await page.evaluate(() => {document.querySelector('#lib-sort').focus();window.dispatchEvent(new Event('focus'));});
  assert.equal(await page.locator('#lib-search').inputValue(),'alpha','window activation discarded the library query');
  assert.equal(await page.evaluate(() => document.activeElement?.id),'lib-search','window activation did not focus the library search');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#lib-search').inputValue(),'','Escape did not clear the library query');
  await page.keyboard.press('Escape');
  await page.locator('#cmd-view.is-active').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'cmd-search',undefined,{timeout:3000});
  await openLibrary();
  await page.locator('#lib-table tr[data-id]').first().click();
  await page.keyboard.press('ArrowDown');
  const selectedRow = await page.evaluate(() => document.querySelector('#lib-table tr.selected')?.dataset.id);
  assert.ok(selectedRow,'arrow keys did not move the library selection');
  await page.locator('#lib-search').focus();
  await page.locator('#lib-table tr[data-id]').nth(2).click();
  await page.keyboard.press('e');
  await page.locator('#sheet-layer.open').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#sheet-layer.open').waitFor({state:'hidden'});
  await page.locator('#lib-back').click();
  await page.locator('#cmd-view.is-active').waitFor();

  const unexpected = errors.filter(message => !/app-icons|Failed to load resource/.test(message));
  assert.deepEqual(unexpected,[],'unexpected console errors: ' + JSON.stringify(unexpected));
  assert.ok(missing.length <= 2,'broken icons were requested ' + missing.length + ' times instead of once');
  await page.screenshot({path:path.join(output,'ui-library.png')});
  console.log('OK: all UI checks passed');
 } finally {
  await browser?.close();
  server.kill();
 }
}
main().catch(async error => {console.error(error);process.exit(1);});
