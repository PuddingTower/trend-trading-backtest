/**
 * L2 成交量占比平方根冲击模型（架构白皮书 §2.4.3 的第二级成本算子）。
 *
 * 固定滑点（L1）回答的是"小单要付多少买卖价差"；它回答不了"我这笔单子本身
 * 压动了价格多少"。容量测试（500 万本金和 5 亿本金的 Alpha 衰减）必须用冲击模型：
 *
 *   ΔP = η · σ_daily · (Q / V)^δ        （δ≈0.5，经验平方根律）
 *
 * Q/V 是订单占当根 bar 成交量的比例。它刻意是**百分比**而不是绝对价差：
 * 波动大的品种冲击大（σ 因子），成交清淡的 bar 冲击大（参与率因子），
 * 一个 η 走天下，跨品种可比。
 *
 * 配套的**最大参与率上限**（Max Volume Participation）是容量测试的另一只手：
 * 单根 bar 里吃掉超过 10%~20% 的成交量在现实中做不完（会把价格一直推到不利侧），
 * 超出部分应该被砍掉或拒绝，而不是假装全部按同一个价成交了。
 *
 * 全部纯函数；引擎只在 impact 配置非空时调用，默认路径（L1 固定滑点）一个字节都不变。
 */

/** 单笔冲击的成交价偏移（价格单位，恒为正数；方向由调用方乘）。 */
export function sqrtImpactPrice({ price, dailyVol, participation, eta = 1.0, delta = 0.5 }) {
  if (!(price > 0) || !(dailyVol > 0) || !(participation > 0)) return 0;
  return price * eta * dailyVol * Math.pow(participation, delta);
}

/**
 * 按最大参与率反推允许的最大手数。barVolume 与 orderQty 必须同单位：
 * 期货日线 volume 是手（qtyPerLot=1）；A股日线 volume 是股（qtyPerLot=100）。
 * barVolume ≤ 0（停牌/无量）时返回 0 —— 没有对手盘就不该成交。
 */
export function participationCapLots({ barVolume, qtyPerLot = 1, maxParticipation = 0.1 }) {
  if (!(barVolume > 0) || !(qtyPerLot > 0) || !(maxParticipation > 0)) return 0;
  return Math.floor((barVolume * maxParticipation) / qtyPerLot);
}

/**
 * 每根 bar 的"截至前一根"日波动率（简单收益样本标准差）。
 * 刻意不含当根：用今天自己的收益算今天自己的冲击，是隐蔽的未来函数。
 * 前缀返回 null，调用方在数据不足时应跳过冲击而不是猜一个默认值。
 */
export function dailyVolSeries(bars, lookback = 20) {
  const n = (bars || []).length;
  const out = new Array(n).fill(null);
  const lb = Math.max(2, Math.round(lookback));
  // 窗口 = 收益 r_k = close[k]/close[k-1]−1, k ∈ [i−lb, i−1]。终点刻意是 i−1：
  // 把当根收盘算进自己的波动率，冲击成本就有了未来函数。
  for (let i = lb + 1; i < n; i++) {
    let sum = 0, sum2 = 0, m = 0;
    for (let k = i - lb; k < i; k++) {
      const prev = bars[k - 1].close, cur = bars[k].close;
      if (!(prev > 0) || !(cur > 0)) { m = -1; break; }
      const r = cur / prev - 1;
      sum += r; sum2 += r * r; m++;
    }
    if (m === lb && lb > 1) {
      const mean = sum / m;
      const v = (sum2 - m * mean * mean) / (m - 1);
      out[i] = v > 0 ? Math.sqrt(v) : null;
    }
  }
  return out;
}
