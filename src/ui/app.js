(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    apiKey: $("apiKey"),
    btnSaveKey: $("btnSaveKey"),
    btnClearKey: $("btnClearKey"),
    keyStatus: $("keyStatus"),
    btnReload: $("btnReload"),
    btnAdd: $("btnAdd"),
    btnRefreshAllQuotas: $("btnRefreshAllQuotas"),
    oauthStatus: $("oauthStatus"),
    oauthUrl: $("oauthUrl"),
    oauthState: $("oauthState"),
    btnCopyUrl: $("btnCopyUrl"),
    oauthPaste: $("oauthPaste"),
    btnSubmitCallback: $("btnSubmitCallback"),
    accountsBody: $("accountsBody"),
    accountsMeta: $("accountsMeta"),
    quotaModal: $("quotaModal"),
    quotaClose: $("quotaClose"),
    quotaBody: $("quotaBody"),
    versionBar: $("versionBar"),
    versionLocal: $("versionLocal"),
    versionUpdate: $("versionUpdate"),
  };

  const state = {
    apiKey: "",
    oauth: { state: null, url: null },
    quotaByAccount: {},               // 缓存各账号的额度数据
    quotaRefreshingAll: false,        // 一键刷新按钮防抖状态
    quotaRefreshingSingle: {},        // 单账号刷新防抖状态（key 为文件名）
    sortBy: null,                     // 当前排序依据：null | "claude" | "gemini"
    sortOrder: "desc",                // 排序方向："desc" 降序 | "asc" 升序
    lastAccountsPayload: null,        // 缓存最后一次账号数据，用于重新排序渲染
  };

  // 防抖时间配置（毫秒）
  const DEBOUNCE_ALL = 3000;
  const DEBOUNCE_SINGLE = 2000;

  let oauthPollTimer = null;

  function setStatus(text, type = "info") {
    const prefix = type === "error" ? "❌ " : type === "success" ? "✅ " : "ℹ️ ";
    els.keyStatus.textContent = prefix + text;
  }

  function closeQuotaModal() {
    els.quotaModal.classList.remove("open");
  }

	  function renderQuotaTable(data) {
	    if (!data || data.length === 0) {
	      els.quotaBody.innerHTML = '<div style="padding: 20px;">未查询到相关模型额度信息。</div>';
	      return;
	    }
	    let html = '<table class="table" style="min-width: 100%;"><thead><tr><th>模型</th><th>剩余</th><th>重置时间</th></tr></thead><tbody>';
	    for (const item of data) {
	      const resetText = Number.isFinite(item?.resetTimeMs) ? formatLocalDateTime(item.resetTimeMs) : item.reset;
	      html += `<tr>
	            <td class="mono">${item.model}</td>
	            <td>${item.limit}</td>
	            <td>${resetText || "-"}</td>
	        </tr>`;
	    }
	    html += '</tbody></table>';
	    els.quotaBody.innerHTML = html;
	  }

  function loadApiKey() {
    try {
      const saved = localStorage.getItem("admin_api_key") || "";
      state.apiKey = saved;
      els.apiKey.value = saved;
      if (saved) setStatus("已加载本地保存的 API Key", "success");
      else setStatus("未设置 API Key（如果服务端配置了 api_keys，调用会 401）", "info");
    } catch (e) {
      setStatus("无法读取 localStorage", "error");
    }
  }

  function saveApiKey() {
    state.apiKey = (els.apiKey.value || "").trim();
    try {
      localStorage.setItem("admin_api_key", state.apiKey);
      setStatus(state.apiKey ? "API Key 已保存" : "API Key 已清空", "success");
    } catch (e) {
      setStatus("保存失败（localStorage 不可用）", "error");
    }
  }

  function clearApiKey() {
    els.apiKey.value = "";
    state.apiKey = "";
    try {
      localStorage.removeItem("admin_api_key");
    } catch (e) {}
    setStatus("已清除 API Key", "success");
  }

  async function apiFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (state.apiKey) headers["x-api-key"] = state.apiKey;
    if (!headers["Content-Type"] && options.method && options.method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, Object.assign({}, options, { headers }));
    const contentType = res.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || (typeof data === "string" ? data : `HTTP ${res.status}`);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

	  function formatLocalDateTime(value) {
	    if (value === undefined || value === null || value === "") return "-";
	    const d = new Date(value);
	    if (Number.isNaN(d.getTime())) return "-";
	    const yyyy = d.getFullYear();
	    const MM = String(d.getMonth() + 1).padStart(2, "0");
	    const dd = String(d.getDate()).padStart(2, "0");
	    const HH = String(d.getHours()).padStart(2, "0");
	    const mm = String(d.getMinutes()).padStart(2, "0");
	    const ss = String(d.getSeconds()).padStart(2, "0");
	    return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
	  }
	
	  function formatExpiry(expiryDateMs) {
	    return formatLocalDateTime(expiryDateMs);
	  }

  // 渲染单个账号的额度信息到表格单元格
  function renderQuotaInline(quotaList, cellEl, fileName) {
    cellEl.innerHTML = "";
    cellEl.className = "quota-cell";

    if (!quotaList || quotaList.length === 0) {
      cellEl.innerHTML = '<span class="quota-loading">-</span>';
      return;
    }

    // 按 shortName 去重，同类模型共用额度池，只取第一条
    const seen = new Set();
    const uniqueList = quotaList.filter(q => {
      if (seen.has(q.shortName)) return false;
      seen.add(q.shortName);
      return true;
    });

    const container = document.createElement("div");
    container.className = "quota-list";

    for (const q of uniqueList) {
      const row = document.createElement("div");
      row.className = "quota-item";

      // 模型简称（带颜色标识）
      const modelSpan = document.createElement("span");
      modelSpan.className = `quota-model ${q.shortName}`;
      modelSpan.textContent = q.shortName;
      row.appendChild(modelSpan);

      // 进度条容器
      const barWrap = document.createElement("div");
      barWrap.className = "quota-bar-wrap";
      const bar = document.createElement("div");
      bar.className = "quota-bar";

      // 根据剩余比例设置进度条宽度和颜色
      const fraction = q.remainingFraction ?? 0;
      const percent = Math.round(fraction * 100);
      bar.style.width = `${percent}%`;

      // 颜色等级：>50% 绿色，20%-50% 黄色，<20% 红色
      if (fraction > 0.5) {
        bar.classList.add("high");
      } else if (fraction > 0.2) {
        bar.classList.add("medium");
      } else {
        bar.classList.add("low");
      }
      barWrap.appendChild(bar);
      row.appendChild(barWrap);

      // 百分比数值
      const percentSpan = document.createElement("span");
      percentSpan.className = "quota-percent";
      percentSpan.textContent = q.limit || "-";
      row.appendChild(percentSpan);

      // 重置时间
      const resetSpan = document.createElement("span");
      resetSpan.className = "quota-reset";
      resetSpan.textContent = q.resetShort || "";
      row.appendChild(resetSpan);

      // 预估调用次数
      if (q.estimatedCalls !== null && q.estimatedCalls !== undefined) {
        const callsSpan = document.createElement("span");
        callsSpan.className = "quota-calls";
        callsSpan.textContent = `~${q.estimatedCalls}`;
        row.appendChild(callsSpan);
      }

      container.appendChild(row);
    }

    cellEl.appendChild(container);
  }

  // 一键刷新所有账号额度（带防抖）
  async function refreshAllQuotas() {
    if (state.quotaRefreshingAll) return;
    state.quotaRefreshingAll = true;

    const btn = els.btnRefreshAllQuotas;
    if (btn) {
      btn.classList.add("refreshing");
      btn.disabled = true;
    }

    try {
      const res = await apiFetch("/admin/api/accounts/quotas/refresh", { method: "POST", body: "{}" });
      if (res.data) {
        state.quotaByAccount = res.data;
        updateQuotaCellsFromCache();
      }
    } catch (e) {
      console.error("刷新所有额度失败:", e);
    }

    // 防抖延时恢复
    setTimeout(() => {
      state.quotaRefreshingAll = false;
      if (btn) {
        btn.classList.remove("refreshing");
        btn.disabled = false;
      }
    }, DEBOUNCE_ALL);
  }

  // 刷新单个账号额度（带防抖）
  async function refreshSingleQuota(fileName, btnEl, cellEl) {
    if (state.quotaRefreshingSingle[fileName]) return;
    state.quotaRefreshingSingle[fileName] = true;

    if (btnEl) {
      btnEl.classList.add("refreshing");
      btnEl.disabled = true;
    }

    try {
      const res = await apiFetch(`/admin/api/accounts/${encodeURIComponent(fileName)}/quota/refresh`, {
        method: "POST",
        body: "{}",
      });
      if (res.data) {
        state.quotaByAccount[fileName] = res.data;
        renderQuotaInline(res.data, cellEl, fileName);
      }
    } catch (e) {
      console.error(`刷新账号 ${fileName} 额度失败:`, e);
    }

    // 防抖延时恢复按钮状态
    setTimeout(() => {
      state.quotaRefreshingSingle[fileName] = false;
      if (btnEl) {
        btnEl.classList.remove("refreshing");
        btnEl.disabled = false;
      }
    }, DEBOUNCE_SINGLE);
  }

  // 根据缓存数据更新所有额度单元格
  function updateQuotaCellsFromCache() {
    const rows = els.accountsBody.querySelectorAll("tr");
    rows.forEach((row) => {
      const fileCell = row.querySelector("td:first-child");
      const quotaCell = row.querySelector("td.quota-cell");
      if (fileCell && quotaCell) {
        const fileName = fileCell.textContent.trim();
        const quotaData = state.quotaByAccount[fileName];
        if (quotaData) {
          renderQuotaInline(quotaData, quotaCell, fileName);
        }
      }
    });
  }

  // 获取所有账号额度（用于初始化加载）
  async function fetchAllQuotas() {
    try {
      const res = await apiFetch("/admin/api/accounts/quotas", { method: "GET" });
      if (res.data) {
        state.quotaByAccount = res.data;
        updateQuotaCellsFromCache();
      }
    } catch (e) {
      console.error("获取额度信息失败:", e);
    }
  }

  // 获取账号指定模型的剩余额度比例
  function getQuotaFraction(fileName, modelType) {
    const quotaList = state.quotaByAccount[fileName];
    if (!quotaList || quotaList.length === 0) return null;
    const item = quotaList.find(q => q.shortName === modelType);
    return item?.remainingFraction ?? null;
  }

  // 按额度排序账号列表
  function sortAccountsByQuota(accounts) {
    if (!state.sortBy || !accounts || accounts.length === 0) {
      return accounts;
    }

    const modelType = state.sortBy; // "claude" 或 "gemini"
    const multiplier = state.sortOrder === "desc" ? -1 : 1;

    return [...accounts].sort((a, b) => {
      const fracA = getQuotaFraction(a.file, modelType);
      const fracB = getQuotaFraction(b.file, modelType);

      // 无额度数据的排在最后
      if (fracA === null && fracB === null) return 0;
      if (fracA === null) return 1;
      if (fracB === null) return -1;

      return (fracA - fracB) * multiplier;
    });
  }

  // 切换排序状态
  function toggleSort(modelType) {
    if (state.sortBy === modelType) {
      // 同一按钮：切换升序/降序
      state.sortOrder = state.sortOrder === "desc" ? "asc" : "desc";
    } else {
      // 不同按钮：切换到新模型，默认降序
      state.sortBy = modelType;
      state.sortOrder = "desc";
    }
    // 更新排序按钮显示
    updateSortButtons();
    // 重新渲染账号列表
    if (state.lastAccountsPayload) {
      renderAccounts(state.lastAccountsPayload);
    }
  }

  // 更新排序按钮显示状态
  function updateSortButtons() {
    const claudeBtn = document.getElementById("sortClaude");
    const geminiBtn = document.getElementById("sortGemini");
    if (claudeBtn) {
      claudeBtn.textContent = state.sortBy === "claude"
        ? (state.sortOrder === "desc" ? "Claude ↓" : "Claude ↑")
        : "Claude";
      claudeBtn.classList.toggle("active", state.sortBy === "claude");
    }
    if (geminiBtn) {
      geminiBtn.textContent = state.sortBy === "gemini"
        ? (state.sortOrder === "desc" ? "Gemini ↓" : "Gemini ↑")
        : "Gemini";
      geminiBtn.classList.toggle("active", state.sortBy === "gemini");
    }
  }

  function renderAccounts(payload) {
    // 缓存原始数据，用于重新排序时渲染
    state.lastAccountsPayload = payload;

    const { count, current, accounts } = payload || {};
    const total = count || 0;
    const claudeIndex = total > 0 ? (current?.claude ?? 0) + 1 : 0;
    const geminiIndex = total > 0 ? (current?.gemini ?? 0) + 1 : 0;
    els.accountsMeta.textContent = `账号数: ${total}；当前索引 claude=${claudeIndex} / gemini=${geminiIndex}`;

    els.accountsBody.innerHTML = "";
    if (!accounts || accounts.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;  // 增加到6列（含额度列）
      td.textContent = '暂无账号，请先点击 "OAuth 添加账号"。';
      tr.appendChild(td);
      els.accountsBody.appendChild(tr);
      return;
    }

    // 应用排序后遍历渲染
    const sortedAccounts = sortAccountsByQuota(accounts);
    for (const acc of sortedAccounts) {
      const tr = document.createElement("tr");

      const fileTd = document.createElement("td");
      fileTd.className = "mono";
      fileTd.textContent = acc.file || "-";

      const emailTd = document.createElement("td");
      emailTd.textContent = acc.email || "-";

      const pidTd = document.createElement("td");
      pidTd.className = "mono";
      pidTd.textContent = acc.projectId || "-";

      // 额度列（内联显示）
      const quotaTd = document.createElement("td");
      quotaTd.className = "quota-cell";
      quotaTd.innerHTML = '<span class="quota-loading">加载中...</span>';
      // 稍后由 fetchAllQuotas 填充数据

      const expTd = document.createElement("td");
      expTd.textContent = formatExpiry(acc.expiry_date);

      const actTd = document.createElement("td");
      actTd.style.display = "flex";
      actTd.style.flexDirection = "row";
      actTd.style.gap = "6px";

      // 删除按钮
      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!acc.file) return;
        const ok = confirm(`确认删除账号文件：${acc.file} ？`);
        if (!ok) return;
        try {
          await apiFetch(`/admin/api/accounts/${encodeURIComponent(acc.file)}`, { method: "DELETE" });
          await refreshAccounts();
        } catch (e) {
          alert(`删除失败：${e.message || e}`);
        }
      });
      actTd.appendChild(delBtn);

      // 刷新额度按钮（放在删除按钮下方）
      const refreshBtn = document.createElement("button");
      refreshBtn.className = "btn small";
      refreshBtn.textContent = "刷新";
      refreshBtn.addEventListener("click", () => refreshSingleQuota(acc.file, refreshBtn, quotaTd));
      actTd.appendChild(refreshBtn);

      tr.appendChild(fileTd);
      tr.appendChild(emailTd);
      tr.appendChild(pidTd);
      tr.appendChild(quotaTd);
      tr.appendChild(expTd);
      tr.appendChild(actTd);
      els.accountsBody.appendChild(tr);
    }

    // 账号渲染完成后，自动填充已缓存的额度数据
    updateQuotaCellsFromCache();
  }

  async function refreshAccounts() {
    try {
      const res = await apiFetch("/admin/api/accounts", { method: "GET" });
      renderAccounts(res.data);
    } catch (e) {
      if (e.status === 401) {
        els.accountsMeta.textContent = "未授权：请先输入正确的 API Key";
        els.accountsBody.innerHTML = "";
        return;
      }
      els.accountsMeta.textContent = `加载失败：${e.message || e}`;
      els.accountsBody.innerHTML = "";
    }
  }

  async function reloadAccountsAndRender() {
    try {
      const res = await apiFetch("/admin/api/accounts/reload", { method: "POST", body: "{}" });
      renderAccounts(res.data);
      return;
    } catch (e) {
      // Fallback to normal refresh (will show 401 message if needed)
    }

    await refreshAccounts();
  }

  function setOAuthInfo({ status, url, stateId }) {
    els.oauthStatus.textContent = status || "-";
    els.oauthState.textContent = stateId || "-";
    if (url) {
      els.oauthUrl.textContent = url;
      els.oauthUrl.href = url;
    } else {
      els.oauthUrl.textContent = "-";
      els.oauthUrl.href = "#";
    }
  }

  function stopOAuthPolling() {
    if (oauthPollTimer) {
      clearInterval(oauthPollTimer);
      oauthPollTimer = null;
    }
  }

  async function pollOAuthStatusOnce() {
    if (!state.oauth.state) return;
    try {
      const res = await apiFetch(`/admin/api/oauth/status/${encodeURIComponent(state.oauth.state)}`, {
        method: "GET",
      });
      const data = res.data;
      if (!data || !data.status) return;

      if (data.status === "pending") {
        setOAuthInfo({ status: "等待授权回调...", url: state.oauth.url, stateId: state.oauth.state });
        return;
      }

      if (data.status === "expired") {
        stopOAuthPolling();
        setOAuthInfo({ status: `授权已过期：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
        return;
      }

      if (data.status === "completed") {
        stopOAuthPolling();
        if (data.success) {
          setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
          refreshAccounts();
        } else {
          setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
        }
      }
    } catch (e) {
      // keep polling silently
    }
  }

  function startOAuthPolling() {
    stopOAuthPolling();
    oauthPollTimer = setInterval(pollOAuthStatusOnce, 2000);
  }

  async function startOAuth() {
    stopOAuthPolling();
    setOAuthInfo({ status: "生成授权链接中..." });
    try {
      const res = await apiFetch("/admin/api/oauth/start", { method: "POST", body: "{}" });
      const data = res.data;
      state.oauth.state = data.state;
      state.oauth.url = data.auth_url;
      setOAuthInfo({ status: "请在弹窗完成授权", url: data.auth_url, stateId: data.state });

      const popup = window.open(data.auth_url, "_blank");
      if (!popup) {
        setOAuthInfo({ status: "弹窗被拦截，请手动点击链接打开", url: data.auth_url, stateId: data.state });
      }

      startOAuthPolling();
    } catch (e) {
      if (e.status === 401) {
        setOAuthInfo({ status: "未授权：请先输入正确的 API Key" });
        return;
      }
      setOAuthInfo({ status: `启动失败：${e.message || e}` });
    }
  }

  function handleOAuthMessage(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== "oauth_result") return;
    if (state.oauth.state && data.state && data.state !== state.oauth.state) return;

    if (data.success) {
      stopOAuthPolling();
      setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
      refreshAccounts();
    } else {
      stopOAuthPolling();
      setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
    }
  }

  async function copyOAuthUrl() {
    const url = state.oauth.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setOAuthInfo({ status: "已复制授权链接", url, stateId: state.oauth.state });
    } catch (e) {
      alert("复制失败，请手动复制");
    }
  }

  async function submitOAuthCallback() {
    const raw = (els.oauthPaste?.value || "").trim();
    if (!raw) {
      setOAuthInfo({ status: "请输入回调链接或授权码 code", url: state.oauth.url, stateId: state.oauth.state });
      return;
    }

    setOAuthInfo({ status: "提交授权信息中...", url: state.oauth.url, stateId: state.oauth.state });

    try {
      const body = { callback_url: raw };
      if (state.oauth.state) body.state = state.oauth.state;
      const res = await apiFetch("/admin/api/oauth/complete", { method: "POST", body: JSON.stringify(body) });
      const data = res.data || {};
      if (data.state && !state.oauth.state) state.oauth.state = data.state;

      if (data.success) {
        stopOAuthPolling();
        setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
        if (els.oauthPaste) els.oauthPaste.value = "";
        refreshAccounts();
      } else {
        setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
      }
    } catch (e) {
      if (e.status === 401) {
        setOAuthInfo({ status: "未授权：请先输入正确的 API Key" });
        return;
      }
      setOAuthInfo({ status: `提交失败：${e.message || e}`, url: state.oauth.url, stateId: state.oauth.state });
    }
  }

  function bindEvents() {
    els.btnSaveKey.addEventListener("click", () => {
      saveApiKey();
      refreshAccounts();
    });
    els.btnClearKey.addEventListener("click", () => {
      clearApiKey();
      refreshAccounts();
    });
    els.btnReload.addEventListener("click", async () => {
      try {
        await apiFetch("/admin/api/accounts/reload", { method: "POST", body: "{}" });
      } catch (e) {}
      refreshAccounts();
    });
    els.btnAdd.addEventListener("click", startOAuth);
    els.btnCopyUrl.addEventListener("click", copyOAuthUrl);
    if (els.btnSubmitCallback) {
      els.btnSubmitCallback.addEventListener("click", submitOAuthCallback);
    }
    if (els.oauthPaste) {
      els.oauthPaste.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitOAuthCallback();
      });
    }
    window.addEventListener("message", handleOAuthMessage);
    els.quotaClose.addEventListener("click", closeQuotaModal);
    els.quotaModal.addEventListener("click", (e) => {
      if (e.target === els.quotaModal) closeQuotaModal();
    });
    // 一键刷新额度按钮
    if (els.btnRefreshAllQuotas) {
      els.btnRefreshAllQuotas.addEventListener("click", refreshAllQuotas);
    }
    // 排序按钮
    const sortClaudeBtn = document.getElementById("sortClaude");
    const sortGeminiBtn = document.getElementById("sortGemini");
    if (sortClaudeBtn) {
      sortClaudeBtn.addEventListener("click", () => toggleSort("claude"));
    }
    if (sortGeminiBtn) {
      sortGeminiBtn.addEventListener("click", () => toggleSort("gemini"));
    }
  }

  function normalizeVersion(value) {
    return String(value || "")
      .trim()
      .replace(/^v/i, "");
  }

  function parseDateVersionKey(value) {
    const v = normalizeVersion(value);
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-t(\d{6})$/.exec(v);
    if (!m) return null;
    return `${m[1]}${m[2]}${m[3]}${m[4]}`;
  }

  function parseSemverParts(value) {
    const v = normalizeVersion(value);
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function compareVersionStrings(localVersion, latestVersion) {
    const localKey = parseDateVersionKey(localVersion);
    const latestKey = parseDateVersionKey(latestVersion);
    if (localKey && latestKey) {
      if (latestKey === localKey) return 0;
      return latestKey > localKey ? 1 : -1;
    }

    const localSemver = parseSemverParts(localVersion);
    const latestSemver = parseSemverParts(latestVersion);
    if (localSemver && latestSemver) {
      for (let i = 0; i < 3; i++) {
        if (latestSemver[i] !== localSemver[i]) return latestSemver[i] > localSemver[i] ? 1 : -1;
      }
      return 0;
    }

    const a = normalizeVersion(localVersion);
    const b = normalizeVersion(latestVersion);
    if (!a || !b) return null;
    return a === b ? 0 : null;
  }

  function renderVersionInfo(payload) {
    if (!els.versionLocal || !els.versionUpdate) return;

    const localVersion = payload?.local?.version || "-";
    const repo = payload?.repo || "znlsl/Antigravity2Api";
    const latestTag = payload?.latest?.tag_name || null;
    const latestUrl = payload?.latest?.html_url || `https://github.com/${repo}/releases/latest`;

    els.versionLocal.textContent = `本地版本：${localVersion}`;

    els.versionUpdate.textContent = "";
    els.versionUpdate.innerHTML = "";

    if (!latestTag) return;

    const cmp = compareVersionStrings(localVersion, latestTag);
    const updateAvailable = cmp == null ? normalizeVersion(localVersion) !== normalizeVersion(latestTag) : cmp > 0;
    if (!updateAvailable) return;

    const prefix = document.createElement("span");
    prefix.textContent = "发现新版本：";

    const link = document.createElement("a");
    link.href = latestUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = latestTag;

    els.versionUpdate.appendChild(prefix);
    els.versionUpdate.appendChild(link);
  }

  async function refreshVersionInfo() {
    if (!els.versionBar || !els.versionLocal || !els.versionUpdate) return;
    els.versionLocal.textContent = "本地版本：加载中...";
    els.versionUpdate.textContent = "";
    try {
      const res = await fetch("/ui/version", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return;
      renderVersionInfo(data);
    } catch (e) {
      // Ignore version check errors (offline / proxy / rate-limit), UI should still work.
    }
  }

  loadApiKey();
  bindEvents();
  reloadAccountsAndRender().then(() => {
    // 账号加载完成后自动获取额度信息
    fetchAllQuotas();
  });
  refreshVersionInfo();
})();
