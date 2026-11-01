// verify-background-layers.mjs — 背景层修复隔离验证（不读取用户真实设置）
/* global document, window, getComputedStyle */
// 用 puppeteer 无痕临时 profile 打开 dist/index.html（file://，渲染层自动降级 Mock 桥），
// 通过 localStorage 注入 mock 设置，断言计算样式（单层遮罩 / 无壳层 blur / 导轨无二次模糊），
// 并执行真实 INI 编辑流程（导入模组 → 展开文件树 → 打开 tank.ini → 输入 → 保存）后输出各场景截图。
// 用法：先 `npm run build`，再 `node scripts/ui-redesign/verify-background-layers.mjs`
// 输出目录：verify-background-out-2（不覆盖上一轮 verify-background-out 证据）。
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CHROME = 'C:/Users/mao/AppData/Local/Google/Chrome/Application/chrome.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(here, '../../dist/index.html');
const BASE = 'file:///' + DIST_INDEX.replace(/\\/g, '/');
const OUT = path.resolve(here, './verify-background-out-2');
fs.mkdirSync(OUT, { recursive: true });

const bg = (over = {}) => ({
  settings: { background: { kind: 'none', opacity: 100, blur: 0, imagePath: null, ...over } },
  // 种子工作区：Mock 桥的 mod.import 返回 null（无真实解压流程），
  // 直接按 workspace 持久化协议注入示例项目，让 init 恢复并刷新文件树
  workspace: {
    projects: [{
      id: 'mock-project',
      name: '我的第一个模组',
      rootPath: ['C:', '模组', '我的第一个模组'].join('\\'),
      createdAt: 1,
      lastOpenedAt: 1,
    }],
    activeProjectId: 'mock-project',
  },
});
// Mock 桥的图片必须位于示例项目根下（见 mockBridge 的 relToRoot）
const MOCK_BG = ['C:', '模组', '我的第一个模组', 'units', 'tank', 'tank.png'].join('\\');
const scenarios = [
  { name: 'image-100-blur0', state: bg({ kind: 'image', imagePath: MOCK_BG, opacity: 100, blur: 0 }), editor: true },
  { name: 'dark-image-100-blur0', state: { ...bg({ kind: 'image', imagePath: MOCK_BG, opacity: 100, blur: 0 }), settings: { theme: 'dark', background: { kind: 'image', imagePath: MOCK_BG, opacity: 100, blur: 0 } } }, editor: true },
  { name: 'image-55-blur6', state: bg({ kind: 'image', imagePath: MOCK_BG, opacity: 55, blur: 6 }), editor: true },
  { name: 'image-0-blur0', state: bg({ kind: 'image', imagePath: MOCK_BG, opacity: 0, blur: 0 }), editor: false },
  { name: 'color-100-blur0', state: bg({ kind: 'color', color: '#c96a2f', opacity: 100, blur: 0 }), editor: false },
  { name: 'gradient-70-blur0', state: bg({ kind: 'gradient', gradient: 'linear-gradient(135deg,#1b6ec2,#7a3e00)', opacity: 70, blur: 0 }), editor: false },
  { name: 'no-background', state: bg(), editor: false },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-extensions', '--allow-file-access-from-files'] });
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开示例项目的 tank.ini：文件树逐层展开 → 点击文件（带轮询重试，树刷新是异步的） */
async function openTankIni(page) {
  // 等文件树出现（种子项目 init 后 refreshTree 异步完成）
  let appeared = false;
  for (let i = 0; i < 20 && !appeared; i++) {
    appeared = await page.evaluate(() => document.querySelectorAll('.tree-row[data-tree-row]').length > 0);
    if (!appeared) await sleep(300);
  }
  if (!appeared) { fail('文件树未渲染'); return false; }

  const findRow = (name, needCollapsed) => `(() => {
    for (const row of document.querySelectorAll('.tree-row[data-tree-row]')) {
      if (row.querySelector('.tree-name')?.textContent !== ${JSON.stringify(name)}) continue;
      const exp = row.getAttribute('aria-expanded');
      if (${needCollapsed ? "exp === 'false'" : 'true'}) return row;
    }
    return null;
  })()`;

  for (const name of ['units', 'tank']) {
    let expanded = false;
    for (let attempt = 0; attempt < 6 && !expanded; attempt++) {
      expanded = await page.evaluate((n) => {
        const rows = document.querySelectorAll('.tree-row[data-tree-row]');
        for (const row of rows) {
          if (row.querySelector('.tree-name')?.textContent !== n) continue;
          if (row.getAttribute('aria-expanded') === 'true') return true;
        }
        // 收起状态：页面内 click（此前 puppeteer handle.click 在部分时序下未触发展开）
        for (const row of rows) {
          if (row.querySelector('.tree-name')?.textContent === n && row.getAttribute('aria-expanded') === 'false') {
            row.click();
            return false;
          }
        }
        return false;
      }, name);
      if (!expanded) await sleep(600);
    }
    if (!expanded) {
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.tree-row[data-tree-row]')).map((r) => `${r.querySelector('.tree-name')?.textContent}:${r.getAttribute('aria-expanded')}`).join(' | '));
      fail(`未找到可展开的目录 ${name}（当前树：${rows}）`);
      return false;
    }
    await sleep(700);
  }
  let fileEl = null;
  for (let attempt = 0; attempt < 8 && !fileEl; attempt++) {
    const file = await page.evaluateHandle(findRow('tank.ini', false));
    fileEl = file.asElement();
    if (!fileEl) await sleep(400);
  }
  if (!fileEl) { fail('未找到 tank.ini 文件行'); return false; }
  // 文件行是双击打开（onDoubleClick）
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('.tree-row[data-tree-row]')) {
      if (row.querySelector('.tree-name')?.textContent === 'tank.ini') {
        row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return;
      }
    }
  });
  await sleep(1500);
  return true;
}

for (const sc of scenarios) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((state) => {
    localStorage.setItem('rust-assistant:mock-state', JSON.stringify(state));
  }, sc.state);
  if (sc.name === 'image-55-blur6') {
    // 减少动态效果：验证 reduced-motion 分支不破坏布局
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  }
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(1200);

  const hasBackdrop = await page.evaluate(() => document.querySelector('.app')?.classList.contains('has-backdrop') ?? false);
  const expectBackdrop = sc.state.settings.background.kind !== 'none';
  (hasBackdrop === expectBackdrop ? ok : fail)(`has-backdrop=${hasBackdrop} (expect ${expectBackdrop})`);

  // 计算样式断言：壳层/导轨不再模糊背景；编辑区保持单层阅读遮罩（强度不降低）
  const probe = await page.evaluate(() => {
    const cs = (sel, prop, pseudo) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, pseudo ?? null)[prop] : null; };
    return {
      titlebarBg: cs('.titlebar', 'backgroundColor'),
      titlebarFilter: cs('.titlebar', 'backdropFilter'),
      wbLeftFilter: cs('.wb-left', 'backdropFilter'),
      railBeforeFilter: cs('.desktop-rail', 'backdropFilter', '::before'),
      railBeforeBg: cs('.desktop-rail', 'background', '::before'),
      editorVeil: getComputedStyle(document.documentElement).getPropertyValue('--veil-editor').trim(),
      appBefore: (() => { const el = document.querySelector('.app'); return el ? getComputedStyle(el, '::before').content : null; })(),
      theme: document.documentElement.getAttribute('data-theme'),
    };
  });
  if (expectBackdrop) {
    (probe.titlebarFilter === 'none' ? ok : fail)(`titlebar backdrop-filter=${probe.titlebarFilter} (expect none, blur=0 不被壳层再模糊)`);
    (probe.wbLeftFilter === 'none' ? ok : fail)(`wb-left backdrop-filter=${probe.wbLeftFilter}`);
    (probe.railBeforeFilter === 'none' ? ok : fail)(`desktop-rail::before backdrop-filter=${probe.railBeforeFilter} (expect none, blur=0 导轨不二次模糊)`);
    // getComputedStyle 把 veil-side 的 color-mix 解析成 color(srgb … / 0.64)：64% 即 --veil-side 本体
    (probe.railBeforeBg?.includes('/ 0.64)') || probe.railBeforeBg?.includes('rgba') ? ok : fail)(`desktop-rail::before bg=${probe.railBeforeBg} (expect veil-side 单层)`);
    (probe.appBefore === 'none' ? ok : fail)(`app::before content=${probe.appBefore} (expect none)`);
    const veilOk = /86%, transparent\)?$/.test(probe.editorVeil);
    (veilOk ? ok : fail)(`--veil-editor=${probe.editorVeil} (expect 阅读遮罩保持单层 86%，不降低)`);
  } else {
    (probe.titlebarFilter !== 'none' ? ok : fail)(`无背景时壳层保留玻璃模糊: ${probe.titlebarFilter}`);
  }

  let editorOpened = false;
  if (sc.editor) editorOpened = await openTankIni(page);

  if (editorOpened) {
    // 大纲默认折叠（outlineCollapsed: true）：点击「大纲」按钮展开后校验
    await page.click('.editor-head-row.actions .toolbar > .btn[data-key="outline"]');
    await sleep(400);
    // 编辑器真实内容断言：行号、双语标签、大纲（含行号）
    const editorProbe = await page.evaluate(() => {
      const lines = document.querySelectorAll('.cm-content .cm-line').length;
      const gutterNums = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
        .map((e) => e.textContent?.trim()).filter(Boolean);
      const outline = Array.from(document.querySelectorAll('.editor-outline-item')).map((e) => e.textContent?.trim());
      const badge = document.querySelector('.editor-head-row .badge')?.textContent ?? '';
      const toolbarBtn = document.querySelector('.editor-head-row.actions .toolbar > .btn[data-key]');
      const undoBtn = document.querySelector('.editor-head-row.actions .toolbar > .btn[data-key="undo"]');
      const btnStyle = toolbarBtn ? getComputedStyle(toolbarBtn) : null;
      return {
        lines,
        gutterNums: gutterNums.slice(0, 3),
        outlineCount: outline.length,
        outlineFirst: outline[0] ?? '',
        badge,
        toolbarBorderTop: btnStyle?.borderTopColor ?? null,
        undoDisabled: undoBtn?.disabled ?? null,
        cmPresent: Boolean(document.querySelector('.cm-editor')),
      };
    });
    (editorProbe.cmPresent ? ok : fail)('CodeMirror 编辑器已挂载');
    (editorProbe.lines > 3 && editorProbe.gutterNums.includes('1') ? ok : fail)(`行号渲染（${editorProbe.lines} 行，gutter=${editorProbe.gutterNums.join(',')}）`);
    (editorProbe.outlineCount > 0 && editorProbe.outlineFirst.includes('第 1 行') ? ok : fail)(`大纲条目=${editorProbe.outlineFirst}（共 ${editorProbe.outlineCount}）`);
    (editorProbe.badge.includes('双语字段') ? ok : fail)(`双语标签=${editorProbe.badge}`);
    (editorProbe.toolbarBorderTop === 'rgba(0, 0, 0, 0)' || editorProbe.toolbarBorderTop === 'transparent'
      ? ok : fail)(`工具栏按钮描边=${editorProbe.toolbarBorderTop} (expect 透明，低对比底色替代)`);
    (editorProbe.undoDisabled === true ? ok : fail)(`初始撤销按钮禁用=${editorProbe.undoDisabled}`);
    await page.screenshot({ path: `${OUT}/${sc.name}-ini-opened.png` });

    // 真实编辑：输入一行 → 脏标记 + 行数增加 → hover/focus 截图 → 保存
    await page.click('.cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type('\nprice = 999');
    await sleep(500);
    const afterEdit = await page.evaluate(() => {
      const lines = document.querySelectorAll('.cm-content .cm-line').length;
      const dirty = document.querySelector('.statusbar .sb-dirty')?.textContent ?? '';
      const dirtyDot = Boolean(document.querySelector('.tab .dirty-dot'));
      const undoBtn = document.querySelector('.editor-head-row.actions .toolbar > .btn[data-key="undo"]');
      return { lines, dirty, dirtyDot, undoDisabled: undoBtn?.disabled ?? null };
    });
    (afterEdit.lines > editorProbe.lines ? ok : fail)(`输入后行数 ${editorProbe.lines} → ${afterEdit.lines}`);
    (afterEdit.dirty.includes('未保存') && afterEdit.dirtyDot ? ok : fail)(`脏标记: 状态栏="${afterEdit.dirty}" 标签脏点=${afterEdit.dirtyDot}`);
    (afterEdit.undoDisabled === false ? ok : fail)(`编辑后撤销可用=${!afterEdit.undoDisabled}`);
    await page.screenshot({ path: `${OUT}/${sc.name}-ini-edited.png` });

    // hover / focus 状态证据
    const fmtBtn = await page.$('.editor-head-row.actions .toolbar > .btn[data-key="format"]');
    if (fmtBtn) {
      await fmtBtn.hover();
      await sleep(200);
      await page.screenshot({ path: `${OUT}/${sc.name}-toolbar-hover.png` });
    } else fail('未找到格式化按钮（hover 取证失败）');
    await page.click('.cm-content');
    await page.keyboard.press('Escape');
    // 键盘 Tab 走到工具栏按钮，验证焦点环保留
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const ae = document.activeElement;
        return ae?.dataset?.key ? ae.dataset.key : '';
      });
      if (info) {
        const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
        (ring && ring !== 'none' ? ok : fail)(`工具栏按钮 ${info} 聚焦 box-shadow=${ring}`);
        await page.screenshot({ path: `${OUT}/${sc.name}-toolbar-focus.png` });
        break;
      }
    }

    // 保存：脏标记消失
    await page.click('.editor-head-row.actions .toolbar > .btn[data-key="save"]');
    await sleep(800);
    const afterSave = await page.evaluate(() => ({
      dirty: document.querySelector('.statusbar .sb-dirty')?.textContent ?? '',
    }));
    (afterSave.dirty === '' ? ok : fail)(`保存后状态栏="${afterSave.dirty || '(无脏标记)'}"`);
    await page.screenshot({ path: `${OUT}/${sc.name}-ini-saved.png` });
  } else if (sc.editor) {
    fail('编辑器流程未完成（INI 未打开）');
  }

  // 场景内交互：缩放（125% / 窄窗口）、分隔条拖动、工具栏溢出
  if (sc.name === 'image-100-blur0') {
    await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1.25 });
    await sleep(700);
    await page.screenshot({ path: `${OUT}/${sc.name}-zoom125-narrow.png` });
    // 更窄（860px）时动作收进「更多」溢出菜单
    await page.setViewport({ width: 860, height: 760, deviceScaleFactor: 1.25 });
    await sleep(700);
    const overflowBtn = await page.evaluate(() => Boolean(document.querySelector('.editor-head-row.actions .toolbar button[title="更多"]')));
    (overflowBtn ? ok : fail)('窄窗口(860px)下工具栏溢出菜单出现');
    await page.screenshot({ path: `${OUT}/${sc.name}-toolbar-overflow.png` });
    await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1.25 });
    await sleep(500);
    const splitter = await page.$('.splitter');
    if (splitter) {
      const box = await splitter.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await sleep(400);
      ok('splitter 拖动完成');
    } else fail('未找到 .splitter');
    await page.screenshot({ path: `${OUT}/${sc.name}-after-splitter-drag.png` });
  }

  // 设置页与云仓库
  const navBtns = await page.$$('.desktop-rail-button');
  for (const btn of navBtns) {
    const label = await btn.evaluate((el) => el.getAttribute('title') || el.textContent || '');
    if (label.includes('设置') || label.toLowerCase().includes('settings')) { await btn.click(); break; }
  }
  await sleep(700);
  await page.screenshot({ path: `${OUT}/${sc.name}-settings.png` });

  // 设置页整页背景统一验证：header/nav/content 计算样式
  const settingsProbe = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const cs = (sel) => { const el = q(sel); return el ? getComputedStyle(el) : null; };
    const pageEl = q('.settings-page');
    const header = cs('.settings-page-header');
    const nav = cs('.settings-page-body .settings-nav');
    const content = cs('.settings-page-body .settings-content');
    const bg = (s) => (s ? s.backgroundColor : null);
    return {
      pageBg: pageEl ? getComputedStyle(pageEl).backgroundColor : null,
      pageBefore: pageEl ? getComputedStyle(pageEl, '::before').content : null,
      headerBg: bg(header),
      headerFilter: header ? header.backdropFilter : null,
      navBg: bg(nav),
      navFilter: nav ? nav.backdropFilter : null,
      contentBg: bg(content),
      contentFilter: content ? content.backdropFilter : null,
      row: (() => { const r = document.querySelector('.setting-row'); return r ? getComputedStyle(r).borderBottomStyle : null; })(),
    };
  });
  if (settingsProbe.row !== null) {
    (settingsProbe.row !== 'dashed' ? ok : fail)(`setting-row 边框样式=${settingsProbe.row} (expect 非 dashed)`);
  }
  if (expectBackdrop) {
    // 整页透出背景：settings-page 本体透明（不整页加 opacity/遮罩），
    // header/nav/content 各自单层 veil（veil-panel→alpha .58 / veil-side→alpha .64），无 blur 叠加
    (settingsProbe.pageBg === 'rgba(0, 0, 0, 0)' ? ok : fail)(`settings-page 本体透明=${settingsProbe.pageBg}`);
    (settingsProbe.pageBefore === 'none' ? ok : fail)(`settings-page::before=${settingsProbe.pageBefore} (expect none，无二次遮罩)`);
    (settingsProbe.headerBg?.includes('/ 0.58)') ? ok : fail)(`settings header 底色=${settingsProbe.headerBg} (expect veil-panel 单层 alpha .58)`);
    (settingsProbe.navBg?.includes('/ 0.64)') ? ok : fail)(`settings nav 底色=${settingsProbe.navBg} (expect veil-side 单层 alpha .64)`);
    (settingsProbe.contentBg?.includes('/ 0.58)') ? ok : fail)(`settings content 底色=${settingsProbe.contentBg} (expect veil-panel 单层 alpha .58)`);
    (settingsProbe.headerFilter === 'none' && settingsProbe.navFilter === 'none' && settingsProbe.contentFilter === 'none'
      ? ok : fail)(`设置页无 blur 叠加: header=${settingsProbe.headerFilter} nav=${settingsProbe.navFilter} content=${settingsProbe.contentFilter}`);
  } else {
    // 无背景：保持原 surface 微对比分区（不透明）
    (settingsProbe.navBg === 'rgb(255, 255, 255)' || settingsProbe.navBg?.startsWith('rgb(') ? ok : fail)(`无背景 nav 底色=${settingsProbe.navBg} (expect 不透明 surface-1)`);
    (settingsProbe.contentBg?.startsWith('rgb(') ? ok : fail)(`无背景 content 底色=${settingsProbe.contentBg} (expect 不透明 surface-0)`);
  }
  ok(`设置页 nav/content 底色: ${settingsProbe.navBg} / ${settingsProbe.contentBg}`);

  // 逐个设置 Tab 截图 + 遮罩一致性（快捷键 / 外观与布局 / 账号）
  const tabMap = [['快捷键', 'shortcuts'], ['外观与布局', 'appearance'], ['账号', 'account']];
  for (const [label, key] of tabMap) {
    const clicked = await page.evaluate((name) => {
      for (const item of document.querySelectorAll('.settings-nav-item')) {
        if (item.textContent?.includes(name)) { item.click(); return true; }
      }
      return false;
    }, label);
    await sleep(500);
    (clicked ? ok : fail)(`设置 Tab「${label}」已切换`);
    await page.screenshot({ path: `${OUT}/${sc.name}-settings-${key}.png` });
    if (expectBackdrop && clicked) {
      const tabBg = await page.evaluate(() => {
        const el = document.querySelector('.settings-page-body .settings-content');
        return el ? getComputedStyle(el).backgroundColor : null;
      });
      if (tabBg?.includes('/ 0.58)')) ok(`Tab「${label}」content 底色=${tabBg} (veil-panel)`);
      else fail(`Tab「${label}」content 底色=${tabBg} (expect veil-panel)`);
    }
  }
  // 回到第一个 Tab（后续场景从这里继续）
  await page.evaluate(() => {
    for (const item of document.querySelectorAll('.settings-nav-item')) {
      if (item.textContent?.includes('外观与布局')) { item.click(); return; }
    }
  });
  await sleep(300);
  if (sc.name === 'image-100-blur0') {
    await page.screenshot({ path: `${OUT}/${sc.name}-settings-full.png` });
  }

  // 云仓库
  for (const btn of navBtns) {
    const label = await btn.evaluate((el) => el.getAttribute('title') || el.textContent || '');
    if (label.includes('云仓库') || label.toLowerCase().includes('cloud')) { await btn.click(); break; }
  }
  await sleep(700);
  const cloudProbe = await page.evaluate(() => {
    const textEls = Array.from(document.querySelectorAll('.cloud-bag-panel, .community-panel, [class*="cloud"]'));
    let minContrastSample = '';
    for (const el of textEls) {
      const t = (el.textContent || '').trim();
      if (t.length > 10) { minContrastSample = t.slice(0, 40); break; }
    }
    return { sample: minContrastSample, bg: (() => { const el = document.querySelector('.community-panel'); return el ? getComputedStyle(el).backgroundColor : null; })() };
  });
  ok(`云仓库面板底色=${cloudProbe.bg} 文本样本="${cloudProbe.sample}"`);
  await page.screenshot({ path: `${OUT}/${sc.name}-cloudbag.png` });
  await page.close();
  console.log(`== ${sc.name} done`);
}

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
