/**
 * Multipart 上传时，部分客户端/中间栈会把 UTF-8 字节按 latin1 解释，
 * 中文文件名会变成 mojibake。对常见情况做 latin1→utf8 纠正。
 */
export function normalizeUploadFilename(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";

  // 已含常见中日韩字符时，认为已是正确 UTF-8
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) {
    return raw;
  }

  try {
    const recovered = Buffer.from(raw, "latin1").toString("utf8");
    if (recovered && recovered !== raw && !/\uFFFD/.test(recovered)) {
      if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(recovered)) {
        return recovered;
      }
    }
  } catch {
    return raw;
  }
  return raw;
}
