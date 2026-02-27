// ============================================================================
// 仪表盘状态管理 Context
// 管理所有清理模块的扫描状态，支持并发扫描和实时进度更新
// ============================================================================

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { getDiskInfo, getHealthScore, HealthScoreResult } from '../api/commands';
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
};

// ============================================================================
// Context 创建
// ============================================================================

const DashboardContext = createContext<DashboardContextValue | null>(null);

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
  const isAnyScanning = Object.values(modules).some(m => m.status === 'scanning');

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

  const value: DashboardContextValue = {
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
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
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

export default DashboardContext;
