'use strict';

/**
 * 双档换速寿命核算（精确分数，基于 BigInt）
 *
 * 针对双档换速选出的方案：固定第一级（两档共用的有向齿轮对 d→w）+
 * 每档换装第二级（有向齿轮对 a_s→b_s）。一轮计划指：在档位 s 下让输入轴
 * 转 N_s 圈（正整数），两档互斥运行，同一轮中两档负荷先后叠加。
 *
 * 档位 s 下每轮各齿轮实际转数（按齿数比精确计算）：
 *   固定主动轮：N_s 转
 *   固定从动轮（中间轴）：N_s·d/w 转
 *   档位 s 换装主动轮（与固定从动轮同轴）：N_s·d/w 转
 *   档位 s 换装从动轮（输出轴）：N_s·d/w·a_s/b_s 转
 *
 * 每枚实物齿轮的每轮合计消耗 = 其参与的全部档位在该轮中的转数之和：
 *   - 固定级两枚齿轮累计两档负荷；
 *   - 跨档重复使用的换装齿轮（同一编号实物）同样累计两档负荷；
 *   - 未装入某档的齿轮，该档不计。
 * 全部以约分分数（BigInt）计算，无浮点误差。
 *
 * 设齿轮 g 每轮合计消耗 c_g、剩余允许转数 L_g（非负整数），
 * 完整执行 R 轮要求 R·c_g ≤ L_g，即 R ≤ ⌊L_g/c_g⌋；
 * 全部齿轮均不超限的最多完整轮数 R* = min_g ⌊L_g/c_g⌋，
 * 取到该最小值的齿轮为共同限制的齿轮；恰好达到限额（余量为 0）视为可执行。
 * R* = 0 时表示存在齿轮连一整轮也无法承受，结果中说明受限原因。
 */

const { makeFrac, MAX_TEETH } = require('./search');

/** 每档每轮计划输入圈数 / 每枚齿轮剩余允许转数的上限（10¹²） */
const MAX_TURNS = 1000000000000n;

/**
 * 解析整数字段：接受 JSON number（安全整数）或纯数字字符串，返回 BigInt。
 * @returns {{ok:true,value:bigint}|{ok:false,error:string}}
 */
function parseBigIntValue(raw, label, { min = 0n, max = MAX_TURNS, kind = '非负整数' } = {}) {
  let v;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      return { ok: false, error: `${label}需为 ${min}～${max} 的${kind}` };
    }
    v = BigInt(raw);
  } else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) {
    v = BigInt(raw.trim());
  } else {
    return { ok: false, error: `${label}需为 ${min}～${max} 的${kind}` };
  }
  if (v < min || v > max) {
    return { ok: false, error: `${label}需为 ${min}～${max} 的${kind}` };
  }
  return { ok: true, value: v };
}

/** 校验单枚齿轮引用 {id, teeth} */
function validateGearRef(raw, label) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${label}数据格式不正确` };
  const id = String(raw.id ?? '').trim();
  if (!id) return { ok: false, error: `${label}缺少编号` };
  const teeth = Number(raw.teeth);
  if (!Number.isInteger(teeth) || teeth < 1 || teeth > MAX_TEETH) {
    return { ok: false, error: `${label} ${id} 的齿数需为 1～${MAX_TEETH} 的整数` };
  }
  return { ok: true, gear: { id, teeth } };
}

/** 校验一个有向齿轮对 {drive, driven}（两轮不得为同一枚） */
function validateStageRef(raw, label) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${label}数据格式不正确` };
  const drive = validateGearRef(raw.drive, `${label}主动轮`);
  if (!drive.ok) return drive;
  const driven = validateGearRef(raw.driven, `${label}从动轮`);
  if (!driven.ok) return driven;
  if (drive.gear.id === driven.gear.id) {
    return { ok: false, error: `${label}主动轮与从动轮不能是同一枚齿轮（${drive.gear.id}）` };
  }
  return { ok: true, stage: { drive: drive.gear, driven: driven.gear } };
}

/**
 * 校验寿命核算请求：
 *   - fixedStage：固定第一级（两档共用的有向齿轮对）；
 *   - speeds：恰好 2 个档位，各带每轮计划输入圈数（正整数）与换装第二级；
 *     档内 4 枚齿轮不得复用（换装级不得占用固定级实物）；
 *     同一编号实物跨档重复出现时齿数必须一致；
 *   - remaining：每枚参与齿轮的剩余允许转数（非负整数），
 *     必须恰好覆盖全部参与齿轮，每枚一次、不多不少。
 *
 * @param {*} body
 * @returns {{ok:true,fixedStage:object,speeds:Array,remaining:Map<string,bigint>}|{ok:false,error:string}}
 */
function validateLifeInput(body) {
  const input = body && typeof body === 'object' ? body : {};

  // ---- 固定第一级 ----
  const fixedChecked = validateStageRef(input.fixedStage, '固定第一级');
  if (!fixedChecked.ok) return fixedChecked;
  const fixedStage = fixedChecked.stage;
  const fixedIds = [fixedStage.drive.id, fixedStage.driven.id];
  const teethById = new Map([
    [fixedStage.drive.id, fixedStage.drive.teeth],
    [fixedStage.driven.id, fixedStage.driven.teeth],
  ]);

  // ---- 恰好 2 个档位：每轮计划输入圈数 + 换装第二级 ----
  if (!Array.isArray(input.speeds) || input.speeds.length !== 2) {
    return { ok: false, error: '档位列表（speeds）必须恰好 2 个' };
  }
  const speeds = [];
  for (let i = 0; i < 2; i++) {
    const row = input.speeds[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `第 ${i + 1} 档数据格式不正确` };
    }
    const name = String(row.name ?? '').trim() || `档位 ${i + 1}`;
    if (name.length > 30) return { ok: false, error: `第 ${i + 1} 档名称不能超过 30 个字符` };
    const turns = parseBigIntValue(row.inputTurns, `${name}的每轮计划输入圈数`, {
      min: 1n,
      kind: '正整数',
    });
    if (!turns.ok) return { ok: false, error: turns.error };
    const swapChecked = validateStageRef(row.swapStage, `${name}换装第二级`);
    if (!swapChecked.ok) return swapChecked;
    const swap = swapChecked.stage;
    for (const g of [swap.drive, swap.driven]) {
      if (fixedIds.includes(g.id)) {
        return {
          ok: false,
          error: `${name}换装第二级齿轮 ${g.id} 与固定第一级重复（档内 4 枚齿轮不得复用）`,
        };
      }
      const seen = teethById.get(g.id);
      if (seen !== undefined && seen !== g.teeth) {
        return {
          ok: false,
          error: `齿轮 ${g.id} 在不同档位中的齿数不一致（${seen} / ${g.teeth}）：同一实物齿轮齿数必须相同`,
        };
      }
      teethById.set(g.id, g.teeth);
    }
    speeds.push({ name, inputTurns: turns.value, swapStage: swap });
  }

  // ---- 每枚参与齿轮的剩余允许转数（非负整数，恰好覆盖） ----
  if (!Array.isArray(input.remaining)) {
    return { ok: false, error: '剩余允许转数列表（remaining）格式不正确' };
  }
  const remaining = new Map();
  for (let i = 0; i < input.remaining.length; i++) {
    const row = input.remaining[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `第 ${i + 1} 行剩余允许转数数据格式不正确` };
    }
    const id = String(row.id ?? '').trim();
    if (!id) return { ok: false, error: `第 ${i + 1} 行剩余允许转数缺少齿轮编号` };
    if (!teethById.has(id)) {
      return { ok: false, error: `剩余允许转数包含未参与本方案的齿轮：${id}` };
    }
    if (remaining.has(id)) {
      return { ok: false, error: `齿轮 ${id} 的剩余允许转数重复填写` };
    }
    const turns = parseBigIntValue(row.turns, `齿轮 ${id} 的剩余允许转数`, {
      min: 0n,
      kind: '非负整数',
    });
    if (!turns.ok) return { ok: false, error: turns.error };
    remaining.set(id, turns.value);
  }
  for (const id of teethById.keys()) {
    if (!remaining.has(id)) {
      return { ok: false, error: `缺少参与齿轮 ${id} 的剩余允许转数` };
    }
  }

  return { ok: true, fixedStage, speeds, remaining };
}

/** 分数相加（均约分） */
function addFrac(x, y) {
  return makeFrac(x.num * y.den + y.num * x.den, x.den * y.den);
}

/**
 * 主入口：按齿数比求每轮每枚齿轮实际转数 → 每轮合计消耗 → 最多完整轮数。
 *
 * @param {{drive:object,driven:object}} fixedStage 固定第一级（已校验）
 * @param {Array<{name:string,inputTurns:bigint,swapStage:object}>} speeds 恰好 2 档（已校验）
 * @param {Map<string,bigint>} remaining 每枚参与齿轮的剩余允许转数（已校验）
 */
function planLife(fixedStage, speeds, remaining) {
  const D = BigInt(fixedStage.drive.teeth);
  const W = BigInt(fixedStage.driven.teeth);
  const fixedRatio = makeFrac(D, W); // 固定级速比（主动/从动）

  // 每档：按齿数比连乘求各齿轮每轮实际转数（精确分数）
  const speedPlans = speeds.map((sp) => {
    const A = BigInt(sp.swapStage.drive.teeth);
    const B = BigInt(sp.swapStage.driven.teeth);
    const swapRatio = makeFrac(A, B);
    const midTurns = makeFrac(sp.inputTurns * fixedRatio.num, fixedRatio.den); // 中间轴每轮转数
    const outTurns = makeFrac(midTurns.num * swapRatio.num, midTurns.den * swapRatio.den); // 输出轴每轮转数
    return {
      name: sp.name,
      inputTurns: sp.inputTurns,
      swapStage: { ...sp.swapStage, stageRatio: swapRatio },
      swapRatio,
      totalRatio: makeFrac(fixedRatio.num * swapRatio.num, fixedRatio.den * swapRatio.den),
      revs: {
        fixedDrive: makeFrac(sp.inputTurns, 1n),
        fixedDriven: midTurns,
        swapDrive: midTurns,
        swapDriven: outTurns,
      },
    };
  });

  // 汇总每枚实物齿轮：承担角色、分档每轮转数（未装入该档为 null）、每轮合计。
  // 固定级两枚齿轮累计两档负荷；跨档重复使用的换装齿轮（同一编号）同样累计；
  // 未装入某档的齿轮该档不计。登记顺序 = 传动链首次出现顺序。
  const gearMap = new Map();
  const ensure = (gear) => {
    let rec = gearMap.get(gear.id);
    if (!rec) {
      rec = { id: gear.id, teeth: gear.teeth, roles: [], perSpeed: [null, null] };
      gearMap.set(gear.id, rec);
    }
    return rec;
  };

  const driveRec = ensure(fixedStage.drive);
  driveRec.roles.push('固定级主动轮（两档共用）');
  const drivenRec = ensure(fixedStage.driven);
  drivenRec.roles.push('固定级从动轮（两档共用）');

  speedPlans.forEach((sp, si) => {
    driveRec.perSpeed[si] = sp.revs.fixedDrive;
    drivenRec.perSpeed[si] = sp.revs.fixedDriven;
    const swapDriveRec = ensure(sp.swapStage.drive);
    swapDriveRec.roles.push(`${sp.name}换装主动轮`);
    swapDriveRec.perSpeed[si] = sp.revs.swapDrive;
    const swapDrivenRec = ensure(sp.swapStage.driven);
    swapDrivenRec.roles.push(`${sp.name}换装从动轮`);
    swapDrivenRec.perSpeed[si] = sp.revs.swapDriven;
  });

  const gears = [...gearMap.values()].map((rec) => {
    const perRound = rec.perSpeed.reduce(
      (acc, f) => (f ? addFrac(acc, f) : acc),
      { num: 0n, den: 1n },
    );
    const allowance = remaining.get(rec.id);
    // ⌊L / c⌋ = ⌊L·den / num⌋；c > 0 恒成立（计划圈数为正整数、齿数为正）
    const maxRounds = (allowance * perRound.den) / perRound.num;
    return { ...rec, perRound, allowance, maxRounds };
  });

  // 全部齿轮均不超限的最多完整轮数 = 各齿轮可承受轮数的最小值
  let maxRounds = null;
  for (const g of gears) {
    if (maxRounds === null || g.maxRounds < maxRounds) maxRounds = g.maxRounds;
  }
  const limitingGears = gears.filter((g) => g.maxRounds === maxRounds).map((g) => g.id);

  // 执行 maxRounds 轮后的累计消耗与余量（恰好达到限额视为可执行：余量可为 0）
  for (const g of gears) {
    g.limiting = g.maxRounds === maxRounds;
    g.consumed = makeFrac(maxRounds * g.perRound.num, g.perRound.den);
    g.remainingAfter = makeFrac(
      g.allowance * g.perRound.den - maxRounds * g.perRound.num,
      g.perRound.den,
    );
    g.atLimit = g.remainingAfter.num === 0n;
  }

  const fracText = (f) => (f.den === 1n ? `${f.num}` : `${f.num}/${f.den}`);
  let message;
  if (maxRounds >= 1n) {
    message =
      `在全部 ${gears.length} 枚参与齿轮均不超过剩余允许转数的前提下，` +
      `最多可完整执行 ${maxRounds} 轮计划（恰好达到限额视为可执行）；` +
      `共同限制的齿轮：${limitingGears.join('、')}。`;
  } else {
    const details = gears
      .filter((g) => g.limiting)
      .map((g) => `${g.id}（每轮合计消耗 ${fracText(g.perRound)} 转，剩余允许 ${g.allowance} 转）`)
      .join('；');
    message =
      `零轮可完整执行：${limitingGears.length} 枚齿轮的剩余允许转数不足以完成一整轮计划——${details}。` +
      '请翻新或更换这些齿轮，或降低每档每轮计划输入圈数。';
  }

  return {
    fixedStage: { ...fixedStage, stageRatio: fixedRatio },
    speeds: speedPlans,
    gears,
    gearCount: gears.length,
    maxRounds,
    feasible: maxRounds >= 1n,
    limitingGears,
    message,
  };
}

module.exports = {
  MAX_TURNS,
  validateLifeInput,
  planLife,
};
