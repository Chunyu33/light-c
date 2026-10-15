// ============================================================================
// 模块动作登记表
//
// 确认卡片是纯展示的，真正"删什么、怎么删"由模块提供 —— 这张表就是那个接口。
// 与 moduleDataRegistry 同一套思路：模块登记一个对象，AI 层按模块 id 取用，
// 双方都不用知道对方的组件长什么样。
//
// 动作按风险递增，模块可以只实现前面的：
//   selectItems  —— 只改勾选态（P3a，无风险，用户仍按原流程点删除）
//   deleteItems  —— 真正执行删除（P3b，必须走模块自己的安全入口）
//
// ⚠️ **deleteItems 绝不能自己实现删除逻辑**：必须调用模块原有的删除函数。
//    这样"校验 → 备份 → 删除 → 复核"整套安全流程照旧生效，
//    也不会出现"手动删很安全、AI 删走了另一条路"这种分裂。
// ============================================================================

import { useEffect, useRef } from 'react';

/** 删除目标解析结果里的一项（给界面展示用）。 */
export interface AiDeleteTargetSummary {
  /** 稳定 id，回调时原样带回 */
  id: string;
  label: string;
  /** 大小、项数等说明，模块格式化好 */
  detail?: string;
  /** 删除后不可恢复（回收站这类），界面会单独标注 */
  irreversible?: boolean;
}

/** 删除执行结果。数字一律由模块给出，**不让模型转述**。 */
export interface AiDeleteOutcome {
  deletedCount: number;
  /** 释放的字节数；模块算不出来时可以不给 */
  freedBytes?: number;
  /** 失败明细：名称 + 原因 */
  failures: { name: string; reason: string }[];
  /** 是否需要重启才生效 */
  needsReboot?: boolean;
}

/**
 * 一页明细。**由模块提供内容，由公共层负责说明"这只是其中一部分"** ——
 * 截断提示不交给模块自觉，否则很容易漏，而模型会因此以为自己看到了全部。
 */
export interface AiReadPage {
  /** 每行一条，模块自己格式化好（路径、大小等） */
  lines: string[];
  /** 总条数，用来告诉模型这一页占了多少 */
  total: number;
}

export interface ModuleActions {
  /**
   * 把 id 列表解析成可展示的目标摘要。
   * **必须容忍失效 id**：提案到确认之间数据可能变了（用户又勾选、模块重扫过），
   * 解析不到的项返回时剔除即可，不要抛错。
   */
  resolveTargets?: (ids: string[]) => AiDeleteTargetSummary[];
  /** P3a：把目标加入勾选态，由用户自己按原来的按钮删除。 */
  selectItems?: (ids: string[]) => void;
  /** P3b：执行删除。**必须调用模块原有的删除入口**。 */
  deleteItems?: (ids: string[]) => Promise<AiDeleteOutcome>;
  /**
   * 只读：读取某个分类下的一页明细。
   * **不登记就不会声明对应工具** —— 渐进增强，不影响没实现的模块。
   */
  readItems?: (targetId: string, offset: number, limit: number) => AiReadPage | null;
  /** 只读：读取单条条目的完整信息。 */
  readItemDetail?: (itemId: string) => string | null;
}

const actions = new Map<string, ModuleActions>();

/** 登记某模块的动作，返回注销函数（模块卸载时必须调用，避免留下旧闭包）。 */
export function registerModuleActions(moduleId: string, moduleActions: ModuleActions): () => void {
  actions.set(moduleId, moduleActions);
  return () => {
    // 只在自己还是当前登记项时删除：页面模式下模块实例可能先挂载后卸载，顺序不保证
    if (actions.get(moduleId) === moduleActions) {
      actions.delete(moduleId);
    }
  };
}

/** 取某模块的动作；没有登记返回 null（调用方据此禁用卡片上的按钮）。 */
export function getModuleActions(moduleId: string | null): ModuleActions | null {
  if (!moduleId) return null;
  return actions.get(moduleId) ?? null;
}

/**
 * 模块侧使用的登记钩子。
 *
 * 用 ref 保存最新的动作对象：动作里会闭包模块当前的状态（选中集合、扫描结果），
 * 所以必须是"每次渲染都更新的最新闭包"；但登记动作本身**只需做一次**，
 * 否则每帧都要 register + unregister 一遍，白白制造副作用。
 * 两者结合：登记一个稳定包装函数，内部每次调用都读 ref 里的最新实现。
 */
export function useModuleActions(moduleId: string, moduleActions: ModuleActions): void {
  const actionsRef = useRef(moduleActions);
  actionsRef.current = moduleActions;

  useEffect(
    () =>
      registerModuleActions(moduleId, {
        resolveTargets: (ids) => actionsRef.current.resolveTargets?.(ids) ?? [],
        selectItems: (ids) => actionsRef.current.selectItems?.(ids),
        deleteItems: (ids) => {
          const implementation = actionsRef.current.deleteItems;
          // 模块没实现删除时明确报错，而不是静默什么都不做
          if (!implementation) {
            return Promise.reject(new Error('当前模块未提供删除能力'));
          }
          return implementation(ids);
        },
        // ⚠️ 只读能力**必须**和上面几个一样走 ref。
        //
        // 直接写 `readItems: moduleActions.readItems` 会捕获**注册那一刻**的闭包，
        // 而注册只在 moduleId 变化时做一次 —— 于是模块里的 scanResult 永远是初始的
        // null，read_items 对**所有模块**都返回空，渐进式读取等于没实现。
        // （这就是"代码写了但一直测不出效果"的原因。）
        readItems: (targetId, offset, limit) =>
          actionsRef.current.readItems?.(targetId, offset, limit) ?? null,
        readItemDetail: (itemId) => actionsRef.current.readItemDetail?.(itemId) ?? null,
      }),
    [moduleId],
  );
}
