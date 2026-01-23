const CLAUDE_MODEL_MAP_ENV = "AG2API_CLAUDE_MODEL_MAP";
const GEMINI_MODEL_MAP_ENV = "AG2API_GEMINI_MODEL_MAP";

function parseModelMapFromEnv(rawValue) {
  if (rawValue == null) return {};
  const raw = String(rawValue).trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out = {};
    for (const [from, to] of Object.entries(parsed)) {
      const key = String(from || "").trim().toLowerCase();
      const value = String(to || "").trim();
      if (!key || !value) continue;
      out[key] = value;
    }
    return out;
  } catch (_) {
    return {};
  }
}

const cacheByEnvName = new Map(); // envName -> { raw: string, map: object }

function getEnvModelMap(envName) {
  const name = String(envName || "").trim();
  if (!name) return {};

  const raw = process.env[name];
  const rawStr = raw == null ? "" : String(raw);

  const cached = cacheByEnvName.get(name);
  if (cached && cached.raw === rawStr) return cached.map;

  const nextMap = parseModelMapFromEnv(rawStr);
  cacheByEnvName.set(name, { raw: rawStr, map: nextMap });
  return nextMap;
}

function mapModelFromEnv(envName, modelName) {
  const model = String(modelName || "").trim();
  if (!model) return null;
  const envModelMap = getEnvModelMap(envName);
  return envModelMap[String(model).toLowerCase()] || null;
}

function mapClaudeModelFromEnv(modelName) {
  return mapModelFromEnv(CLAUDE_MODEL_MAP_ENV, modelName);
}

function mapGeminiModelFromEnv(modelName) {
  return mapModelFromEnv(GEMINI_MODEL_MAP_ENV, modelName);
}

module.exports = {
  CLAUDE_MODEL_MAP_ENV,
  GEMINI_MODEL_MAP_ENV,
  getEnvModelMap,
  mapModelFromEnv,
  mapClaudeModelFromEnv,
  mapGeminiModelFromEnv,
};
