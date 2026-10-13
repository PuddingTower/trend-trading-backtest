/**
 * 仿真行情生成器 —— 行为与旧内联版逐字保持一致（同样的分段 trend、同样的取整、同样的跳周末），
 * 因为用户看到的拟真盘感是既成事实，改它等于改产品。
 * 均线不再在这里算：它已归入 indicators.attachDefaultMAs，由统一入口调用。
 */

export const MockDataGenerator = {
  generate(symbol = 'eg9999', count = 260) {
    let basePrice = 4250;
    let volatility = 28;
    let startDate = new Date(2025, 4, 6, 9, 0);

    if (symbol === 'rb9999') { basePrice = 3380; volatility = 22; }
    else if (symbol === 'm9999') { basePrice = 3050; volatility = 18; }

    const data = [];
    let curClose = basePrice;

    for (let i = 0; i < count; i++) {
      let trend = 0;
      if (i < 40) trend = Math.sin(i / 6) * 12;
      else if (i < 55) trend = -20 - (i - 40) * 2;
      else if (i < 130) trend = 25 + Math.sin(i / 8) * 15;
      else if (i < 170) trend = Math.sin(i / 5) * 20;
      else if (i < 220) trend = -24 - Math.cos(i / 7) * 10;
      else trend = 18 + Math.sin(i / 4) * 8;

      const delta = (Math.random() - 0.48) * volatility + trend * 0.4;
      const open = Math.round(curClose + (Math.random() - 0.5) * (volatility * 0.4));
      const close = Math.round(open + delta);
      const high = Math.round(Math.max(open, close) + Math.random() * (volatility * 0.8));
      const low = Math.round(Math.min(open, close) - Math.random() * (volatility * 0.8));
      const volume = Math.round(35000 + Math.random() * 85000 + Math.abs(delta) * 1800);

      startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() === 0) startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() === 6) startDate.setDate(startDate.getDate() + 2);

      const yyyy = startDate.getFullYear();
      const mm = String(startDate.getMonth() + 1).padStart(2, '0');
      const dd = String(startDate.getDate()).padStart(2, '0');
      data.push({ date: `${yyyy}-${mm}-${dd}`, open, high, low, close, volume });
      curClose = close;
    }
    return data;
  }
};
