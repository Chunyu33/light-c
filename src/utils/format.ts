// ============================================================================
// 格式化工具函数
// ============================================================================

/**
 * 格式化文件大小为人类可读格式
 * @param bytes 字节数
 * @returns 格式化后的字符串
 */
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(2)} GB`;
  } else if (bytes >= MB) {
    return `${(bytes / MB).toFixed(2)} MB`;
  } else if (bytes >= KB) {
    return `${(bytes / KB).toFixed(2)} KB`;
  } else {
    return `${bytes} B`;
  }
}

/**
 * 格式化时间戳为日期字符串
 * @param timestamp Unix时间戳（秒）
 * @returns 格式化后的日期字符串
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 格式化耗时
 * @param ms 毫秒数
 * @returns 格式化后的字符串
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} 毫秒`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)} 秒`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes} 分 ${seconds} 秒`;
  }
}

/**
 * 获取风险等级的颜色
 * @param level 风险等级 (1-5)
 * @returns 颜色类名
 */
export function getRiskLevelColor(level: number): string {
  switch (level) {
    case 1:
      return 'text-green-500';
    case 2:
      return 'text-lime-500';
    case 3:
      return 'text-yellow-500';
    case 4:
      return 'text-orange-500';
    case 5:
      return 'text-red-500';
    default:
      return 'text-gray-500';
  }
}

/**
 * 获取风险等级的背景颜色
 * @param level 风险等级 (1-5)
 * @returns 背景颜色类名
 */
export function getRiskLevelBgColor(level: number): string {
  switch (level) {
    case 1:
      return 'bg-green-500/10';
    case 2:
      return 'bg-lime-500/10';
    case 3:
      return 'bg-yellow-500/10';
    case 4:
      return 'bg-orange-500/10';
    case 5:
      return 'bg-red-500/10';
    default:
      return 'bg-gray-500/10';
  }
}

/**
 * 获取风险等级文字描述
 * @param level 风险等级 (1-5)
 * @returns 风险描述
 */
export function getRiskLevelText(level: number): string {
  switch (level) {
    case 1:
      return '安全';
    case 2:
      return '低风险';
    case 3:
      return '中等';
    case 4:
      return '较高';
    case 5:
      return '高风险';
    default:
      return '未知';
  }
}
