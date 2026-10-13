/**
 * 期货合约规格表
 *
 * 置信度说明（重要，别把这张表当成实时准确的）：
 *   confidence: 'high'   —— 乘数/tick 为交易所公布规格，长期稳定，可直接用于回测。
 *   confidence: 'verify' —— 较新或规格特殊的品种，乘数/tick 需与交易所公告核对后再依赖。
 *   marginRate / fee 一律是「常见默认值」量级：交易所会按市场调整，且期货公司实际加收佣金，
 *   平今仓费差异极大（中金所平今约为平昨的 10~20 倍）。这两项必须在 UI 里可覆盖（M2 规格编辑器），
 *   不要把它们当权威数据。回测口径上真正稳定的是 multiplier 与 tick。
 *
 * 主连合约代码规律已实测（见 exchanges.js）：所有交易所 = 品种代码 + 'm'，大小写不敏感。
 */

const V = (o) => o;

export const FUTURES_SPECS = {
  // ================= 上期所 SHFE (113) =================
  RB: V({ name: '螺纹钢', exchange: 'SHFE', emCode: 'rb', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.08, fee: { mode: 'rate', value: 0.0001 }, closeTodayFee: { mode: 'rate', value: 0.0001 },
    night: '21:00-23:00', confidence: 'high', aliases: ['螺纹钢', '螺纹', 'RB'] }),
  HC: V({ name: '热轧卷板', exchange: 'SHFE', emCode: 'hc', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.08, fee: { mode: 'rate', value: 0.0001 }, closeTodayFee: { mode: 'rate', value: 0.0001 },
    night: '21:00-23:00', confidence: 'high', aliases: ['热卷', '热轧卷板', 'HC'] }),
  CU: V({ name: '阴极铜', exchange: 'SHFE', emCode: 'cu', unit: '元/吨', multiplier: 5, tick: 10,
    marginRate: 0.10, limitPct: 0.08, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'rate', value: 0.00007 },
    night: '21:00-01:00', confidence: 'high', aliases: ['沪铜', '铜', 'CU'] }),
  AL: V({ name: '铝', exchange: 'SHFE', emCode: 'al', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.10, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-01:00', confidence: 'high', aliases: ['沪铝', '铝', 'AL'] }),
  ZN: V({ name: '锌', exchange: 'SHFE', emCode: 'zn', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.11, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-01:00', confidence: 'high', aliases: ['沪锌', '锌', 'ZN'] }),
  PB: V({ name: '铅', exchange: 'SHFE', emCode: 'pb', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.11, limitPct: 0.08, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-01:00', confidence: 'high', aliases: ['沪铅', '铅', 'PB'] }),
  NI: V({ name: '镍', exchange: 'SHFE', emCode: 'ni', unit: '元/吨', multiplier: 1, tick: 10,
    marginRate: 0.14, limitPct: 0.12, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-01:00', confidence: 'high', aliases: ['沪镍', '镍', 'NI'] }),
  SN: V({ name: '锡', exchange: 'SHFE', emCode: 'sn', unit: '元/吨', multiplier: 1, tick: 10,
    marginRate: 0.14, limitPct: 0.10, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-01:00', confidence: 'high', aliases: ['沪锡', '锡', 'SN'] }),
  AU: V({ name: '黄金', exchange: 'SHFE', emCode: 'au', unit: '元/克', multiplier: 1000, tick: 0.02,
    marginRate: 0.09, limitPct: 0.08, fee: { mode: 'fixed', value: 10 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-02:30', confidence: 'high', aliases: ['沪金', '黄金', 'AU'] }),
  AG: V({ name: '白银', exchange: 'SHFE', emCode: 'ag', unit: '元/千克', multiplier: 15, tick: 1,
    marginRate: 0.12, limitPct: 0.15, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'rate', value: 0.00005 },
    night: '21:00-02:30', confidence: 'high', aliases: ['沪银', '白银', '银', 'AG'] }),
  RU: V({ name: '天然橡胶', exchange: 'SHFE', emCode: 'ru', unit: '元/吨', multiplier: 10, tick: 5,
    marginRate: 0.11, limitPct: 0.07, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:00', confidence: 'high', aliases: ['橡胶', '沪胶', '天然橡胶', 'RU'] }),
  FU: V({ name: '燃料油', exchange: 'SHFE', emCode: 'fu', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.13, limitPct: 0.08, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'rate', value: 0.00005 },
    night: '21:00-23:00', confidence: 'high', aliases: ['燃油', '燃料油', 'FU'] }),
  BU: V({ name: '石油沥青', exchange: 'SHFE', emCode: 'bu', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.11, limitPct: 0.08, fee: { mode: 'rate', value: 0.0001 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-23:00', confidence: 'high', aliases: ['沥青', '石油沥青', 'BU'] }),
  SP: V({ name: '纸浆', exchange: 'SHFE', emCode: 'sp', unit: '元/吨', multiplier: 10, tick: 2,
    marginRate: 0.10, limitPct: 0.08, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-23:00', confidence: 'high', aliases: ['纸浆', 'SP'] }),
  SS: V({ name: '不锈钢', exchange: 'SHFE', emCode: 'ss', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.09, limitPct: 0.07, fee: { mode: 'fixed', value: 2 }, closeTodayFee: { mode: 'fixed', value: 2 },
    night: '21:00-01:00', confidence: 'high', aliases: ['不锈钢', 'SS'] }),
  BR: V({ name: '丁二烯橡胶', exchange: 'SHFE', emCode: 'br', unit: '元/吨', multiplier: 10, tick: 5,
    marginRate: 0.11, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:00', confidence: 'verify', aliases: ['丁二烯橡胶', '丁二烯', 'BR'] }),
  AO: V({ name: '氧化铝', exchange: 'SHFE', emCode: 'ao', unit: '元/吨', multiplier: 20, tick: 1,
    marginRate: 0.10, limitPct: 0.07, fee: { mode: 'rate', value: 0.0001 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-01:00', confidence: 'verify', aliases: ['氧化铝', 'AO'] }),

  // ================= 大商所 DCE (114) =================
  M: V({ name: '豆粕', exchange: 'DCE', emCode: 'm', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.08, limitPct: 0.06, fee: { mode: 'fixed', value: 1.5 }, closeTodayFee: { mode: 'fixed', value: 1.5 },
    night: '21:00-23:00', confidence: 'high', aliases: ['豆粕', 'M'] }),
  Y: V({ name: '豆油', exchange: 'DCE', emCode: 'y', unit: '元/吨', multiplier: 10, tick: 2,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 2.5 }, closeTodayFee: { mode: 'fixed', value: 2.5 },
    night: '21:00-23:00', confidence: 'high', aliases: ['豆油', 'Y'] }),
  A: V({ name: '黄大豆一号', exchange: 'DCE', emCode: 'a', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 2 }, closeTodayFee: { mode: 'fixed', value: 2 },
    night: '21:00-23:00', confidence: 'high', aliases: ['豆一', '黄大豆一号', 'A'] }),
  B: V({ name: '黄大豆二号', exchange: 'DCE', emCode: 'b', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 2 }, closeTodayFee: { mode: 'fixed', value: 2 },
    night: '21:00-23:00', confidence: 'high', aliases: ['豆二', '黄大豆二号', 'B'] }),
  P: V({ name: '棕榈油', exchange: 'DCE', emCode: 'p', unit: '元/吨', multiplier: 10, tick: 2,
    marginRate: 0.10, limitPct: 0.07, fee: { mode: 'fixed', value: 2.5 }, closeTodayFee: { mode: 'fixed', value: 2.5 },
    night: '21:00-23:00', confidence: 'high', aliases: ['棕榈油', '棕榈', 'P'] }),
  C: V({ name: '玉米', exchange: 'DCE', emCode: 'c', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.08, limitPct: 0.05, fee: { mode: 'fixed', value: 1.2 }, closeTodayFee: { mode: 'fixed', value: 1.2 },
    night: '21:00-23:00', confidence: 'high', aliases: ['玉米', 'C'] }),
  CS: V({ name: '玉米淀粉', exchange: 'DCE', emCode: 'cs', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.08, limitPct: 0.05, fee: { mode: 'fixed', value: 1.5 }, closeTodayFee: { mode: 'fixed', value: 1.5 },
    night: '21:00-23:00', confidence: 'high', aliases: ['淀粉', '玉米淀粉', 'CS'] }),
  JD: V({ name: '鸡蛋', exchange: 'DCE', emCode: 'jd', unit: '元/500千克', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'rate', value: 0.00015 }, closeTodayFee: { mode: 'rate', value: 0.00015 },
    night: null, confidence: 'high', aliases: ['鸡蛋', 'JD'] }),
  I: V({ name: '铁矿石', exchange: 'DCE', emCode: 'i', unit: '元/吨', multiplier: 100, tick: 0.5,
    marginRate: 0.13, limitPct: 0.08, fee: { mode: 'rate', value: 0.0001 }, closeTodayFee: { mode: 'rate', value: 0.0001 },
    night: '21:00-23:00', confidence: 'high', aliases: ['铁矿石', '铁矿', 'I'] }),
  J: V({ name: '冶金焦炭', exchange: 'DCE', emCode: 'j', unit: '元/吨', multiplier: 100, tick: 1,
    marginRate: 0.20, limitPct: 0.09, fee: { mode: 'rate', value: 0.00014 }, closeTodayFee: { mode: 'rate', value: 0.00014 },
    night: '21:00-23:00', confidence: 'high', aliases: ['焦炭', '冶金焦炭', 'J'] }),
  JM: V({ name: '焦煤', exchange: 'DCE', emCode: 'jm', unit: '元/吨', multiplier: 60, tick: 1,
    marginRate: 0.20, limitPct: 0.09, fee: { mode: 'rate', value: 0.00014 }, closeTodayFee: { mode: 'rate', value: 0.00014 },
    night: '21:00-23:00', confidence: 'high', aliases: ['焦煤', 'JM'] }),
  L: V({ name: '线型低密度聚乙烯', exchange: 'DCE', emCode: 'l', unit: '元/吨', multiplier: 5, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 1 }, closeTodayFee: { mode: 'fixed', value: 1 },
    night: '21:00-23:00', confidence: 'high', aliases: ['塑料', 'LLDPE', 'L'] }),
  V: V({ name: '聚氯乙烯', exchange: 'DCE', emCode: 'v', unit: '元/吨', multiplier: 5, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 1 }, closeTodayFee: { mode: 'fixed', value: 1 },
    night: '21:00-23:00', confidence: 'high', aliases: ['PVC', '聚氯乙烯', 'V'] }),
  PP: V({ name: '聚丙烯', exchange: 'DCE', emCode: 'pp', unit: '元/吨', multiplier: 5, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 1 }, closeTodayFee: { mode: 'fixed', value: 1 },
    night: '21:00-23:00', confidence: 'high', aliases: ['聚丙烯', 'PP'] }),
  EG: V({ name: '乙二醇', exchange: 'DCE', emCode: 'eg', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.10, limitPct: 0.07, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:00', confidence: 'high', aliases: ['乙二醇', 'EG'] }),
  PG: V({ name: '液化石油气', exchange: 'DCE', emCode: 'pg', unit: '元/吨', multiplier: 20, tick: 1,
    marginRate: 0.11, limitPct: 0.06, fee: { mode: 'fixed', value: 6 }, closeTodayFee: { mode: 'fixed', value: 6 },
    night: '21:00-23:00', confidence: 'high', aliases: ['LPG', '液化石油气', 'PG'] }),
  LH: V({ name: '生猪', exchange: 'DCE', emCode: 'lh', unit: '元/千克', multiplier: 16, tick: 5,
    marginRate: 0.15, limitPct: 0.08, fee: { mode: 'rate', value: 0.0002 }, closeTodayFee: { mode: 'rate', value: 0.0002 },
    night: null, confidence: 'verify', aliases: ['生猪', '猪肉', 'LH'] }),
  RR: V({ name: '粳米', exchange: 'DCE', emCode: 'rr', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 1 }, closeTodayFee: { mode: 'fixed', value: 1 },
    night: '21:00-23:00', confidence: 'verify', aliases: ['粳米', 'RR'] }),

  // ================= 郑商所 CZCE (115) =================
  SR: V({ name: '白砂糖', exchange: 'CZCE', emCode: 'SR', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.08, limitPct: 0.06, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:30', confidence: 'high', aliases: ['白糖', '白砂糖', 'SR'] }),
  CF: V({ name: '棉花', exchange: 'CZCE', emCode: 'CF', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.09, limitPct: 0.07, fee: { mode: 'fixed', value: 4.3 }, closeTodayFee: { mode: 'fixed', value: 4.3 },
    night: '21:00-23:30', confidence: 'high', aliases: ['棉花', 'CF'] }),
  TA: V({ name: '精对苯二甲酸', exchange: 'CZCE', emCode: 'TA', unit: '元/吨', multiplier: 5, tick: 2,
    marginRate: 0.09, limitPct: 0.07, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:30', confidence: 'high', aliases: ['PTA', 'TA'] }),
  MA: V({ name: '甲醇', exchange: 'CZCE', emCode: 'MA', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.10, limitPct: 0.07, fee: { mode: 'fixed', value: 2 }, closeTodayFee: { mode: 'fixed', value: 2 },
    night: '21:00-23:30', confidence: 'high', aliases: ['甲醇', 'MA'] }),
  FG: V({ name: '平板玻璃', exchange: 'CZCE', emCode: 'FG', unit: '元/吨', multiplier: 20, tick: 1,
    marginRate: 0.12, limitPct: 0.09, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:30', confidence: 'high', aliases: ['玻璃', '平板玻璃', 'FG'] }),
  RM: V({ name: '菜籽粕', exchange: 'CZCE', emCode: 'RM', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.07, fee: { mode: 'fixed', value: 1.5 }, closeTodayFee: { mode: 'fixed', value: 1.5 },
    night: '21:00-23:30', confidence: 'high', aliases: ['菜粕', '菜籽粕', 'RM'] }),
  OI: V({ name: '菜籽油', exchange: 'CZCE', emCode: 'OI', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.09, limitPct: 0.07, fee: { mode: 'fixed', value: 2 }, closeTodayFee: { mode: 'fixed', value: 2 },
    night: '21:00-23:30', confidence: 'high', aliases: ['菜油', '菜籽油', 'OI'] }),
  AP: V({ name: '苹果', exchange: 'CZCE', emCode: 'AP', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.12, limitPct: 0.08, fee: { mode: 'fixed', value: 5 }, closeTodayFee: { mode: 'fixed', value: 5 },
    night: null, confidence: 'high', aliases: ['苹果', 'AP'] }),
  CJ: V({ name: '红枣', exchange: 'CZCE', emCode: 'CJ', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.12, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: null, confidence: 'high', aliases: ['红枣', 'CJ'] }),
  SA: V({ name: '纯碱', exchange: 'CZCE', emCode: 'SA', unit: '元/吨', multiplier: 20, tick: 1,
    marginRate: 0.12, limitPct: 0.09, fee: { mode: 'fixed', value: 3.5 }, closeTodayFee: { mode: 'fixed', value: 3.5 },
    night: '21:00-23:30', confidence: 'high', aliases: ['纯碱', 'SA'] }),
  UR: V({ name: '尿素', exchange: 'CZCE', emCode: 'UR', unit: '元/吨', multiplier: 20, tick: 1,
    marginRate: 0.09, limitPct: 0.06, fee: { mode: 'fixed', value: 5 }, closeTodayFee: { mode: 'fixed', value: 5 },
    night: null, confidence: 'high', aliases: ['尿素', 'UR'] }),
  PF: V({ name: '涤纶短纤', exchange: 'CZCE', emCode: 'PF', unit: '元/吨', multiplier: 5, tick: 2,
    marginRate: 0.09, limitPct: 0.07, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:30', confidence: 'verify', aliases: ['短纤', 'PF'] }),
  PK: V({ name: '花生', exchange: 'CZCE', emCode: 'PK', unit: '元/吨', multiplier: 5, tick: 2,
    marginRate: 0.10, limitPct: 0.07, fee: { mode: 'fixed', value: 2 }, closeTodayFee: { mode: 'fixed', value: 2 },
    night: null, confidence: 'verify', aliases: ['花生', 'PK'] }),
  SF: V({ name: '硅铁', exchange: 'CZCE', emCode: 'SF', unit: '元/吨', multiplier: 5, tick: 2,
    marginRate: 0.12, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: null, confidence: 'high', aliases: ['硅铁', 'SF'] }),
  SM: V({ name: '硅锰合金', exchange: 'CZCE', emCode: 'SM', unit: '元/吨', multiplier: 5, tick: 2,
    marginRate: 0.12, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: null, confidence: 'high', aliases: ['锰硅', '硅锰', 'SM'] }),
  SH: V({ name: '烧碱', exchange: 'CZCE', emCode: 'SH', unit: '元/吨', multiplier: 30, tick: 1,
    marginRate: 0.11, limitPct: 0.08, fee: { mode: 'fixed', value: 5 }, closeTodayFee: { mode: 'fixed', value: 5 },
    night: '21:00-23:30', confidence: 'verify', aliases: ['烧碱', 'SH'] }),
  PX: V({ name: '对二甲苯', exchange: 'CZCE', emCode: 'PX', unit: '元/吨', multiplier: 5, tick: 2,
    marginRate: 0.10, limitPct: 0.07, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: '21:00-23:30', confidence: 'verify', aliases: ['对二甲苯', 'PX'] }),

  // ================= 上期能源 INE (142) =================
  SC: V({ name: '原油', exchange: 'INE', emCode: 'sc', unit: '元/桶', multiplier: 1000, tick: 0.1,
    marginRate: 0.13, limitPct: 0.08, fee: { mode: 'fixed', value: 20 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-02:30', confidence: 'high', aliases: ['原油', 'SC'] }),
  BC: V({ name: '国际铜', exchange: 'INE', emCode: 'bc', unit: '元/吨', multiplier: 5, tick: 10,
    marginRate: 0.10, limitPct: 0.08, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-01:00', confidence: 'verify', aliases: ['国际铜', 'BC'] }),
  LU: V({ name: '低硫燃料油', exchange: 'INE', emCode: 'lu', unit: '元/吨', multiplier: 10, tick: 1,
    marginRate: 0.13, limitPct: 0.08, fee: { mode: 'rate', value: 0.00005 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-02:30', confidence: 'verify', aliases: ['低硫燃油', 'LU'] }),
  NR: V({ name: '20号胶', exchange: 'INE', emCode: 'nr', unit: '元/吨', multiplier: 10, tick: 5,
    marginRate: 0.11, limitPct: 0.07, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 0 },
    night: '21:00-23:00', confidence: 'verify', aliases: ['20号胶', 'NR'] }),

  // ================= 中金所 CFFEX (220) —— 平今仓费显著高于平昨 =================
  IF: V({ name: '沪深300股指期货', exchange: 'CFFEX', emCode: 'IF', unit: '元/点', multiplier: 300, tick: 0.2,
    marginRate: 0.12, limitPct: 0.10, fee: { mode: 'rate', value: 0.000023 }, closeTodayFee: { mode: 'rate', value: 0.00023 },
    night: null, confidence: 'high', aliases: ['沪深300股指', 'IF', '股指期货'] }),
  IH: V({ name: '上证50股指期货', exchange: 'CFFEX', emCode: 'IH', unit: '元/点', multiplier: 300, tick: 0.2,
    marginRate: 0.12, limitPct: 0.10, fee: { mode: 'rate', value: 0.000023 }, closeTodayFee: { mode: 'rate', value: 0.00023 },
    night: null, confidence: 'high', aliases: ['上证50股指', 'IH'] }),
  IC: V({ name: '中证500股指期货', exchange: 'CFFEX', emCode: 'IC', unit: '元/点', multiplier: 200, tick: 0.2,
    marginRate: 0.14, limitPct: 0.10, fee: { mode: 'rate', value: 0.000023 }, closeTodayFee: { mode: 'rate', value: 0.00023 },
    night: null, confidence: 'high', aliases: ['中证500股指', 'IC'] }),
  IM: V({ name: '中证1000股指期货', exchange: 'CFFEX', emCode: 'IM', unit: '元/点', multiplier: 200, tick: 0.2,
    marginRate: 0.15, limitPct: 0.10, fee: { mode: 'rate', value: 0.000023 }, closeTodayFee: { mode: 'rate', value: 0.00023 },
    night: null, confidence: 'high', aliases: ['中证1000股指', 'IM'] }),
  T: V({ name: '10年期国债', exchange: 'CFFEX', emCode: 'T', unit: '元/百元面值', multiplier: 10000, tick: 0.005,
    marginRate: 0.02, limitPct: 0.12, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: null, confidence: 'verify', aliases: ['十债', '国债10年', 'T'] }),
  TF: V({ name: '5年期国债', exchange: 'CFFEX', emCode: 'TF', unit: '元/百元面值', multiplier: 10000, tick: 0.005,
    marginRate: 0.015, limitPct: 0.12, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: null, confidence: 'verify', aliases: ['五债', 'TF'] }),

  // ================= 广期所 GFEX (225) =================
  SI: V({ name: '工业硅', exchange: 'GFEX', emCode: 'si', unit: '元/吨', multiplier: 5, tick: 5,
    marginRate: 0.10, limitPct: 0.08, fee: { mode: 'fixed', value: 3 }, closeTodayFee: { mode: 'fixed', value: 3 },
    night: null, confidence: 'verify', aliases: ['工业硅', 'SI'] }),
  LC: V({ name: '碳酸锂', exchange: 'GFEX', emCode: 'lc', unit: '元/吨', multiplier: 1, tick: 50,
    marginRate: 0.13, limitPct: 0.10, fee: { mode: 'rate', value: 0.00008 }, closeTodayFee: { mode: 'rate', value: 0.00008 },
    night: null, confidence: 'verify', aliases: ['碳酸锂', '锂', 'LC'] })
};

/** 品种中文名/简称/字母代码 -> 品种字母（M3 识图解析用这张别名表消歧）。 */
export const FUTURES_ALIAS = (() => {
  const map = new Map();
  for (const [code, spec] of Object.entries(FUTURES_SPECS)) {
    for (const a of (spec.aliases || [])) map.set(String(a).toLowerCase(), code);
    map.set(spec.name.toLowerCase(), code);
    map.set(code.toLowerCase(), code);
  }
  return map;
})();

export const getFuturesSpec = (variety) =>
  FUTURES_SPECS[String(variety || '').toUpperCase()] || null;

export const resolveFuturesVariety = (text) =>
  FUTURES_ALIAS.get(String(text || '').trim().toLowerCase()) || null;

/** 按 tick 取整（期货价格必须落在 tick 网格上；按 tick 小数位收口，避免 457.84000000000003）。 */
export const roundToTick = (price, tick) => {
  if (!tick || tick <= 0) return price;
  const decimals = (String(tick).split('.')[1] || '').length;
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
};

/** 手续费：mode='fixed' 元/手；mode='rate' 按成交金额比例。 */
export const calcFuturesFee = (spec, price, lots, { closeToday = false } = {}) => {
  const plan = closeToday && spec.closeTodayFee ? spec.closeTodayFee : spec.fee;
  const notional = price * spec.multiplier * lots;
  const raw = plan.mode === 'rate' ? notional * plan.value : plan.value * lots;
  return Math.round(raw * 100) / 100;
};
