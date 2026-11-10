; 大肥鱼桌宠 · 自定义 NSIS 片段
; 1) 安装向导底部版权行
; 2) 安装时写入开机自启（HKCU Run），卸载时清理
;
; 【重要】本文件刻意不使用任何 nsDialogs 自定义页面。
; 原因：1.1.0 用自定义向导页提供「开机自启」勾选，在部分机器上点「安装」
; 立即崩溃（Windows 事件日志 0xc0000005，出错模块 nsDialogs.dll，多次复现；
; 换成仅含单个复选框的最小页面依然崩）。该插件为 2018 年编译版本，在启用了
; 内存完整性 / CET 的新版 Windows 上不可靠。
; 现在改为安装时默认写入自启项，用户在桌宠右键菜单里可随时关闭 —— 功能不丢，
; 且安装器全程不加载 nsDialogs，崩溃根因被彻底绕开。
;
; 注意：本文件在 electron-builder 模板之前被 include；页面/安装段代码必须限定在
; 非卸载器编译中，否则生成 uninstaller 那一趟会出现 "function not referenced"
; 警告，而 electron-builder 将 NSIS 警告视为错误。
!include "MUI2.nsh"

; 版权与开发者：安装向导每一页底部都显示这一行（文案全局统一）
BrandingText "大肥鱼桌宠 · 开发者 Dudu Studio · Copyright © 2026 Dudu Studio. All Rights Reserved."

!ifndef BUILD_UNINSTALLER
  !macro customInstall
    ; 用 PRODUCT_FILENAME / APP_EXECUTABLE_FILENAME 而不是写死名字：
    ; 干净版的 exe 名不同，自启项与路径会自动跟着变，两个版本可共存
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_FILENAME}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  !macroend
!endif

!macro customUnInstall
  ; 只删自己的 Run 值，绝不动整个 Run 键（系统共用）
  ; （卸载器界面底部的品牌行由文件顶部的全局 BrandingText 提供，NSIS 不允许在 Section 里改）
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_FILENAME}"
!macroend
