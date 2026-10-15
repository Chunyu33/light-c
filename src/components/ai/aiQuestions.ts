// ============================================================================
// 快捷提问的问句模板
//
// **不要直接复用"一键搜索"的关键字**。那是给搜索引擎用的短语，例如
//   `Windows 文件 C:\Windows\Temp 可以删除吗`
// 空格堆词对搜索引擎没问题，但模型在具体模块的语境下会把它读成"处理这个对象"——
// 旧驱动模块就因此把"查这个驱动"理解成了"删这个驱动"，直接开始提删除。
//
// 所以统一在这里把同一个对象包装成完整问句：字段仍取自模块已有的数据，
// 不另维护一套；变的只是"怎么问"。
//
// ⚠️ 问句也要跟着界面语言走：英文/日文界面里冒出一句中文问句很突兀，
// 而且会把模型也带成用中文回答。文案在 i18n 的 `askQuestion.*` 下，四种语言各一套。
// ============================================================================

import i18n from '../../i18n';

/** 被询问的对象类型，决定用词与追问的重点。 */
export type AskTargetKind = 'file' | 'folder' | 'model';

/**
 * 组装某个对象的完整问句。target 通常是路径或模型名。
 *
 * ⚠️ `askQuestion.file / folder / model` 这三个键**不受类型检查** ——
 * 键名写错时 tsc 与构建都不报，只会把键名本身显示在气泡里。
 * 四种语言都补齐了，改动时挨个核一遍。
 */
export function buildItemQuestion(target: string, kind: AskTargetKind = 'file'): string {
  const trimmed = target.trim();
  if (!trimmed) return '';
  return i18n.t(`askQuestion.${kind}`, { ns: 'ai', target: trimmed });
}
