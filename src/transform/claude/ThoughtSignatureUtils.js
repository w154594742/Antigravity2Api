/**
 * Thought Signature 工具函数（独立模块，便于上游合并）
 * 处理 Claude ↔ Gemini 签名格式转换
 *
 * @author wangqiupei
 */

// Claude 客户端签名前缀标识
const CLAUDE_SIGNATURE_PREFIX = "claude#";

/**
 * 规范化签名：去除 Claude 客户端添加的 "claude#" 前缀
 * Gemini API 期望纯 Base64 编码的签名，不支持带前缀格式
 *
 * @param {string} signature - 原始签名（可能带 claude# 前缀）
 * @returns {string} 规范化后的纯 Base64 签名
 */
function normalizeThoughtSignature(signature) {
  if (typeof signature !== "string" || !signature) return "";
  if (signature.startsWith(CLAUDE_SIGNATURE_PREFIX)) {
    return signature.slice(CLAUDE_SIGNATURE_PREFIX.length);
  }
  return signature;
}

module.exports = {
  normalizeThoughtSignature,
  CLAUDE_SIGNATURE_PREFIX,
};
