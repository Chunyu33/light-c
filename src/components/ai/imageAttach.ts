// ============================================================================
// 图片附件：压缩与转换
//
// **为什么必须压缩**：图片是以 base64 放进请求里的，比原文件大 ~1/3；
// 而对话是无状态的 —— 整个历史**每一轮都会重发**。一张 2MB 的截图会让每轮请求
// 多背 2.7MB，几轮之后又慢又贵。压到长边 1280 / 质量 0.8，通常落在 200~400KB。
//
// 用 canvas 而不是引入图像库：需求只有"缩放 + 转 JPEG"这一件事，
// 浏览器原生完全够用，也符合项目"能用原生就不加依赖"的约定。
//
// ⚠️ 统一输出 JPEG：截图没有透明通道，压成 JPEG 体积小得多。
//    代价是带透明背景的图会变成黑底/白底 —— 对当前用途（截图提问）可以接受。
// ============================================================================

/** 压缩后的图片附件，直接可用于发给后端。 */
export interface AttachedImage {
  /** 例如 image/jpeg */
  mediaType: string;
  /** 不带 data: 前缀的纯 base64 */
  base64: string;
  /** 用于界面上的缩略图预览 */
  previewUrl: string;
}

/** 长边上限：再大对"看懂截图"没有帮助，只会让每轮请求变重。 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.8;

/** 单张图的上限：超过就拒绝，避免用户误选一张几十 MB 的图。 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * 把一张图片压到可发送的尺寸。
 * 失败（不是图片、解码不了）时抛错，调用方负责提示 —— 不静默丢弃。
 */
export async function compressImage(file: File): Promise<AttachedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('不是图片文件');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('图片太大，请先裁剪或压缩后再试');
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法处理图片');
  }
  // 白底：JPEG 没有透明通道，直接画会在透明区域留下黑块
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const base64 = dataUrl.split(',')[1] ?? '';
  if (!base64) {
    throw new Error('图片编码失败');
  }

  return { mediaType: 'image/jpeg', base64, previewUrl: dataUrl };
}

/** 从粘贴板或文件选择里取出图片文件。 */
export function collectImageFiles(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((file) => file.type.startsWith('image/'));
}
