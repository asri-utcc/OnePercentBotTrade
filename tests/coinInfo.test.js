'use strict';

/**
 * FIX-2026-08-22: Unit tests for coinInfo single-flight + bulk fetch
 *
 * Covers:
 *   - getCoinInfo() single-flight (concurrent calls share one Promise)
 *   - getCoinInfo() cache hit / miss / force refresh
 *   - getCoinInfosBulk() bulk fetch with single 24hr + 1 exchangeInfo call
 *   - getCoinInfosBulk() single-flight (5 concurrent calls = 1 work)
 *   - getCoinInfosBulk() populates cache so subsequent getCoinInfo() is cache hit
 *   - Response shape: includes status, baseAsset, quoteAsset, fullName, logo,
 *     lotSize.minQty, priceFilter.tickSize, quoteVolume, isAtRisk, daysUntil, fetchedAt
 *   - clearCache() empties cache + single-flight
 *   - Empty array, force=true
 */

jest.mock('../src/binance/binanceRest', () => ({
  getExchangeInfo: jest.fn(),
  get24hrTickers: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/binanceDelistMonitor', () => ({
  getRiskInfoFor: jest.fn(() => null),
}));

const coinInfo = require('../src/core/coinInfo');
const binanceRest = require('../src/binance/binanceRest');

const SAMPLE_EXCHANGE = (sym) => ({
  symbols: [{
    symbol: sym,
    baseAsset: sym.replace('USDT', ''),
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [
      { filterType: 'LOT_SIZE', minQty: '1.00000000', maxQty: '9000000.00000000', stepSize: '1.00000000' },
      { filterType: 'PRICE_FILTER', minPrice: '0.00001000', maxPrice: '1000.00000000', tickSize: '0.00001000' },
      { filterType: 'NOTIONAL', minNotional: '10.00000000', applyToMarket: true },
    ],
  }],
});

const SAMPLE_TICKER = (sym) => ({
  symbol: sym,
  lastPrice: '100.00000000',
  priceChange: '5.00000000',
  priceChangePercent: '5.000000',
  quoteVolume: '1000000.00000000',
  volume: '10000.00000000',
  count: 50000,
});

const SAMPLE_TICKER_ALL = (symbols) => symbols.map(SAMPLE_TICKER);

beforeEach(() => {
  jest.clearAllMocks();
  coinInfo.clearCache();
});

describe('coinInfo.getCoinInfo() — single-flight + cache', () => {
  test('single call uses getExchangeInfo + get24hrTickers with symbol param', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));

    const data = await coinInfo.getCoinInfo('BTCUSDT');
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
    expect(binanceRest.get24hrTickers).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
    expect(data.symbol).toBe('BTCUSDT');
    expect(data.baseAsset).toBe('BTC');
    expect(data.status).toBe('TRADING');
    expect(data.lastPrice).toBe(100);
    expect(data.priceChangePct).toBe(5);
    expect(data.quoteVolume).toBe(1000000);
    expect(data.fetchedAt).toBeTruthy();
  });

  test('concurrent getCoinInfo() calls share one Promise (single-flight)', async () => {
    let resolveExchange;
    binanceRest.getExchangeInfo.mockReturnValueOnce(new Promise((r) => { resolveExchange = r; }));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));

    const p1 = coinInfo.getCoinInfo('BTCUSDT');
    const p2 = coinInfo.getCoinInfo('BTCUSDT');
    const p3 = coinInfo.getCoinInfo('BTCUSDT');

    resolveExchange(SAMPLE_EXCHANGE('BTCUSDT'));
    const [a, b, c] = await Promise.all([p1, p2, p3]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledTimes(1);
    expect(binanceRest.get24hrTickers).toHaveBeenCalledTimes(1);
  });

  test('cache hit on second call within TTL — no API calls', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));

    await coinInfo.getCoinInfo('BTCUSDT');
    await coinInfo.getCoinInfo('BTCUSDT');
    await coinInfo.getCoinInfo('BTCUSDT');

    expect(binanceRest.getExchangeInfo).toHaveBeenCalledTimes(1);
    expect(binanceRest.get24hrTickers).toHaveBeenCalledTimes(1);
  });

  test('force=true bypasses cache', async () => {
    binanceRest.getExchangeInfo.mockResolvedValue(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValue(SAMPLE_TICKER('BTCUSDT'));

    await coinInfo.getCoinInfo('BTCUSDT');
    await coinInfo.getCoinInfo('BTCUSDT', { force: true });

    expect(binanceRest.getExchangeInfo).toHaveBeenCalledTimes(2);
  });

  test('lowercase symbol normalized to uppercase', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));

    await coinInfo.getCoinInfo('btcusdt');
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
  });

  test('throws when symbol missing', async () => {
    await expect(coinInfo.getCoinInfo()).rejects.toThrow('symbol required');
    await expect(coinInfo.getCoinInfo(null)).rejects.toThrow('symbol required');
  });

  test('throws when exchangeInfo fails', async () => {
    binanceRest.getExchangeInfo.mockRejectedValueOnce(new Error('binance down'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));
    await expect(coinInfo.getCoinInfo('BTCUSDT')).rejects.toThrow('exchangeInfo failed');
  });

  test('throws when symbol not found on Binance', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce({ symbols: [] });
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('XYZUSDT'));
    await expect(coinInfo.getCoinInfo('XYZUSDT')).rejects.toThrow('Symbol not found');
  });

  test('ticker failure is fail-safe (lastPrice = null)', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockRejectedValueOnce(new Error('ticker fail'));
    const data = await coinInfo.getCoinInfo('BTCUSDT');
    expect(data.symbol).toBe('BTCUSDT');
    expect(data.lastPrice).toBeNull();
    expect(data.status).toBe('TRADING');
  });

  test('response includes all expected fields', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));
    const data = await coinInfo.getCoinInfo('BTCUSDT');
    expect(data).toHaveProperty('symbol');
    expect(data).toHaveProperty('baseAsset');
    expect(data).toHaveProperty('quoteAsset');
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('isSpotTradingAllowed');
    expect(data).toHaveProperty('lotSize.minQty');
    expect(data).toHaveProperty('priceFilter.tickSize');
    expect(data).toHaveProperty('notional.minNotional');
    expect(data).toHaveProperty('lastPrice');
    expect(data).toHaveProperty('priceChange');
    expect(data).toHaveProperty('priceChangePct');
    expect(data).toHaveProperty('quoteVolume');
    expect(data).toHaveProperty('volume');
    expect(data).toHaveProperty('count');
    expect(data).toHaveProperty('fullName');
    expect(data).toHaveProperty('logo');
    expect(data).toHaveProperty('cmcId');
    expect(data).toHaveProperty('cmcRank');
    expect(data).toHaveProperty('circulatingSupply');
    expect(data).toHaveProperty('maxSupply');
    expect(data).toHaveProperty('totalSupply');
    expect(data).toHaveProperty('isAtRisk');
    expect(data).toHaveProperty('isDelisted');
    expect(data).toHaveProperty('delistTime');
    expect(data).toHaveProperty('delistDateIso');
    expect(data).toHaveProperty('daysUntil');
    expect(data).toHaveProperty('fetchedAt');
  });
});

describe('coinInfo.getCoinInfosBulk() — bulk fetch + single-flight', () => {
  test('calls get24hrTickers({}) once + getExchangeInfo({symbols:[...]}) once', async () => {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER_ALL(symbols));
    binanceRest.getExchangeInfo.mockResolvedValueOnce({
      symbols: symbols.map((s) => SAMPLE_EXCHANGE(s).symbols[0]),
    });

    const coins = await coinInfo.getCoinInfosBulk(symbols);

    expect(binanceRest.get24hrTickers).toHaveBeenCalledTimes(1);
    expect(binanceRest.get24hrTickers).toHaveBeenCalledWith({});
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledTimes(1);
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledWith({ symbols });
    expect(coins.BTCUSDT).toBeDefined();
    expect(coins.ETHUSDT).toBeDefined();
    expect(coins.BTCUSDT.lastPrice).toBe(100);
  });

  test('dedupes symbols (multi-bot same symbol → 1 entry)', async () => {
    const symbols = ['BTCUSDT', 'BTCUSDT', 'ETHUSDT'];
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER_ALL(['BTCUSDT', 'ETHUSDT']));
    binanceRest.getExchangeInfo.mockResolvedValueOnce({
      symbols: ['BTCUSDT', 'ETHUSDT'].map((s) => SAMPLE_EXCHANGE(s).symbols[0]),
    });
    const coins = await coinInfo.getCoinInfosBulk(symbols);
    expect(Object.keys(coins).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  test('single-flight: 5 concurrent bulk calls share one Promise', async () => {
    const symbols = ['BTCUSDT'];
    let resolveTickers;
    binanceRest.get24hrTickers.mockReturnValueOnce(new Promise((r) => { resolveTickers = r; }));
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(coinInfo.getCoinInfosBulk(symbols));
    }

    resolveTickers(SAMPLE_TICKER_ALL(['BTCUSDT']));
    const results = await Promise.all(promises);

    // all 5 calls returned the same data
    expect(results[0].BTCUSDT).toBeDefined();
    expect(results[4].BTCUSDT).toBeDefined();
    // but underlying binance calls happened once
    expect(binanceRest.get24hrTickers).toHaveBeenCalledTimes(1);
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledTimes(1);
  });

  test('bulk populates cache so subsequent getCoinInfo() is cache hit', async () => {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER_ALL(symbols));
    binanceRest.getExchangeInfo.mockResolvedValueOnce({
      symbols: symbols.map((s) => SAMPLE_EXCHANGE(s).symbols[0]),
    });

    await coinInfo.getCoinInfosBulk(symbols);

    // reset spies
    binanceRest.get24hrTickers.mockClear();
    binanceRest.getExchangeInfo.mockClear();

    // subsequent getCoinInfo should hit cache
    const cached = await coinInfo.getCoinInfo('BTCUSDT');
    expect(cached.lastPrice).toBe(100);
    expect(binanceRest.getExchangeInfo).not.toHaveBeenCalled();
    expect(binanceRest.get24hrTickers).not.toHaveBeenCalled();
  });

  test('partial cache: bulk only fetches missing symbols', async () => {
    // pre-seed cache with BTCUSDT
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));
    await coinInfo.getCoinInfo('BTCUSDT');
    jest.clearAllMocks();

    // bulk request [BTCUSDT, ETHUSDT] → only ETHUSDT should be fetched
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER_ALL(['BTCUSDT', 'ETHUSDT']));
    binanceRest.getExchangeInfo.mockResolvedValueOnce({
      symbols: [SAMPLE_EXCHANGE('ETHUSDT').symbols[0]],
    });
    const coins = await coinInfo.getCoinInfosBulk(['BTCUSDT', 'ETHUSDT']);
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledWith({ symbols: ['ETHUSDT'] });
    expect(coins.BTCUSDT).toBeDefined();
    expect(coins.ETHUSDT).toBeDefined();
  });

  test('partial failure: symbol missing in bulk response does not poison others', async () => {
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER_ALL(['BTCUSDT']));
    binanceRest.getExchangeInfo.mockResolvedValueOnce({
      // ETHUSDT deliberately missing
      symbols: [SAMPLE_EXCHANGE('BTCUSDT').symbols[0]],
    });
    const coins = await coinInfo.getCoinInfosBulk(['BTCUSDT', 'ETHUSDT']);
    expect(coins.BTCUSDT).toBeDefined();
    expect(coins.ETHUSDT).toBeUndefined();
  });

  test('empty input returns empty record', async () => {
    const coins = await coinInfo.getCoinInfosBulk([]);
    expect(coins).toEqual({});
    expect(binanceRest.get24hrTickers).not.toHaveBeenCalled();
    expect(binanceRest.getExchangeInfo).not.toHaveBeenCalled();
  });

  test('non-array input throws', async () => {
    await expect(coinInfo.getCoinInfosBulk(null)).rejects.toThrow('symbols must be an array');
    await expect(coinInfo.getCoinInfosBulk('BTCUSDT')).rejects.toThrow('symbols must be an array');
  });

  test('get24hrTickers failure throws (no cache writes)', async () => {
    binanceRest.get24hrTickers.mockRejectedValueOnce(new Error('binance down'));
    binanceRest.getExchangeInfo.mockResolvedValueOnce({ symbols: [] });
    await expect(coinInfo.getCoinInfosBulk(['BTCUSDT'])).rejects.toThrow('binance down');
    // no cache write
    binanceRest.get24hrTickers.mockClear();
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));
    binanceRest.getExchangeInfo.mockClear();
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    const fresh = await coinInfo.getCoinInfo('BTCUSDT');
    expect(fresh.lastPrice).toBe(100); // re-fetched, not from failed bulk
  });
});

describe('coinInfo.clearCache()', () => {
  test('empties cache Map', async () => {
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));
    await coinInfo.getCoinInfo('BTCUSDT');
    coinInfo.clearCache();
    binanceRest.getExchangeInfo.mockClear();
    binanceRest.get24hrTickers.mockClear();
    binanceRest.getExchangeInfo.mockResolvedValueOnce(SAMPLE_EXCHANGE('BTCUSDT'));
    binanceRest.get24hrTickers.mockResolvedValueOnce(SAMPLE_TICKER('BTCUSDT'));
    await coinInfo.getCoinInfo('BTCUSDT');
    expect(binanceRest.getExchangeInfo).toHaveBeenCalledTimes(1);
  });
});
