; ============================================================================
; LightC Custom NSIS Installer Script
; ============================================================================
; 此文件由 Tauri 的 installerScript 配置注入到主安装脚本中
; 用于自定义 MUI2 界面、压缩算法、多语言支持等

; ============================================================================
; 1. 压缩算法配置 - LZMA 固实压缩，极致轻量
; ============================================================================
SetCompressor /SOLID lzma
SetCompressorDictSize 64

; ============================================================================
; 2. MUI2 视觉自定义
; ============================================================================

; 品牌标题
!define MUI_WELCOMEPAGE_TITLE "欢迎使用 LightC$\n轻量级 C 盘清理工具"
!define MUI_WELCOMEPAGE_TITLE_3LINES

; 欢迎页文字
!define MUI_WELCOMEPAGE_TEXT "LightC 是一款轻量级 Windows C 盘智能清理工具，帮助您快速释放磁盘空间、清理垃圾文件、优化系统性能。$\r$\n$\r$\n点击「下一步」继续安装。"

; 完成页配置
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "LightC 已成功安装到您的计算机。$\r$\n$\r$\n点击「完成」退出安装向导。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\LightC.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 LightC"
!define MUI_FINISHPAGE_RUN_CHECKED

; 桌面快捷方式选项
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!define MUI_FINISHPAGE_SHOWREADME_CHECKED

; 侧边栏位图 (164x314) - 欢迎/完成页
!define MUI_WELCOMEFINISHPAGE_BITMAP "nsis\wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "nsis\wizard.bmp"

; 顶部 Banner 位图 (150x57)
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "nsis\header.bmp"
!define MUI_HEADERIMAGE_BITMAP_STRETCH FillHeight
!define MUI_HEADERIMAGE_UNBITMAP "nsis\header.bmp"

; 图标配置
!define MUI_ICON "icons\icon.ico"
!define MUI_UNICON "icons\icon.ico"

; 界面风格
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "确定要取消 LightC 的安装吗？"

; ============================================================================
; 3. 多语言支持
; ============================================================================
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; 语言字符串
LangString DESC_SecMain ${LANG_SIMPCHINESE} "LightC 主程序文件"
LangString DESC_SecMain ${LANG_ENGLISH} "LightC main application files"

LangString MSG_ALREADY_RUNNING ${LANG_SIMPCHINESE} "LightC 正在运行中，请先关闭程序后再继续安装。"
LangString MSG_ALREADY_RUNNING ${LANG_ENGLISH} "LightC is currently running. Please close it before continuing."

; ============================================================================
; 4. 自定义函数
; ============================================================================

; 创建桌面快捷方式
Function CreateDesktopShortcut
    CreateShortCut "$DESKTOP\LightC.lnk" "$INSTDIR\LightC.exe" "" "$INSTDIR\LightC.exe" 0
FunctionEnd

; 检查程序是否正在运行
Function CheckAppRunning
    FindWindow $0 "" "LightC"
    StrCmp $0 0 notRunning
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(MSG_ALREADY_RUNNING)"
        Abort
    notRunning:
FunctionEnd

; 安装前回调
Function .onInit
    ; 检查是否正在运行
    Call CheckAppRunning
    
    ; 自动选择语言
    !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

; ============================================================================
; 5. 卸载程序美化
; ============================================================================

; 卸载欢迎页
!define MUI_UNCONFIRMPAGE_TEXT_TOP "即将从您的计算机中卸载 LightC。$\r$\n$\r$\n卸载前请确保 LightC 已关闭。"

; 卸载完成页
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

; 卸载前检查
Function un.onInit
    FindWindow $0 "" "LightC"
    StrCmp $0 0 notRunning
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(MSG_ALREADY_RUNNING)"
        Abort
    notRunning:
FunctionEnd

; 卸载时删除桌面快捷方式
Function un.onUninstSuccess
    Delete "$DESKTOP\LightC.lnk"
FunctionEnd
