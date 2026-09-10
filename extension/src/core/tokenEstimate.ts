/**
 * 粗略的 token 用量估算（本地展示用，非精确计费）。
 * 中文字符 ≈ 1 token/字；其余文本 ≈ 4 字符/token。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [])
    .length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk + other / 4));
}
