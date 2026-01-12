const path = require("path");

const httpClient = require("../auth/httpClient");

function parseEnvNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// Fixed delay used for:
// - network error retry
// - 429 without retryDelay (and after account rotation)
// - 429 with retryDelay > 5000ms (after rotation)
const FIXED_RETRY_DELAY_MS = parseEnvNonNegativeInt("AG2API_RETRY_DELAY_MS", 1200);

// Quota refresh interval (seconds). Each tick refreshes ALL accounts concurrently.
// Default: 300s.
const QUOTA_REFRESH_S = parseEnvNonNegativeInt("AG2API_QUOTA_REFRESH_S", 300);
const QUOTA_REFRESH_MS = QUOTA_REFRESH_S * 1000;

// First request will wait up to this long for the initial quota refresh to complete.
const INITIAL_QUOTA_WAIT_MS = 3000;

const KNOWN_LOG_LEVELS = new Set([
  "debug",
  "info",
  "success",
  "warn",
  "error",
  "fatal",
  "request",
  "response",
  "upstream",
  "retry",
  "account",
  "quota",
  "stream",
]);

function isKnownLogLevel(value) {
  return typeof value === "string" && KNOWN_LOG_LEVELS.has(value.toLowerCase());
}

class UpstreamClient {
  constructor(authManager, options = {}) {
    this.auth = authManager;
    this.logger = options.logger || null;

    // Per-model quota cache:
    // model -> (accountKey -> { remainingPercent, resetTimeMs, cooldownUntilMs, updatedAtMs, ... })
    this.modelQuotaByAccount = new Map();
    // Cache last HTTP error response per model (for fast-fail when all accounts are exhausted).
    this.lastErrorByModel = new Map();

    this._quotaRefreshInFlight = false;
    this._quotaRefreshTimer = null;
    this._initialQuotaRefreshPromise = null;
    this._initialQuotaRefreshDone = false;
    this.startQuotaRefresher();
  }

  // 基础日志方法（兼容旧 API）
  log(levelOrTitle, messageOrData, meta) {
    if (this.logger) {
      if (typeof this.logger.log === "function") {
        if (isKnownLogLevel(levelOrTitle)) {
          return this.logger.log(String(levelOrTitle).toLowerCase(), messageOrData, meta);
        }
        return this.logger.log("info", String(levelOrTitle), messageOrData);
      }
      if (typeof this.logger === "function") {
        return this.logger(levelOrTitle, messageOrData, meta);
      }
    }

    const title = String(levelOrTitle);
    if (meta !== undefined && meta !== null) {
      console.log(`[${title}]`, messageOrData, meta);
      return;
    }
    if (messageOrData !== undefined && messageOrData !== null) {
      console.log(`[${title}]`, typeof messageOrData === "string" ? messageOrData : JSON.stringify(messageOrData, null, 2));
      return;
    }
    console.log(`[${title}]`);
  }

  // 上游调用日志
  logUpstream(action, options = {}) {
    if (this.logger && typeof this.logger.logUpstream === "function") {
      return this.logger.logUpstream(action, options);
    }
    // 回退到基础日志
    const { method, account, model, group, attempt, maxAttempts, status, duration, error } = options;
    const attemptStr = attempt && maxAttempts ? `[${attempt}/${maxAttempts}]` : "";
    const message = `${action} ${attemptStr} [${group || ""}] @${account || "unknown"} ${model || ""}`;
    this.log("upstream", { message, status, duration, error });
  }

  // 重试日志
  logRetry(reason, options = {}) {
    if (this.logger && typeof this.logger.logRetry === "function") {
      return this.logger.logRetry(reason, options);
    }
    // 回退到基础日志
    const { attempt, maxAttempts, delayMs, account, error, nextAction } = options;
    this.log("retry", { reason, attempt, maxAttempts, delayMs, account, error, nextAction });
  }

  // 配额日志
  logQuota(event, options = {}) {
    if (this.logger && typeof this.logger.logQuota === "function") {
      return this.logger.logQuota(event, options);
    }
    this.log("quota", { event, ...options });
  }

  // 错误日志
  logError(message, error, options = {}) {
    if (this.logger && typeof this.logger.logError === "function") {
      return this.logger.logError(message, error, options);
    }
    this.log("error", { message, error: error?.message || error, ...options });
  }

  getMaxAttempts() {
    const n = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
    return Math.max(1, n || 0);
  }

  getQuotaGroupFromModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) return "claude";
    if (m.includes("gemini")) return "gemini";
    return "gemini";
  }

  parseDurationMs(durationStr) {
    if (!durationStr) return null;
    const str = String(durationStr).trim();
    if (!str) return null;

    let totalMs = 0;
    let matched = false;
    const re = /([\d.]+)\s*(ms|s|m|h)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      matched = true;
      const value = parseFloat(m[1]);
      if (!Number.isFinite(value)) continue;
      const unit = m[2];
      if (unit === "ms") totalMs += value;
      else if (unit === "s") totalMs += value * 1000;
      else if (unit === "m") totalMs += value * 60 * 1000;
      else if (unit === "h") totalMs += value * 60 * 60 * 1000;
    }
    if (!matched) return null;
    return Math.round(totalMs);
  }

  parseRetryDelayMs(errText) {
    try {
      const errObj = JSON.parse(errText);
      const details = errObj.error?.details || [];

      // RetryInfo.retryDelay like "1.203608125s"
      const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"));
      if (retryInfo?.retryDelay) {
        const ms = this.parseDurationMs(retryInfo.retryDelay);
        if (ms != null) return ms;
      }

      // quotaResetDelay like "331.167174ms" or "1h16m0.667923083s"
      const metaDelay = details.find((d) => d.metadata?.quotaResetDelay)?.metadata?.quotaResetDelay;
      if (metaDelay) {
        const ms = this.parseDurationMs(metaDelay);
        if (ms != null) return ms;
      }
    } catch (_) {}
    return null;
  }

  getAccountKeyFromAccount(account) {
    return account?.filePath ? path.basename(account.filePath) : "unknown-account";
  }

  startQuotaRefresher() {
    if (this._quotaRefreshTimer || this._initialQuotaRefreshPromise) return;

    // Initial refresh: wait for accounts to load (up to INITIAL_QUOTA_WAIT_MS),
    // then refresh all accounts concurrently.
    this._initialQuotaRefreshPromise = (async () => {
      try {
        const ready = await this.waitForAccountsReady(INITIAL_QUOTA_WAIT_MS);
        if (!ready) return;
        if (this.auth && typeof this.auth.waitInitialTokenRefresh === "function") {
          await this.auth.waitInitialTokenRefresh();
        }
        await this.refreshAllAccountQuotas();
      } catch (e) {
        this.logError("额度刷新失败", e);
      }
    })().finally(() => {
      this._initialQuotaRefreshDone = true;
    });

    if (!Number.isFinite(QUOTA_REFRESH_MS) || QUOTA_REFRESH_MS <= 0) return;

    const tick = async () => {
      try {
        await this.refreshAllAccountQuotas();
      } catch (e) {
        this.logError("额度刷新失败", e);
      }
    };

    this._quotaRefreshTimer = setInterval(() => tick(), QUOTA_REFRESH_MS);
    if (this._quotaRefreshTimer && typeof this._quotaRefreshTimer.unref === "function") this._quotaRefreshTimer.unref();
  }

  async waitForAccountsReady(timeoutMs) {
    const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 0;
    if (timeout <= 0) {
      const count = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
      return count > 0;
    }

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
      if (count > 0) return true;
      await this.sleep(50);
    }

    const count = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
    return count > 0;
  }

  async refreshAllAccountQuotas() {
    if (this._quotaRefreshInFlight) return;
    if (!this.auth || typeof this.auth.getAccountCount !== "function") return;

    const accountCount = this.auth.getAccountCount();
    if (!accountCount) return;

    this._quotaRefreshInFlight = true;

    try {
      const now = Date.now();
      const perAccount = [];

      for (let accountIndex = 0; accountIndex < accountCount; accountIndex++) {
        perAccount.push(
          (async () => {
            let account = null;
            let accessToken = null;

            try {
              if (typeof this.auth.getAccessTokenByIndex === "function") {
                const creds = await this.auth.getAccessTokenByIndex(accountIndex, "gemini");
                account = creds.account;
                accessToken = creds.accessToken;
              } else if (Array.isArray(this.auth.accounts)) {
                account = this.auth.accounts[accountIndex];
                accessToken = account?.creds?.access_token || null;
              }
            } catch (e) {
              const accountKey = this.getAccountKeyFromAccount(account) || `account_${accountIndex}`;
              return { accountKey, ok: false, error: e };
            }

            const accountKey = this.getAccountKeyFromAccount(account);
            if (!accessToken) {
              return { accountKey, ok: false, error: new Error("Missing access_token") };
            }
            try {
              const models = await httpClient.fetchAvailableModels(accessToken, null);
              return { accountKey, ok: true, models };
            } catch (e) {
              return { accountKey, ok: false, error: e };
            }
          })(),
        );
      }

      const results = await Promise.all(perAccount);

      const failed = results.filter((r) => !r || !r.ok);
      for (const item of failed) {
        const accountKey = item?.accountKey || "unknown-account";
        const message = String(item?.error?.message || item?.error || "unknown error")
          .split("\n")[0]
          .slice(0, 200);
        this.log("quota", `额度刷新失败 @${accountKey}${message ? ` (${message})` : ""}`);
      }

      this.log("quota", `额度刷新完成 ok=${results.length - failed.length} fail=${failed.length}`);

      for (const item of results) {
        if (!item || !item.ok || !item.models || typeof item.models !== "object") continue;
        const { accountKey, models } = item;

        for (const modelId of Object.keys(models)) {
          const quotaInfo = models[modelId]?.quotaInfo || {};
          const remainingFraction = quotaInfo.remainingFraction;
          const remainingPercent =
            remainingFraction !== undefined && remainingFraction !== null ? Math.round(remainingFraction * 100) : null;
          const resetTime = quotaInfo.resetTime || null;
          const resetTimeMs = resetTime ? Date.parse(resetTime) : null;

          const perModel = this.modelQuotaByAccount.get(modelId) || new Map();
          const prev = perModel.get(accountKey) || {};
          perModel.set(accountKey, {
            ...prev,
            remainingFraction,
            remainingPercent,
            resetTime,
            resetTimeMs: Number.isFinite(resetTimeMs) ? resetTimeMs : null,
            updatedAtMs: now,
          });
          this.modelQuotaByAccount.set(modelId, perModel);
        }
      }

    } finally {
      this._quotaRefreshInFlight = false;
    }
  }

  parseErrorDetails(errText) {
    try {
      const errObj = JSON.parse(errText);
      return {
        code: errObj.error?.code,
        message: errObj.error?.message,
        status: errObj.error?.status,
        details: errObj.error?.details,
      };
    } catch (_) {
      return { message: errText };
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }

  setCooldownUntil(modelId, accountKey, cooldownUntilMs) {
    const key = String(modelId || "").trim();
    if (!key) return;
    const perModel = this.modelQuotaByAccount.get(key) || new Map();
    const prev = perModel.get(accountKey) || {};
    perModel.set(accountKey, {
      ...prev,
      cooldownUntilMs: Number.isFinite(cooldownUntilMs) ? cooldownUntilMs : null,
    });
    this.modelQuotaByAccount.set(key, perModel);
  }

  async cacheLastErrorResponse(modelId, response) {
    const key = String(modelId || "").trim();
    if (!key || !response) return;

    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch (_) {}

    const headers = {};
    try {
      response.headers?.forEach?.((value, name) => {
        headers[name] = value;
      });
    } catch (_) {}

    this.lastErrorByModel.set(key, {
      status: response.status,
      headers,
      bodyText,
      cachedAtMs: Date.now(),
    });
  }

  getCachedErrorResponse(modelId) {
    const key = String(modelId || "").trim();
    if (!key) return null;
    const cached = this.lastErrorByModel.get(key);
    if (!cached) return null;
    try {
      return new Response(cached.bodyText || "", {
        status: cached.status || 500,
        headers: cached.headers || {},
      });
    } catch (_) {
      return null;
    }
  }

  getAccountPrioritiesForModel(modelId, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const includeZero = !!options.includeZero;
    const excludeAccountIndices = options.excludeAccountIndices instanceof Set ? options.excludeAccountIndices : new Set();

    const accounts = Array.isArray(this.auth?.accounts) ? this.auth.accounts : [];
    const perModel = this.modelQuotaByAccount.get(String(modelId || "").trim());

    let knownCount = 0;
    let nonZeroKnownCount = 0;
    const items = [];

    for (let accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
      if (excludeAccountIndices.has(accountIndex)) continue;

      const account = accounts[accountIndex];
      const accountKey = this.getAccountKeyFromAccount(account);
      const q = perModel ? perModel.get(accountKey) : null;

      const remainingPercent = Number.isFinite(q?.remainingPercent) ? q.remainingPercent : null;
      if (remainingPercent !== null) {
        knownCount++;
        if (remainingPercent > 0) nonZeroKnownCount++;
      }

      if (!includeZero && remainingPercent === 0) continue;

      const resetTimeMs = Number.isFinite(q?.resetTimeMs) ? q.resetTimeMs : null;
      const cooldownUntilMs = Number.isFinite(q?.cooldownUntilMs) ? q.cooldownUntilMs : 0;

      items.push({
        accountIndex,
        accountKey,
        remainingPercent,
        resetTimeMs,
        cooldownUntilMs,
        cooldownActive: cooldownUntilMs > now,
      });
    }

    items.sort((a, b) => {
      if (a.cooldownActive !== b.cooldownActive) return a.cooldownActive ? 1 : -1;

      const aPct = a.remainingPercent !== null ? a.remainingPercent : -1;
      const bPct = b.remainingPercent !== null ? b.remainingPercent : -1;
      if (aPct !== bPct) return bPct - aPct;

      const aReset = Number.isFinite(a.resetTimeMs) ? a.resetTimeMs : Number.POSITIVE_INFINITY;
      const bReset = Number.isFinite(b.resetTimeMs) ? b.resetTimeMs : Number.POSITIVE_INFINITY;
      if (aReset !== bReset) return aReset - bReset;

      return a.accountIndex - b.accountIndex;
    });

    const allKnown = accounts.length > 0 && knownCount === accounts.length;
    const allZeroKnown = allKnown && nonZeroKnownCount === 0;

    return {
      items,
      allKnown,
      allZeroKnown,
    };
  }

  /**
   * v1internal call with 429 retry + per-model quota group rotation.
   * @param {string} method - v1internal method (e.g. "generateContent")
   * @param {object} options
   * @param {string} [options.group] - "claude" | "gemini" (defaults to inferred from model)
   * @param {string} [options.model] - Used to infer group when group is not provided
   * @param {string} [options.queryString]
   * @param {(projectId: string) => object} options.buildBody
   * @param {object} [options.headers]
   * @returns {Promise<Response>}
   */
  async callV1Internal(method, options = {}) {
    const buildBody = options.buildBody;
    if (typeof buildBody !== "function") {
      throw new Error("UpstreamClient.callV1Internal requires options.buildBody(projectId)");
    }

    const quotaGroup = this.getQuotaGroupFromModel(options.group || options.model);
    const modelId = String(options.model || "").trim();
    const queryString = options.queryString || "";
    const headers = options.headers && typeof options.headers === "object" ? options.headers : {};

    let lastResponse = null;
    let lastNetworkError = null;
    const maxAttempts = this.getMaxAttempts();

    this.logUpstream(`开始调用 v1internal:${method}`, {
      method,
      group: quotaGroup,
      model: modelId || options.model,
      maxAttempts,
    });

    // Best-effort: wait for initial quota refresh so the first request can pick the best account.
    if (modelId && this._initialQuotaRefreshPromise && !this._initialQuotaRefreshDone) {
      try {
        await Promise.race([this._initialQuotaRefreshPromise, this.sleep(INITIAL_QUOTA_WAIT_MS)]);
      } catch (_) {}
    }

    // Fast-fail: if we KNOW all accounts have 0% quota for this model, do not try all accounts.
    if (modelId) {
      const snapshot = this.getAccountPrioritiesForModel(modelId, { includeZero: true, now: Date.now() });
      if (snapshot.allZeroKnown) {
        const cached = this.getCachedErrorResponse(modelId);
        if (cached) return cached;

        const pick = snapshot.items[0];
        if (!pick) {
          throw new Error(`No accounts available for model ${modelId}`);
        }

        let creds;
        try {
          creds = await this.auth.getCredentialsByIndex(pick.accountIndex, quotaGroup);
        } catch (e) {
          this.logError(`获取凭证失败 [${quotaGroup}]`, e, { attempt: 1, maxAttempts: 1 });
          throw e;
        }

        const accountName = this.getAccountKeyFromAccount(creds.account);
        const requestBody = buildBody(creds.projectId);
        const startTime = Date.now();

        this.logUpstream(`发送请求`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: 1,
          maxAttempts: 1,
          model: modelId,
        });

        let response;
        try {
          response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
            queryString,
            headers,
            limiter: this.auth.apiLimiter,
          });
        } catch (netErr) {
          const duration = Date.now() - startTime;
          this.logError(`网络错误`, netErr, {
            context: {
              method: `v1internal:${method}`,
              group: quotaGroup,
              account: accountName,
              attempt: 1,
              maxAttempts: 1,
              duration,
            },
          });
          throw netErr;
        }

        if (!response.ok) {
          await this.cacheLastErrorResponse(modelId, response);
        }

        return response;
      }
    }

    const triedAccountIndices = new Set();

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      const attemptNum = attempts + 1;
      const now = Date.now();

      let picked = null;
      if (modelId) {
        const { items } = this.getAccountPrioritiesForModel(modelId, { now, excludeAccountIndices: triedAccountIndices });
        if (items.length === 0) break;

        if (items.every((item) => item.cooldownActive)) {
          const cached = this.getCachedErrorResponse(modelId);
          if (cached) return cached;
          if (lastResponse) return lastResponse;
          if (lastNetworkError) throw lastNetworkError;
          throw new Error(`All accounts are in cooldown for model ${modelId}`);
        }

        picked = items[0];
      } else {
        // If model is unknown, fall back to current account selection by group index.
        picked = {
          accountIndex: this.auth?.getCurrentAccountIndex ? this.auth.getCurrentAccountIndex(quotaGroup) : 0,
          accountKey: "unknown-account",
          remainingPercent: null,
          resetTimeMs: null,
          cooldownUntilMs: 0,
          cooldownActive: false,
        };
      }

      triedAccountIndices.add(picked.accountIndex);

      let creds;
      try {
        creds = await this.auth.getCredentialsByIndex(picked.accountIndex, quotaGroup);
      } catch (e) {
        this.logError(`获取凭证失败 [${quotaGroup}]`, e, { attempt: attemptNum, maxAttempts });
        throw e;
      }

      const accountName = this.getAccountKeyFromAccount(creds.account);
      const requestBody = buildBody(creds.projectId);
      let startTime = Date.now();

      this.logUpstream(`发送请求`, {
        method,
        account: accountName,
        group: quotaGroup,
        attempt: attemptNum,
        maxAttempts,
        model: modelId || options.model,
      });

      let response;
      try {
        response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
          queryString,
          headers,
          limiter: this.auth.apiLimiter,
        });
      } catch (netErr) {
        const duration = Date.now() - startTime;
        lastNetworkError = netErr;

        this.logError(`网络错误`, netErr, {
          context: {
            method: `v1internal:${method}`,
            group: quotaGroup,
            account: accountName,
            attempt: attemptNum,
            maxAttempts,
            duration,
          },
        });

        if (maxAttempts === 1) {
          this.logRetry("网络错误，等待重试", {
            attempt: attemptNum,
            maxAttempts,
            delayMs: FIXED_RETRY_DELAY_MS,
            account: accountName,
            error: netErr.message || netErr,
            nextAction: "同账户重试",
          });

          await this.sleep(FIXED_RETRY_DELAY_MS);

          startTime = Date.now();
          try {
            response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
              queryString,
              headers,
              limiter: this.auth.apiLimiter,
            });
          } catch (netErr2) {
            const retryDuration = Date.now() - startTime;
            lastNetworkError = netErr2;
            this.logError(`重试时网络错误`, netErr2, {
              context: {
                method: `v1internal:${method}`,
                group: quotaGroup,
                account: accountName,
                attempt: attemptNum,
                maxAttempts,
                duration: retryDuration,
              },
            });
            throw netErr2;
          }
        } else {
          this.logRetry("网络错误，切换账户重试", {
            attempt: attemptNum,
            maxAttempts,
            delayMs: FIXED_RETRY_DELAY_MS,
            account: accountName,
            error: netErr.message || netErr,
            nextAction: "轮换到下一个账户",
          });

          await this.sleep(FIXED_RETRY_DELAY_MS);
          continue;
        }
      }

      const duration = Date.now() - startTime;

      if (response.ok) {
        this.logUpstream(`请求成功`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: attemptNum,
          maxAttempts,
          status: response.status,
          duration,
        });
        return response;
      }

      // Non-429 4xx: do not retry/rotate, pass through as-is.
      if (response.status !== 429) {
        let errorText = "";
        try {
          errorText = await response.clone().text();
        } catch (_) {}

        const errorDetails = this.parseErrorDetails(errorText);
        
        this.logUpstream(`请求失败 (${response.status})`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: attemptNum,
          maxAttempts,
          status: response.status,
          duration,
          error: errorDetails,
        });

        if (modelId) {
          await this.cacheLastErrorResponse(modelId, response);
        }
        return response;
      }

      lastResponse = response;
      if (modelId) {
        await this.cacheLastErrorResponse(modelId, response);
      }

      // 429: decide short-wait retry vs rotate.
      let errorText = "";
      try {
        errorText = await response.clone().text();
      } catch (_) {}

      const errorDetails = this.parseErrorDetails(errorText);
      let retryMs = this.parseRetryDelayMs(errorText);

      this.logQuota(`收到 429 限流响应`, {
        account: accountName,
        group: quotaGroup,
        resetDelay: retryMs,
      });

      this.log("error", `🚫 Google API 429 错误详情`, errorDetails);

      if (modelId) {
        const cooldownUntil = now + (retryMs != null ? Math.max(0, retryMs) : FIXED_RETRY_DELAY_MS);
        this.setCooldownUntil(modelId, accountName, cooldownUntil);
      }

      if (maxAttempts === 1) {
        if (retryMs != null && retryMs > 5000) {
          // Long cooldown: do not wait, just return the 429 as-is.
          return response;
        }

        const delay = retryMs == null ? FIXED_RETRY_DELAY_MS : Math.max(0, retryMs + 200);
        const reason = retryMs == null ? "429 无重试信息，延迟后同账户重试" : "短时间限流，延迟后同账户重试";
        this.logRetry(reason, {
          attempt: attemptNum,
          maxAttempts,
          delayMs: delay,
          account: accountName,
          nextAction: "同账户重试",
        });

        await this.sleep(delay);

        startTime = Date.now();
        let retryResp;
        try {
          retryResp = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
            queryString,
            headers,
            limiter: this.auth.apiLimiter,
          });
        } catch (netErr2) {
          const retryDuration = Date.now() - startTime;
          lastNetworkError = netErr2;
          this.logError(`重试时网络错误`, netErr2, {
            context: {
              method: `v1internal:${method}`,
              group: quotaGroup,
              account: accountName,
              attempt: attemptNum,
              maxAttempts,
              duration: retryDuration,
            },
          });
          throw netErr2;
        }

        const retryDuration = Date.now() - startTime;
        if (retryResp.ok) {
          this.logUpstream(`重试成功`, {
            method,
            account: accountName,
            group: quotaGroup,
            attempt: attemptNum,
            maxAttempts,
            status: retryResp.status,
            duration: retryDuration,
          });
          return retryResp;
        }

        if (modelId) {
          await this.cacheLastErrorResponse(modelId, retryResp);
        }

        if (retryResp.status !== 429) {
          this.logUpstream(`重试返回非 429 错误`, {
            method,
            account: accountName,
            group: quotaGroup,
            attempt: attemptNum,
            maxAttempts,
            status: retryResp.status,
            duration: retryDuration,
          });
          return retryResp;
        }

        lastResponse = retryResp;
        return retryResp;
      }

      if (retryMs == null) {
        this.logRetry("429 无重试信息，延迟后切换账户", {
          attempt: attemptNum,
          maxAttempts,
          delayMs: FIXED_RETRY_DELAY_MS,
          account: accountName,
          nextAction: "延迟后轮换到下一个账户",
        });
        await this.sleep(FIXED_RETRY_DELAY_MS);
      } else {
        this.logRetry("429 可解析重试信息，立即切换账户", {
          attempt: attemptNum,
          maxAttempts,
          delayMs: retryMs,
          account: accountName,
          nextAction: "立即轮换到下一个账户",
        });
      }
    }

    if (lastResponse) {
      this.logError(`所有账户都已耗尽`, null, {
        context: {
          method: `v1internal:${method}`,
          group: quotaGroup,
          totalAttempts: maxAttempts,
          model: modelId || options.model,
        },
      });
      return lastResponse;
    }

    if (lastNetworkError) {
      throw lastNetworkError;
    }

    const cached = modelId ? this.getCachedErrorResponse(modelId) : null;
    if (cached) return cached;

    const error = new Error(`Upstream call exhausted without a response (v1internal:${method})`);
    error.status = 500;
    this.logError(`上游调用失败`, error, {
      context: { method: `v1internal:${method}`, group: quotaGroup, model: modelId || options.model },
    });
    throw error;
  }

  async fetchAvailableModels() {
    const accessToken = await this.auth.getCurrentAccessToken();
    this.log("info", "📋 获取可用模型列表");
    return httpClient.fetchAvailableModels(accessToken, this.auth.apiLimiter);
  }

  /**
   * v1internal:countTokens with 429 rotation policy (final 429 passthrough).
   * @param {object} body - Raw countTokens request body (typically { request: { model, contents } })
   * @param {object} [options]
   * @param {string} [options.group]
   * @param {string} [options.model]
   * @returns {Promise<Response>}
   */
  async countTokens(body, options = {}) {
    const inferredModel = options.model || body?.request?.model || body?.model;
    this.log("info", `🔢 计算 Token 数量 (${inferredModel || "unknown model"})`);
    return this.callV1Internal("countTokens", {
      group: options.group,
      model: inferredModel,
      buildBody: () => body || {},
    });
  }
}

module.exports = UpstreamClient;
