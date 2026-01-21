function getAccountsPayload(authManager) {
  const accounts = authManager.getAccountsSummary();
  return {
    count: accounts.length,
    current: {
      claude: authManager.getCurrentAccountIndex("claude"),
      gemini: authManager.getCurrentAccountIndex("gemini"),
    },
    accounts,
  };
}

async function deleteAccount(authManager, fileName) {
  const ok = await authManager.deleteAccountByFile(fileName);
  return ok;
}

async function reloadAccounts(authManager) {
  const accounts = await authManager.reloadAccounts();
  return {
    count: accounts.length,
    current: {
      claude: authManager.getCurrentAccountIndex("claude"),
      gemini: authManager.getCurrentAccountIndex("gemini"),
    },
    accounts,
  };
}

function formatLocalDateTime(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "-";
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

function formatRemainingFractionAsPercent(remainingFraction) {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return "-";
  const percent = remainingFraction * 100;
  const text = percent.toFixed(2).replace(/\.?0+$/, "");
  return `${text}%`;
}

// 格式化重置时间为简短格式 MM/DD HH:mm
function formatResetTimeShort(resetTime) {
  if (!resetTime) return "-";
  const d = new Date(resetTime);
  if (!Number.isFinite(d.getTime())) return "-";
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MM}/${dd} ${HH}:${mm}`;
}

// 根据百分比估算剩余调用次数（假设每个周期约149次）
function estimateRemainingCalls(remainingFraction, baseCallsPerCycle = 149) {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return null;
  return Math.round(remainingFraction * baseCallsPerCycle);
}

async function getAccountQuota(authManager, fileName, upstreamClient) {
  const safeName = String(fileName || "").trim();
  const account = authManager.accounts.find((acc) => acc.keyName === safeName);

  if (!account) {
    throw new Error("Account not found");
  }

  const accountIndex = authManager.accounts.indexOf(account);
  const models = await upstreamClient.fetchAvailableModelsByAccountIndex(accountIndex);

  const result = [];
  if (models && typeof models === "object") {
    for (const modelId in models) {
      const m = models[modelId];
      const quota = m.quotaInfo || {};
      const limit = formatRemainingFractionAsPercent(quota.remainingFraction);
      let resetTimeMs = null;
      let reset = "-";
      if (quota.resetTime) {
        const d = new Date(quota.resetTime);
        if (Number.isFinite(d.getTime())) {
          resetTimeMs = d.getTime();
          reset = formatLocalDateTime(d);
        }
      }

      result.push({
        model: modelId,
        limit,
        reset,
        resetTimeMs,
      });
    }
  }

  result.sort((a, b) => a.model.localeCompare(b.model));
  return result;
}

// 获取所有账号的额度信息（用于列表内联显示）
async function getAllAccountsQuota(authManager, upstreamClient) {
  const accounts = authManager.accounts || [];
  if (accounts.length === 0) {
    return {};
  }

  const result = {};
  const fetchTasks = accounts.map(async (account, accountIndex) => {
    const fileName = account.keyName;
    try {
      const models = await upstreamClient.fetchAvailableModelsByAccountIndex(accountIndex);
      const quotaList = [];

      if (models && typeof models === "object") {
        for (const modelId in models) {
          // 只取 claude 和 gemini 相关模型
          if (modelId.includes("gemini") || modelId.includes("claude")) {
            const m = models[modelId];
            const quota = m.quotaInfo || {};
            const remainingFraction = quota.remainingFraction;
            const limit = formatRemainingFractionAsPercent(remainingFraction);
            const resetShort = formatResetTimeShort(quota.resetTime);
            const estimatedCalls = estimateRemainingCalls(remainingFraction);

            let resetTimeMs = null;
            if (quota.resetTime) {
              const d = new Date(quota.resetTime);
              if (Number.isFinite(d.getTime())) {
                resetTimeMs = d.getTime();
              }
            }

            // 提取模型简称用于显示
            let shortName = modelId;
            if (modelId.includes("claude")) {
              shortName = "claude";
            } else if (modelId.includes("gemini")) {
              shortName = "gemini";
            }

            quotaList.push({
              model: modelId,
              shortName,
              limit,
              remainingFraction: typeof remainingFraction === "number" ? remainingFraction : null,
              resetShort,
              resetTimeMs,
              estimatedCalls,
            });
          }
        }
      }

      // 按模型名排序，claude 优先
      quotaList.sort((a, b) => {
        if (a.shortName === "claude" && b.shortName !== "claude") return -1;
        if (a.shortName !== "claude" && b.shortName === "claude") return 1;
        return a.model.localeCompare(b.model);
      });

      result[fileName] = quotaList;
    } catch (e) {
      // 该账号获取失败，记录空数组
      result[fileName] = [];
    }
  });

  await Promise.all(fetchTasks);
  return result;
}

// 刷新所有账号额度（调用 QuotaRefresher）
async function refreshAllQuotas(quotaRefresher) {
  if (!quotaRefresher || typeof quotaRefresher.refreshAllAccountQuotas !== "function") {
    throw new Error("QuotaRefresher not available");
  }
  const refreshResult = await quotaRefresher.refreshAllAccountQuotas();
  return refreshResult;
}

// 刷新单个账号额度并返回结果
async function refreshSingleQuota(authManager, fileName, upstreamClient) {
  const safeName = String(fileName || "").trim();
  const account = authManager.accounts.find((acc) => acc.keyName === safeName);

  if (!account) {
    throw new Error("Account not found");
  }

  const accountIndex = authManager.accounts.indexOf(account);
  const models = await upstreamClient.fetchAvailableModelsByAccountIndex(accountIndex);

  const quotaList = [];
  if (models && typeof models === "object") {
    for (const modelId in models) {
      if (modelId.includes("gemini") || modelId.includes("claude")) {
        const m = models[modelId];
        const quota = m.quotaInfo || {};
        const remainingFraction = quota.remainingFraction;
        const limit = formatRemainingFractionAsPercent(remainingFraction);
        const resetShort = formatResetTimeShort(quota.resetTime);
        const estimatedCalls = estimateRemainingCalls(remainingFraction);

        let resetTimeMs = null;
        if (quota.resetTime) {
          const d = new Date(quota.resetTime);
          if (Number.isFinite(d.getTime())) {
            resetTimeMs = d.getTime();
          }
        }

        let shortName = modelId;
        if (modelId.includes("claude")) {
          shortName = "claude";
        } else if (modelId.includes("gemini")) {
          shortName = "gemini";
        }

        quotaList.push({
          model: modelId,
          shortName,
          limit,
          remainingFraction: typeof remainingFraction === "number" ? remainingFraction : null,
          resetShort,
          resetTimeMs,
          estimatedCalls,
        });
      }
    }
  }

  quotaList.sort((a, b) => {
    if (a.shortName === "claude" && b.shortName !== "claude") return -1;
    if (a.shortName !== "claude" && b.shortName === "claude") return 1;
    return a.model.localeCompare(b.model);
  });

  return quotaList;
}

module.exports = {
  getAccountsPayload,
  deleteAccount,
  reloadAccounts,
  getAccountQuota,
  getAllAccountsQuota,
  refreshAllQuotas,
  refreshSingleQuota,
};
