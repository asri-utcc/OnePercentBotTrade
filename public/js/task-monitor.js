/* ═══════════════════════════════════════════════════════════════════════
   Task Monitor — bot dashboard view (per-process)
   ═══════════════════════════════════════════════════════════════════════
   Polls /api/health (5s, driven by healthMonitor eventBus) + /api/health/tasks (10s).
   Same UI pattern as admin Task Monitor but for THIS bot only.

   Data sources:
     - perf / rateLimit / tasks summary: /api/health (existing)
     - full per-task list: /api/health/tasks (new — taskRegistry.getTaskSnapshot)
*/

(function () {
  'use strict';

  const POLL_HEALTH_MS = 5000;
  const POLL_TASKS_MS = 10000;
  const POLL_ATTRIBUTION_MS = 5000;

  const state = {
    healthTs: 0,
    tasksTs: 0,
    attributionTs: 0,
    tasks: [],
    health: null,
    attribution: null,
    attributionExpanded: new Set(),
  };

  // ── helpers ──
  function _fmtAgo(ms) {
    if (!ms) return '—';
    const sec = Math.round((Date.now() - ms) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.round(sec / 60) + 'm ago';
    return Math.round(sec / 3600) + 'h ago';
  }
  function _fmtMs(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleTimeString();
  }
  function _fmtDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1) return ms.toFixed(2) + ' ms';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }
  function _setKpi(elId, value, sub, barElId, barPct, status) {
    const el = document.getElementById(elId);
    if (el) {
      el.dataset.status = status || 'idle';
      el.querySelector('.tm-kpi-value').textContent = value;
      const subNode = el.querySelector('.tm-kpi-sub');
      if (subNode) subNode.textContent = sub || '';
    }
    if (barElId) {
      const bar = document.getElementById(barElId);
      if (bar) bar.style.width = Math.max(0, Math.min(100, barPct || 0)) + '%';
    }
  }

  function _setPollPill(state_, label) {
    const pill = document.getElementById('tm-poll-pill');
    if (pill) pill.dataset.state = state_;
    const lbl = document.getElementById('tm-poll-label');
    if (lbl) lbl.textContent = label;
  }

  // ── poll health ──
  async function _pollHealth() {
    try {
      const r = await fetch('/api/health', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      state.health = await r.json();
      state.healthTs = Date.now();
      _setPollPill('open', 'Live');
      _renderKpis();
      _renderPerfTab();
      _renderApiWeightTable();
      _renderAge();
    } catch (err) {
      _setPollPill('error', 'Error: ' + err.message);
    }
  }

  // ── poll tasks ──
  async function _pollTasks() {
    try {
      const r = await fetch('/api/health/tasks', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      const data = await r.json();
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      state.tasksTs = Date.now();
      _renderTasksTable();
      _renderErrorsTable();
      _renderAge();
    } catch (err) {
      console.warn('[task-monitor] /api/health/tasks failed:', err.message);
    }
  }

  // ── poll weight attribution ──
  async function _pollAttribution() {
    try {
      const r = await fetch('/api/health/weight-attribution', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('status ' + r.status);
      const data = await r.json();
      state.attribution = data;
      state.attributionTs = Date.now();
      _renderAttributionTable();
      _renderAge();
    } catch (err) {
      console.warn('[task-monitor] /api/health/weight-attribution failed:', err.message);
    }
  }

  function _renderAge() {
    const el = document.getElementById('tm-last-age');
    if (!el) return;
    const a = _fmtAgo(state.healthTs);
    const b = _fmtAgo(state.tasksTs);
    const c = _fmtAgo(state.attributionTs);
    el.textContent = `health ${a} · tasks ${b} · attribution ${c}`;
  }

  // ── render ──
  function _renderKpis() {
    const h = state.health;
    if (!h) return;

    // MEMORY
    const mem = h.perf && h.perf.memory;
    if (mem) {
      const pct = mem.heapTotal > 0 ? Math.round((mem.heapUsed / mem.heapTotal) * 100) : 0;
      _setKpi('kpiMemory', `${mem.heapUsed} / ${mem.heapTotal}`, `RSS ${mem.rss} MB`, 'kpiMemoryBar', pct, pct > 90 ? 'warn' : (pct > 70 ? 'busy' : 'ok'));
    } else {
      _setKpi('kpiMemory', '—', 'no data', 'kpiMemoryBar', 0, 'idle');
    }

    // CPU
    const cpu = h.perf && h.perf.cpu;
    if (cpu) {
      const pct = cpu.pctSmoothed || 0;
      _setKpi('kpiCpu', `${pct.toFixed(1)}%`, `${cpu.coreCount} cores`, 'kpiCpuBar', Math.min(100, pct * 2), pct > 80 ? 'warn' : (pct > 50 ? 'busy' : 'ok'));
    } else {
      _setKpi('kpiCpu', '—', 'no data', 'kpiCpuBar', 0, 'idle');
    }

    // EL LAG
    const el = h.perf && h.perf.elLag;
    if (el && el.enabled) {
      _setKpi('kpiElLag', `${(el.p99Ms || 0).toFixed(1)} ms`, `p50 ${(el.p50Ms || 0).toFixed(1)} / max ${(el.maxMs || 0).toFixed(1)} ms`, null, null, (el.p99Ms || 0) > 100 ? 'warn' : ((el.p99Ms || 0) > 50 ? 'busy' : 'ok'));
    } else {
      _setKpi('kpiElLag', '—', 'no data', null, null, 'idle');
    }

    // API WEIGHT
    const rl = h.rateLimit;
    if (rl) {
      const pct = rl.usedPct || 0;
      _setKpi('kpiApiWeight', `${pct}%`, `${rl.usedEstimated || 0}/${rl.capacity || 0}`, 'kpiApiWeightBar', pct, pct > 90 ? 'warn' : (pct > 70 ? 'busy' : 'ok'));
    } else {
      _setKpi('kpiApiWeight', '—', 'no data', 'kpiApiWeightBar', 0, 'idle');
    }

    // CIRCUIT BREAKER
    const cb = rl && rl.circuitBreaker;
    if (cb) {
      const s = (cb.state || 'unknown').toUpperCase();
      const remaining = cb.cooldownRemainingMs && cb.cooldownRemainingMs > 0
        ? `${Math.ceil(cb.cooldownRemainingMs / 1000)}s cooldown`
        : (cb.usedPct != null ? `${cb.usedPct}% used` : '');
      _setKpi('kpiCb', s, remaining, null, null, cb.state === 'open' ? 'warn' : (cb.state === 'half_open' ? 'busy' : 'ok'));
    } else {
      _setKpi('kpiCb', '—', '', null, null, 'idle');
    }

    // TASKS
    const t = h.tasks;
    if (t) {
      const errCount = t.errorsLastHour || 0;
      _setKpi('kpiTasks', `${t.totalTasks || 0}`, `${t.scheduled || 0} sched · ${errCount} err/h`, null, null, errCount > 0 ? 'warn' : 'ok');
    } else {
      _setKpi('kpiTasks', '—', '', null, null, 'idle');
    }
  }

  function _filterTasks() {
    const q = (document.getElementById('taskSearch') || {}).value || '';
    const type = (document.getElementById('taskTypeFilter') || {}).value || '';
    const ql = q.toLowerCase();
    return state.tasks.filter((t) => {
      if (type && t.type !== type) return false;
      if (!ql) return true;
      const hay = `${t.name} ${t.owner || ''} ${t.lastError || ''}`.toLowerCase();
      return hay.indexOf(ql) >= 0;
    });
  }

  function _renderTasksTable() {
    const body = document.getElementById('tasksBody');
    if (!body) return;
    const filtered = _filterTasks();
    const lbl = document.getElementById('taskCountLabel');
    if (lbl) lbl.textContent = `${filtered.length} / ${state.tasks.length} tasks`;
    if (!filtered.length) {
      body.innerHTML = '<tr class="tm-empty"><td colspan="9" class="text-center py-3 text-muted-3">ไม่มี task ที่ตรง filter</td></tr>';
      return;
    }
    body.innerHTML = filtered.map((t) => {
      const errBadge = t.lastError ? `<span class="tm-err-badge" title="${_escapeHtml(t.lastError)}">${_escapeHtml(t.lastError.slice(0, 80))}${t.lastError.length > 80 ? '…' : ''}</span>` : '<span class="text-muted-3">—</span>';
      return `<tr class="${t.lastError ? 'tm-row-err' : ''}">
        <td class="tm-task-name">${_escapeHtml(t.name || '—')}</td>
        <td><span class="tm-type-pill tm-type-${t.type}">${t.type || '—'}</span></td>
        <td class="tm-mono">${_escapeHtml(t.owner || '—')}</td>
        <td>${t.intervalMs ? Math.round(t.intervalMs / 1000) + 's' : '—'}</td>
        <td class="tm-num">${t.fireCount || 0}</td>
        <td>${_fmtMs(t.lastFireAt)}</td>
        <td>${_fmtDuration(t.lastDurationMs)}</td>
        <td>${_fmtMs(t.nextFireAt)}</td>
        <td>${errBadge}</td>
      </tr>`;
    }).join('');
  }

  function _renderPerfTab() {
    const h = state.health;
    if (!h) return;
    const mem = h.perf && h.perf.memory;
    const cpu = h.perf && h.perf.cpu;
    const el = h.perf && h.perf.elLag;
    document.getElementById('perfMemoryContent').innerHTML = mem ? `
      <div class="d-flex justify-content-between"><span>RSS</span><b>${mem.rss} MB</b></div>
      <div class="d-flex justify-content-between"><span>Heap total</span><b>${mem.heapTotal} MB</b></div>
      <div class="d-flex justify-content-between"><span>Heap used</span><b>${mem.heapUsed} MB</b></div>
      <div class="d-flex justify-content-between"><span>External</span><b>${mem.external} MB</b></div>
      <div class="d-flex justify-content-between"><span>ArrayBuffers</span><b>${mem.arrayBuffers} MB</b></div>
    ` : '—';
    document.getElementById('perfCpuContent').innerHTML = cpu ? `
      <div class="d-flex justify-content-between"><span>Smoothed</span><b>${(cpu.pctSmoothed || 0).toFixed(2)}%</b></div>
      <div class="d-flex justify-content-between"><span>User Δ</span><b>${cpu.userDeltaUs || 0} µs</b></div>
      <div class="d-flex justify-content-between"><span>System Δ</span><b>${cpu.systemDeltaUs || 0} µs</b></div>
      <div class="d-flex justify-content-between"><span>Cores</span><b>${cpu.coreCount}</b></div>
    ` : '—';
    document.getElementById('perfElContent').innerHTML = (el && el.enabled) ? `
      <div class="d-flex justify-content-between"><span>p50</span><b>${(el.p50Ms || 0).toFixed(2)} ms</b></div>
      <div class="d-flex justify-content-between"><span>p99</span><b>${(el.p99Ms || 0).toFixed(2)} ms</b></div>
      <div class="d-flex justify-content-between"><span>max</span><b>${(el.maxMs || 0).toFixed(2)} ms</b></div>
      <div class="d-flex justify-content-between"><span>mean</span><b>${(el.meanMs || 0).toFixed(2)} ms</b></div>
      <div class="d-flex justify-content-between"><span>samples</span><b>${el.samples || 0}</b></div>
    ` : 'EL lag monitor disabled';
  }

  function _renderApiWeightTable() {
    const body = document.getElementById('apiWeightBody');
    if (!body) return;
    const rl = state.health && state.health.rateLimit;
    if (!rl) { body.innerHTML = '<tr class="tm-empty"><td colspan="2" class="text-center py-3 text-muted-3">—</td></tr>'; return; }
    const rows = [
      ['Capacity', rl.capacity],
      ['Tokens (current)', rl.tokens],
      ['Used (estimated)', rl.usedEstimated],
      ['Used %', (rl.usedPct || 0) + '%'],
      ['Refill rate', rl.refillRate],
      ['Ban remaining (sec)', rl.banRemainingSec],
    ];
    if (rl.circuitBreaker) {
      const cb = rl.circuitBreaker;
      rows.push(['CB state', cb.state]);
      rows.push(['CB used %', cb.usedPct + '%']);
      rows.push(['CB consecutive high (sec)', cb.consecutiveHighUsed]);
      rows.push(['CB cooldown remaining (ms)', cb.cooldownRemainingMs]);
    }
    body.innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('');
  }

  function _renderErrorsTable() {
    const body = document.getElementById('errorsBody');
    if (!body) return;
    const errs = state.tasks
      .filter((t) => t.lastError)
      .sort((a, b) => (b.lastErrorAt || 0) - (a.lastErrorAt || 0));
    if (!errs.length) {
      body.innerHTML = '<tr class="tm-empty"><td colspan="4" class="text-center py-3 text-muted-3">✅ ไม่มี error</td></tr>';
      return;
    }
    body.innerHTML = errs.map((t) => `<tr class="tm-row-err">
      <td class="tm-task-name">${_escapeHtml(t.name)}</td>
      <td class="tm-mono">${_escapeHtml(t.owner || '—')}</td>
      <td><span class="tm-err-badge" title="${_escapeHtml(t.lastError)}">${_escapeHtml(t.lastError.slice(0, 200))}${t.lastError.length > 200 ? '…' : ''}</span></td>
      <td>${_fmtMs(t.lastErrorAt)}</td>
    </tr>`).join('');
  }

  // ── render weight attribution table with expandable per-endpoint rows ──
  // Purpose map: tells the user WHAT each task does + HOW (interval/frequency)
  // so they can identify "this task is the culprit" without grep'ing source.
  const _TASK_PURPOSE = {
    'untracked':                'API calls outside any task context — boot / WS events / ad-hoc admin. Investigate.',
    'autoAddBot':               'Auto-add bot service — scans /ticker/24hr to discover tradable symbols. Runs periodically.',
    'positionWatchdog':         'Position watchdog — reconciles stale positions vs Binance open orders. Runs every 5 min.',
    'healthMonitor:binance-ping':  'Binance connection health ping (every 30s). Low cost.',
    'healthMonitor:binance-time':  'Binance server-time sync (every 5 min). Low cost.',
    'reconcileBalance':         'Periodic balance reconcile — pulls /account to sync internal balance model. Every ~15 min.',
    'reconcileKlines':          'Kline cache reconcile — pulls fresh klines for all tracked symbols. Every ~5 min.',
    'botManager:reconcile':     'Bot manager reconcile — cross-checks bot state with Binance.',
    'trader:sweep':             'Per-symbol sweep — pulls klines + checks open orders. Every ~5 min per symbol.',
    'trader:startupSweep':      'Bot startup sweep — initial kline pull after bot start.',
    'trader:startupBalance':    'Bot startup balance — initial /account call after bot start.',
    'trader:buyCooldown':       'BUY cooldown retry — re-evaluates placeBuy with fresh kline after signal cooldown.',
    'trader:retryCheck':        'BUY retry check — re-evaluates unfilled LIMIT_BUY orders after retryTimeMin.',
    'trader:holdingRetry':      'Holding retry — attempts SELL for stranded positions every 30s (up to 10 retries).',
    'trader:partialFill':       'BUY partial-fill watch — polls BUY order status every 30s for partial fills.',
    'trader:sellPartialFill':   'SELL partial-fill watch — polls SELL order status every 30s for partial fills.',
  };

  function _taskPurpose(taskName) {
    if (!taskName) return '';
    // exact match first
    if (_TASK_PURPOSE[taskName]) return _TASK_PURPOSE[taskName];
    // prefix match for parameterized names (trader:sweep:XYZ, trader:<botId>:startupSweep, etc.)
    for (const k of Object.keys(_TASK_PURPOSE)) {
      if (taskName.indexOf(k + ':') === 0 || taskName.indexOf(k + '@') === 0) {
        const sub = taskName.slice(k.length + 1);
        return _TASK_PURPOSE[k] + ` [${sub}]`;
      }
    }
    // owner-prefix fallbacks
    if (taskName.startsWith('trader:') && taskName.length === 26 + 7) {
      return 'Per-bot timer for bot ' + taskName.slice(7, 19) + '…';
    }
    if (taskName.indexOf('reconcile') >= 0) return 'Periodic reconcile task.';
    if (taskName.indexOf('sweep') >= 0) return 'Periodic sweep — pulls klines + status.';
    return 'Task';
  }

  function _filterAttribution() {
    const q = ((document.getElementById('attrSearch') || {}).value || '').toLowerCase();
    const data = state.attribution;
    if (!data || !Array.isArray(data.tasks)) return [];
    // ALWAYS include rows that have used weight before (weightTotal > 0)
    // so user sees EVERY consumer, not just currently-active ones.
    let rows = data.tasks.filter((row) => (row.weightTotal || 0) > 0);
    // Sort: weightPerMin desc, then weightTotal desc (so heavy historical tasks still rank high)
    rows.sort((a, b) => (b.weightPerMin - a.weightPerMin) || (b.weightTotal - a.weightTotal));
    if (!q) return rows;
    return rows.filter((row) => {
      const hay = [
        row.taskName,
        row.owner,
        _taskPurpose(row.taskName),
        ...((row.endpoints || []).map((e) => e.endpoint)),
      ].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function _attributionStatus(weightPerMin) {
    if (weightPerMin > 500) return 'tm-warn-bad';   // red - likely causing CB
    if (weightPerMin > 200) return 'tm-warn-mid';   // amber - heavy
    if (weightPerMin > 0)   return 'tm-warn-ok';    // green - normal
    return 'tm-warn-zero';
  }

  function _heavyBadge(weightTotal) {
    if (weightTotal >= 5000) return ' <span class="tm-heavy-badge tm-heavy-1k">🔥 heavy</span>';
    if (weightTotal >= 1000) return ' <span class="tm-heavy-badge">⚠️ notable</span>';
    return '';
  }

  function _renderAttributionTable() {
    const body = document.getElementById('attributionBody');
    if (!body) return;
    const filtered = _filterAttribution();
    const total = (state.attribution && state.attribution.tasks) || [];
    const liveCount = total.filter((t) => (t.weightPerMin || 0) > 0).length;
    const lbl = document.getElementById('attrCountLabel');
    if (lbl) lbl.textContent = `${filtered.length} weight consumers · ${liveCount} active this minute · ${total.length} total tracked`;
    if (!filtered.length) {
      body.innerHTML = '<tr class="tm-empty"><td colspan="8" class="text-center py-3 text-muted-3">ยังไม่มี weight attribution — รอ task ทำงานสัก 1 นาที</td></tr>';
      return;
    }
    const html = [];
    for (const row of filtered) {
      const epCount = (row.endpoints || []).length;
      const isExpanded = state.attributionExpanded.has(row.taskName);
      const caret = epCount > 0
        ? `<a href="#" class="tm-caret" data-task="${_escapeHtml(row.taskName)}">${isExpanded ? '▼' : '⌄'}</a>`
        : '<span class="text-muted-3">·</span>';
      const statusCls = _attributionStatus(row.weightPerMin);
      const trackedBadge = row.tracked
        ? ''
        : ' <span class="tm-type-pill" style="background:#666;">untracked</span>';
      const heavyBadge = _heavyBadge(row.weightTotal || 0);
      const purpose = _taskPurpose(row.taskName);
      html.push(`<tr class="tm-attr-row ${statusCls}" data-task="${_escapeHtml(row.taskName)}">
        <td>${caret}</td>
        <td>
          <div class="tm-task-name">${_escapeHtml(row.taskName)}${trackedBadge}${heavyBadge}</div>
          <div class="tm-task-purpose">${_escapeHtml(purpose)}</div>
        </td>
        <td class="tm-mono">${_escapeHtml(row.owner || '—')}</td>
        <td class="tm-num"><b>${row.weightPerMin || 0}</b></td>
        <td class="tm-num">${row.weightPrevMin || 0}</td>
        <td class="tm-num">${row.weightTotal || 0}</td>
        <td class="tm-num">${epCount}</td>
        <td class="tm-num">${_fmtAgo(row.lastFireAt)}</td>
      </tr>`);
      if (isExpanded && epCount > 0) {
        html.push(`<tr class="tm-attr-subheader"><td colspan="8">↳ Binance endpoints called by this task (in this minute)</td></tr>`);
        for (const ep of row.endpoints) {
          const epCls = _attributionStatus(ep.weightPerMin);
          const epHeavyBadge = _heavyBadge(ep.weightTotal || 0);
          html.push(`<tr class="tm-attr-endpoint ${epCls}">
            <td></td>
            <td colspan="2" class="tm-mono ps-4">${_escapeHtml(ep.endpoint)}${epHeavyBadge}</td>
            <td class="tm-num"><b>${ep.weightPerMin || 0}</b></td>
            <td class="tm-num">${ep.weightPrevMin || 0}</td>
            <td class="tm-num">${ep.weightTotal || 0}</td>
            <td class="tm-num"></td>
            <td class="tm-num"></td>
          </tr>`);
        }
      }
    }
    body.innerHTML = html.join('');
    // wire caret clicks
    body.querySelectorAll('.tm-caret').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const name = el.dataset.task;
        if (!name) return;
        if (state.attributionExpanded.has(name)) state.attributionExpanded.delete(name);
        else state.attributionExpanded.add(name);
        _renderAttributionTable();
      });
    });
  }

  function _escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── tabs ──
  document.querySelectorAll('#tmTabs .nav-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = a.dataset.tab;
      document.querySelectorAll('#tmTabs .nav-link').forEach((b) => b.classList.remove('active'));
      a.classList.add('active');
      document.querySelectorAll('.tm-tab-pane').forEach((p) => p.classList.add('d-none'));
      const pane = document.getElementById('tab-' + tab);
      if (pane) pane.classList.remove('d-none');
    });
  });

  // ── search + filter ──
  const search = document.getElementById('taskSearch');
  if (search) search.addEventListener('input', _renderTasksTable);
  const typeFilter = document.getElementById('taskTypeFilter');
  if (typeFilter) typeFilter.addEventListener('change', _renderTasksTable);
  const attrSearch = document.getElementById('attrSearch');
  if (attrSearch) attrSearch.addEventListener('input', _renderAttributionTable);

  // ── boot ──
  _setPollPill('connecting', 'Connecting…');
  _pollHealth();
  _pollTasks();
  _pollAttribution();
  setInterval(_pollHealth, POLL_HEALTH_MS);
  setInterval(_pollTasks, POLL_TASKS_MS);
  setInterval(_pollAttribution, POLL_ATTRIBUTION_MS);
  // age ticker
  setInterval(_renderAge, 1000);
})();