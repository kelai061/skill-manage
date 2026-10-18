; installer.nsh — 安装向导的自定义页与快捷方式
;
; 目标：安装路径可选（electron-builder 的 allowToChangeInstallationDirectory），
;       快捷方式由用户在向导里勾选，而不是被默认塞进桌面和开始菜单。
;
; 为什么不用 electron-builder 自带的 createDesktopShortcut：
;   它只有 always / never 两个值，做不出「让用户选」。
;
; 注意：本文件在 MUI 页面宏定义之前就被 include，所以不能用 MUI_HEADER_TEXT 之类的宏。

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var DesktopShortcutCheckbox
Var StartMenuShortcutCheckbox
Var DesktopShortcutState
Var StartMenuShortcutState
!endif

!macro customHeader
  ; 该宏被插在脚本头部（函数体之外），只能放声明类内容
!macroend

!macro customInit
  ; 静默安装（/S）不走向导页，这里给默认值：两个都建
  StrCpy $DesktopShortcutState ${BST_CHECKED}
  StrCpy $StartMenuShortcutState ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom ShortcutOptionsPage ShortcutOptionsLeave
!macroend

; 构建卸载器的那一遍里 installer 页面整体被 !ifndef BUILD_UNINSTALLER 跳过，
; 若此时仍定义这两个函数，makensis 会报 6010（函数未被引用）并当成错误。
!ifndef BUILD_UNINSTALLER

Function ShortcutOptionsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "选择要创建的快捷方式（安装位置可在上一步修改）："
  Pop $0

  ${NSD_CreateCheckbox} 0 26u 100% 12u "创建桌面快捷方式"
  Pop $DesktopShortcutCheckbox
  ${If} $DesktopShortcutState == ${BST_CHECKED}
    ${NSD_Check} $DesktopShortcutCheckbox
  ${EndIf}

  ${NSD_CreateCheckbox} 0 44u 100% 12u "创建开始菜单快捷方式"
  Pop $StartMenuShortcutCheckbox
  ${If} $StartMenuShortcutState == ${BST_CHECKED}
    ${NSD_Check} $StartMenuShortcutCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0 70u 100% 30u "两个都不勾也可以：装完后直接进安装目录双击 SkillAtelier.exe。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function ShortcutOptionsLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutState
  ${NSD_GetState} $StartMenuShortcutCheckbox $StartMenuShortcutState
FunctionEnd

!endif ; BUILD_UNINSTALLER

!macro customInstall
  ${If} $DesktopShortcutState == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\SkillAtelier.lnk" "$INSTDIR\SkillAtelier.exe" "" "$INSTDIR\SkillAtelier.exe" 0
  ${EndIf}

  ${If} $StartMenuShortcutState == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\SkillAtelier"
    CreateShortCut "$SMPROGRAMS\SkillAtelier\SkillAtelier.lnk" "$INSTDIR\SkillAtelier.exe" "" "$INSTDIR\SkillAtelier.exe" 0
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\SkillAtelier.lnk"
  Delete "$SMPROGRAMS\SkillAtelier\SkillAtelier.lnk"
  RMDir "$SMPROGRAMS\SkillAtelier"
!macroend
