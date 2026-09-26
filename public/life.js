'use strict';

/* 与后端 MAX_TURNS 保持一致（仅用于前端提示与范围校验） */
const MAX_TURNS = 1000000000000n;
/** 逐轮累计表最多展开的轮数（轮数较多时只展示每轮消耗 + 执行后余量） */
const ROUND_TABLE_LIMIT = 12;

const schemeHint = document.getElementById('scheme-hint');
const schemePanel = document.getElementById('scheme-panel');
const turnsGrid = document.getElementById('turns-grid');
const remainingRowsBox = document.getElementById('remaining-rows');
const form = document.getElementById('life-form');
const formError = document.getElementById('form-error');
const resultPanel = document.getElementById('result-panel');
const resultSummary = document.getElementById('result-summary');
const verdictAlert = document.getElementById('verdict-alert');
const resultDetail = document.getElementById('result-detail');

/**
 * 示例方案（双档换速示例页的延伸）：
 * 固定第一级 G1(10)→G2(60)；档位一换装 G3(20)→G4(40)；档位二换装 G3(20)→G5(30)。
 * G3 跨档重复使用（两档换装主动轴位同一实物），其负荷累计两档。
 */
const EXAMPLE_SCHEME = {
  fixedStage: {
    drive: { id: 'G1', teeth: 10 },
    driven: { id: 'G2', teeth: 60 },
  },
  speeds: [
    {
      name: '档位一',
      inputTurns: '100',
      swapStage: { drive: { id: 'G3', teeth: 20 }, driven: { id: 'G4', teeth: 40 } },
    },
    {
      name: '档位二',
      inputTurns: '60',
      swapStage: { drive: { id: 'G3', teeth: 20 }, driven: { id: 'G5', teeth: 30 } },
    },
  ],
  remaining: { G1: '100000', G2: '20000', G3: '15000', G4: '9000', G5: '8000' },
};

/** 当前核算方案：{ fixedStage, speeds:[{name,inputTurns?,swapStage}], remaining?: {id: turns} } */
let scheme = null;

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/* ---------------- 方案结构校验 ---------------- */

function isGearRef(g) {
  return g && typeof g === 'object' &&
    typeof g.id === 'string' && g.id.trim() &&
    Number.isInteger(g.teeth) && g.teeth >= 1 && g.teeth <= 100000;
}

function isStageRef(st) {
  return st && isGearRef(st.drive) && isGearRef(st.driven) && st.drive.id !== st.driven.id;
}

function isValidSchemeShape(sc) {
  if (!sc || typeof sc !== 'object') return false;
  if (!isStageRef(sc.fixedStage)) return false;
  if (!Array.isArray(sc.speeds) || sc.speeds.length !== 2) return false;
  return sc.speeds.every((sp) => sp && isStageRef(sp.swapStage));
}

/** 参与齿轮清单（传动链首次出现顺序，跨档重复使用的同一实物只列一次，角色累计） */
function participatingGears(sc) {
  const list = [];
  const seen = new Map();
  const add = (gear, role) => {
    if (seen.has(gear.id)) {
      seen.get(gear.id).roles.push(role);
      return;
    }
    const rec = { id: gear.id, teeth: gear.teeth, roles: [role] };
    seen.set(gear.id, rec);
    list.push(rec);
  };
  add(sc.fixedStage.drive, '固定级主动轮（两档共用）');
  add(sc.fixedStage.driven, '固定级从动轮（两档共用）');
  sc.speeds.forEach((sp, i) => {
    const name = String(sp.name ?? '').trim() || `档位 ${i + 1}`;
    add(sp.swapStage.drive, `${name}换装主动轮`);
    add(sp.swapStage.driven, `${name}换装从动轮`);
  });
  return list;
}

/* ---------------- 方案区与输入区渲染 ---------------- */

function gearText(g) {
  return `<span class="gear-id">${g.id}</span> · ${g.teeth} 齿`;
}

function renderScheme() {
  // 方案表：固定第一级 + 两档换装第二级
  schemePanel.innerHTML = '';
  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr><th>部位</th><th>主动轮（编号 / 齿数）</th><th>从动轮（编号 / 齿数）</th></tr></thead>`;
  const tbody = el('tbody');
  const rows = [
    ['固定第一级（两档共用）', scheme.fixedStage.drive, scheme.fixedStage.driven],
    [`${scheme.speeds[0].name} · 换装第二级`, scheme.speeds[0].swapStage.drive, scheme.speeds[0].swapStage.driven],
    [`${scheme.speeds[1].name} · 换装第二级`, scheme.speeds[1].swapStage.drive, scheme.speeds[1].swapStage.driven],
  ];
  for (const [label, d, w] of rows) {
    const tr = el('tr');
    tr.innerHTML = `<td>${label}</td><td>${gearText(d)}</td><td>${gearText(w)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  schemePanel.appendChild(table);

  // 每档每轮计划输入圈数
  turnsGrid.innerHTML = '';
  scheme.speeds.forEach((sp) => {
    const label = el('label', 'field');
    label.innerHTML = `<span>${sp.name} · 每轮计划输入圈数（输入轴转数）</span>`;
    const input = document.createElement('input');
    input.className = 'turns-input';
    input.type = 'text';
    input.placeholder = '正整数，如 100';
    input.value = sp.inputTurns ?? '';
    label.appendChild(input);
    turnsGrid.appendChild(label);
  });

  // 各参与齿轮剩余允许转数
  remainingRowsBox.innerHTML = '';
  for (const g of participatingGears(scheme)) {
    const row = el('div', 'life-row');
    const preset = scheme.remaining && scheme.remaining[g.id] !== undefined
      ? scheme.remaining[g.id]
      : '';
    const label = el('div', 'life-gear');
    label.innerHTML = `
      <span class="gear-id">${g.id}</span> · ${g.teeth} 齿
      <div class="roles">${g.roles.join('；')}</div>`;
    const input = document.createElement('input');
    input.className = 'remaining-input';
    input.dataset.gearId = g.id;
    input.type = 'text';
    input.placeholder = '非负整数，如 100000';
    input.value = preset;
    row.appendChild(label);
    row.appendChild(input);
    remainingRowsBox.appendChild(row);
  }
}

function loadInitialScheme() {
  let carried = null;
  try {
    carried = JSON.parse(sessionStorage.getItem('lifeScheme') || 'null');
  } catch (_) {
    carried = null;
  }
  if (isValidSchemeShape(carried)) {
    scheme = carried;
    schemeHint.hidden = false;
    schemeHint.className = 'alert ok';
    schemeHint.textContent =
      '✓ 已从双档换速结果带入固定第一级与两档换装第二级；请填写每档每轮计划输入圈数与各齿轮剩余允许转数。';
  } else {
    scheme = JSON.parse(JSON.stringify(EXAMPLE_SCHEME));
    schemeHint.hidden = false;
    schemeHint.className = 'alert warn';
    schemeHint.innerHTML =
      '未检测到双档换速结果，当前为<strong>示例方案</strong>。可先在 ' +
      '<a href="/dual-speed">双档换速</a> 页完成选配，再点结果区“前往寿命核算”自动带入选中方案。';
  }
  renderScheme();
}

document.getElementById('btn-example').addEventListener('click', () => {
  scheme = JSON.parse(JSON.stringify(EXAMPLE_SCHEME));
  schemeHint.hidden = false;
  schemeHint.className = 'alert warn';
  schemeHint.textContent = '已填入示例方案。';
  renderScheme();
  resultPanel.hidden = true;
  formError.hidden = true;
});

/* ---------------- 采集与提交 ---------------- */

function parseNonNegBigInt(raw, label, { positive = false } = {}) {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`${label}需为${positive ? '正整数' : '非负整数'}`);
  }
  const v = BigInt(s);
  if (positive && v < 1n) throw new Error(`${label}需为正整数`);
  if (v > MAX_TURNS) throw new Error(`${label}需在 ${positive ? '1' : '0'}～${MAX_TURNS} 之间`);
  return v;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  resultPanel.hidden = true;

  let payload;
  try {
    const turnsInputs = [...turnsGrid.querySelectorAll('.turns-input')];
    const speeds = scheme.speeds.map((sp, i) => {
      parseNonNegBigInt(turnsInputs[i].value, `${sp.name}的每轮计划输入圈数`, { positive: true });
      return {
        name: sp.name,
        inputTurns: turnsInputs[i].value.trim(),
        swapStage: sp.swapStage,
      };
    });
    const remaining = [];
    for (const input of remainingRowsBox.querySelectorAll('.remaining-input')) {
      parseNonNegBigInt(input.value, `齿轮 ${input.dataset.gearId} 的剩余允许转数`);
      remaining.push({ id: input.dataset.gearId, turns: input.value.trim() });
    }
    payload = { fixedStage: scheme.fixedStage, speeds, remaining };
  } catch (e) {
    formError.textContent = e.message;
    formError.hidden = false;
    return;
  }

  try {
    const resp = await fetch('/api/life', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '寿命核算失败');

    resultPanel.hidden = false;
    resultDetail.innerHTML = '';
    renderResult(data);
  } catch (e) {
    resultPanel.hidden = false;
    resultDetail.innerHTML = '';
    resultSummary.textContent = '';
    verdictAlert.hidden = false;
    verdictAlert.className = 'alert error';
    verdictAlert.textContent = `请求出错：${e.message}`;
  }
});

/* ---------------- 结果渲染 ---------------- */

/** 序列化分数 → 展示文本（整数直接显示整数；分数附最多 10 位精确小数） */
function fmtFrac(f) {
  if (!f) return '—';
  return f.den === '1' ? f.num : `${f.num}/${f.den} ≈ ${f.decimal}`;
}

/** 序列化分数 → 简短文本（仅整数或 分子/分母，用于公式与角标内嵌） */
function fmtFracShort(f) {
  if (!f) return '—';
  return f.den === '1' ? f.num : `${f.num}/${f.den}`;
}

function gcdBig(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

/** BigInt 分数 k 倍并约分（逐轮累计表用，完全在前端按整数计算） */
function scaleFrac(f, k) {
  const num = BigInt(f.num) * k;
  const den = BigInt(f.den);
  const g = gcdBig(num, den);
  return { num: num / g, den: den / g };
}

/** BigInt 分数 → 字符串（分数 + 最多 4 位精确小数，无浮点误差） */
function fmtBigFrac(f) {
  if (f.den === 1n) return f.num.toString();
  const intPart = f.num / f.den;
  let rem = f.num % f.den;
  let fracStr = '';
  for (let i = 0; i < 4 && rem > 0n; i++) {
    rem *= 10n;
    fracStr += (rem / f.den).toString();
    rem %= f.den;
  }
  return fracStr ? `${f.num}/${f.den} ≈ ${intPart}.${fracStr}` : `${f.num}/${f.den} ≈ ${intPart}`;
}

/** ① 每轮消耗明细：每枚齿轮分档转数 + 每轮合计（未装入该档标注“不计”） */
function renderPerRoundTable(data) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '① 逐轮消耗（每轮相同：分档实际转数与每轮合计，精确分数）'));
  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr>
      <th>齿轮（编号 · 齿数）</th><th>承担角色</th>
      <th>${data.speeds[0].name}<br/>每轮转数</th>
      <th>${data.speeds[1].name}<br/>每轮转数</th>
      <th>每轮合计消耗（转）</th>
    </tr></thead>`;
  const tbody = el('tbody');
  data.gears.forEach((g) => {
    const tr = el('tr');
    const cell = (f) =>
      f ? `<td class="frac">${fmtFrac(f)}</td>` : '<td class="muted">— 未装入，不计</td>';
    tr.innerHTML = `
      <td><span class="gear-id">${g.id}</span> · ${g.teeth} 齿</td>
      <td style="font-size:12px">${g.roles.join('；')}</td>
      ${cell(g.perSpeed[0])}
      ${cell(g.perSpeed[1])}
      <td class="frac"><strong>${fmtFrac(g.perRound)}</strong></td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  const speedNote = data.speeds
    .map((sp) =>
      `${sp.name}每轮输入 ${sp.inputTurns} 圈：中间轴（固定从动轮 / 换装主动轮）转 ` +
      `${fmtFrac(sp.revs.fixedDriven)}，输出轴转 ${fmtFrac(sp.revs.swapDriven)}`,
    )
    .join('；');
  wrap.appendChild(el('p', 'muted', speedNote + '。'));
  return wrap;
}

/** ② 逐轮累计消耗（轮数较少时逐轮展开；轮数过多时改为公式说明） */
function renderRoundCumulative(data, maxRounds) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '② 逐轮累计消耗（执行到该轮后各齿轮累计转数）'));

  if (maxRounds === 0n) {
    wrap.appendChild(el('p', 'muted', '最大可执行轮数为 0，不展开逐轮累计（连一整轮也无法完整执行）。'));
    return wrap;
  }

  if (maxRounds > BigInt(ROUND_TABLE_LIMIT)) {
    wrap.appendChild(
      el('p', 'muted',
        `最多可执行 ${maxRounds} 轮（超过 ${ROUND_TABLE_LIMIT} 轮，不逐轮展开）：每轮消耗与第①表完全相同，` +
        '执行 k 轮后某齿轮的累计消耗 = k × 其每轮合计；最终执行后余量见第③表。'),
    );
    return wrap;
  }

  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr>
      <th>轮次</th>
      ${data.gears.map((g) => `<th><span class="gear-id">${g.id}</span> 累计消耗</th>`).join('')}
    </tr></thead>`;
  const tbody = el('tbody');
  for (let k = 1n; k <= maxRounds; k++) {
    const tr = el('tr');
    const cells = data.gears
      .map((g) => `<td class="life-round-cell">${fmtBigFrac(scaleFrac(g.perRound, k))}</td>`)
      .join('');
    tr.innerHTML = `<td>第 ${k} 轮后</td>${cells}`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** ③ 执行后余量：剩余允许转数、累计消耗、余量与状态 */
function renderRemainderTable(data, maxRounds) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', `③ 完整执行 ${maxRounds} 轮后的累计消耗与余量`));
  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr>
      <th>齿轮</th><th>剩余允许转数</th><th>${maxRounds} 轮累计消耗</th>
      <th>执行后余量</th><th>该齿轮可承受轮数</th><th>状态</th>
    </tr></thead>`;
  const tbody = el('tbody');
  data.gears.forEach((g) => {
    const tags = [];
    if (g.limiting) tags.push('<span class="badge badge-life">共同限制</span>');
    if (g.atLimit) tags.push('<span class="badge badge-limit">恰好用尽</span>');
    if (!g.limiting && !g.atLimit) tags.push('<span class="diag-ok">富余</span>');
    const tr = el('tr');
    tr.innerHTML = `
      <td><span class="gear-id">${g.id}</span> · ${g.teeth} 齿</td>
      <td class="frac">${g.allowance}</td>
      <td class="frac">${fmtFrac(g.consumed)}</td>
      <td class="frac"><strong>${fmtFrac(g.remainingAfter)}</strong></td>
      <td class="frac">⌊${g.allowance} ÷ ${fmtFracShort(g.perRound)}⌋ = ${g.maxRounds} 轮</td>
      <td>${tags.join(' ')}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** ④ 共同限制的齿轮 */
function renderLimitingPanel(data, maxRounds) {
  const wrap = el('div', 'unused-panel');
  wrap.appendChild(el('h3', null, `④ 共同限制的齿轮（最大可执行轮数 ${maxRounds} 由其决定）`));
  const chips = el('div', 'chip-list');
  data.gears
    .filter((g) => g.limiting)
    .forEach((g) => {
      const chip = el('span', 'chip chip-buy');
      chip.textContent =
        `${g.id}：每轮合计 ${fmtFracShort(g.perRound)} 转，剩余允许 ${g.allowance} 转` +
        ` → 至多 ${g.maxRounds} 轮${g.atLimit ? '（恰好达到限额）' : ''}`;
      chips.appendChild(chip);
    });
  wrap.appendChild(chips);
  return wrap;
}

function renderResult(data) {
  const maxRounds = BigInt(data.maxRounds);

  resultSummary.textContent =
    `参与齿轮 ${data.gearCount} 枚 · ` +
    data.speeds.map((sp) => `${sp.name}每轮输入 ${sp.inputTurns} 圈`).join('，') +
    ` · 最多完整执行 ${maxRounds} 轮`;

  verdictAlert.hidden = false;
  verdictAlert.className = `alert ${data.feasible ? 'ok' : 'error'}`;
  verdictAlert.innerHTML =
    `<strong>${data.feasible ? `最多可完整执行 ${maxRounds} 轮` : '零轮可执行'}：</strong>${data.message}`;

  resultDetail.appendChild(renderPerRoundTable(data));
  resultDetail.appendChild(renderRoundCumulative(data, maxRounds));
  resultDetail.appendChild(renderRemainderTable(data, maxRounds));
  resultDetail.appendChild(renderLimitingPanel(data, maxRounds));
}

/* ---------------- 初始化 ---------------- */
loadInitialScheme();
