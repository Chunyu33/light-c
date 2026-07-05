// ============================================================================
// 仪表盘状态管理 Context
// 管理所有清理模块的扫描状态，支持并发扫描和实时进度更新
// ============================================================================

import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react';
import {
  cancelDiskGrowthScan,
  cancelHotspotScan,
  cancelLargeFileScan,
  getDiskInfo,
  getHealthScore,
  HealthScoreResult,
} from '../api/commands';
import type { DiskInfo } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/** 模块扫描状态 */
export type ModuleStatus = 'idle' | 'scanning' | 'done' | 'error';

/** 单个模块的状态 */
export interface ModuleState {
  /** 模块状态 */
  status: ModuleStatus;
  /** 扫描进度（0-100） */
  progress: number;
  /** 发现的文件数量 */
  fileCount: number;
  /** 可清理的总大小 */
  totalSize: number;
  /** 错误信息 */
  error: string | null;
  /** 最后更新时间 */
  lastUpdated: number;
}

/** 所有模块的状态映射 */
export interface ModulesState {
  /** 垃圾清理模块 */
  junk: ModuleState;
  /** 大文件清理模块 */
  bigFiles: ModuleState;
  /** 社交软件专清模块 */
  social: ModuleState;
  /** 系统瘦身模块 */
  system: ModuleState;
  /** 卸载残留模块 */
  leftovers: ModuleState;
  /** 注册表冗余模块 */
  registry: ModuleState;
  /** C盘热点扫描模块 */
  hotspot: ModuleState;
  /** 右键菜单清理模块 */
  contextMenu: ModuleState;
  /** C 盘全盘变化分析模块 */
  diskGrowth: ModuleState;
  /** AI资产分析模块 */
  aiModels: ModuleState;
}

/** 仪表盘 Context 值类型 */
export interface DashboardContextValue {
  /** 磁盘信息 */
  diskInfo: DiskInfo | null;
  /** 健康评分数据 */
  healthData: HealthScoreResult | null;
  /** 是否正在加载健康评分 */
  isLoadingHealth: boolean;
  /** 所有模块的状态 */
  modules: ModulesState;
  /** 当前展开的模块ID */
  expandedModule: string | null;
  /** 设置展开的模块 */
  setExpandedModule: (moduleId: string | null) => void;
  /** 更新模块状态 */
  updateModuleState: (moduleId: keyof ModulesState, state: Partial<ModuleState>) => void;
  /** 刷新磁盘信息 */
  refreshDiskInfo: () => Promise<void>;
  /** 刷新健康评分 */
  refreshHealthScore: () => Promise<void>;
  /** 是否有任何模块正在扫描 */
  isAnyScanning: boolean;
  /** 健康评分刷新触发器 */
  healthRefreshTrigger: number;
  /** 触发健康评分刷新 */
  triggerHealthRefresh: () => void;
  /** 一键扫描触发器（递增数字，各模块监听此值变化来启动扫描） */
  oneClickScanTrigger: number;
  /** 触发一键扫描 */
  triggerOneClickScan: () => void;
  /** 停止所有扫描 */
  stopAllScans: () => void;
  /** 全局停止触发器，模块用它丢弃被取消任务的异步返回。 */
  stopScanTrigger: number;
}

interface DashboardActionsValue {
  setExpandedModule: (moduleId: string | null) => void;
  updateModuleState: (moduleId: keyof ModulesState, state: Partial<ModuleState>) => void;
  refreshDiskInfo: () => Promise<void>;
  refreshHealthScore: () => Promise<void>;
  triggerHealthRefresh: () => void;
  triggerOneClickScan: () => void;
  stopAllScans: () => void;
}

interface DashboardSignalsValue {
  expandedModule: string | null;
  healthRefreshTrigger: number;
  oneClickScanTrigger: number;
  stopScanTrigger: number;
}

interface DashboardSummaryValue {
  diskInfo: DiskInfo | null;
  healthData: HealthScoreResult | null;
  isLoadingHealth: boolean;
  isAnyScanning: boolean;
}

// ============================================================================
// 初始状态
// ============================================================================

/** 模块初始状态 */
const initialModuleState: ModuleState = {
  status: 'idle',
  progress: 0,
  fileCount: 0,
  totalSize: 0,
  error: null,
  lastUpdated: 0,
};

/** 所有模块初始状态 */
const initialModulesState: ModulesState = {
  junk: { ...initialModuleState },
  bigFiles: { ...initialModuleState },
  social: { ...initialModuleState },
  system: { ...initialModuleState },
  leftovers: { ...initialModuleState },
  registry: { ...initialModuleState },
  hotspot: { ...initialModuleState },
  contextMenu: { ...initialModuleState },
  diskGrowth: { ...initialModuleState },
  aiModels: { ...initialModuleState },
};

// ============================================================================
// Context 创建
// ============================================================================

const DashboardContext = createContext<DashboardContextValue | null>(null);
const DashboardActionsContext = createContext<DashboardActionsValue | null>(null);
const DashboardSignalsContext = createContext<DashboardSignalsValue | null>(null);
const DashboardSummaryContext = createContext<DashboardSummaryValue | null>(null);

const ModuleStateContexts: { [K in keyof ModulesState]: React.Context<ModuleState | null> } = {
  junk: createContext<ModuleState | null>(null),
  bigFiles: createContext<ModuleState | null>(null),
  social: createContext<ModuleState | null>(null),
  system: createContext<ModuleState | null>(null),
  leftovers: createContext<ModuleState | null>(null),
  registry: createContext<ModuleState | null>(null),
  hotspot: createContext<ModuleState | null>(null),
  contextMenu: createContext<ModuleState | null>(null),
  diskGrowth: createContext<ModuleState | null>(null),
  aiModels: createContext<ModuleState | null>(null),
};

// ============================================================================
// Provider 组件
// ============================================================================

interface DashboardProviderProps {
  children: ReactNode;
}

export function DashboardProvider({ children }: DashboardProviderProps) {
  // 磁盘信息
  const [diskInfo, setDiskInfo] = useState<DiskInfo | null>(null);
  // 健康评分
  const [healthData, setHealthData] = useState<HealthScoreResult | null>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(true);
  // 模块状态
  const [modules, setModules] = useState<ModulesState>(initialModulesState);
  // 当前展开的模块
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  // 健康评分刷新触发器
  const [healthRefreshTrigger, setHealthRefreshTrigger] = useState(0);
  // 一键扫描触发器
  const [oneClickScanTrigger, setOneClickScanTrigger] = useState(0);
  const [stopScanTrigger, setStopScanTrigger] = useState(0);

  // 刷新磁盘信息
  const refreshDiskInfo = useCallback(async () => {
    try {
      const info = await getDiskInfo();
      setDiskInfo(info);
    } catch (error) {
      console.error('获取磁盘信息失败:', error);
    }
  }, []);

  // 刷新健康评分
  const refreshHealthScore = useCallback(async () => {
    setIsLoadingHealth(true);
    try {
      const result = await getHealthScore();
      setHealthData(result);
    } catch (error) {
      console.error('获取健康评分失败:', error);
    } finally {
      setIsLoadingHealth(false);
    }
  }, []);

  // 触发健康评分刷新
  const triggerHealthRefresh = useCallback(() => {
    setHealthRefreshTrigger(n => n + 1);
  }, []);

  // 触发一键扫描
  const triggerOneClickScan = useCallback(() => {
    setOneClickScanTrigger(n => n + 1);
  }, []);

  // 停止所有扫描
  const stopAllScans = useCallback(() => {
    // 先通知支持取消的后端任务，避免 UI 已停止但 MFT/文件扫描仍在后台占用 IO。
    void cancelLargeFileScan().catch(error => console.error('停止大文件扫描失败:', error));
    void cancelHotspotScan().catch(error => console.error('停止大目录扫描失败:', error));
    void cancelDiskGrowthScan().catch(error => console.error('停止磁盘变化分析失败:', error));
    setStopScanTrigger(n => n + 1);

    // 将所有正在扫描的模块状态重置为 idle
    setModules(prev => {
      const newModules = { ...prev };
      (Object.keys(newModules) as Array<keyof ModulesState>).forEach(key => {
        if (newModules[key].status === 'scanning') {
          newModules[key] = { ...newModules[key], status: 'idle', progress: 0 };
        }
      });
      return newModules;
    });
  }, []);

  // 更新模块状态
  const updateModuleState = useCallback((moduleId: keyof ModulesState, state: Partial<ModuleState>) => {
    setModules(prev => ({
      ...prev,
      [moduleId]: {
        ...prev[moduleId],
        ...state,
        lastUpdated: Date.now(),
      },
    }));
  }, []);

  // 计算是否有任何模块正在扫描
  const isAnyScanning = useMemo(
    () => Object.values(modules).some(m => m.status === 'scanning'),
    [modules]
  );

  // 初始化加载
  useEffect(() => {
    refreshDiskInfo();
    refreshHealthScore();
  }, [refreshDiskInfo, refreshHealthScore]);

  // 监听健康评分刷新触发器
  useEffect(() => {
    if (healthRefreshTrigger > 0) {
      refreshHealthScore();
      refreshDiskInfo();
    }
  }, [healthRefreshTrigger, refreshHealthScore, refreshDiskInfo]);

  const actionsValue = useMemo<DashboardActionsValue>(() => ({
    setExpandedModule,
    updateModuleState,
    refreshDiskInfo,
    refreshHealthScore,
    triggerHealthRefresh,
    triggerOneClickScan,
    stopAllScans,
  }), [
    setExpandedModule,
    updateModuleState,
    refreshDiskInfo,
    refreshHealthScore,
    triggerHealthRefresh,
    triggerOneClickScan,
    stopAllScans,
  ]);

  const signalsValue = useMemo<DashboardSignalsValue>(() => ({
    expandedModule,
    healthRefreshTrigger,
    oneClickScanTrigger,
    stopScanTrigger,
  }), [expandedModule, healthRefreshTrigger, oneClickScanTrigger, stopScanTrigger]);

  const summaryValue = useMemo<DashboardSummaryValue>(() => ({
    diskInfo,
    healthData,
    isLoadingHealth,
    isAnyScanning,
  }), [diskInfo, healthData, isLoadingHealth, isAnyScanning]);

  const value = useMemo<DashboardContextValue>(() => ({
    diskInfo,
    healthData,
    isLoadingHealth,
    modules,
    expandedModule,
    setExpandedModule,
    updateModuleState,
    refreshDiskInfo,
    refreshHealthScore,
    isAnyScanning,
    healthRefreshTrigger,
    triggerHealthRefresh,
    oneClickScanTrigger,
    triggerOneClickScan,
    stopAllScans,
    stopScanTrigger,
  }), [
    diskInfo,
    healthData,
    isLoadingHealth,
    modules,
    expandedModule,
    setExpandedModule,
    updateModuleState,
    refreshDiskInfo,
    refreshHealthScore,
    isAnyScanning,
    healthRefreshTrigger,
    triggerHealthRefresh,
    oneClickScanTrigger,
    triggerOneClickScan,
    stopAllScans,
    stopScanTrigger,
  ]);

  return (
    <DashboardContext.Provider value={value}>
      <DashboardActionsContext.Provider value={actionsValue}>
        <DashboardSignalsContext.Provider value={signalsValue}>
          <DashboardSummaryContext.Provider value={summaryValue}>
            <ModuleStateContexts.junk.Provider value={modules.junk}>
              <ModuleStateContexts.bigFiles.Provider value={modules.bigFiles}>
                <ModuleStateContexts.social.Provider value={modules.social}>
                  <ModuleStateContexts.system.Provider value={modules.system}>
                    <ModuleStateContexts.leftovers.Provider value={modules.leftovers}>
                      <ModuleStateContexts.registry.Provider value={modules.registry}>
                        <ModuleStateContexts.hotspot.Provider value={modules.hotspot}>
                          <ModuleStateContexts.contextMenu.Provider value={modules.contextMenu}>
                            <ModuleStateContexts.diskGrowth.Provider value={modules.diskGrowth}>
                              <ModuleStateContexts.aiModels.Provider value={modules.aiModels}>
                                {children}
                              </ModuleStateContexts.aiModels.Provider>
                            </ModuleStateContexts.diskGrowth.Provider>
                          </ModuleStateContexts.contextMenu.Provider>
                        </ModuleStateContexts.hotspot.Provider>
                      </ModuleStateContexts.registry.Provider>
                    </ModuleStateContexts.leftovers.Provider>
                  </ModuleStateContexts.system.Provider>
                </ModuleStateContexts.social.Provider>
              </ModuleStateContexts.bigFiles.Provider>
            </ModuleStateContexts.junk.Provider>
          </DashboardSummaryContext.Provider>
        </DashboardSignalsContext.Provider>
      </DashboardActionsContext.Provider>
    </DashboardContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useDashboard(): DashboardContextValue {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboard 必须在 DashboardProvider 内部使用');
  }
  return context;
}

export function useDashboardActions(): DashboardActionsValue {
  const context = useContext(DashboardActionsContext);
  if (!context) {
    throw new Error('useDashboardActions 必须在 DashboardProvider 内部使用');
  }
  return context;
}

export function useDashboardSummary(): DashboardSummaryValue {
  const context = useContext(DashboardSummaryContext);
  if (!context) {
    throw new Error('useDashboardSummary 必须在 DashboardProvider 内部使用');
  }
  return context;
}

export function useDashboardSignals(): DashboardSignalsValue {
  const context = useContext(DashboardSignalsContext);
  if (!context) {
    throw new Error('useDashboardSignals 必须在 DashboardProvider 内部使用');
  }
  return context;
}

export function useDashboardModuleState(moduleId: keyof ModulesState): ModuleState {
  const context = useContext(ModuleStateContexts[moduleId]);
  if (!context) {
    throw new Error('useDashboardModuleState 必须在 DashboardProvider 内部使用');
  }
  return context;
}

export function useModuleDashboard(moduleId: keyof ModulesState) {
  const moduleState = useDashboardModuleState(moduleId);
  const actions = useDashboardActions();
  const signals = useDashboardSignals();

  // 模块只订阅自己的扫描状态；全局触发信号仍单独订阅，保持一键扫描/停止扫描行为不变。
  return {
    moduleState,
    expandedModule: signals.expandedModule,
    oneClickScanTrigger: signals.oneClickScanTrigger,
    stopScanTrigger: signals.stopScanTrigger,
    setExpandedModule: actions.setExpandedModule,
    updateModuleState: actions.updateModuleState,
    triggerHealthRefresh: actions.triggerHealthRefresh,
  };
}

export default DashboardContext;
